// Core agent loop — orchestrates Claude API calls, tool execution, and Telegram messaging

import type { MessageParam, ContentBlockParam, ToolResultBlockParam, ToolUseBlock, TextBlock } from '@anthropic-ai/sdk/resources/messages.js';
import { SYSTEM_PROMPT } from './prompts.js';
import { TOOL_DEFINITIONS, executeTool, getOrCreateContext } from './tools.js';
import {
  saveConversation,
  getConversationHistory as getConversationHistoryFromDb,
  resolveConversationUserId,
} from '../storage/db.js';
import { AsyncMutex } from '../utils/mutex.js';
import { createMessageTracked } from './client.js';

/** One conversation at a time for the whole family. */
const familyMutex = new AsyncMutex();

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = 2048;
const MAX_TOOL_ROUNDS = 10;

function saveConversationTurn(userId: number, role: 'user' | 'assistant', content: string): void {
  saveConversation(resolveConversationUserId(userId), role, content);
}

function getConversationHistory(userId: number, limit = 20): MessageParam[] {
  const rows = getConversationHistoryFromDb(resolveConversationUserId(userId), limit);
  return rows.map((row) => ({
    role: row.role as 'user' | 'assistant',
    content: row.content,
  }));
}

function sanitizeHistory(history: MessageParam[]): MessageParam[] {
  const result: MessageParam[] = [];
  for (const msg of history) {
    if (result.length === 0 && msg.role !== 'user') continue;
    if (result.length > 0 && result[result.length - 1].role === msg.role) continue;
    result.push(msg);
  }
  return result;
}

function startTypingIndicator(
  chatId: number,
  typingFn: (chatId: number) => Promise<void>,
): () => void {
  // Only the asker sees "typing…" — other members shouldn't get a phantom indicator
  // for a search they didn't initiate.
  typingFn(chatId).catch(() => {});
  const interval = setInterval(() => {
    typingFn(chatId).catch(() => {});
  }, 4000);
  return () => clearInterval(interval);
}

export async function handleUserMessage(
  userId: number,
  chatId: number,
  text: string,
  senderName: string,
  sendFn: (chatId: number, text: string, opts?: Record<string, unknown>) => Promise<void>,
  sendPhotosFn: (chatId: number, urls: string[], caption?: string, meta?: { resultId?: string }) => Promise<void>,
  typingFn?: (chatId: number) => Promise<void>,
): Promise<void> {
  return familyMutex.run(async () => {
  try {
    const context = getOrCreateContext(userId, chatId);

    let history = sanitizeHistory(getConversationHistory(userId));

    if (history.length > 0 && history[history.length - 1].role === 'user') {
      history = history.slice(0, -1);
    }

    // Prefix the turn with the speaker's name so the model can attribute follow-ups
    // in the shared family thread. Persisted prefixed too (see saveConversationTurn below).
    const prefixedText = `👤 ${senderName}: ${text}`;
    const messages: MessageParam[] = [
      ...history,
      { role: 'user', content: prefixedText },
    ];

    const noopTyping = async () => {};
    const stopTyping = startTypingIndicator(chatId, typingFn ?? noopTyping);

    try {
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
      }, { feature: 'agent_initial', userId });

      let rounds = 0;
      while (response.stop_reason === 'tool_use' && rounds < MAX_TOOL_ROUNDS) {
        rounds++;

        const toolUseBlocks = response.content.filter(
          (block): block is ToolUseBlock => block.type === 'tool_use',
        );

        if (toolUseBlocks.length === 0) break;

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

        messages.push({
          role: 'assistant',
          content: response.content as ContentBlockParam[],
        });
        messages.push({
          role: 'user',
          content: toolResults,
        });

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
        }, { feature: 'agent_tool_loop', userId });
      }

      const textBlocks = response.content.filter(
        (block): block is TextBlock => block.type === 'text',
      );
      const finalText = textBlocks.map((b) => b.text).join('\n\n');

      if (!finalText) {
        await sendFn(chatId, 'Не удалось сформировать ответ. Попробуйте ещё раз.');
        return;
      }

      await sendFn(chatId, finalText);

      try {
        saveConversationTurn(userId, 'user', prefixedText);
        saveConversationTurn(userId, 'assistant', finalText);
      } catch (dbErr) {
        console.error('[agent] Failed to save conversation:', dbErr);
      }
    } finally {
      stopTyping();
    }
  } catch (err) {
    console.error(`[agent] Error handling message from user ${userId}:`, err);

    try {
      await sendFn(chatId, 'Ошибка. Попробуйте ещё раз.');
    } catch (sendErr) {
      console.error('[agent] Failed to send error message:', sendErr);
    }
  }
  });
}
