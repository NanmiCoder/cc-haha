import type { ImageGenerationRuntimeConfig } from '../../services/imageGeneration/config.js'
import { assertGeminiImageAspectRatio } from './aspectRatios.js'
import { assertGeminiImageResolution } from './modelCapabilities.js'
import type { ImageGenerationInput, PreparedInputImage } from './backend.js'

type ProtocolImageInput = ImageGenerationInput & { model: string }

export type ProtocolImageRequest = {
  url: string
  body: Record<string, unknown>
  headers?: Record<string, string>
}

export type ProtocolImage = {
  b64Json?: string
  url?: string
  mimeType?: string
  revisedPrompt?: string
}

export function buildProtocolImageRequests(
  input: ProtocolImageInput,
  config: ImageGenerationRuntimeConfig,
  inputImages: PreparedInputImage[],
): ProtocolImageRequest[] {
  const { baseUrl, apiKey } = config
  if (!baseUrl || !apiKey) {
    throw new Error('The configured image API is missing a Base URL or API key.')
  }
  const protocol = config.protocol
  if (protocol === 'gemini_native') {
    const url = buildGeminiImageUrl(baseUrl, input.model)
    return Array.from({ length: input.count }, () => ({
      url,
      headers: { 'x-goog-api-key': apiKey },
      body: buildGeminiImageRequestBody(input, inputImages),
    }))
  }
  if (protocol === 'xai_images') {
    const operation = inputImages.length > 0 ? 'edits' : 'generations'
    const url = buildImagesProtocolUrl(baseUrl, operation)
    return Array.from({ length: input.count }, () => ({
      url,
      body: inputImages.length > 0
        ? buildXaiEditRequestBody({ ...input, count: 1 }, inputImages)
        : buildXaiRequestBody({ ...input, count: 1 }),
    }))
  }
  throw new Error(`Unsupported image request protocol: ${protocol ?? 'openai_images'}`)
}

export function buildGeminiImageRequestBody(
  input: ProtocolImageInput,
  inputImages: PreparedInputImage[] = [],
): Record<string, unknown> {
  assertGeminiImageResolution(input.model, input.resolution)
  const aspectRatio = input.aspect_ratio ?? aspectRatioForSize(input.size)
  assertGeminiImageAspectRatio(aspectRatio)
  const imageConfig = compactObject({
    aspectRatio: aspectRatio === 'auto' ? undefined : aspectRatio,
    imageSize: input.resolution?.toUpperCase(),
  })
  return {
    contents: [{
      role: 'user',
      parts: [
        { text: input.prompt },
        ...inputImages.map(image => ({
          inlineData: {
            mimeType: image.mimeType,
            data: image.bytes.toString('base64'),
          },
        })),
      ],
    }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      ...(Object.keys(imageConfig).length > 0 ? { imageConfig } : {}),
    },
  }
}

export function buildXaiRequestBody(input: ProtocolImageInput): Record<string, unknown> {
  return compactObject({
    model: input.model,
    prompt: input.prompt,
    n: input.count,
    response_format: 'b64_json',
    aspect_ratio: input.aspect_ratio ?? aspectRatioForSize(input.size),
    resolution: input.resolution,
  })
}

export function buildXaiEditRequestBody(
  input: ProtocolImageInput,
  inputImages: PreparedInputImage[],
): Record<string, unknown> {
  const sources = inputImages.map(image => ({ type: 'image_url', url: image.dataUrl }))
  return {
    ...buildXaiRequestBody(input),
    ...(sources.length === 1 ? { image: sources[0] } : { images: sources }),
  }
}

export function buildGeminiImageUrl(baseUrl: string, model: string): string {
  const url = imageBaseUrl(baseUrl)
  const modelName = model.trim().replace(/^models\//, '')
  if (!modelName) throw new Error('The configured Gemini image model is empty.')
  const pathname = url.pathname.replace(/\/+$/, '')
  const modelAction = /\/models\/.+:(?:generateContent|streamGenerateContent)$/i
  const modelPath = `models/${encodeURIComponent(modelName)}:generateContent`
  if (modelAction.test(pathname)) {
    url.pathname = pathname.replace(modelAction, `/${modelPath}`)
  } else if (/\/models$/i.test(pathname)) {
    url.pathname = `${pathname}/${encodeURIComponent(modelName)}:generateContent`
  } else if (/\/v1(?:beta)?\/openai$/i.test(pathname)) {
    url.pathname = `${pathname.replace(/\/v1(?:beta)?\/openai$/i, '/v1beta')}/${modelPath}`
  } else if (/\/v1(?:beta)?$/i.test(pathname)) {
    // Providers commonly share their OpenAI /v1 base with image settings.
    // sub2api exposes Gemini native models under /v1beta instead.
    url.pathname = `${pathname.replace(/\/v1$/i, '/v1beta')}/${modelPath}`
  } else {
    url.pathname = `${pathname}/v1beta/${modelPath}`
  }
  // This tool requests a complete native JSON response, including image parts.
  if (url.searchParams.get('alt') === 'sse') url.searchParams.delete('alt')
  return url.toString()
}

const OPENAI_BASE64_IMAGE_MODELS = new Set([
  'gpt-image-1',
  'gpt-image-1-mini',
  'gpt-image-1.5',
  'gpt-image-2',
  'gpt-image-2-2026-04-21',
  'gpt-image-2.5-sunburst',
  'gpt-image-2.5-sunburst-2026-09-08',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-flare-2026-09-08',
  'chatgpt-image-latest',
])

// The official GPT image API returns base64 by default and rejects
// response_format. Relays and legacy Images models retain their contract.
export function applyOpenAIImageRequestContract<T extends Record<string, unknown> | FormData>(
  body: T,
  config: ImageGenerationRuntimeConfig,
): T {
  if (config.kind !== 'openai_images'
    || (config.protocol && config.protocol !== 'openai_images')
    || !config.baseUrl
    || !OPENAI_BASE64_IMAGE_MODELS.has(config.model)) {
    return body
  }
  try {
    if (new URL(config.baseUrl).hostname !== 'api.openai.com') return body
  } catch {
    return body
  }
  if (body instanceof FormData) body.delete('response_format')
  else delete body.response_format
  return body
}

export function buildImagesProtocolUrl(
  baseUrl: string,
  operation: 'generations' | 'edits',
): string {
  const url = imageBaseUrl(baseUrl)
  const pathname = url.pathname.replace(/\/+$/, '')
  if (/\/images\/(?:generations|edits)$/i.test(pathname)) {
    url.pathname = pathname.replace(/(?:generations|edits)$/i, operation)
  } else if (/\/images$/i.test(pathname)) {
    url.pathname = `${pathname}/${operation}`
  } else if (/\/(?:v1|v1beta\/openai)$/i.test(pathname)) {
    url.pathname = `${pathname}/images/${operation}`
  } else {
    url.pathname = `${pathname}/v1/images/${operation}`
  }
  return url.toString()
}

export function parseGeminiImageResponse(value: unknown): ProtocolImage[] {
  if (!isRecord(value)) return []
  const response = Array.isArray(value.candidates)
    ? value
    : isRecord(value.response) ? value.response : value
  if (!Array.isArray(response.candidates)) return []
  return response.candidates.flatMap((candidate): ProtocolImage[] => {
    if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) {
      return []
    }
    return candidate.content.parts.flatMap((part): ProtocolImage[] => {
      if (!isRecord(part) || part.thought === true) return []
      const inlineData = isRecord(part.inlineData)
        ? part.inlineData
        : isRecord(part.inline_data) ? part.inline_data : undefined
      if (!inlineData) return []
      const mimeType = stringValue(inlineData.mimeType ?? inlineData.mime_type)?.toLowerCase()
      if (mimeType !== 'image/png' && mimeType !== 'image/jpeg' && mimeType !== 'image/webp') return []
      const b64Json = stringValue(inlineData.data)
      return b64Json ? [{ b64Json, mimeType }] : []
    })
  })
}

function imageBaseUrl(baseUrl: string): URL {
  const url = new URL(baseUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Image API Base URL must use HTTP or HTTPS.')
  }
  return url
}

function aspectRatioForSize(size: ImageGenerationInput['size']): string | undefined {
  if (size === '1024x1024') return '1:1'
  if (size === '1024x1536') return '2:3'
  if (size === '1536x1024') return '3:2'
  return undefined
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
