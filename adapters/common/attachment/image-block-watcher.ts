/**
 * Pure, stateful extractor that watches a stream of assistant text for
 * markdown image references (`![alt](source)`) and emits PendingUpload
 * records. Used by IM adapters to know which images to upload to IM.
 *
 * - Buffers input so an image marker split across multiple feed() calls
 *   still gets detected.
 * - Dedups by fingerprint of the source so the same image is only emitted
 *   once per watcher lifetime.
 */

import type { PendingUpload } from './attachment-types.js'

// Matches a complete markdown image: ![alt](target)
// `alt` may be empty; `target` stops at the first closing paren.
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g

function fingerprint(raw: string): string {
  let h = 5381
  for (let i = 0; i < raw.length; i++) {
    h = ((h << 5) + h) ^ raw.charCodeAt(i)
  }
  return (h >>> 0).toString(16)
}

function classify(target: string): PendingUpload['source'] | null {
  if (target.startsWith('data:')) {
    const m = /^data:([^;,]+);base64,(.+)$/.exec(target)
    if (!m) return null
    return { kind: 'base64', mime: m[1]!, data: m[2]! }
  }
  if (target.startsWith('file://')) {
    return { kind: 'path', path: target.slice('file://'.length) }
  }
  if (target.startsWith('http://') || target.startsWith('https://')) {
    return { kind: 'url', url: target }
  }
  if (target.startsWith('/')) {
    return { kind: 'path', path: target }
  }
  return null // relative paths — skip, we can't resolve them safely
}

export class ImageBlockWatcher {
  private buffer = ''
  private seen = new Set<string>()
  private accumulated: PendingUpload[] = []

  /** Feed a new chunk of streaming text; returns any NEW PendingUploads. */
  feed(chunk: string): PendingUpload[] {
    this.buffer += chunk
    const out: PendingUpload[] = []

    IMAGE_RE.lastIndex = 0
    let lastConsumedEnd = 0
    let m: RegExpExecArray | null
    while ((m = IMAGE_RE.exec(this.buffer)) !== null) {
      const [, alt, target] = m
      const source = classify(target!)
      if (source) {
        const id = fingerprint(`${source.kind}:${target}`)
        if (!this.seen.has(id)) {
          this.seen.add(id)
          const pending: PendingUpload = { id, source, alt: alt || undefined }
          out.push(pending)
          this.accumulated.push(pending)
        }
      }
      lastConsumedEnd = m.index + m[0].length
    }

    // Preserve tail that might contain a partially-received marker.
    if (lastConsumedEnd > 0) {
      this.buffer = this.buffer.slice(lastConsumedEnd)
    }
    if (this.buffer.length > 4096) {
      this.buffer = this.buffer.slice(-2048)
    }

    return out
  }

  /** Return everything seen so far (for end-of-stream reconciliation). */
  drain(): PendingUpload[] {
    return [...this.accumulated]
  }

  /** Reset watcher state (use at /clear or new session). */
  reset(): void {
    this.buffer = ''
    this.seen.clear()
    this.accumulated = []
  }
}
