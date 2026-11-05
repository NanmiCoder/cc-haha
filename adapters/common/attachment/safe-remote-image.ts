import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
// Bun maps the bare `undici` specifier to a compatibility shim whose explicit
// Client is incomplete. The package subpath loads the repository dependency.
import { Client } from 'undici/index.js'
import {
  IMAGE_MAX_BYTES,
  IMAGE_MIME_WHITELIST,
} from './attachment-limits.js'
import type { PendingUpload } from './attachment-types.js'
import { loadSafeOutboundImage } from './outbound-image.js'

const REMOTE_IMAGE_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 5

export type RemoteAddress = {
  address: string
  family: 4 | 6
}

export type RemoteImageHeaders = Record<
  string,
  string | string[] | undefined
>

export type RemoteImageHopResponse = {
  status: number
  headers: RemoteImageHeaders
  body: AsyncIterable<Uint8Array>
  destroy: (error?: Error) => void
}

export type RemoteImageDependencies = {
  resolveHostname?: (hostname: string) => Promise<RemoteAddress[]>
  requestHop?: (
    url: URL,
    address: RemoteAddress,
    timeoutMs: number,
  ) => Promise<RemoteImageHopResponse>
  timeoutMs?: number
}

export type SafeRemoteImage =
  | { ok: true; buffer: Buffer; mime: string }
  | { ok: false; reason: string }

function normalizeHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
}

function ipv4Octets(address: string): number[] | null {
  const octets = address.split('.')
  if (octets.length !== 4) return null
  const parsed = octets.map((octet) => Number(octet))
  return parsed.every((octet) =>
    Number.isInteger(octet) && octet >= 0 && octet <= 255
  )
    ? parsed
    : null
}

function isPublicIpv4(address: string): boolean {
  const octets = ipv4Octets(address)
  if (!octets) return false
  const [a, b, c] = octets

  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 0 && c === 0) return false
  if (a === 192 && b === 0 && c === 2) return false
  if (a === 192 && b === 88 && c === 99) return false
  if (a === 192 && b === 168) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  if (a >= 224) return false
  return true
}

function parseIpv6Words(rawAddress: string): number[] | null {
  const address = rawAddress.split('%')[0]!.toLowerCase()
  const separator = address.indexOf('::')
  if (separator !== -1 && separator !== address.lastIndexOf('::')) return null

  const parseSide = (side: string): number[] | null => {
    if (!side) return []
    const groups = side.split(':')
    const words: number[] = []
    for (const group of groups) {
      if (group.includes('.')) {
        const octets = ipv4Octets(group)
        if (!octets) return null
        words.push((octets[0]! << 8) | octets[1]!)
        words.push((octets[2]! << 8) | octets[3]!)
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null
      words.push(Number.parseInt(group, 16))
    }
    return words
  }

  const left = parseSide(separator === -1 ? address : address.slice(0, separator))
  const right = parseSide(separator === -1 ? '' : address.slice(separator + 2))
  if (!left || !right) return null
  if (separator === -1) return left.length === 8 ? left : null
  if (left.length + right.length >= 8) return null
  return [
    ...left,
    ...Array(8 - left.length - right.length).fill(0),
    ...right,
  ]
}

function isPublicIpv6(address: string): boolean {
  const words = parseIpv6Words(address)
  if (!words) return false

  const isMappedIpv4 = words.slice(0, 5).every((word) => word === 0)
    && words[5] === 0xffff
  if (isMappedIpv4) {
    const mapped = [
      words[6]! >> 8,
      words[6]! & 0xff,
      words[7]! >> 8,
      words[7]! & 0xff,
    ].join('.')
    return isPublicIpv4(mapped)
  }

  // Public IPv6 unicast currently occupies 2000::/3. Keeping the allow rule
  // narrow avoids local, multicast, translation, and future reserved ranges.
  if (words[0]! < 0x2000 || words[0]! > 0x3fff) return false
  // Documentation, benchmarking, and transition ranges are not destinations
  // an adapter needs to fetch from.
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false
  if (words[0] === 0x2001 && words[1]! <= 0x01ff) return false
  if (words[0] === 0x2002) return false
  if (words[0] === 0x3fff && words[1]! <= 0x0fff) return false
  return true
}

export function isPublicRemoteAddress(address: string): boolean {
  const normalized = normalizeHostname(address)
  const family = isIP(normalized)
  if (family === 4) return isPublicIpv4(normalized)
  if (family === 6) return isPublicIpv6(normalized)
  return false
}

async function resolveRemoteHostname(hostname: string): Promise<RemoteAddress[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true })
  return answers
    .filter((answer): answer is { address: string; family: 4 | 6 } =>
      answer.family === 4 || answer.family === 6
    )
    .map(({ address, family }) => ({ address, family }))
}

/**
 * Issue one request to a pre-vetted address. The TCP/TLS connection uses the
 * supplied IP directly, while Host and TLS SNI retain the original hostname.
 * No cookie, authorization, proxy, or ambient credential state is forwarded.
 */
export async function requestPinnedRemoteImageHop(
  url: URL,
  address: RemoteAddress,
  timeoutMs: number,
): Promise<RemoteImageHopResponse> {
  const abortController = new AbortController()
  const client = new Client(url.origin, {
    connectTimeout: timeoutMs,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    maxHeaderSize: 64 * 1024,
    maxResponseSize: IMAGE_MAX_BYTES + 1,
    connect: {
      lookup(_hostname, options, callback) {
        if (options.all) {
          callback(null, [address])
          return
        }
        callback(null, address.address, address.family)
      },
    },
  })
  const totalTimer = setTimeout(() => {
    abortController.abort(new Error('remote image request timed out'))
  }, timeoutMs)

  try {
    const response = await client.request({
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers: {
        Accept: IMAGE_MIME_WHITELIST.join(', '),
        'User-Agent': 'claude-code-haha-im-adapter',
      },
      signal: abortController.signal,
    })
    const close = (error?: Error): void => {
      abortController.abort(error)
      clearTimeout(totalTimer)
      void response.body.dump().catch(() => {})
      void client.destroy(error ?? null).catch(() => {})
    }
    return {
      status: response.statusCode,
      headers: response.headers,
      body: (async function* () {
        try {
          for await (const chunk of response.body) yield chunk
        } finally {
          clearTimeout(totalTimer)
          await client.close().catch(() => {})
        }
      })(),
      destroy: close,
    }
  } catch (error) {
    clearTimeout(totalTimer)
    await client.destroy(
      error instanceof Error ? error : new Error(String(error)),
    ).catch(() => {})
    throw error
  }
}

function headerValue(
  headers: RemoteImageHeaders,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function parseRemoteUrl(rawUrl: string): SafeRemoteImage | URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'remote image URL is invalid' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'remote image URL must use http or https' }
  }
  if (url.username || url.password) {
    return {
      ok: false,
      reason: 'remote image URL must not contain credentials',
    }
  }
  return url
}

function failure(reason: string): SafeRemoteImage {
  return { ok: false, reason }
}

async function withinDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
): Promise<T> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error('remote image request timed out')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('remote image request timed out')),
          remaining,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function loadSafeRemoteImage(
  rawUrl: string,
  dependencies: RemoteImageDependencies = {},
): Promise<SafeRemoteImage> {
  const initial = parseRemoteUrl(rawUrl)
  if (!(initial instanceof URL)) return initial

  const resolveHostname = dependencies.resolveHostname ?? resolveRemoteHostname
  const requestHop = dependencies.requestHop ?? requestPinnedRemoteImageHop
  const timeoutMs = dependencies.timeoutMs ?? REMOTE_IMAGE_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  let current = initial

  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const hostname = normalizeHostname(current.hostname)
      const literalFamily = isIP(hostname)
      const addresses: RemoteAddress[] = literalFamily === 4 || literalFamily === 6
        ? [{ address: hostname, family: literalFamily }]
        : await withinDeadline(() => resolveHostname(hostname), deadline)
      if (
        addresses.length === 0
        || addresses.some(({ address }) => !isPublicRemoteAddress(address))
      ) {
        return failure('remote image host resolved to a non-public address')
      }

      // Connecting to this exact vetted address closes the DNS-rebinding gap:
      // the HTTP stack never performs a second lookup.
      const remaining = deadline - Date.now()
      const hop = await withinDeadline(
        () => requestHop(current, addresses[0]!, Math.max(1, remaining)),
        deadline,
      )
      if ([301, 302, 303, 307, 308].includes(hop.status)) {
        const location = headerValue(hop.headers, 'location')
        hop.destroy()
        if (!location) return failure('remote image redirect is missing a location')
        if (redirects === MAX_REDIRECTS) {
          return failure('remote image exceeded the redirect limit')
        }
        const redirected = parseRemoteUrl(new URL(location, current).href)
        if (!(redirected instanceof URL)) return redirected
        current = redirected
        continue
      }

      if (hop.status !== 200) {
        hop.destroy()
        return failure(`remote image request returned status ${hop.status}`)
      }

      const mime = (headerValue(hop.headers, 'content-type') ?? '')
        .split(';', 1)[0]!
        .trim()
        .toLowerCase()
      if (!IMAGE_MIME_WHITELIST.includes(
        mime as (typeof IMAGE_MIME_WHITELIST)[number],
      )) {
        hop.destroy()
        return failure(`remote image has unsupported MIME type: ${mime || 'missing'}`)
      }
      const contentEncoding = headerValue(hop.headers, 'content-encoding')
      if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
        hop.destroy()
        return failure('remote image uses an unsupported content encoding')
      }

      const declaredLength = Number(headerValue(hop.headers, 'content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > IMAGE_MAX_BYTES) {
        hop.destroy()
        return failure('remote image exceeds the 10 MB limit')
      }

      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of hop.body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        total += buffer.length
        if (total > IMAGE_MAX_BYTES) {
          hop.destroy()
          return failure('remote image exceeds the 10 MB limit')
        }
        chunks.push(buffer)
      }
      return {
        ok: true,
        buffer: Buffer.concat(chunks, total),
        mime,
      }
    }
  } catch (error) {
    return failure(
      `remote image request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  return failure('remote image request failed')
}

export async function materializePendingUploadImage(
  source: PendingUpload['source'],
  sessionWorkDir?: string | null,
): Promise<{ buffer: Buffer; mime: string }> {
  if (source.kind === 'base64') {
    return {
      buffer: Buffer.from(source.data, 'base64'),
      mime: source.mime,
    }
  }
  if (source.kind === 'path') {
    const loaded = await loadSafeOutboundImage({ id: 'local-image', source }, sessionWorkDir)
    if (!loaded.ok) throw new Error(loaded.reason)
    return loaded
  }

  const loaded = await loadSafeRemoteImage(source.url)
  if (!loaded.ok) throw new Error(loaded.reason)
  return loaded
}
