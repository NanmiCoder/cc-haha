import type { ModelInfo } from '../types/settings'

export const GROK_OFFICIAL_PROVIDER_ID = 'grok-official'
export const GROK_OFFICIAL_DEFAULT_MODEL_ID = 'grok-4.5'
export const GROK_OFFICIAL_PROVIDER_NAME = 'Grok Official'

export const GROK_OFFICIAL_MODELS: ModelInfo[] = [
  {
    id: GROK_OFFICIAL_DEFAULT_MODEL_ID,
    name: 'Grok 4.5',
    description: 'Grok frontier text model',
    context: '500000',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'grok-composer-2.5-fast',
    name: 'Composer 2.5',
    description: 'Grok coding model',
    context: '200000',
    supportedReasoningEfforts: [],
  },
]
