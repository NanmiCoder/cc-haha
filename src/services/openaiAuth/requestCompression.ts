import { registerEncodedRequestBody } from '../api/requestBodyAudit.js'

/** Called only after conversion to the fixed Codex OAuth endpoint. No network retries. */
export async function encodeOpenAIRequestBody(
  plainBody: string,
  headers: Headers,
  signal?: AbortSignal | null,
): Promise<string | Uint8Array> {
  signal?.throwIfAborted()
  // An explicit compatibility opt-out leaves the established plain JSON path.
  if (/^(0|false|off)$/i.test(process.env.CC_HAHA_OPENAI_REQUEST_COMPRESSION ?? '') ||
      headers.has('Content-Encoding') ||
      typeof Bun === 'undefined' || typeof Bun.zstdCompress !== 'function') {
    return plainBody
  }
  let body: Uint8Array
  try {
    body = await Bun.zstdCompress(Buffer.from(plainBody), { level: 3 })
  } catch {
    // A local encoding failure occurs before submission; never replay a request
    // after the transport has been invoked, including HTTP encoding rejection.
    signal?.throwIfAborted()
    return plainBody
  }
  signal?.throwIfAborted()
  registerEncodedRequestBody(body, plainBody)
  headers.set('Content-Encoding', 'zstd')
  headers.delete('Content-Length')
  return body
}
