/**
 * Images inside a tool_result (#1397).
 *
 * A tool result reaches the desktop as a string or as an array of API content
 * blocks. A tool that returns a picture — `Read` on a PNG, a screenshot or plotting
 * tool, an MCP server — sends
 *
 *   { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '…' } }
 *
 * The text extractors in ToolCallBlock, ToolResultBlock and ToolCallGroup only read
 * `text`, so that block used to vanish from the transcript. This module is the image
 * counterpart. It does not replace them: their small differences are pinned by
 * tests, and an image is not text.
 *
 * The payload is whatever the tool (and, for MCP, a third-party server) wrote, so
 * nothing is rendered on trust: only base64 sources, only the four raster types the
 * model API itself accepts, only well-formed base64, and only within fixed limits.
 * Every check runs before the data is decoded.
 */

/** Exactly what the model API accepts. `image/svg+xml` in particular stays out. */
export const TOOL_RESULT_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

export type ToolResultImageMediaType = (typeof TOOL_RESULT_IMAGE_MEDIA_TYPES)[number]

/** Most images shown for one tool result; the rest are reported as dropped. */
export const TOOL_RESULT_IMAGE_MAX_COUNT = 6

/** Largest single image, measured in decoded bytes. */
export const TOOL_RESULT_IMAGE_MAX_BYTES = 8 * 1024 * 1024

/** Largest sum of decoded bytes across the images of one tool result. */
export const TOOL_RESULT_IMAGES_MAX_TOTAL_BYTES = 24 * 1024 * 1024

export type ToolResultImage = {
  mediaType: ToolResultImageMediaType
  /** Base64 with all whitespace removed. */
  data: string
}

export type ToolResultImageExtraction = {
  images: ToolResultImage[]
  /**
   * Image blocks the result carried that are not in `images`: an unsupported
   * source or type, malformed base64, a limit hit, or past the count cap.
   */
  dropped: number
}

const ALLOWED_MEDIA_TYPES: ReadonlySet<string> = new Set(TOOL_RESULT_IMAGE_MEDIA_TYPES)

/** The whitespace `atob` skips too. Anything else outside the alphabet is invalid. */
const BASE64_WHITESPACE = /[\t\n\f\r ]+/g
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Longest string worth looking at for one image: its base64 length at the byte
 * cap, doubled to leave room for line-wrapped output. Anything longer is refused
 * on `length` alone, so an oversized payload is never scanned, copied or decoded.
 */
const MAX_RAW_BASE64_LENGTH = 2 * Math.ceil(TOOL_RESULT_IMAGE_MAX_BYTES / 3) * 4

/**
 * What was read from each content object. The transcript list rebuilds its result
 * map, and every group that holds it re-renders, for each streamed token; keying
 * on the container or the map would validate the same megabytes of base64 again on
 * every one of those. The content object itself is the one thing that stays put.
 */
const extractionsByContent = new WeakMap<object, ToolResultImageExtraction>()

/**
 * Pull the displayable images out of a tool_result `content`.
 *
 * Accepts the array of blocks, and the `{ content: [...] }` wrapper (also with
 * `status: 'completed'`) that the sibling text extractors tolerate. Order is kept.
 * Never throws: content it cannot make sense of yields no images.
 *
 * A given content object is read once and the result is remembered, so the same
 * object always yields the same extraction. Tool results are not edited after
 * they arrive; treat the returned value as read-only.
 */
export function extractToolResultImages(content: unknown): ToolResultImageExtraction {
  // Only an object can hold blocks, and only an object can be remembered.
  if (!content || typeof content !== 'object') return { images: [], dropped: 0 }
  const remembered = extractionsByContent.get(content)
  if (remembered) return remembered
  const extraction = readImages(content)
  extractionsByContent.set(content, extraction)
  return extraction
}

/**
 * What to show for one tool call: the images its result carried, and the file they
 * came from when the tool says so.
 *
 * Only `Read` names its source. Any other tool's `file_path` may be where it wrote
 * something, which the returned pixels are not a copy of. Whether that path can be
 * opened is for the strip to decide; this only says which call it belongs to.
 */
export function toolResultImagesFor(call: {
  toolName: string
  input: unknown
  content: unknown
}): ToolResultImageExtraction & { originalPath?: string } {
  const extraction = extractToolResultImages(call.content)
  const originalPath = sourcePathOf(call.toolName, call.input)
  return originalPath === undefined ? { ...extraction } : { ...extraction, originalPath }
}

function sourcePathOf(toolName: string, input: unknown): string | undefined {
  if (toolName !== 'Read' || !input || typeof input !== 'object') return undefined
  try {
    const filePath = (input as { file_path?: unknown }).file_path
    return typeof filePath === 'string' && filePath ? filePath : undefined
  } catch {
    return undefined
  }
}

function readImages(content: object): ToolResultImageExtraction {
  const extraction: ToolResultImageExtraction = { images: [], dropped: 0 }
  try {
    let totalBytes = 0
    for (const block of contentBlocks(content)) {
      if (!isImageBlock(block)) continue
      // Past the cap nothing more is inspected, however many blocks follow.
      if (extraction.images.length >= TOOL_RESULT_IMAGE_MAX_COUNT) {
        extraction.dropped += 1
        continue
      }
      const parsed = readImageBlock(block)
      if (!parsed || totalBytes + parsed.bytes > TOOL_RESULT_IMAGES_MAX_TOTAL_BYTES) {
        extraction.dropped += 1
        continue
      }
      totalBytes += parsed.bytes
      extraction.images.push(parsed.image)
    }
    return extraction
  } catch {
    // Hostile input (a throwing getter or proxy): show nothing rather than half.
    return { images: [], dropped: 0 }
  }
}

/**
 * Decode an extracted image into a Blob for `URL.createObjectURL`.
 *
 * Throws when `atob` rejects the data. Callers own the resulting object URL and
 * must revoke it.
 */
export function toolResultImageToBlob(image: ToolResultImage): Blob {
  const binary = atob(image.data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new Blob([bytes], { type: image.mediaType })
}

/** Group offscreen calls by block type without validating their image bytes. */
export function hasToolResultImageBlock(content: unknown): boolean {
  try {
    return contentBlocks(content).some(isImageBlock)
  } catch {
    return false
  }
}

function contentBlocks(content: unknown): readonly unknown[] {
  if (Array.isArray(content)) return content
  if (content && typeof content === 'object') {
    const inner = (content as { content?: unknown }).content
    if (Array.isArray(inner)) return inner
  }
  return []
}

function isImageBlock(block: unknown): block is Record<string, unknown> {
  return Boolean(block) && typeof block === 'object' && (block as { type?: unknown }).type === 'image'
}

function readImageBlock(block: Record<string, unknown>): { image: ToolResultImage; bytes: number } | null {
  const source = block.source
  if (!source || typeof source !== 'object') return null
  const { type, media_type: rawMediaType, data } = source as Record<string, unknown>
  if (type !== 'base64' || typeof data !== 'string') return null

  const mediaType = normalizeMediaType(rawMediaType)
  if (!mediaType) return null

  if (data.length > MAX_RAW_BASE64_LENGTH) return null
  const base64 = data.replace(BASE64_WHITESPACE, '')
  const bytes = decodedByteLength(base64)
  if (bytes === null || bytes > TOOL_RESULT_IMAGE_MAX_BYTES) return null

  return { image: { mediaType, data: base64 }, bytes }
}

function normalizeMediaType(value: unknown): ToolResultImageMediaType | null {
  if (typeof value !== 'string') return null
  const lower = value.toLowerCase()
  return ALLOWED_MEDIA_TYPES.has(lower) ? (lower as ToolResultImageMediaType) : null
}

/**
 * The size `base64` decodes to, or null when it is not base64 `atob` would take:
 * outside the alphabet, empty, padding that disagrees with the length, or a
 * length that leaves a lone trailing character.
 */
function decodedByteLength(base64: string): number | null {
  if (!BASE64_PATTERN.test(base64)) return null
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  const remainder = base64.length % 4
  if (padding > 0 ? remainder !== 0 : remainder === 1) return null
  return Math.floor(((base64.length - padding) * 3) / 4)
}
