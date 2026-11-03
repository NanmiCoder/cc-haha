import type { AssistantMessage, UserMessage } from '../../types/message.js'
import { replaceMediaWithPlaceholders } from '../../utils/messages.js'

// Image support is learned from the upstream, as the OpenAI Chat proxy does
// (server/proxy/openaiChatImageSupport.ts), not predicted from model names.
// Every model starts on the vision path. A model moves to text-only only after
// a request it refused succeeds once its images are replaced, so a rejection
// that merely happened to carry images (a malformed history block, a schema
// error) never strips them. The knowledge expires, so a model that gains vision
// support, or a rare misreading, recovers without a restart.
const TEXT_ONLY_TTL_MS = 30 * 60 * 1000
const MAX_TEXT_ONLY_MODELS = 256
const textOnlyModelsUntil = new Map<string, number>()

const OMITTED_IMAGE_TEXT =
  '[Image omitted: the upstream rejected image input for this model.]'

export function isTextOnlyImageModel(model: string, now = Date.now()): boolean {
  const key = model.toLowerCase()
  const until = textOnlyModelsUntil.get(key)
  if (until === undefined) return false
  if (until > now) return true
  textOnlyModelsUntil.delete(key)
  return false
}

export function rememberTextOnlyImageModel(model: string, now = Date.now()): void {
  const key = model.toLowerCase()
  textOnlyModelsUntil.delete(key)
  if (textOnlyModelsUntil.size >= MAX_TEXT_ONLY_MODELS) {
    const oldest = textOnlyModelsUntil.keys().next().value
    if (oldest !== undefined) textOnlyModelsUntil.delete(oldest)
  }
  textOnlyModelsUntil.set(key, now + TEXT_ONLY_TTL_MS)
}

/** Returns the same array when the request carries no images. */
export function replaceImagesForTextOnlyModel(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  let changed = false
  const result = messages.map(message => {
    if (message.type !== 'user') return message
    const replaced = replaceMediaWithPlaceholders(message, {
      image: OMITTED_IMAGE_TEXT,
    })
    if (replaced !== message) changed = true
    return replaced
  })
  return changed ? result : messages
}

export function resetImageInputRefusalsForTests(): void {
  textOnlyModelsUntil.clear()
}
