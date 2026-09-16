/** Only locally encoded bodies are associated with plaintext; never decompress caller input. */
export type RequestBodyAudit = Readonly<{
  plainBody: string
  requestEncoding: 'zstd'
  requestPlainBytes: number
  requestWireBytes: number
}>

const encodedBodies = new WeakMap<Uint8Array, RequestBodyAudit>()

export function registerEncodedRequestBody(body: Uint8Array, plainBody: string): void {
  encodedBodies.set(body, Object.freeze({
    plainBody,
    requestEncoding: 'zstd',
    requestPlainBytes: Buffer.byteLength(plainBody),
    requestWireBytes: body.byteLength,
  }))
}

export function getRequestBodyAudit(body: unknown): RequestBodyAudit | undefined {
  return body instanceof Uint8Array ? encodedBodies.get(body) : undefined
}
