/**
 * Last-mile preparation of base64 image blocks in an outgoing request.
 *
 * 1. Bytes that carry no image signature are replaced with a text note instead
 *    of going out as an image block. Once such a block sits in history every
 *    later request fails with the same decode error; an HTML error page saved
 *    as .png is the typical case.
 * 2. When the request carries more than API_MANY_IMAGE_THRESHOLD image blocks
 *    (earlier turns and tool_result images included), the API limits every
 *    image to API_MANY_IMAGE_MAX_DIMENSION px per side and rejects the request
 *    otherwise. Larger images are downscaled to fit, as Codex does before
 *    upload, instead of asking the user to start a new session.
 *
 * Persisted messages never change; only the disposable request copy does.
 * Results are cached by content hash because history is resent every turn.
 */
import { createHash } from 'node:crypto'
import {
  API_MANY_IMAGE_MAX_DIMENSION,
  API_MANY_IMAGE_THRESHOLD,
} from '../../constants/apiLimits.js'
import { getImageProcessor } from '../../tools/FileReadTool/imageProcessor.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  detectImageFormatFromBufferOrNull,
  type ImageMediaType,
} from '../../utils/imageResizer.js'

export const INVALID_IMAGE_PLACEHOLDER =
  '[image omitted: the data is not a valid image (corrupted, truncated, or not an image file)]'

type Base64ImageBlock = {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}

type MessageLike = { type: string; message: { content: unknown } }

type PreparedImage =
  | { kind: 'invalid' }
  | { kind: 'keep' }
  | { kind: 'resized'; mediaType: ImageMediaType; data: string }

const PREPARED_IMAGE_CACHE_LIMIT = 256
const preparedImages = new Map<string, PreparedImage>()

function isBase64ImageBlock(block: unknown): block is Base64ImageBlock {
  if (!block || typeof block !== 'object') return false
  const candidate = block as {
    type?: unknown
    source?: { type?: unknown; data?: unknown }
  }
  return (
    candidate.type === 'image' &&
    candidate.source?.type === 'base64' &&
    typeof candidate.source.data === 'string'
  )
}

function isToolResultWithContent(
  block: unknown,
): block is { type: 'tool_result'; content: unknown[] } {
  return (
    !!block &&
    typeof block === 'object' &&
    (block as { type?: unknown }).type === 'tool_result' &&
    Array.isArray((block as { content?: unknown }).content)
  )
}

function collectBase64ImageBlocks(messages: MessageLike[]): Base64ImageBlock[] {
  const blocks: Base64ImageBlock[] = []
  for (const msg of messages) {
    // Only user messages carry media; assistant messages hold text, tool_use
    // and thinking blocks.
    if (msg.type !== 'user' || !Array.isArray(msg.message.content)) continue
    for (const block of msg.message.content) {
      if (isBase64ImageBlock(block)) {
        blocks.push(block)
      } else if (isToolResultWithContent(block)) {
        for (const nested of block.content) {
          if (isBase64ImageBlock(nested)) blocks.push(nested)
        }
      }
    }
  }
  return blocks
}

function cacheKey(block: Base64ImageBlock, manyImages: boolean): string {
  const data = block.source.data
  const bun = (
    globalThis as { Bun?: { hash?: (input: string) => number | bigint } }
  ).Bun
  const digest = bun?.hash
    ? bun.hash(data).toString(16)
    : createHash('sha1').update(data).digest('hex')
  return `${manyImages ? 'many' : 'any'}:${data.length}:${digest}`
}

function remember(key: string, prepared: PreparedImage): PreparedImage {
  if (preparedImages.size >= PREPARED_IMAGE_CACHE_LIMIT) {
    const oldest = preparedImages.keys().next().value
    if (oldest !== undefined) preparedImages.delete(oldest)
  }
  preparedImages.set(key, prepared)
  return prepared
}

async function prepareImage(
  block: Base64ImageBlock,
  manyImages: boolean,
): Promise<PreparedImage> {
  const key = cacheKey(block, manyImages)
  const cached = preparedImages.get(key)
  if (cached) return cached

  // The first 24 bytes cover every supported signature; the whole payload is
  // only decoded when its dimensions matter.
  const signature = detectImageFormatFromBufferOrNull(
    Buffer.from(block.source.data.slice(0, 32), 'base64'),
  )
  if (signature === null) return remember(key, { kind: 'invalid' })
  if (!manyImages) return remember(key, { kind: 'keep' })

  try {
    const sharp = await getImageProcessor()
    const buffer = Buffer.from(block.source.data, 'base64')
    const { width = 0, height = 0 } = await sharp(buffer).metadata()
    if (
      width <= API_MANY_IMAGE_MAX_DIMENSION &&
      height <= API_MANY_IMAGE_MAX_DIMENSION
    ) {
      return remember(key, { kind: 'keep' })
    }
    const resized = sharp(buffer).resize(
      API_MANY_IMAGE_MAX_DIMENSION,
      API_MANY_IMAGE_MAX_DIMENSION,
      { fit: 'inside', withoutEnlargement: true },
    )
    // GIF re-encodes as PNG: the API uses only the first frame anyway.
    const mediaType: ImageMediaType =
      signature === 'image/jpeg' || signature === 'image/webp'
        ? signature
        : 'image/png'
    const encoded =
      mediaType === 'image/jpeg'
        ? resized.jpeg({ quality: 90 })
        : mediaType === 'image/webp'
          ? resized.webp()
          : resized.png()
    const data = (await encoded.toBuffer()).toString('base64')
    logForDebugging(
      `prepareRequestImages: downscaled a ${width}x${height} image to fit ${API_MANY_IMAGE_MAX_DIMENSION}px for a many-image request`,
    )
    return remember(key, { kind: 'resized', mediaType, data })
  } catch (error) {
    // Without a working image processor the request goes out unchanged; the
    // API error path still reports what happened.
    logForDebugging(
      `prepareRequestImages: could not inspect image: ${error instanceof Error ? error.message : String(error)}`,
    )
    return remember(key, { kind: 'keep' })
  }
}

function rewriteContent(
  content: unknown[],
  replacements: Map<Base64ImageBlock, unknown>,
): unknown[] | null {
  let changed = false
  const next = content.map(block => {
    if (isBase64ImageBlock(block)) {
      const replacement = replacements.get(block)
      if (replacement !== undefined) {
        changed = true
        return replacement
      }
      return block
    }
    if (isToolResultWithContent(block)) {
      const nested = rewriteContent(block.content, replacements)
      if (nested) {
        changed = true
        return { ...block, content: nested }
      }
    }
    return block
  })
  return changed ? next : null
}

export async function prepareRequestImages<T extends MessageLike>(
  messages: T[],
): Promise<T[]> {
  const blocks = collectBase64ImageBlocks(messages)
  if (blocks.length === 0) return messages
  const manyImages = blocks.length > API_MANY_IMAGE_THRESHOLD
  const replacements = new Map<Base64ImageBlock, unknown>()
  for (const block of blocks) {
    const prepared = await prepareImage(block, manyImages)
    if (prepared.kind === 'invalid') {
      replacements.set(block, { type: 'text', text: INVALID_IMAGE_PLACEHOLDER })
    } else if (prepared.kind === 'resized') {
      replacements.set(block, {
        type: 'image',
        source: {
          type: 'base64',
          media_type: prepared.mediaType,
          data: prepared.data,
        },
      })
    }
  }
  if (replacements.size === 0) return messages
  return messages.map(msg => {
    if (msg.type !== 'user' || !Array.isArray(msg.message.content)) return msg
    const next = rewriteContent(msg.message.content, replacements)
    return next
      ? ({ ...msg, message: { ...msg.message, content: next } } as T)
      : msg
  })
}

export function __resetPreparedImageCacheForTests(): void {
  preparedImages.clear()
}
