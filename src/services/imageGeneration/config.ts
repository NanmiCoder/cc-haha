export const IMAGE_GENERATION_PROVIDER_KIND_ENV_KEY =
  'CC_HAHA_IMAGE_PROVIDER_KIND'
export const IMAGE_GENERATION_PROVIDER_ID_ENV_KEY =
  'CC_HAHA_IMAGE_PROVIDER_ID'
export const IMAGE_GENERATION_BASE_URL_ENV_KEY =
  'CC_HAHA_IMAGE_BASE_URL'
export const IMAGE_GENERATION_API_KEY_ENV_KEY =
  'CC_HAHA_IMAGE_API_KEY'
export const IMAGE_GENERATION_MODEL_ENV_KEY =
  'CC_HAHA_IMAGE_MODEL'
export const IMAGE_GENERATION_PROTOCOL_ENV_KEY =
  'CC_HAHA_IMAGE_PROTOCOL'

export const OPENAI_IMAGE_DEFAULT_MODEL = 'gpt-image-2'
export const GROK_IMAGE_DEFAULT_MODEL = 'grok-imagine-image-quality'

export type ImageGenerationProviderKind =
  | 'openai_oauth'
  | 'grok_oauth'
  | 'openai_images'

export type ImageGenerationProtocol =
  | 'openai_images'
  | 'gemini_native'
  | 'xai_images'

export type ImageGenerationRuntimeConfig = {
  kind: ImageGenerationProviderKind
  providerId: string
  model: string
  baseUrl?: string
  apiKey?: string
  protocol?: ImageGenerationProtocol
}

export function getImageGenerationRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ImageGenerationRuntimeConfig | null {
  const kind = env[IMAGE_GENERATION_PROVIDER_KIND_ENV_KEY]?.trim()
  const providerId = env[IMAGE_GENERATION_PROVIDER_ID_ENV_KEY]?.trim()
  const model = env[IMAGE_GENERATION_MODEL_ENV_KEY]?.trim()

  if (
    !providerId ||
    !model ||
    (kind !== 'openai_oauth' &&
      kind !== 'grok_oauth' &&
      kind !== 'openai_images')
  ) {
    return null
  }

  const baseUrl = env[IMAGE_GENERATION_BASE_URL_ENV_KEY]?.trim()
  const apiKey = env[IMAGE_GENERATION_API_KEY_ENV_KEY]?.trim()
  if (kind === 'openai_images' && (!baseUrl || !apiKey)) {
    return null
  }
  let protocol: ImageGenerationProtocol | undefined
  if (kind === 'openai_images') {
    const configuredProtocol = env[IMAGE_GENERATION_PROTOCOL_ENV_KEY]?.trim() ?? 'openai_images'
    if (configuredProtocol !== 'openai_images' &&
      configuredProtocol !== 'gemini_native' && configuredProtocol !== 'xai_images') {
      return null
    }
    protocol = configuredProtocol
  }

  return {
    kind,
    providerId,
    model,
    ...(protocol ? { protocol } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  }
}
