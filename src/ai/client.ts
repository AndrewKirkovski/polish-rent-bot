// Singleton Anthropic client with usage tracking.
// All messages.create calls in the codebase should go through createMessageTracked
// so token counts, cost, and cache hits land in the ai_usage table.

import Anthropic from '@anthropic-ai/sdk';
import { insertAiUsage } from '../storage/db.js';
import { calculateCost, extractUsage } from './pricing.js';

export type Feature =
  | 'agent_initial'
  | 'agent_tool_loop'
  | 'parse_rental'
  | 'parse_item'
  | 'rejection_eval'
  | 'triage_rental';

export interface CallContext {
  feature: Feature;
  userId?: number;
  monitorId?: number;
}

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      maxRetries: 3,
      timeout: 120_000,
    });
  }
  return _client;
}

export async function createMessageTracked(
  params: Anthropic.MessageCreateParamsNonStreaming,
  ctx: CallContext,
  options?: Anthropic.RequestOptions,
): Promise<Anthropic.Message> {
  const startedAt = Date.now();
  try {
    const response = options
      ? await getClient().messages.create(params, options)
      : await getClient().messages.create(params);
    const durationMs = Date.now() - startedAt;
    const usage = extractUsage(response.usage);
    const cost = calculateCost(response.model ?? params.model, usage);
    safeInsert({
      feature: ctx.feature,
      model: response.model ?? params.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      cacheReadTokens: usage.cacheReadTokens,
      costUsd: cost,
      localCacheHit: 0,
      durationMs,
      monitorId: ctx.monitorId ?? null,
      userId: ctx.userId ?? null,
      errorMessage: null,
    });
    return response;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    safeInsert({
      feature: ctx.feature,
      model: params.model,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      localCacheHit: 0,
      durationMs,
      monitorId: ctx.monitorId ?? null,
      userId: ctx.userId ?? null,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export function recordLocalCacheHit(ctx: CallContext, model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'): void {
  safeInsert({
    feature: ctx.feature,
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    localCacheHit: 1,
    durationMs: 0,
    monitorId: ctx.monitorId ?? null,
    userId: ctx.userId ?? null,
    errorMessage: null,
  });
}

function safeInsert(row: Parameters<typeof insertAiUsage>[0]): void {
  try {
    insertAiUsage(row);
  } catch (err) {
    console.error('[ai/client] insertAiUsage failed (telemetry only):', err instanceof Error ? err.message : err);
  }
}
