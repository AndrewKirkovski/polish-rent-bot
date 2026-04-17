// Core agent loop — orchestrates Claude API calls, tool execution, and Telegram messaging

import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ContentBlockParam, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.js';
import { SYSTEM_PROMPT } from './prompts.js';
import { TOOL_DEFINITIONS, executeTool, getOrCreateContext } from './tools.js';
import type { UserContext } from './tools.js';
import { getDb } from '../storage/db.js';

// ---------------------------------------------------------------------------
// Anthropic client
// ---------------------------------------------------------------------------

const client = new Anthropic(); // uses ANTHROPIC_API_KEY env var
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = 2048;
const MAX_TOOL_ROUNDS = 10; // safety limit on tool-use loops

// ---------------------------------------------------------------------------
// Conversation history persistence
// ---------------------------------------------------------------------------

// Ensure the conversations table exists (called once lazily)
let _tableCreated = false;

function ensureConversationTable(): void {
  if (_tableCreated) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_user
      ON conversations(user_id, created_at);
  `);
  _tableCreated = true;
}

function saveConversationTurn(userId: number, role: 'user' | 'assistant', content: string): void {
  ensureConversationTable();
  const db = getDb();
  db.prepare(
    'INSERT INTO conversations (user_id, role, content) VALUES (?, ?, ?)',
  ).run(userId, role, content);
}

function getConversationHistory(userId: number, limit = 20): MessageParam[] {
  ensureConversationTable();
  const db = getDb();
  const rows = db.prepare(`
    SELECT role, content FROM conversations
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, limit) as Array<{ role: string; content: string }>;

  // Rows come newest-first, reverse to chronological order
  rows.reverse();

  return rows.map((row) => ({
    role: row.role as 'user' | 'assistant',
    content: row.content,
  }));
}

// ---------------------------------------------------------------------------
// Typing indicator management
// ---------------------------------------------------------------------------

function startTypingIndicator(
  chatId: number,
  sendFn: (chatId: number, text: string, opts?: Record<string, unknown>) => Promise<void>,
): () => void {
  // Send initial typing action
  // node-telegram-bot-api uses sendChatAction but we only have sendMessage here.
  // The caller should pass a function that can send chat actions.
  // For now, we'll use the interval pattern — the caller wraps sendChatAction.

  const interval = setInterval(() => {
    // This is a best-effort typing indicator refresh.
    // Errors are silently ignored — typing indicators are not critical.
    sendFn(chatId, '', { _action: 'typing' }).catch(() => {});
  }, 4000);

  return () => clearInterval(interval);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleUserMessage(
  userId: number,
  chatId: number,
  text: string,
  sendFn: (chatId: number, text: string, opts?: Record<string, unknown>) => Promise<void>,
  sendPhotosFn: (chatId: number, urls: string[]) => Promise<void>,
): Promise<void> {
  try {
    // 1. Get or create user context
    const context = getOrCreateContext(userId, chatId);

    // 2. Load conversation history from DB
    const history = getConversationHistory(userId);

    // 3. Build messages array — history + current user message
    const messages: MessageParam[] = [
      ...history,
      { role: 'user', content: text },
    ];

    // 4. Save user message to DB
    saveConversationTurn(userId, 'user', text);

    // 5. Start typing indicator
    const stopTyping = startTypingIndicator(chatId, sendFn);

    try {
      // 6. Call Claude with system prompt, tools, and messages
      let response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: TOOL_DEFINITIONS,
        messages,
      });

      // 7. Tool-use loop
      let rounds = 0;
      while (response.stop_reason === 'tool_use' && rounds < MAX_TOOL_ROUNDS) {
        rounds++;

        // Extract tool use blocks from the response
        const toolUseBlocks = response.content.filter(
          (block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use',
        );

        if (toolUseBlocks.length === 0) break;

        // Execute each tool and collect results
        const toolResults: ToolResultBlockParam[] = [];
        for (const toolUse of toolUseBlocks) {
          const result = await executeTool(
            toolUse.name,
            toolUse.input as Record<string, unknown>,
            userId,
            chatId,
            context,
            sendPhotosFn,
          );

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result,
          });
        }

        // Continue the conversation with the tool results
        messages.push({
          role: 'assistant',
          content: response.content as ContentBlockParam[],
        });
        messages.push({
          role: 'user',
          content: toolResults,
        });

        // Call Claude again with the updated messages
        response = await client.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          tools: TOOL_DEFINITIONS,
          messages,
        });
      }

      // 8. Extract final text response
      const textBlocks = response.content.filter(
        (block): block is Anthropic.Messages.TextBlock => block.type === 'text',
      );
      const finalText = textBlocks.map((b) => b.text).join('\n\n');

      if (!finalText) {
        // Edge case: Claude returned only tool calls but hit the round limit
        await sendFn(chatId, 'I processed your request but couldn\'t generate a final response. Please try again.');
        return;
      }

      // 9. Save assistant response to DB
      saveConversationTurn(userId, 'assistant', finalText);

      // 10. Send response to user
      await sendFn(chatId, finalText);
    } finally {
      // Always stop typing indicator
      stopTyping();
    }
  } catch (err) {
    console.error(`[agent] Error handling message from user ${userId}:`, err);

    // Send a user-friendly error message
    try {
      await sendFn(chatId, 'Sorry, something went wrong. Please try again.');
    } catch (sendErr) {
      console.error('[agent] Failed to send error message:', sendErr);
    }
  }
}
