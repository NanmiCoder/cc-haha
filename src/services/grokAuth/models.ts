export const GROK_DEFAULT_MAIN_MODEL = 'grok-4.5'
export const GROK_DEFAULT_SONNET_MODEL = GROK_DEFAULT_MAIN_MODEL
export const GROK_DEFAULT_HAIKU_MODEL = GROK_DEFAULT_MAIN_MODEL
export const GROK_DEFAULT_MODEL = GROK_DEFAULT_MAIN_MODEL
export const GROK_DEFAULT_CONTEXT_WINDOW = 500_000

export type GrokModelCatalogEntry = {
  value: string
  label: string
  description: string
  contextWindow?: number
  source?: 'official' | 'cli'
  supportsReasoningEffort?: boolean
  reasoningEffort?: string
  reasoningEfforts?: string[]
}

export const GROK_MODEL_CATALOG: GrokModelCatalogEntry[] = [
  {
    ...model('grok-4.5', 'Grok 4.5', 'Grok frontier text model', 500_000),
    supportsReasoningEffort: true,
    reasoningEffort: 'high',
    reasoningEfforts: ['high', 'medium', 'low'],
  },
  {
    ...model('grok-composer-2.5-fast', 'Composer 2.5', 'Grok coding model', 200_000),
    supportsReasoningEffort: false,
  },
]

function model(
  value: string,
  label: string,
  description: string,
  contextWindow: number,
  source: 'official' | 'cli' = 'official',
): GrokModelCatalogEntry {
  return { value, label, description, contextWindow, source }
}

const EXPLICIT_MODELS = new Set(GROK_MODEL_CATALOG.map((entry) => entry.value))

export function resolveGrokModel(modelId: string): string {
  const normalized = modelId.trim().toLowerCase()
  return EXPLICIT_MODELS.has(normalized) ? normalized : GROK_DEFAULT_MAIN_MODEL
}

export function getGrokContextWindowForModel(modelId: string): number | null {
  const resolved = resolveGrokModel(modelId)
  return GROK_MODEL_CATALOG.find((model) => model.value === resolved)?.contextWindow ?? null
}

export function grokModelRejectsReasoningEffort(modelId: string): boolean {
  const resolved = resolveGrokModel(modelId)
  return resolved === 'grok-composer-2.5-fast'
}
