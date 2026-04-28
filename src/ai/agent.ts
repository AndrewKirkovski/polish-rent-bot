// Core agent loop — orchestrates Claude API calls, tool execution, and Telegram messaging

import type { MessageParam, ContentBlockParam, ToolResultBlockParam, ToolUseBlock, TextBlock } from '@anthropic-ai/sdk/resources/messages.js';
import { SYSTEM_PROMPT } from './prompts.js';
import { TOOL_DEFINITIONS, executeTool, getOrCreateContext } from './tools.js';
import {
  saveConversation,
  getConversationHistory as getConversationHistoryFromDb,
} from '../storage/db.js';
import { AsyncMutex } from '../utils/mutex.js';
import { createMessageTracked } from './client.js';

// Per-user mutex — prevents concurrent message handling for the same user
const userMutexes = new Map<number, AsyncMutex>();
function getUserMutex(userId: number): AsyncMutex {
  let m = userMutexes.get(userId);
  if (!m) { m = new AsyncMutex(); userMutexes.set(userId, m); }
  return m;
}

// ---------------------------------------------------------------------------
// Anthropic client config
// ---------------------------------------------------------------------------

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = 2048;
const MAX_TOOL_ROUNDS = 10;

// ---------------------------------------------------------------------------
// Conversation history — uses db.ts exports, maps to Claude MessageParam[]
// ---------------------------------------------------------------------------

function saveConversationTurn(userId: number, role: 'user' | 'assistant', content: string): void {
  saveConversation(userId, role, content);
}

function getConversationHistory(userId: number, limit = 20): MessageParam[] {
  const rows = getConversationHistoryFromDb(userId, limit);
  return rows.map((row) => ({
    role: row.role as 'user' | 'assistant',
    content: row.content,
  }));
}

/** Ensure messages alternate user/assistant before sending to Claude — prevents 400 errors */
function sanitizeHistory(history: MessageParam[]): MessageParam[] {
  const result: MessageParam[] = [];
  for (const msg of history) {
    if (result.length === 0 && msg.role !== 'user') continue; // skip leading assistant
    if (result.length > 0 && result[result.length - 1].role === msg.role) continue; // skip consecutive same role
    result.push(msg);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Typing indicator management
// ---------------------------------------------------------------------------

function startTypingIndicator(
  chatId: number,
  typingFn: (chatId: number) => Promise<void>,
): () => void {
  typingFn(chatId).catch(() => {});
  const interval = setInterval(() => {
    typingFn(chatId).catch(() => {});
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
  sendPhotosFn: (chatId: number, urls: string[], caption?: string) => Promise<void>,
  typingFn?: (chatId: number) => Promise<void>,
): Promise<void> {
  // Per-user mutex — if user sends multiple messages quickly, they queue up
  return getUserMutex(userId).run(async () => {
  try {
    // 1. Get or create user context
    const context = getOrCreateContext(userId, chatId);

    // 2. Load conversation history from DB and sanitize to ensure alternation
    let history = sanitizeHistory(getConversationHistory(userId));

    // 3. If history ends with 'user', drop it to prevent consecutive user messages
    if (history.length > 0 && history[history.length - 1].role === 'user') {
      history = history.slice(0, -1);
    }

    // 4. Build messages array — history + current user message
    const messages: MessageParam[] = [
      ...history,
      { role: 'user', content: text },
    ];

    // 4. Start typing indicator (user message saved AFTER successful API call to prevent corruption)
    const noopTyping = async () => {};
    const stopTyping = startTypingIndicator(chatId, typingFn ?? noopTyping);

    try {
      // 6. Call Claude with system prompt, tools, and messages
      // Prompt caching: cache_control on system prompt and last tool definition
      // caches everything up to that point (5-min TTL), saving ~90% input tokens on repeat calls
      const cachedTools = TOOL_DEFINITIONS.map((tool, i) =>
        i === TOOL_DEFINITIONS.length - 1
          ? { ...tool, cache_control: { type: 'ephemeral' as const } }
          : tool,
      );
      let response = await createMessageTracked({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [
          {
            type: 'text' as const,
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' as const },
          },
        ],
        tools: cachedTools,
        messages,
      }, { feature: 'agent_initial', userId }); // client defaults: 120s timeout, 3 retries

      // 7. Tool-use loop
      let rounds = 0;
      while (response.stop_reason === 'tool_use' && rounds < MAX_TOOL_ROUNDS) {
        rounds++;

        // Extract tool use blocks from the response
        const toolUseBlocks = response.content.filter(
          (block): block is ToolUseBlock => block.type === 'tool_use',
        );

        if (toolUseBlocks.length === 0) break;

        // Execute each tool and collect results — pass sendFn and sendPhotosFn
        // so tools can send progress messages and photo albums directly
        const toolResults: ToolResultBlockParam[] = [];
        for (const toolUse of toolUseBlocks) {
          const result = await executeTool(
            toolUse.name,
            toolUse.input as Record<string, unknown>,
            userId,
            chatId,
            context,
            sendFn,
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

        // Call Claude again with the updated messages (reuses cached system + tools)
        response = await createMessageTracked({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: [
            {
              type: 'text' as const,
              text: SYSTEM_PROMPT,
              cache_control: { type: 'ephemeral' as const },
            },
          ],
          tools: cachedTools,
          messages,
        }, { feature: 'agent_tool_loop', userId }); // client defaults: 120s timeout, 3 retries
      }

      // 8. Extract final text response
      const textBlocks = response.content.filter(
        (block): block is TextBlock => block.type === 'text',
      );
      const finalText = textBlocks.map((b) => b.text).join('\n\n');

      if (!finalText) {
        // Edge case: Claude returned only tool calls but hit the round limit
        await sendFn(chatId, 'I processed your request but couldn\'t generate a final response. Please try again.');
        return;
      }

      // 9. Send response to user FIRST — this is the priority
      await sendFn(chatId, finalText);

      // 10. Save conversation to DB — best effort, don't block the user
      try {
        saveConversationTurn(userId, 'user', text);
        saveConversationTurn(userId, 'assistant', finalText);
      } catch (dbErr) {
        console.error('[agent] Failed to save conversation:', dbErr);
      }
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
  }); // getUserMutex.run
}
