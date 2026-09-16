import type { ImageGenerationRuntimeConfig } from '../../services/imageGeneration/config.js'
import type { ImageGenerationInput, PreparedInputImage } from './backend.js'

export function isApiSmartImageConfig(config: ImageGenerationRuntimeConfig): boolean {
  if (config.kind !== 'openai_images' || !config.baseUrl) return false
  try {
    return new URL(config.baseUrl).hostname === 'gw.apismart.ai'
  } catch {
    return false
  }
}

// ApiSmart's Seedream endpoint accepts URL output and >= 2K dimensions, unlike
// the generic OpenAI Images defaults. Keep this scoped to its documented gateway.
export function buildApiSmartImageBodies(
  input: ImageGenerationInput & { model: string },
  images: PreparedInputImage[],
): Array<Record<string, unknown> | FormData> {
  if (input.output_format === 'webp') {
    throw new Error('ApiSmart image output supports PNG or JPEG. Choose one of those formats.')
  }
  if (input.background === 'transparent') {
    throw new Error('ApiSmart does not document transparent image backgrounds. Use an opaque background.')
  }
  if (images.some(image => image.bytes.byteLength > 10 * 1024 * 1024)) {
    throw new Error('ApiSmart reference images must not exceed 10 MB each.')
  }
  const fields = {
    model: input.model,
    prompt: input.prompt,
    response_format: 'url',
    size: apiSmartSize(input),
    output_format: input.output_format ?? 'png',
  }
  return Array.from({ length: input.count }, () => {
    if (images.length === 0) return { ...fields }
    const form = new FormData()
    for (const [key, value] of Object.entries(fields)) form.set(key, value)
    for (const image of images) {
      form.append('image', new Blob([image.bytes], { type: image.mimeType }), image.fileName)
    }
    return form
  })
}

function apiSmartSize(input: ImageGenerationInput): string {
  const explicitSizes = {
    '1024x1024': '2048x2048',
    '1024x1536': '2048x3072',
    '1536x1024': '3072x2048',
  }
  if (input.size && input.size !== 'auto') return explicitSizes[input.size]
  if (!input.aspect_ratio || input.aspect_ratio === 'auto') return '2K'
  const [width, height] = input.aspect_ratio.split(':').map(Number)
  if (!width || !height || width / height < 1 / 16 || width / height > 16) {
    throw new Error('ApiSmart image aspect ratio must be between 1:16 and 16:1.')
  }
  // Match the requested ratio while staying above the documented 3,686,400
  // pixel minimum; round upwards to ensure the product never falls below it.
  const scale = Math.sqrt(2048 * 2048 / (width * height))
  return `${Math.ceil(width * scale)}x${Math.ceil(height * scale)}`
}
