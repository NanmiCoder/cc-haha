import type { InlineImage, MediaEndpoint } from './types.js'

const MIB = 1024 * 1024
const EXPIRES_AFTER_SECONDS = 24 * 60 * 60
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const VISION_MODELS = new Set(['deepseek-flash', 'deepseek-v4-flash-vision-exp'])

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function isBase64(data: unknown): data is string {
  if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0) return false
  if (/[^A-Za-z0-9+/=]/.test(data)) return false
  const padding = data.indexOf('=')
  return padding === -1 || (
    padding >= data.length - 2 && /^={1,2}$/.test(data.slice(padding))
  )
}

function parseDataUrl(value: unknown): { mediaType: string; data: string } | undefined {
  if (typeof value !== 'string' || !value.startsWith('data:')) return undefined
  const comma = value.indexOf(',')
  if (comma === -1) return undefined
  const header = value.slice(5, comma)
  if (!header.endsWith(';base64')) return undefined
  const mediaType = header.slice(0, -7)
  if (!IMAGE_TYPES.has(mediaType)) return undefined
  const data = value.slice(comma + 1)
  return isBase64(data) ? { mediaType, data } : undefined
}

function replaceBlock(block: Record<string, unknown>, mutate: () => void): number {
  const before = Buffer.byteLength(JSON.stringify(block))
  mutate()
  return before - Buffer.byteLength(JSON.stringify(block))
}

function collectAnthropicImages(body: Record<string, unknown>): InlineImage[] {
  const images: InlineImage[] = []
  const collectBlock = (value: unknown) => {
    const block = asRecord(value)
    const source = asRecord(block?.source)
    if (
      block?.type !== 'image' || source?.type !== 'base64' ||
      typeof source.media_type !== 'string' || !IMAGE_TYPES.has(source.media_type) ||
      !isBase64(source.data)
    ) return
    images.push({
      data: source.data,
      mediaType: source.media_type,
      replace(fileId) {
        return replaceBlock(block, () => {
          block.source = { type: 'file', file_id: fileId }
        })
      },
    })
  }

  if (!Array.isArray(body.messages)) return images
  for (const value of body.messages) {
    const message = asRecord(value)
    if (message?.role !== 'user' || !Array.isArray(message.content)) continue
    for (const value of message.content) {
      const block = asRecord(value)
      if (block?.type === 'tool_result' && Array.isArray(block.content)) {
        for (const result of block.content) collectBlock(result)
      } else {
        collectBlock(block)
      }
    }
  }
  return images
}

function collectChatImages(body: Record<string, unknown>): InlineImage[] {
  const images: InlineImage[] = []
  if (!Array.isArray(body.messages)) return images
  for (const value of body.messages) {
    const message = asRecord(value)
    if (message?.role !== 'user' || !Array.isArray(message.content)) continue
    for (const value of message.content) {
      const block = asRecord(value)
      if (block?.type !== 'image_url' || block.file_id !== undefined) continue
      const imageUrl = asRecord(block.image_url)
      const image = parseDataUrl(imageUrl?.url)
      if (!image) continue
      images.push({
        ...image,
        replace(fileId) {
          return replaceBlock(block, () => {
            delete block.image_url
            block.type = 'file'
            block.file_id = fileId
          })
        },
      })
    }
  }
  return images
}

function collectResponsesImages(body: Record<string, unknown>): InlineImage[] {
  const images: InlineImage[] = []
  if (!Array.isArray(body.input)) return images
  for (const value of body.input) {
    const item = asRecord(value)
    if (!item) continue
    // Follow only documented image-bearing fields, never tool arguments or arbitrary JSON.
    const blocks = item.type === 'function_call_output' || item.type === 'custom_tool_call_output'
      ? item.output
      : (item.type === undefined || item.type === 'message') &&
        (item.role === 'user' || item.role === 'developer')
        ? item.content
        : undefined
    if (!Array.isArray(blocks)) continue
    for (const value of blocks) {
      const block = asRecord(value)
      if (block?.type !== 'input_image' || block.file_id !== undefined) continue
      const image = parseDataUrl(block.image_url)
      if (!image) continue
      images.push({
        ...image,
        replace(fileId) {
          return replaceBlock(block, () => {
            delete block.image_url
            block.file_id = fileId
          })
        },
      })
    }
  }
  return images
}

function credentialScope(headers: Headers): string | undefined {
  const credentials = ['x-dsh-auth-token', 'authorization', 'x-api-key'].map(name => headers.get(name) ?? '')
  return credentials.some(Boolean) ? JSON.stringify(credentials) : undefined
}

function createUpload(data: Uint8Array, mediaType: string, headers: Headers): { body: BodyInit; headers: Headers } {
  if (!IMAGE_TYPES.has(mediaType)) throw new TypeError('Unsupported DeepSeek image type')
  const body = new FormData()
  body.set('purpose', 'user_data')
  body.set('expires_after[anchor]', 'created_at')
  body.set('expires_after[seconds]', String(EXPIRES_AFTER_SECONDS))
  body.set('file', new Blob([data], { type: mediaType }), `image.${mediaType.slice('image/'.length)}`)

  // The upload uses the same account, with only the credentials required by its
  // API family. Inference content headers and signatures must not be forwarded.
  const uploadHeaders = new Headers()
  const accountToken = headers.get('x-dsh-auth-token')
  if (accountToken) uploadHeaders.set('x-dsh-auth-token', accountToken)
  else {
    const authorization = headers.get('authorization')
    const apiKey = headers.get('x-api-key')
    if (authorization) uploadHeaders.set('authorization', authorization)
    else if (apiKey) uploadHeaders.set('authorization', `Bearer ${apiKey}`)
  }
  return { body, headers: uploadHeaders }
}

function parseUpload(value: unknown): { id: string; expiresAt?: number } | undefined {
  const file = asRecord(value)
  if (typeof file?.id !== 'string' || !file.id.trim() || file.id.length > 512) return undefined
  if (file.expires_at === undefined) return { id: file.id }
  if (typeof file.expires_at !== 'number' || !Number.isFinite(file.expires_at)) return undefined
  return { id: file.id, expiresAt: file.expires_at * 1000 }
}

/** Explicit capability selection: compatible model names at other hosts do not imply Files API support. */
export function resolveDeepSeekMediaEndpoint(url: URL): MediaEndpoint | undefined {
  if (url.origin !== 'https://api.deepseek.com' || url.username || url.password) return undefined
  const path = url.pathname.replace(/\/$/, '')
  const collect = path === '/anthropic/v1/messages'
    ? collectAnthropicImages
    : path === '/chat/completions' || path === '/v1/chat/completions'
      ? collectChatImages
      : path === '/responses' || path === '/v1/responses'
        ? collectResponsesImages
        : undefined
  if (!collect) return undefined
  return {
    providerId: 'deepseek',
    uploadUrl: `${url.origin}/files`,
    ...(path === '/anthropic/v1/messages' ? { betaHeader: 'files-api-2025-04-14' } : {}),
    triggerBytes: 40 * MIB,
    targetBytes: 32 * MIB,
    maxFileBytes: 64 * MIB,
    expiresAfterSeconds: EXPIRES_AFTER_SECONDS,
    collectImages(body) {
      return typeof body.model === 'string' && VISION_MODELS.has(body.model) ? collect(body) : []
    },
    credentialScope,
    createUpload,
    parseUpload,
  }
}
