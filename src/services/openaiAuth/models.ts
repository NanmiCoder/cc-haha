import { isOpenAIReasoningModel } from '../../shared/modelReasoning.js'

export const OPENAI_DEFAULT_MAIN_MODEL = 'gpt-5.6-sol'
export const OPENAI_DEFAULT_SONNET_MODEL = 'gpt-5.6-terra'
export const OPENAI_DEFAULT_HAIKU_MODEL = 'gpt-5.6-luna'
export const OPENAI_CODEX_EFFECTIVE_CONTEXT_PERCENT = 95
export const OPENAI_CODEX_STANDARD_CONTEXT_WINDOW = 272_000
export const OPENAI_CODEX_FRONTIER_CONTEXT_WINDOW = 372_000
export const OPENAI_CODEX_LARGE_CONTEXT_WINDOW = 1_000_000
export const OPENAI_CODEX_ASTRA_CONTEXT_WINDOW = 1_050_000
export const OPENAI_CODEX_SPARK_CONTEXT_WINDOW = 128_000
export const OPENAI_CODEX_STANDARD_EFFECTIVE_CONTEXT_WINDOW = Math.floor(
  (OPENAI_CODEX_STANDARD_CONTEXT_WINDOW * OPENAI_CODEX_EFFECTIVE_CONTEXT_PERCENT) /
    100,
)
export const OPENAI_CODEX_LARGE_EFFECTIVE_CONTEXT_WINDOW = Math.floor(
  (OPENAI_CODEX_LARGE_CONTEXT_WINDOW * OPENAI_CODEX_EFFECTIVE_CONTEXT_PERCENT) /
    100,
)
export const OPENAI_CODEX_FRONTIER_EFFECTIVE_CONTEXT_WINDOW = Math.floor(
  (OPENAI_CODEX_FRONTIER_CONTEXT_WINDOW * OPENAI_CODEX_EFFECTIVE_CONTEXT_PERCENT) /
    100,
)
export const OPENAI_CODEX_SPARK_EFFECTIVE_CONTEXT_WINDOW = Math.floor(
  (OPENAI_CODEX_SPARK_CONTEXT_WINDOW * OPENAI_CODEX_EFFECTIVE_CONTEXT_PERCENT) /
    100,
)
export const OPENAI_CODEX_ASTRA_EFFECTIVE_CONTEXT_WINDOW = Math.floor(
  (OPENAI_CODEX_ASTRA_CONTEXT_WINDOW * OPENAI_CODEX_EFFECTIVE_CONTEXT_PERCENT) /
    100,
)

export type OpenAIModelCatalogEntry = {
  value: string
  label: string
  description: string
  descriptionForModel?: string
  defaultReasoningEffort: OpenAIReasoningEffort
  supportedReasoningEfforts: OpenAIReasoningEffort[]
  contextWindow?: number
}

export const OPENAI_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type OpenAIReasoningEffort = (typeof OPENAI_REASONING_EFFORTS)[number]

export const OPENAI_CODEX_REASONING_EFFORT_ENV_KEY =
  'CC_HAHA_OPENAI_REASONING_EFFORT'

const GPT_5_6_REASONING_EFFORTS: OpenAIReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

const GPT_5_5_REASONING_EFFORTS: OpenAIReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
]

export const OPENAI_CODEX_MODEL_CATALOG: OpenAIModelCatalogEntry[] = [
  {
    value: OPENAI_DEFAULT_MAIN_MODEL,
    label: 'GPT-5.6-Sol',
    description: 'Latest frontier agentic coding model',
    descriptionForModel: 'GPT-5.6-Sol - latest frontier agentic coding model',
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: GPT_5_6_REASONING_EFFORTS,
    contextWindow: OPENAI_CODEX_FRONTIER_EFFECTIVE_CONTEXT_WINDOW,
  },
  {
    value: OPENAI_DEFAULT_SONNET_MODEL,
    label: 'GPT-5.6-Terra',
    description: 'Balanced agentic coding model for everyday work',
    descriptionForModel: 'GPT-5.6-Terra - balanced agentic coding model',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: GPT_5_6_REASONING_EFFORTS,
    contextWindow: OPENAI_CODEX_FRONTIER_EFFECTIVE_CONTEXT_WINDOW,
  },
  {
    value: OPENAI_DEFAULT_HAIKU_MODEL,
    label: 'GPT-5.6-Luna',
    description: 'Fast and affordable agentic coding model',
    descriptionForModel: 'GPT-5.6-Luna - fast and affordable agentic coding model',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: GPT_5_6_REASONING_EFFORTS,
    contextWindow: OPENAI_CODEX_FRONTIER_EFFECTIVE_CONTEXT_WINDOW,
  },
  {
    value: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
    description: 'Best for coding and agentic work',
    descriptionForModel: 'GPT-5.3 Codex - best for coding and agentic work',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    contextWindow: OPENAI_CODEX_STANDARD_EFFECTIVE_CONTEXT_WINDOW,
  },
  {
    value: 'gpt-5.4',
    label: 'GPT-5.4',
    description: 'Strong general-purpose model',
    descriptionForModel: 'GPT-5.4 - strong general-purpose model',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: GPT_5_5_REASONING_EFFORTS,
    contextWindow: OPENAI_CODEX_LARGE_EFFECTIVE_CONTEXT_WINDOW,
  },
  {
    value: 'gpt-5.5',
    label: 'GPT-5.5',
    description: 'Latest general-purpose model',
    descriptionForModel: 'GPT-5.5 - latest general-purpose model',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: GPT_5_5_REASONING_EFFORTS,
    contextWindow: OPENAI_CODEX_STANDARD_EFFECTIVE_CONTEXT_WINDOW,
  },
  {
    value: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    description: 'Fastest for quick tasks',
    descriptionForModel: 'GPT-5.4 Mini - fastest for quick tasks',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: GPT_5_5_REASONING_EFFORTS,
    contextWindow: OPENAI_CODEX_STANDARD_EFFECTIVE_CONTEXT_WINDOW,
  },
  {
    value: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    description: 'Frontier model for complex reasoning and agentic work',
    descriptionForModel: 'GPT-6 Astra - complex reasoning and agentic work',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    contextWindow: OPENAI_CODEX_ASTRA_EFFECTIVE_CONTEXT_WINDOW,
  },
]

export function isOpenAIReasoningEffort(
  value: unknown,
): value is OpenAIReasoningEffort {
  return (
    typeof value === 'string' &&
    (OPENAI_REASONING_EFFORTS as readonly string[]).includes(value)
  )
}

export function getOpenAIModelCatalogEntry(
  model: string,
  catalog: OpenAIModelCatalogEntry[] = OPENAI_CODEX_MODEL_CATALOG,
): OpenAIModelCatalogEntry | undefined {
  const normalized = model.trim().toLowerCase()
  return catalog.find((entry) => entry.value.toLowerCase() === normalized)
}

export function resolveOpenAIReasoningEffort(
  model: string,
  requestedEffort: unknown,
): OpenAIReasoningEffort {
  return resolveOpenAIReasoningEffortWithPriority(model, [requestedEffort])
}

/**
 * Resolve the first model-supported effort candidate, in priority order.
 * Request-scoped values should come before process/session defaults so
 * concurrent subagents can select different efforts without mutating shared
 * environment state.
 */
export function resolveOpenAIReasoningEffortWithPriority(
  model: string,
  requestedEfforts: readonly unknown[],
): OpenAIReasoningEffort {
  const entry = getOpenAIModelCatalogEntry(model)
  for (const requestedEffort of requestedEfforts) {
    if (
      isOpenAIReasoningEffort(requestedEffort) &&
      (!entry || entry.supportedReasoningEfforts.includes(requestedEffort))
    ) {
      return requestedEffort
    }
  }

  return entry?.defaultReasoningEffort ?? 'medium'
}

export function isOpenAIResponsesModel(model: string): boolean {
  return isOpenAIReasoningModel(model)
}

export function resolveOpenAICodexModel(model: string): string {
  if (process.env.OPENAI_CODEX_MODEL?.trim()) {
    return process.env.OPENAI_CODEX_MODEL.trim()
  }

  const normalized = model.trim().toLowerCase()
  if (isOpenAIResponsesModel(normalized)) {
    return model
  }

  if (normalized.includes('haiku')) {
    return (
      process.env.OPENAI_CODEX_HAIKU_MODEL?.trim() ||
      OPENAI_DEFAULT_HAIKU_MODEL
    )
  }

  if (normalized.includes('sonnet')) {
    return (
      process.env.OPENAI_CODEX_SONNET_MODEL?.trim() ||
      OPENAI_DEFAULT_SONNET_MODEL
    )
  }

  if (normalized.includes('opus')) {
    return (
      process.env.OPENAI_CODEX_OPUS_MODEL?.trim() || OPENAI_DEFAULT_MAIN_MODEL
    )
  }

  return OPENAI_DEFAULT_MAIN_MODEL
}

export function getOpenAIModelDisplayName(model: string): string | null {
  switch (model.trim().toLowerCase()) {
    case 'gpt-6':
    case 'gpt-6-astra':
      return 'GPT-6 Astra'
    case 'gpt-5.3-codex':
      return 'GPT-5.3 Codex'
    case 'gpt-5.6-sol':
      return 'GPT-5.6-Sol'
    case 'gpt-5.6-terra':
      return 'GPT-5.6-Terra'
    case 'gpt-5.6-luna':
      return 'GPT-5.6-Luna'
    case 'gpt-5.3-codex-spark':
      return 'GPT-5.3 Codex Spark'
    case 'gpt-5.5':
      return 'GPT-5.5'
    case 'gpt-5.4':
      return 'GPT-5.4'
    case 'gpt-5.4-mini':
      return 'GPT-5.4 Mini'
    case 'gpt-5.2':
      return 'GPT-5.2'
    case 'gpt-5.2-codex':
      return 'GPT-5.2 Codex'
    case 'gpt-5.1-codex':
      return 'GPT-5.1 Codex'
    case 'gpt-5.1-codex-max':
      return 'GPT-5.1 Codex Max'
    case 'gpt-5.1-codex-mini':
      return 'GPT-5.1 Codex Mini'
    default:
      return null
  }
}

export function getOpenAICodexContextWindowForModel(
  model: string,
): number | null {
  const normalized = model.trim().toLowerCase()

  // Codex OAuth follows the Codex app model catalog, not the public API model
  // context limits. The catalog applies effective_context_window_percent=95,
  // and the runtime /context display reports this effective window.
  if (normalized === 'gpt-6-astra' || normalized === 'gpt-6') {
    return OPENAI_CODEX_ASTRA_EFFECTIVE_CONTEXT_WINDOW
  }

  if (
    normalized === 'gpt-5.6-sol' ||
    normalized === 'gpt-5.6-terra' ||
    normalized === 'gpt-5.6-luna' ||
    normalized === 'gpt-5.6'
  ) {
    return OPENAI_CODEX_FRONTIER_EFFECTIVE_CONTEXT_WINDOW
  }

  if (
    normalized === 'gpt-5.4' ||
    normalized === 'gpt-5.4-pro'
  ) {
    return OPENAI_CODEX_LARGE_EFFECTIVE_CONTEXT_WINDOW
  }

  if (normalized === 'gpt-5.3-codex-spark') {
    return OPENAI_CODEX_SPARK_EFFECTIVE_CONTEXT_WINDOW
  }

  if (
    normalized === 'gpt-5.5' ||
    normalized === 'gpt-5.5-pro' ||
    normalized === 'gpt-5.4-mini' ||
    normalized === 'gpt-5.4-nano' ||
    normalized === 'gpt-5.3-codex' ||
    normalized === 'gpt-5.2' ||
    normalized === 'gpt-5.2-codex' ||
    normalized === 'gpt-5.1' ||
    normalized === 'gpt-5.1-codex' ||
    normalized === 'gpt-5.1-codex-max' ||
    normalized === 'gpt-5.1-codex-mini' ||
    normalized === 'gpt-5-codex' ||
    normalized === 'gpt-5' ||
    normalized === 'gpt-5-mini' ||
    normalized === 'gpt-5-nano'
  ) {
    return OPENAI_CODEX_STANDARD_EFFECTIVE_CONTEXT_WINDOW
  }

  return null
}

export const getOpenAIContextWindowForModel =
  getOpenAICodexContextWindowForModel
