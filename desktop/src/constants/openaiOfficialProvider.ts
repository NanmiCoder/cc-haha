import type { ModelInfo } from '../types/settings'
import { GROK_OFFICIAL_PROVIDER_ID } from './grokOfficialProvider'

export const CLAUDE_OFFICIAL_PROVIDER_ID = 'claude-official'
export const OPENAI_OFFICIAL_PROVIDER_ID = 'openai-official'
export const BUILT_IN_PROVIDER_IDS = [
  CLAUDE_OFFICIAL_PROVIDER_ID,
  OPENAI_OFFICIAL_PROVIDER_ID,
  GROK_OFFICIAL_PROVIDER_ID,
] as const
export const OPENAI_OFFICIAL_DEFAULT_MODEL_ID = 'gpt-5.6-sol'
export const OPENAI_OFFICIAL_PROVIDER_NAME = 'ChatGPT Official'

export const OPENAI_OFFICIAL_MODELS: ModelInfo[] = [
  {
    id: OPENAI_OFFICIAL_DEFAULT_MODEL_ID,
    name: 'GPT-5.6-Sol',
    description: 'Latest frontier agentic coding model',
    context: '353400',
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6-Terra',
    description: 'Balanced agentic coding model for everyday work',
    context: '353400',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6-Luna',
    description: 'Fast and affordable agentic coding model',
    context: '353400',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3 Codex',
    description: 'Best for coding and agentic work',
    context: '',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    description: 'Strong general-purpose model',
    context: '',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    description: 'Latest general-purpose model',
    context: '',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    description: 'Fastest for quick tasks',
    context: '',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
  },
]
