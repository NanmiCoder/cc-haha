import {
  API_IMAGE_MAX_BASE64_SIZE,
  API_MANY_IMAGE_MAX_DIMENSION,
  API_MANY_IMAGE_THRESHOLD,
  IMAGE_MAX_WIDTH,
} from '../constants/apiLimits.js'
import { logEvent } from '../services/analytics/index.js'
import { getImageProcessor } from '../tools/FileReadTool/imageProcessor.js'
import { formatFileSize } from './format.js'
import { ImageResizeError, maybeResizeAndDownsampleImageBuffer, type ImageDimensions } from './imageResizer.js'

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

// Follow only API content containers, never arbitrary JSON inside tool inputs.
function nestedContent(block: Record<string, unknown>): unknown {
  if (block.type === 'tool_result' || block.type === 'mcp_tool_result') return block.content
  const source = asRecord(block.source)
  if (block.type === 'document' && source?.type === 'content') return source.content
}

/**
 * Normalize the outbound snapshot after media stripping. Every request must
 * recount history: an image accepted last turn can exceed this turn's limit.
 * Original message/source objects (and persisted transcripts) are never edited.
 * Opaque URL/file sources count too, but their pixels are owned by the provider.
 */
export async function normalizeImagesForAPI<T extends { message: { content: unknown } }>(
  messages: T[],
  options: { countDocuments?: boolean } = {},
): Promise<T[]> {
  let imageCount = 0
  function count(content: unknown): void {
    if (!Array.isArray(content)) return
    for (const value of content) {
      const block = asRecord(value)
      if (!block) continue
      if (block.type === 'image' || (options.countDocuments && block.type === 'document')) imageCount++
      count(nestedContent(block))
    }
  }
  for (const message of messages) count(message.message.content)
  if (imageCount === 0) return messages
  const dimensionLimit = imageCount > API_MANY_IMAGE_THRESHOLD
    ? API_MANY_IMAGE_MAX_DIMENSION : IMAGE_MAX_WIDTH
  // Bound concurrency and reuse identical payloads only within this request.
  // A cross-request cache would need the count-dependent dimension limit too.
  const resized = new Map<string, { data: string; media_type: string; dimensions?: ImageDimensions }>()
  async function normalize(content: unknown): Promise<unknown> {
    if (!Array.isArray(content)) return content
    let changed = false
    const result: unknown[] = []
    for (const value of content) {
      const block = asRecord(value)
      let next = value
      if (block && isBase64ImageBlock(block)) {
        const data = block.source.data
        let image = resized.get(data)
        if (!image) {
          const buffer = Buffer.from(data, 'base64')
          const result = await maybeResizeAndDownsampleImageBuffer(
            buffer, buffer.length, '', dimensionLimit,
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
          image = {
            data: result.buffer === buffer ? data : result.buffer.toString('base64'),
            media_type: `image/${result.mediaType}`,
            dimensions,
          }
          resized.set(data, image)
        }
        if (image.data !== data || asRecord(block.source)?.media_type !== image.media_type) {
          next = { ...block, source: { ...block.source, data: image.data, media_type: image.media_type } }
        }
        const dims = image.dimensions
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
        const normalized = await normalize(nested)
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
  for (const message of messages) {
    const content = await normalize(message.message.content)
    result.push(content === message.message.content ? message
      : { ...message, message: { ...message.message, content } })
  }
  // Earlier versions persisted free-standing Image notes with no source ID.
  // Only rewrite their exact generated format when the old grid has one
  // unambiguous new grid; otherwise identify it as the earlier mapping.
  const grids = new Map<string, Set<string>>()
  for (const image of resized.values()) {
    const d = image.dimensions
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
