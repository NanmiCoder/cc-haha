import type { ModelInfo } from '../types/settings'

export const GROK_OFFICIAL_PROVIDER_ID = 'grok-official'
export const GROK_OFFICIAL_DEFAULT_MODEL_ID = 'grok-4.7'
export const GROK_OFFICIAL_PROVIDER_NAME = 'Grok Official'

export const GROK_OFFICIAL_MODELS: ModelInfo[] = [
  {
    id: GROK_OFFICIAL_DEFAULT_MODEL_ID,
    name: 'Grok 4.7',
    description: "SpaceXAI's latest frontier model",
    context: '500000',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['xhigh', 'high', 'medium', 'low'],
  },
  {
    id: 'grok-4.7-build-fast',
    name: 'Grok 4.7 Fast',
    description: 'Fast variant. 2x the price.',
    context: '500000',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['xhigh', 'high', 'medium', 'low'],
  },
  {
    id: 'grok-4.6',
    name: 'Grok 4.6',
    description: 'Grok 4.6 frontier model',
    context: '500000',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['xhigh', 'high', 'medium', 'low'],
  },
  {
    id: 'grok-4.5',
    name: 'Grok 4.5',
    description: 'Grok frontier text model',
    context: '500000',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
  },
]
