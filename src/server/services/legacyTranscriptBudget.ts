import type { Stats } from 'node:fs'
import { open } from 'node:fs/promises'
import { ApiError } from '../middleware/errorHandler.js'

export const LEGACY_TRANSCRIPT_BYTES = 8 * 1024 * 1024

/** Legacy parsers may materialize only a small, fixed aggregate source budget. */
export async function readLegacyTranscriptFiles(paths: string[]): Promise<Array<{ bytes: Buffer; stat: Stats }>> {
  if (paths.length > 128) throw new ApiError(413, 'Too many transcript fragments for legacy history', 'TEAM_TRANSCRIPT_TOO_LARGE')
  const handles: Awaited<ReturnType<typeof open>>[] = []
  try {
    const sources = []
    let total = 0
    for (const filePath of paths) {
      const handle = await open(filePath, 'r')
      handles.push(handle)
      const stat = await handle.stat()
      total += stat.size
      if (total > LEGACY_TRANSCRIPT_BYTES) throw new ApiError(413, 'Transcript exceeds the legacy history budget; use paged session history', 'TEAM_TRANSCRIPT_TOO_LARGE')
      sources.push({ handle, stat })
    }
    const result = []
    for (const source of sources) {
      const bytes = Buffer.allocUnsafe(source.stat.size)
      let position = 0
      while (position < bytes.length) {
        const { bytesRead } = await source.handle.read(bytes, position, Math.min(128 * 1024, bytes.length - position), position)
        if (!bytesRead) throw new ApiError(409, 'Transcript changed while reading', 'HISTORY_CHANGED')
        position += bytesRead
      }
      result.push({ bytes, stat: source.stat })
    }
    return result
  } finally { await Promise.all(handles.map(handle => handle.close())) }
}
