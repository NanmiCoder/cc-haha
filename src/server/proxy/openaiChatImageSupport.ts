import { isUnsupportedImageInputErrorMessage } from '../../services/api/unsupportedImageInput.js'
import type { OpenAIChatImageContentMode } from './transform/anthropicToOpenaiChat.js'
import type { OpenAIChatRequest } from './transform/types.js'

// Image support is learned from the upstream, not predicted from host or model
// names: gateways such as OpenCode Go add vision models faster than any static
// list can follow. Every model starts on the vision path; a model is moved to
// text-only only after its endpoint explicitly rejects image input and the
// same request succeeds without images. The knowledge expires, so a model that
// gains vision support (or a rare misreading) recovers without a restart.
const TEXT_ONLY_TTL_MS = 30 * 60 * 1000
const MAX_TEXT_ONLY_MODELS = 256
const textOnlyModelsUntil = new Map<string, number>()

// Failures about particular images (format, MIME type, size, animation, image
// count, broken data, unreachable URL) also mention images, but the model
// still accepts other images. Learning from them would strip every later image
// for this model, so they surface unchanged; a missed refusal only costs one
// visible error.
const IMAGE_CONTENT_PROBLEM = new RegExp([
  String.raw`\bmime\b`, String.raw`\bformats?\b`, String.raw`\bgif\b`, 'animated', 'image type',
  'multiple images', 'too many images', 'number of images',
  'too large', 'exceed', String.raw`\bsize\b`, 'dimension', 'resolution', 'pixel',
  'corrupt', 'decod', 'base64', 'download', 'fetch', 'could not process', 'unable to process', 'region',
].join('|'), 'i')

function modelKey(endpointUrl: string, model: string): string {
  return `${endpointUrl.replace(/\/+$/, '').toLowerCase()}\n${model.toLowerCase()}`
}

export function getOpenAIChatImageContentMode(
  endpointUrl: string,
  model: string,
  now = Date.now(),
): OpenAIChatImageContentMode {
  const key = modelKey(endpointUrl, model)
  const until = textOnlyModelsUntil.get(key)
  if (until === undefined) return 'vision'
  if (until > now) return 'text_only'
  textOnlyModelsUntil.delete(key)
  return 'vision'
}

export function rememberOpenAIChatTextOnlyModel(endpointUrl: string, model: string, now = Date.now()): void {
  const key = modelKey(endpointUrl, model)
  textOnlyModelsUntil.delete(key)
  if (textOnlyModelsUntil.size >= MAX_TEXT_ONLY_MODELS) {
    const oldest = textOnlyModelsUntil.keys().next().value
    if (oldest !== undefined) textOnlyModelsUntil.delete(oldest)
  }
  textOnlyModelsUntil.set(key, now + TEXT_ONLY_TTL_MS)
}

/**
 * Whether a failed upstream response is the endpoint refusing image input for
 * this model. Only an explicit refusal of a request that actually carried
 * images qualifies: other failures (a bad image, context overflow, 5xx) must
 * surface unchanged instead of silently dropping the user's images.
 */
export function isOpenAIChatImageRejection(
  status: number,
  errorText: string,
  request: OpenAIChatRequest,
): boolean {
  return (
    (status === 400 || status === 422) &&
    requestCarriesImages(request) &&
    isUnsupportedImageInputErrorMessage(errorText) &&
    !IMAGE_CONTENT_PROBLEM.test(errorText)
  )
}

function requestCarriesImages(request: OpenAIChatRequest): boolean {
  return request.messages.some(message =>
    Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))
}

export function resetOpenAIChatImageSupportForTests(): void {
  textOnlyModelsUntil.clear()
}
