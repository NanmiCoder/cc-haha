import { open } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import parser, { type Token } from 'stream-json/parser.js'
import { ApiError } from '../middleware/errorHandler.js'
import { HISTORY_SEMANTIC_RECORD_BYTES } from './boundedSessionHistory.js'
import { createBoundedJsonProjection } from './boundedJsonProjection.js'

const METADATA_BYTES = 128 * 1024
const TEXT_PREVIEW_CHARS = 4096
const truncatedTextEntries = new WeakSet<object>()

/** A projected long text is unsuitable for authoritative notification classification. */
export function isSessionMetadataTextTruncated(entry: object): boolean {
  return truncatedTextEntries.has(entry)
}

const rootFields = new Set([
  'type', 'subtype', 'uuid', 'parentUuid', 'parent_tool_use_id', 'isSidechain', 'isMeta',
  'cwd', 'timestamp', 'workDir', 'repository', 'worktreeSession', 'permissionMode', 'agentProfile',
  'runtimeProviderId', 'runtimeModelId', 'effortLevel', 'customTitle', 'aiTitle',
  'entrypoint', 'message', 'content',
])
const blockFields = new Set(['type', 'name', 'id', 'tool_use_id', 'text'])

function limit(): ApiError {
  return new ApiError(413, 'Session metadata exceeds its resource budget', 'SESSION_METADATA_TOO_LARGE')
}

/** Assemble only the small structural envelope; the parser still validates every byte. */
function createProjection() {
  const projection = createBoundedJsonProjection({
    selected: path => {
      if (!path.length) return true
      if (!rootFields.has(path[0]!)) return false
      if (path[0] !== 'message') return true
      if (path.length === 1) return true
      if (path[1] === 'role') return path.length === 2
      if (path[1] !== 'content') return false
      return path.length <= 3 || path.length === 4 && blockFields.has(path[3]!)
    },
    preview: path => path.length === 1 && path[0] === 'content'
      || path[0] === 'message' && path[1] === 'content' && (path.length === 2 || path.length === 4 && path[3] === 'text'),
    metadataBytes: METADATA_BYTES,
    previewChars: TEXT_PREVIEW_CHARS,
    limitError: limit,
  })
  return {
    token: projection.token,
    result: () => {
      const root = projection.root()
      if (root && typeof root === 'object' && !Array.isArray(root)) {
        const message = (root as Record<string, unknown>).message as Record<string, unknown> | undefined
        if (message && typeof message === 'object' && (projection.wasTruncated(message, 'content')
          || Array.isArray(message.content) && message.content.some(block => block && typeof block === 'object' && projection.wasTruncated(block, 'text')))) {
          truncatedTextEntries.add(root)
        }
        return root as Record<string, unknown>
      }
      return undefined
    },
  }
}

/**
 * Preserve ordinary JSONL semantics. Oversized bodies use a validated streaming
 * projection instead of making otherwise small launch metadata unavailable.
 * This is not a semantic replay reader: large message payloads are not returned.
 */
export async function streamSessionMetadata(
  filePath: string,
  onEntry: (entry: Record<string, unknown>, completeLine: boolean, byteStart: number) => void,
  signal?: AbortSignal,
  options: {
    startOffset?: number
    endOffset?: number
    onSkipped?: () => void
  } = {},
): Promise<{
  sourceVersion: string
  omittedRecords: number
  projectedRecords: number
  scannedBytes: number
  nextOffset: number
}> {
  const handle = await open(filePath, 'r')
  const check = () => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  }
  let active: ReturnType<typeof parser.asStream> | undefined
  try {
    const stat = await handle.stat({ bigint: true })
    const size = Math.min(Number(stat.size), options.endOffset ?? Number(stat.size))
    const firstOffset = options.startOffset ?? 0
    let lineStart = firstOffset
    let nextOffset = firstOffset
    let parts: Buffer[] = []
    let length = 0
    let projection: ReturnType<typeof createProjection> | undefined
    let parseError: Error | undefined
    let projectionError: unknown
    let decoder: StringDecoder | undefined
    let omittedRecords = 0
    let projectedRecords = 0
    const feed = async (part: Buffer) => {
      if (!active || parseError || projectionError) return
      const text = decoder!.write(part)
      await new Promise<void>(resolve => active!.write(text, () => resolve()))
    }
    const flush = async (completeLine: boolean) => {
      let entry: unknown
      if (active) {
        if (!parseError && !projectionError) {
          await new Promise<void>(resolve => {
            active!.once('end', resolve)
            active!.once('error', resolve)
            active!.end(decoder!.end())
          })
        }
        active.destroy()
        active = undefined
        if (projectionError) throw projectionError
        if (!parseError) {
          entry = projection!.result()
          projectedRecords++
        }
      } else if (length) {
        try {
          entry = JSON.parse((parts.length === 1 ? parts[0]! : Buffer.concat(parts, length)).toString('utf8'))
        } catch (error) {
          parseError = error as Error
        }
      }
      if (parseError) {
        omittedRecords++
        options.onSkipped?.()
      }
      else if (entry && typeof entry === 'object' && !Array.isArray(entry)) onEntry(entry as Record<string, unknown>, completeLine, lineStart)
      parts = []
      length = 0
      projection = undefined
      parseError = undefined
      projectionError = undefined
    }
    const chunk = Buffer.allocUnsafe(64 * 1024)
    for (let offset = firstOffset; offset < size;) {
      check()
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - offset), offset)
      if (!bytesRead) throw new ApiError(409, 'Session history changed during recovery', 'HISTORY_CHANGED')
      offset += bytesRead
      let start = 0
      while (start < bytesRead) {
        check()
        const found = chunk.indexOf(10, start)
        const end = found >= 0 && found < bytesRead ? found : bytesRead
        const part = chunk.subarray(start, end)
        length += part.length
        if (!active && length > HISTORY_SEMANTIC_RECORD_BYTES) {
          projection = createProjection()
          decoder = new StringDecoder('utf8')
          active = parser.asStream({ packValues: false, streamValues: true })
          active.on('error', error => {
            parseError = error
          })
          active.on('data', (token: Token) => {
            if (!projectionError) {
              try {
                projection!.token(token)
              } catch (error) {
                projectionError = error
              }
            }
          })
          for (const saved of parts) await feed(saved)
          parts = []
        }
        if (active) await feed(part)
        else parts.push(Buffer.from(part))
        start = end + 1
        if (end < bytesRead) {
          await flush(true)
          lineStart = offset - bytesRead + end + 1
          nextOffset = lineStart
          await new Promise<void>(resolve => setImmediate(resolve))
        }
      }
    }
    if (length) await flush(false)
    const after = await handle.stat({ bigint: true })
    if (after.size < stat.size || after.size === stat.size && after.mtimeNs !== stat.mtimeNs) throw new ApiError(409, 'Session changed during recovery; retry', 'HISTORY_CHANGED')
    return { sourceVersion: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`, omittedRecords, projectedRecords, scannedBytes: size - firstOffset, nextOffset }
  } finally {
    active?.destroy()
    await handle.close()
  }
}
