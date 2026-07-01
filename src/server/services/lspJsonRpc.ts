/**
 * Minimal JSON-RPC framing for LSP stdio transport.
 *
 * The Language Server Protocol speaks JSON-RPC 2.0 over stdio with a
 * `Content-Length: <bytes>\r\n\r\n<json>` framing. We frame and parse
 * the bytes ourselves rather than pulling in `vscode-jsonrpc` — that
 * package is ~120 KB minified and we only need the bottom layer.
 *
 * `LspFrameDecoder` accepts arbitrary chunks (LSP servers often write
 * partial frames or multiple frames per chunk) and yields complete
 * messages on each `push()`. `encodeLspFrame` produces the wire bytes
 * for outgoing requests.
 *
 * _Requirements: 7.2 (Phase 3 task 19)_
 */

const HEADER_TERMINATOR = '\r\n\r\n'
const HEADER_TERMINATOR_BYTES = Buffer.from(HEADER_TERMINATOR, 'ascii')

export class LspFrameDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LspFrameDecodeError'
  }
}

export type LspFrame = {
  contentLength: number
  bodyBytes: Buffer
}

/**
 * Encode a JSON-RPC payload as an LSP stdio frame:
 * `Content-Length: <n>\r\n\r\n<json>`.
 *
 * The body is written as raw UTF-8 — no charset header is emitted because
 * UTF-8 is the LSP default and emitting `Content-Type: ...; charset=utf-8`
 * confuses some servers (vscode-jsonrpc dropped it years ago).
 */
export function encodeLspFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  return Buffer.concat([header, body])
}

/**
 * Streaming decoder for `Content-Length`-framed LSP messages.
 *
 * Usage:
 *   const decoder = new LspFrameDecoder()
 *   childProcess.stdout.on('data', (chunk) => {
 *     for (const frame of decoder.push(chunk)) {
 *       // frame.bodyBytes is exactly contentLength bytes of UTF-8 JSON
 *     }
 *   })
 */
export class LspFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0)
  private pendingContentLength: number | null = null

  push(chunk: Buffer | string): LspFrame[] {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk
    this.buffer = this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming])

    const frames: LspFrame[] = []
    while (true) {
      if (this.pendingContentLength === null) {
        const headerEnd = this.buffer.indexOf(HEADER_TERMINATOR_BYTES)
        if (headerEnd === -1) break

        const headerBytes = this.buffer.subarray(0, headerEnd)
        this.pendingContentLength = parseContentLength(headerBytes.toString('utf-8'))
        this.buffer = this.buffer.subarray(headerEnd + HEADER_TERMINATOR_BYTES.length)
      }

      if (this.buffer.length < this.pendingContentLength) break

      const bodyBytes = this.buffer.subarray(0, this.pendingContentLength)
      this.buffer = this.buffer.subarray(this.pendingContentLength)
      frames.push({ contentLength: this.pendingContentLength, bodyBytes })
      this.pendingContentLength = null
    }

    return frames
  }

  /**
   * Reset internal buffer state — call when the underlying transport is
   * recycled (e.g. after a server crash + respawn) so we don't try to
   * resume a half-frame from a different lifetime.
   */
  reset(): void {
    this.buffer = Buffer.alloc(0)
    this.pendingContentLength = null
  }
}

function parseContentLength(headerBlock: string): number {
  // Headers are CRLF-separated, name: value pairs. We only care about
  // Content-Length; other headers (Content-Type) are accepted but ignored.
  const lines = headerBlock.split('\r\n')
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (name === 'content-length') {
      const parsed = Number.parseInt(value, 10)
      if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== value) {
        throw new LspFrameDecodeError(`Invalid Content-Length value: ${JSON.stringify(value)}`)
      }
      return parsed
    }
  }
  throw new LspFrameDecodeError('Missing Content-Length header in LSP frame')
}
