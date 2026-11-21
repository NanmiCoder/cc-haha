import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { getImageProcessor } from '../../tools/FileReadTool/imageProcessor.js'
import { readImageHeaderDimensions } from '../../utils/imageResizer.js'

/**
 * Tool-produced images (a Read of a PNG, a screenshot) by reference.
 *
 * The transcript and the model's context keep the full base64 bytes. Clients
 * that opt in (`media=ref`, the phone over a tunnel) receive a small reference
 * in history pages and live `tool_result` events instead, and fetch the bytes
 * from `/api/sessions/:id/tool-images/:toolUseId/:index` only when they draw
 * them. A 1.7 MB screenshot otherwise costs ~2.3 MB per live frame and ~4.5 MB
 * per history page (the Read tool also stores it in `toolUseResult`).
 */

export type ToolImage = { mediaType: string; data: string }
export type ToolImageRefSource = {
  type: 'ref'
  media_type: string
  url: string
  bytes: number
  width?: number
  height?: number
}
export type ToolImageVariant = 'thumb' | 'full'

/** Formats the Read tool emits; anything else (SVG included) is never served. */
const SERVED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
export const TOOL_IMAGE_THUMBNAIL_EDGE = 800
/** Small images are served unchanged as their own thumbnail. */
const THUMBNAIL_PASSTHROUGH_BYTES = 160 * 1024
/** Serialized size of one reference, used when paging by projected size. */
const REF_BYTES = 240
const LIVE_CACHE_BYTES = 64 * 1024 * 1024
const RENDER_CACHE_BYTES = 24 * 1024 * 1024
const MAX_IMAGES_PER_RESULT = 64

export function toolImageUrl(sessionId: string, toolUseId: string, index: number): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/tool-images/${encodeURIComponent(toolUseId)}/${index}`
}

function base64Image(block: unknown): ToolImage | null {
  if (!block || typeof block !== 'object') return null
  const value = block as Record<string, unknown>
  if (value.type !== 'image') return null
  const source = value.source as Record<string, unknown> | undefined
  if (source?.type !== 'base64' || typeof source.data !== 'string' || typeof source.media_type !== 'string') return null
  return { mediaType: source.media_type, data: source.data }
}

/** Base64 images of one tool result, in content order (the index used by references). */
export function toolResultImages(content: unknown): ToolImage[] {
  if (!Array.isArray(content)) return []
  return content.flatMap(block => {
    const image = base64Image(block)
    return image ? [image] : []
  })
}

function decodedLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding)
}

function imageRef(image: ToolImage, url: string): ToolImageRefSource {
  // JPEG frame headers may follow large EXIF blocks; 64 KB of base64 covers
  // typical screenshots without decoding the whole payload per reference.
  const dimensions = readImageHeaderDimensions(Buffer.from(image.data.slice(0, 64 * 1024), 'base64'))
  return {
    type: 'ref',
    media_type: image.mediaType,
    url,
    bytes: decodedLength(image.data),
    ...(dimensions ?? {}),
  }
}

/** Replace base64 image blocks of one tool result with references. */
export function projectToolResultContent(content: unknown, sessionId: string, toolUseId: string): unknown {
  if (!Array.isArray(content)) return content
  let index = 0
  let changed = false
  const projected = content.map(block => {
    const image = base64Image(block)
    if (!image) return block
    changed = true
    return { ...(block as Record<string, unknown>), source: imageRef(image, toolImageUrl(sessionId, toolUseId, index++)) }
  })
  return changed ? projected : content
}

/** The Read tool records the image bytes a second time in its structured output. */
export function stripToolUseResultImageData(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  const file = record.file
  if (!file || typeof file !== 'object' || Array.isArray(file)) return value
  const { base64, ...rest } = file as Record<string, unknown>
  if (typeof base64 !== 'string') return value
  return { ...record, file: rest }
}

function findLastToolResultUseId(content: unknown[]): string | null {
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i]
    if (!block || typeof block !== 'object') continue
    const value = block as Record<string, unknown>
    if (value.type === 'tool_result' && typeof value.tool_use_id === 'string') {
      return value.tool_use_id
    }
  }
  return null
}

function parseDataUrlImage(dataUrl: string, fallbackMediaType?: string): ToolImage | null {
  const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i)
  if (match) {
    return { mediaType: match[1]!.toLowerCase(), data: match[2]! }
  }
  if (fallbackMediaType && fallbackMediaType.startsWith('image/') && dataUrl.length > 0) {
    return { mediaType: fallbackMediaType.toLowerCase(), data: dataUrl }
  }
  return null
}

/** History message projection for `media=ref` readers. */
export function projectMessageMedia<T extends { content?: unknown; toolUseResult?: unknown }>(message: T, sessionId: string): T {
  let next = message
  if (Array.isArray(message.content)) {
    const siblingAnchorToolUseId = findLastToolResultUseId(message.content)
    let anchorImageCount = 0
    let changed = false
    const projectedBlocks = message.content.map((block: unknown) => {
      if (!block || typeof block !== 'object') return block
      const value = block as Record<string, unknown>
      if (value.type === 'tool_result' && typeof value.tool_use_id === 'string') {
        if (value.tool_use_id === siblingAnchorToolUseId) {
          anchorImageCount = toolResultImages(value.content).length
        }
        const projected = projectToolResultContent(value.content, sessionId, value.tool_use_id)
        if (projected === value.content) return block
        changed = true
        return { ...value, content: projected }
      }
      return block
    })
    let siblingIndex = anchorImageCount
    const content = siblingAnchorToolUseId
      ? projectedBlocks.map((block: unknown) => {
          const image = base64Image(block)
          if (!image) return block
          changed = true
          return {
            ...(block as Record<string, unknown>),
            source: imageRef(image, toolImageUrl(sessionId, siblingAnchorToolUseId, siblingIndex++)),
          }
        })
      : projectedBlocks
    if (changed) next = { ...next, content }
  }
  if ('toolUseResult' in message) {
    const stripped = stripToolUseResultImageData(message.toolUseResult)
    if (stripped !== message.toolUseResult) next = { ...next, toolUseResult: stripped }
  }
  return next
}

/**
 * Page cost of a raw transcript record after projection. Without it a record
 * holding one screenshot owns a whole page, so a turn with a few screenshots
 * spans more pages than a client walks back to find its own prompt.
 */
export function measureEntryWithMediaRefs(entry: Record<string, unknown>): number {
  let bytes = Buffer.byteLength(JSON.stringify(entry))
  const content = (entry.message as { content?: unknown } | undefined)?.content
  if (Array.isArray(content)) {
    const hasToolResult = findLastToolResultUseId(content) !== null
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const typed = block as { type?: unknown; content?: unknown }
      if (typed.type === 'tool_result') {
        for (const image of toolResultImages(typed.content)) bytes -= image.data.length - REF_BYTES
      } else if (hasToolResult) {
        const siblingImage = base64Image(block)
        if (siblingImage) bytes -= siblingImage.data.length - REF_BYTES
      }
    }
  }
  const file = (entry.toolUseResult as { file?: { base64?: unknown } } | undefined)?.file
  if (typeof file?.base64 === 'string') bytes -= file.base64.length
  return Math.max(1, bytes)
}

// ---------------------------------------------------------------------------
// Image lookup: recent live results first, then the session transcript.
// ---------------------------------------------------------------------------

type LiveEntry = { images: ToolImage[]; bytes: number }
const liveImages = new Map<string, LiveEntry>()
let liveBytes = 0

const liveKey = (sessionId: string, toolUseId: string) => `${sessionId}\n${toolUseId}`

/**
 * A live reference can be fetched before the CLI's transcript line is flushed,
 * and subagent results never reach the root transcript; keep recent ones.
 */
function cacheLiveImages(sessionId: string, toolUseId: string, images: ToolImage[]): void {
  const limited = images.slice(0, MAX_IMAGES_PER_RESULT)
  if (!limited.length) return
  const key = liveKey(sessionId, toolUseId)
  const previous = liveImages.get(key)
  if (previous) {
    liveImages.delete(key)
    liveBytes -= previous.bytes
  }
  const bytes = limited.reduce((sum, image) => sum + image.data.length, 0)
  if (bytes > LIVE_CACHE_BYTES) return
  liveImages.set(key, { images: limited, bytes })
  liveBytes += bytes
  for (const [oldest, entry] of liveImages) {
    if (liveBytes <= LIVE_CACHE_BYTES) break
    liveImages.delete(oldest)
    liveBytes -= entry.bytes
  }
}

export function rememberToolResultImages(sessionId: string, toolUseId: string, content: unknown): void {
  cacheLiveImages(sessionId, toolUseId, toolResultImages(content))
}

/** Project a live `tool_result` event for a `media=ref` client. */
export function projectLiveToolResult<T extends { toolUseId: string; content: unknown }>(message: T, sessionId: string): T {
  const content = projectToolResultContent(message.content, sessionId, message.toolUseId)
  if (content !== message.content) {
    rememberToolResultImages(sessionId, message.toolUseId, message.content)
    return { ...message, content }
  }
  // Structured AskUserQuestion results can carry inline base64 fallback images
  // when no staged path exists; project those to refs as well.
  if (message.content && typeof message.content === 'object' && !Array.isArray(message.content)) {
    const record = message.content as Record<string, unknown>
    if (Array.isArray(record.attachments) && record.attachments.length > 0) {
      const collected: ToolImage[] = []
      let changed = false
      const projectedAttachments = record.attachments.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry
        const att = entry as Record<string, unknown>
        if (att.type !== 'image' || typeof att.data !== 'string') return entry
        const parsed = parseDataUrlImage(att.data, typeof att.mimeType === 'string' ? att.mimeType : undefined)
        if (!parsed) return entry
        const url = toolImageUrl(sessionId, message.toolUseId, collected.length)
        collected.push(parsed)
        changed = true
        const { data: _omitted, ...rest } = att
        return { ...rest, previewUrl: url }
      })
      if (changed) {
        cacheLiveImages(sessionId, message.toolUseId, collected)
        return { ...message, content: { ...record, attachments: projectedAttachments } }
      }
    }
  }
  return message
}

async function readTranscriptToolImages(filePath: string, toolUseId: string): Promise<ToolImage[] | null> {
  // JSON.stringify writes no spaces, so a raw-line check skips parsing every record.
  const needle = `"tool_use_id":${JSON.stringify(toolUseId)}`
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.includes(needle)) continue
      let entry: { message?: { content?: unknown } }
      try { entry = JSON.parse(line) } catch { continue }
      const content = entry.message?.content
      if (!Array.isArray(content)) continue
      const siblingAnchorToolUseId = findLastToolResultUseId(content)
      for (const block of content) {
        const value = block as Record<string, unknown> | null
        if (value?.type === 'tool_result' && value.tool_use_id === toolUseId) {
          const inner = toolResultImages(value.content)
          if (siblingAnchorToolUseId !== toolUseId) return inner
          const siblings = content.flatMap((sibling) => {
            const image = base64Image(sibling)
            return image ? [image] : []
          })
          return siblings.length > 0 ? [...inner, ...siblings] : inner
        }
      }
    }
    return null
  } finally {
    lines.close()
    stream.destroy()
  }
}

export async function findToolImage(
  sessionId: string,
  toolUseId: string,
  index: number,
  transcriptPath: () => Promise<string | null>,
): Promise<ToolImage | null> {
  const live = liveImages.get(liveKey(sessionId, toolUseId))
  if (live) return live.images[index] ?? null
  const filePath = await transcriptPath()
  if (!filePath) return null
  const images = await readTranscriptToolImages(filePath, toolUseId)
  return images?.[index] ?? null
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export type RenderedToolImage = { bytes: Buffer; mediaType: string }
const rendered = new Map<string, RenderedToolImage>()
let renderedBytes = 0

export function isServedToolImageType(mediaType: string): boolean {
  return SERVED_MEDIA_TYPES.has(mediaType)
}

async function thumbnail(original: Buffer, mediaType: string): Promise<RenderedToolImage> {
  const dimensions = readImageHeaderDimensions(original)
  if (original.length <= THUMBNAIL_PASSTHROUGH_BYTES && dimensions &&
    Math.max(dimensions.width, dimensions.height) <= TOOL_IMAGE_THUMBNAIL_EDGE) {
    return { bytes: original, mediaType }
  }
  try {
    const sharp = await getImageProcessor()
    const bytes = await sharp(original)
      .resize(TOOL_IMAGE_THUMBNAIL_EDGE, TOOL_IMAGE_THUMBNAIL_EDGE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer()
    return bytes.length < original.length ? { bytes, mediaType: 'image/webp' } : { bytes: original, mediaType }
  } catch {
    // Without an image processor the original still renders; it is only larger.
    return { bytes: original, mediaType }
  }
}

/** Resolve and render one referenced image; null when it is unknown or not a servable type. */
export async function loadRenderedToolImage(
  sessionId: string,
  toolUseId: string,
  index: number,
  variant: ToolImageVariant,
  transcriptPath: () => Promise<string | null>,
): Promise<RenderedToolImage | null> {
  const key = `${sessionId}\n${toolUseId}\n${index}\n${variant}`
  const cached = rendered.get(key)
  if (cached) {
    rendered.delete(key)
    rendered.set(key, cached)
    return cached
  }
  const image = await findToolImage(sessionId, toolUseId, index, transcriptPath)
  if (!image || !isServedToolImageType(image.mediaType)) return null
  const original = Buffer.from(image.data, 'base64')
  const result = variant === 'full' ? { bytes: original, mediaType: image.mediaType } : await thumbnail(original, image.mediaType)
  if (result.bytes.length <= RENDER_CACHE_BYTES / 4) {
    rendered.set(key, result)
    renderedBytes += result.bytes.length
    for (const [oldest, entry] of rendered) {
      if (renderedBytes <= RENDER_CACHE_BYTES) break
      rendered.delete(oldest)
      renderedBytes -= entry.bytes.length
    }
  }
  return result
}

/** Test seam: process-level caches outlive individual requests. */
export function resetToolImageCachesForTests(): void {
  liveImages.clear()
  rendered.clear()
  liveBytes = 0
  renderedBytes = 0
}
