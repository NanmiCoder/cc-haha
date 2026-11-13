import {
  API_IMAGE_MAX_BASE64_SIZE,
  API_MANY_IMAGE_MAX_DIMENSION,
  API_MANY_IMAGE_THRESHOLD,
  IMAGE_MAX_WIDTH,
  IMAGE_CONTEXT_TARGET_BYTES,
  IMAGE_REQUEST_BASE64_BUDGET,
} from '../constants/apiLimits.js'
import { logEvent } from '../services/analytics/index.js'
import { getImageProcessor } from '../tools/FileReadTool/imageProcessor.js'
import { logForDebugging } from './debug.js'
import { errorMessage } from './errors.js'
import { formatFileSize } from './format.js'
import { ImageResizeError, optimizeImageForContext, type ImageDimensions } from './imageResizer.js'

/**
 * Information about an oversized image.
 */
export type OversizedImage = {
  index: number
  size: number
}

/**
 * Error thrown when one or more images exceed the API size limit.
 */
export class ImageSizeError extends Error {
  constructor(oversizedImages: OversizedImage[], maxSize: number) {
    let message: string
    const firstImage = oversizedImages[0]
    if (oversizedImages.length === 1 && firstImage) {
      message =
        `Image base64 size (${formatFileSize(firstImage.size)}) exceeds API limit (${formatFileSize(maxSize)}). ` +
        `Please resize the image before sending.`
    } else {
      message =
        `${oversizedImages.length} images exceed the API limit (${formatFileSize(maxSize)}): ` +
        oversizedImages
          .map(img => `Image ${img.index}: ${formatFileSize(img.size)}`)
          .join(', ') +
        `. Please resize these images before sending.`
    }
    super(message)
    this.name = 'ImageSizeError'
  }
}

/**
 * Type guard to check if a block is a base64 image block
 */
function isBase64ImageBlock(
  block: unknown,
): block is { type: 'image'; source: { type: 'base64'; data: string } } {
  if (typeof block !== 'object' || block === null) return false
  const b = block as Record<string, unknown>
  if (b.type !== 'image') return false
  if (typeof b.source !== 'object' || b.source === null) return false
  const source = b.source as Record<string, unknown>
  return source.type === 'base64' && typeof source.data === 'string'
}

/**
 * Validates that all images in messages are within the API size limit.
 * This is a safety net at the API boundary to catch any oversized images
 * that may have slipped through upstream processing.
 *
 * Note: The API's 5MB limit applies to the base64-encoded string length,
 * not the decoded raw bytes.
 *
 * Works with both UserMessage/AssistantMessage types (which have { type, message })
 * and raw MessageParam types (which have { role, content }).
 *
 * @param messages - Array of messages to validate
 * @throws ImageSizeError if any image exceeds the API limit
 */
export function validateImagesForAPI(messages: unknown[]): void {
  const oversizedImages: OversizedImage[] = []
  let imageIndex = 0

  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) continue

    const m = msg as Record<string, unknown>

    // Handle wrapped message format { type: 'user', message: { role, content } }
    // Only check user messages
    if (m.type !== 'user') continue

    const innerMessage = m.message as Record<string, unknown> | undefined
    if (!innerMessage) continue

    const content = innerMessage.content
    if (typeof content === 'string' || !Array.isArray(content)) continue

    for (const block of content) {
      if (isBase64ImageBlock(block)) {
        imageIndex++
        // Check the base64-encoded string length directly (not decoded bytes)
        // The API limit applies to the base64 payload size
        const base64Size = block.source.data.length
        if (base64Size > API_IMAGE_MAX_BASE64_SIZE) {
          logEvent('tengu_image_api_validation_failed', {
            base64_size_bytes: base64Size,
            max_bytes: API_IMAGE_MAX_BASE64_SIZE,
          })
          oversizedImages.push({ index: imageIndex, size: base64Size })
        }
      }
    }
  }

  if (oversizedImages.length > 0) {
    throw new ImageSizeError(oversizedImages, API_IMAGE_MAX_BASE64_SIZE)
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined
}

type NormalizedImage =
  | { data: string; media_type: string; dimensions?: ImageDimensions }
  | { omitted: string }

// Follow only API content containers, never arbitrary JSON inside tool inputs.
function nestedContent(block: Record<string, unknown>): unknown {
  if (block.type === 'tool_result' || block.type === 'mcp_tool_result') return block.content
  const source = asRecord(block.source)
  if (block.type === 'document' && source?.type === 'content') return source.content
}

function isAssistantMessage(value: unknown): boolean {
  const message = asRecord(value)
  return message?.type === 'assistant' || asRecord(message?.message)?.role === 'assistant'
}

function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some(value =>
    ['tool_result', 'mcp_tool_result'].includes(String(asRecord(value)?.type)))
}

// Read the original input, before API normalization merges human and meta/tool
// messages. An input group includes its adjacent attachments, but not tool output.
function currentInputRange(messages: unknown[]): [number, number] {
  const current = messages.findLastIndex(value => {
    const message = asRecord(value)
    if (!message || isAssistantMessage(message) || message.isVirtual) return false
    const attachment = asRecord(message.attachment)
    if (message.type === 'attachment') {
      const origin = asRecord(attachment?.origin)
      return attachment?.type === 'queued_command' && !attachment.isMeta && !attachment.isSynthetic &&
        attachment.commandMode !== 'task-notification' && (!origin || origin.kind === 'human')
    }
    if (message.type !== undefined && message.type !== 'user') return false
    const content = asRecord(message.message)?.content
    return !message.isMeta && message.toolUseResult === undefined && !hasToolResult(content) &&
      (typeof content === 'string' ? content.length > 0 : Array.isArray(content) && content.length > 0)
  })
  if (current < 0) return [-1, -1]
  let start = current
  let end = current + 1
  while (start > 0 && !isAssistantMessage(messages[start - 1])) start--
  while (end < messages.length && !isAssistantMessage(messages[end])) end++
  return [start, end]
}

/** Request-local provenance; no fields are added to messages or transcripts. */
export function createImageInputProtection(messages: unknown[]) {
  const [start, end] = currentInputRange(messages)
  const sources = new Set(start < 0 ? [] : messages.slice(start, end).filter(value => {
    const message = asRecord(value)
    return message?.toolUseResult === undefined && !hasToolResult(asRecord(message?.message)?.content)
  }))
  // Capture the most recent tool-result/input group before filters can remove
  // an assistant and merge it with older history into one API message.
  let recentEnd = messages.length
  while (recentEnd > 0 && isAssistantMessage(messages[recentEnd - 1])) recentEnd--
  let recentStart = recentEnd
  while (recentStart > 0 && !isAssistantMessage(messages[recentStart - 1])) recentStart--
  for (const source of messages.slice(recentStart, recentEnd)) sources.add(source)
  const images = new WeakSet<object>()
  function protect(content: unknown): unknown {
    if (!Array.isArray(content)) return content
    let changed = false
    const result = content.map(value => {
      const block = asRecord(value)
      if (!block) return value
      if (block.type === 'image') {
        // Clone each occurrence: the same object can also occur in old history.
        const image = { ...block }
        images.add(image)
        changed = true
        return image
      }
      const nested = nestedContent(block)
      const next = protect(nested)
      if (next === nested) return value
      changed = true
      return block.type === 'document'
        ? { ...block, source: { ...asRecord(block.source), content: next } }
        : { ...block, content: next }
    })
    return changed ? result : content
  }
  return {
    images,
    mapMessage<T extends { message: { content: unknown } }>(source: unknown, message: T): T {
      if (!sources.has(source)) return message
      const content = protect(message.message.content)
      return content === message.message.content ? message : { ...message, message: { ...message.message, content } }
    },
  }
}

/**
 * Normalize the outbound snapshot after media stripping. Every request must
 * recount history: an image accepted last turn can exceed this turn's limit.
 * Original message/source objects (and persisted transcripts) are never edited.
 * Opaque URL/file sources count too, but their pixels are owned by the provider.
 */
export async function normalizeImagesForAPI<T extends { message: { content: unknown } }>(
  messages: T[],
  options: { countDocuments?: boolean; protectedInputImages?: WeakSet<object> } = {},
): Promise<T[]> {
  let imageCount = 0
  const occurrences = new Map<string, number>()
  let encodedBytes = 0
  let inlineCount = 0
  const sources = new Map<string, string>()
  function count(content: unknown): void {
    if (!Array.isArray(content)) return
    for (const value of content) {
      const block = asRecord(value)
      if (!block) continue
      if (block.type === 'tool_use' && block.name === 'Read' && typeof block.id === 'string') {
        const path = asRecord(block.input)?.file_path
        if (typeof path === 'string') sources.set(block.id, path)
      }
      if (block.type === 'image' || (options.countDocuments && block.type === 'document')) imageCount++
      if (isBase64ImageBlock(block)) {
        const data = block.source.data
        occurrences.set(data, (occurrences.get(data) ?? 0) + 1)
        encodedBytes += data.length
        inlineCount++
      }
      count(nestedContent(block))
    }
  }
  for (const message of messages) count(message.message.content)
  if (imageCount === 0) return messages
  const dimensionLimit = imageCount > API_MANY_IMAGE_THRESHOLD
    ? API_MANY_IMAGE_MAX_DIMENSION : IMAGE_MAX_WIDTH
  // Repeated payloads share encoding work, but consume bytes on every occurrence.
  const targetBytes = encodedBytes > IMAGE_REQUEST_BASE64_BUDGET
    ? Math.min(IMAGE_CONTEXT_TARGET_BYTES, Math.floor(IMAGE_REQUEST_BASE64_BUDGET / 4 / inlineCount) * 3)
    : IMAGE_CONTEXT_TARGET_BYTES
  // The newest input group can contain several user/attachment/tool-result
  // messages. Preserve all of it, including every image in a multi-image turn.
  let lastInput = messages.length - 1
  while (lastInput >= 0 && isAssistantMessage(messages[lastInput])) lastInput--
  let protectedStart = lastInput
  while (protectedStart > 0 && !isAssistantMessage(messages[protectedStart - 1])) protectedStart--
  // Callers that merge messages supply block provenance captured before merging.
  const [currentStart, currentEnd] = options.protectedInputImages ? [-1, -1] : currentInputRange(messages)
  // Bound concurrency and reuse identical payloads only within this request.
  // A cross-request cache would need the count-dependent dimension limit too.
  const resized = new Map<string, NormalizedImage>()
  async function normalizeImage(data: string): Promise<NormalizedImage> {
    const buffer = Buffer.from(data, 'base64')
    try {
      const result = await optimizeImageForContext(
        buffer, buffer.length, '', dimensionLimit, targetBytes,
      )
      let dimensions = result.dimensions
      if (result.buffer !== buffer) {
        // fit:inside can encode fewer pixels than its rounded target box.
        // Coordinate notes and the final cap must use the actual output.
        const processor = await getImageProcessor({ requireAutoOrient: true })
        const { width, height } = await processor(result.buffer).metadata()
        if (!width || !height || width > dimensionLimit || height > dimensionLimit) {
          throw new ImageResizeError('Resized image does not meet the request dimension limit')
        }
        dimensions = { ...dimensions, displayWidth: width, displayHeight: height }
      }
      return {
        data: result.buffer === buffer ? data : result.buffer.toString('base64'),
        media_type: `image/${result.mediaType}`,
        dimensions,
      }
    } catch (error) {
      // History is immutable and replayed into every request, so one image that
      // cannot be made compliant would fail this turn and every later one. It is
      // still never sent unverified: the model gets a note in its place.
      const reason = errorMessage(error)
      logForDebugging(`Omitting an image from the API request: ${reason}`, { level: 'warn' })
      return { omitted: `[Image omitted from this request: ${reason}]` }
    }
  }
  let optimizedBytes = 0
  for (const [data, count] of occurrences) {
    const image = await normalizeImage(data)
    resized.set(data, image)
    if (!('omitted' in image)) optimizedBytes += image.data.length * count
  }
  let excessBytes = optimizedBytes - IMAGE_REQUEST_BASE64_BUDGET
  async function normalize(content: unknown, protectedInput: boolean, sourcePath?: string): Promise<unknown> {
    if (!Array.isArray(content)) return content
    let changed = false
    const result: unknown[] = []
    for (const value of content) {
      const block = asRecord(value)
      let next = value
      if (block && isBase64ImageBlock(block)) {
        const data = block.source.data
        let image = resized.get(data)!
        if (!('omitted' in image) && !protectedInput && !options.protectedInputImages?.has(block) && excessBytes > 0) {
          excessBytes -= image.data.length
          image = { omitted: '[Image omitted from this request to keep older image data within the context budget.' +
            (sourcePath ? ` Original source: ${JSON.stringify(sourcePath)}.` : '') +
            ' Read the original image again if needed.]' }
        }
        if ('omitted' in image) {
          next = { type: 'text', text: image.omitted,
            ...(block.cache_control ? { cache_control: block.cache_control } : {}) }
        } else if (image.data !== data || asRecord(block.source)?.media_type !== image.media_type) {
          next = { ...block, source: { ...block.source, data: image.data, media_type: image.media_type } }
          if (options.protectedInputImages?.has(block)) options.protectedInputImages.add(next as object)
        }
        const dims = 'omitted' in image ? undefined : image.dimensions
        if (dims?.originalWidth && dims.originalHeight && dims.displayWidth && dims.displayHeight &&
          (dims.originalWidth !== dims.displayWidth || dims.originalHeight !== dims.displayHeight)) {
          // Keep the current grid tied to this exact image, including tools with
          // their own coordinate units or older separately stored image notes.
          result.push({ type: 'text', text:
            `[Image resized for this request: ${dims.displayWidth}x${dims.displayHeight} pixels. ` +
            `Before request resizing: ${dims.originalWidth}x${dims.originalHeight} pixels. ` +
            `Instructions referring to the earlier ${dims.originalWidth}x${dims.originalHeight} grid require multiplying x by ${(dims.originalWidth / dims.displayWidth).toFixed(4)} ` +
            `and y by ${(dims.originalHeight / dims.displayHeight).toFixed(4)} before applying that grid's mapping. ` +
            `Instructions already using the current ${dims.displayWidth}x${dims.displayHeight} grid need no extra scaling. Preserve the tool's action coordinate units. ` +
            `This image's current pixel bounds are (0,0) to (${dims.displayWidth - 1},${dims.displayHeight - 1}).]`,
          })
          changed = true
        }
      } else if (block) {
        const nested = nestedContent(block)
        const hint = typeof block.tool_use_id === 'string' ? sources.get(block.tool_use_id) : undefined
        const normalized = await normalize(nested, protectedInput, hint ?? sourcePath)
        if (normalized !== nested) {
          next = block.type === 'document'
            ? { ...block, source: { ...asRecord(block.source), content: normalized } }
            : { ...block, content: normalized }
        }
      }
      changed ||= next !== value
      result.push(next)
    }
    return changed ? result : content
  }
  const result: T[] = []
  for (const [index, message] of messages.entries()) {
    const content = await normalize(message.message.content,
      !options.protectedInputImages &&
        (index >= protectedStart || (currentStart >= 0 && index >= currentStart && index < currentEnd)))
    result.push(content === message.message.content ? message
      : { ...message, message: { ...message.message, content } })
  }
  // Earlier versions persisted free-standing Image notes with no source ID.
  // Only rewrite their exact generated format when the old grid has one
  // unambiguous new grid; otherwise identify it as the earlier mapping.
  const grids = new Map<string, Set<string>>()
  for (const image of resized.values()) {
    const d = 'omitted' in image ? undefined : image.dimensions
    if (!d?.originalWidth || !d.originalHeight || !d.displayWidth || !d.displayHeight) continue
    const key = `${d.originalWidth}x${d.originalHeight}`
    if (!grids.has(key)) grids.set(key, new Set())
    grids.get(key)!.add(`${d.displayWidth}x${d.displayHeight}`)
  }
  function updateText(text: string): string {
    return text.replace(
      /\[Image: ((?:source: [^\n]*?, )?)original (\d+)x(\d+), displayed at (\d+)x(\d+)\. Multiply coordinates by [\d.]+ to map to original image\.\]/g,
      (note, source, originalWidth, originalHeight, width, height) => {
        const targets = grids.get(`${width}x${height}`)
        if (!targets || (targets.size === 1 && targets.has(`${width}x${height}`))) return note
        if (targets.size !== 1) return note.replace('[Image:', '[Image before request resizing:')
        const [newWidth, newHeight] = [...targets][0]!.split('x').map(Number)
        return `[Image: ${source}original ${originalWidth}x${originalHeight}, displayed at ${newWidth}x${newHeight}. ` +
          `Multiply coordinates by ${(Number(originalWidth) / newWidth!).toFixed(2)} to map to original image.]`
      },
    )
  }
  function updateNotes(content: unknown): unknown {
    if (typeof content === 'string') return updateText(content)
    if (!Array.isArray(content)) return content
    let changed = false
    const updated = content.map(value => {
      const block = asRecord(value)
      if (!block) return value
      if (block.type === 'text' && typeof block.text === 'string') {
        const text = updateText(block.text)
        if (text === block.text) return value
        changed = true
        return { ...block, text }
      }
      const nested = nestedContent(block)
      const next = updateNotes(nested)
      if (next === nested) return value
      changed = true
      return block.type === 'document'
        ? { ...block, source: { ...asRecord(block.source), content: next } }
        : { ...block, content: next }
    })
    return changed ? updated : content
  }
  return result.map(message => {
    const content = updateNotes(message.message.content)
    return content === message.message.content ? message
      : { ...message, message: { ...message.message, content } }
  })
}
