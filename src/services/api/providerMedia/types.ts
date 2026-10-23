/** A mutable view into a disposable, parsed outbound request, never a transcript. */
export type InlineImage = {
  data: string
  mediaType: string
  /** Replace one block and return its exact JSON UTF-8 byte reduction. */
  replace(fileId: string): number
}

/** Provider-specific wire contract; actual credentials come from the authenticated caller. */
export type MediaEndpoint = {
  providerId: string
  uploadUrl: string
  betaHeader?: string
  triggerBytes: number
  targetBytes: number
  maxFileBytes: number
  expiresAfterSeconds: number
  collectImages(body: Record<string, unknown>): InlineImage[]
  /** Opaque credential identity, hashed by the transport before caching. */
  credentialScope(headers: Headers): string | undefined
  createUpload(data: Uint8Array, mediaType: string, headers: Headers): { body: BodyInit; headers: Headers }
  parseUpload(value: unknown): { id: string; expiresAt?: number } | undefined
}

export type MediaEndpointResolver = (url: URL) => MediaEndpoint | undefined
