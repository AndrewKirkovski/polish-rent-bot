// Conversation history management for per-user chat context
// Wraps the storage layer functions for conversation persistence

import {
  saveConversation,
  getConversationHistory as dbGetHistory,
  clearConversation,
} from '../storage/db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ---------------------------------------------------------------------------
// saveConversationTurn
// ---------------------------------------------------------------------------

export function saveConversationTurn(
  userId: number,
  userText: string,
  assistantText: string,
  _toolCalls?: string,
): void {
  // Save user message, then assistant response
  saveConversation(userId, 'user', userText);
  saveConversation(userId, 'assistant', assistantText);
}

// ---------------------------------------------------------------------------
// getConversationHistory
// ---------------------------------------------------------------------------

export function getConversationHistory(
  userId: number,
  limit: number = 20,
): ConversationMessage[] {
  const rows = dbGetHistory(userId, limit);
  return rows.map((row) => ({
    role: row.role as 'user' | 'assistant',
    content: row.content,
  }));
}

// ---------------------------------------------------------------------------
// clearConversationHistory
// ---------------------------------------------------------------------------

export function clearConversationHistory(userId: number): void {
  clearConversation(userId);
}
