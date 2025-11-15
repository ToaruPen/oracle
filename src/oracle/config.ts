import { countTokens as countTokensGpt5 } from 'gpt-tokenizer/model/gpt-5';
import { countTokens as countTokensGpt5Pro } from 'gpt-tokenizer/model/gpt-5-pro';
import type { ModelConfig, ModelName, TokenizerFn } from './types.js';

export const MODEL_CONFIGS: Record<ModelName, ModelConfig> = {
  'gpt-5-pro': {
    model: 'gpt-5-pro',
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: 196000,
    pricing: {
      inputPerToken: 15 / 1_000_000,
      outputPerToken: 120 / 1_000_000,
    },
    reasoning: null,
  },
  'gpt-5.1': {
    model: 'gpt-5.1',
    tokenizer: countTokensGpt5 as TokenizerFn,
    inputLimit: 196000,
    pricing: {
      inputPerToken: 1.25 / 1_000_000,
      outputPerToken: 10 / 1_000_000,
    },
    reasoning: { effort: 'high' },
  },
};

export const DEFAULT_SYSTEM_PROMPT = [
  'You are Oracle, a focused one-shot problem solver.',
  'Emphasize direct answers, cite any files referenced, and clearly note when the search tool was used.',
].join(' ');

export const TOKENIZER_OPTIONS = { allowedSpecial: 'all' } as const;
