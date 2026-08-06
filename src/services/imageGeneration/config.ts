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

export const OPENAI_IMAGE_DEFAULT_MODEL = 'gpt-image-2'
export const GROK_IMAGE_DEFAULT_MODEL = 'grok-imagine-image-quality'

export type ImageGenerationProviderKind =
  | 'openai_oauth'
  | 'grok_oauth'
  | 'openai_images'

export type ImageGenerationRuntimeConfig = {
  kind: ImageGenerationProviderKind
  providerId: string
  model: string
  baseUrl?: string
  apiKey?: string
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

  return {
    kind,
    providerId,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  }
}
