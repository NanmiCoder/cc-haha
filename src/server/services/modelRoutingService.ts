export type ModelRouting = {
  main: string
  haiku: string
  sonnet: string
  opus: string
  smallFast: string
}

type PartialRoutingInput = Record<string, unknown> | Partial<ModelRouting> | null | undefined

function readString(
  input: PartialRoutingInput,
  keys: string[],
): string | undefined {
  if (!input || typeof input !== 'object') return undefined

  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return undefined
}

export function normalizeModelRouting(
  input: PartialRoutingInput,
  fallbackMain: string,
): ModelRouting {
  const main = readString(input, ['main', 'mainModel', 'model', 'modelId']) || fallbackMain
  const haiku = readString(input, ['haiku', 'haikuModel']) || main
  const sonnet = readString(input, ['sonnet', 'sonnetModel']) || main
  const opus = readString(input, ['opus', 'opusModel']) || main
  const smallFast = readString(input, [
    'smallFast',
    'small_fast',
    'smallFastModel',
    'small_fast_model',
  ]) || haiku || main

  return {
    main,
    haiku: haiku || main,
    sonnet: sonnet || main,
    opus: opus || main,
    smallFast: smallFast || haiku || main,
  }
}

export function routingFromProviderModels(models: {
  main: string
  haiku: string
  sonnet: string
  opus: string
}): ModelRouting {
  return normalizeModelRouting(
    {
      main: models.main,
      haiku: models.haiku,
      sonnet: models.sonnet,
      opus: models.opus,
      smallFast: models.haiku,
    },
    models.main,
  )
}

export function toModelEnv(routing: ModelRouting): Record<string, string> {
  return {
    ANTHROPIC_MODEL: routing.main,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: routing.haiku,
    ANTHROPIC_DEFAULT_SONNET_MODEL: routing.sonnet,
    ANTHROPIC_DEFAULT_OPUS_MODEL: routing.opus,
    ANTHROPIC_SMALL_FAST_MODEL: routing.smallFast,
  }
}

export function modelEnvMatches(
  env: Record<string, string | undefined>,
  routing: ModelRouting,
): boolean {
  const expected = toModelEnv(routing)
  return Object.entries(expected).every(([key, value]) => env[key] === value)
}
