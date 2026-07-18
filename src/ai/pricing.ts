// Anthropic API pricing — USD per million tokens.
// Verified 2026-04-28 against platform.claude.com/docs/en/docs/about-claude/pricing.
// Update the table when prices change; calculateCost is the only consumer.

import type Anthropic from '@anthropic-ai/sdk';

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWrite5mPerMTok: number;
  cacheWrite1hPerMTok: number;
  cacheReadPerMTok: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-6': {
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    cacheWrite5mPerMTok: 3.75,
    cacheWrite1hPerMTok: 6.0,
    cacheReadPerMTok: 0.3,
  },
  'claude-sonnet-4-5': {
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    cacheWrite5mPerMTok: 3.75,
    cacheWrite1hPerMTok: 6.0,
    cacheReadPerMTok: 0.3,
  },
  'claude-opus-4-7': {
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
    cacheWrite5mPerMTok: 6.25,
    cacheWrite1hPerMTok: 10.0,
    cacheReadPerMTok: 0.5,
  },
  'claude-opus-4-6': {
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
    cacheWrite5mPerMTok: 6.25,
    cacheWrite1hPerMTok: 10.0,
    cacheReadPerMTok: 0.5,
  },
  'claude-haiku-4-5': {
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
    cacheWrite5mPerMTok: 1.25,
    cacheWrite1hPerMTok: 2.0,
    cacheReadPerMTok: 0.1,
  },
};

export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export function extractUsage(usage: Anthropic.Usage | undefined | null): UsageBreakdown {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
  };
}

const warnedModels = new Set<string>();

export function calculateCost(model: string, usage: UsageBreakdown): number {
  // The API returns dated model IDs (e.g. claude-haiku-4-5-20251001) while the table is
  // keyed by the alias — fall back to the date-stripped base so pricing still resolves.
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING[model.replace(/-\d{8}$/, '')];
  if (!pricing) {
    if (!warnedModels.has(model)) {
      console.warn(`[pricing] No pricing entry for model "${model}" — cost will be 0. Update src/ai/pricing.ts.`);
      warnedModels.add(model);
    }
    return 0;
  }
  const PER_M = 1_000_000;
  return (
    (usage.inputTokens * pricing.inputPerMTok) / PER_M +
    (usage.outputTokens * pricing.outputPerMTok) / PER_M +
    (usage.cacheCreationTokens * pricing.cacheWrite5mPerMTok) / PER_M +
    (usage.cacheReadTokens * pricing.cacheReadPerMTok) / PER_M
  );
}
