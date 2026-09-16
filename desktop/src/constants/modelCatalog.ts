import type { ModelInfo } from '../types/settings'

export const OFFICIAL_DEFAULT_MODEL_ID = 'claude-opus-4-8'

export const OFFICIAL_MODELS: ModelInfo[] = [
  {
    id: 'claude-fable-5-1',
    name: 'Fable 5.1',
    description: 'Highest capability for long-running tasks',
    context: '1m',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'claude-fable-5',
    name: 'Fable 5',
    description: 'Highest capability for long-running tasks',
    context: '1m',
  },
  {
    id: 'claude-opus-4-8',
    name: 'Opus 4.8',
    description: 'Best for complex agentic coding and enterprise work',
    context: '1m',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'claude-sonnet-5',
    name: 'Sonnet 5',
    description: 'Best combination of speed and intelligence',
    context: '1m',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Haiku 4.5',
    description: 'Fastest with near-frontier intelligence',
    context: '200k',
  },
]
