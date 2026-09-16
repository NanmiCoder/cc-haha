import { lookup, type LookupAddress } from 'dns'
import type { ClientRequest, IncomingMessage } from 'http'
import { request, type RequestOptions } from 'https'
import { isIP } from 'net'

import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { isBlockedAddress } from '../../utils/hooks/ssrfGuard.js'

const MAX_IMAGE_BYTES = 30 * 1024 * 1024

type DownloadDependencies = {
  resolve?: (
    hostname: string,
    callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
  ) => void
  request?: (
    url: URL,
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => ClientRequest
  timeoutMs?: number
}

// HTTP hooks intentionally allow localhost. Provider-controlled image URLs must
// be stricter, including mapped IPv4 and non-global IPv6 address space.
function assertPublicAddress(address: string): void {
  const family = isIP(address)
  let blocked = family === 0 || isBlockedAddress(address)
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number)
    blocked ||= a === 127 || a >= 224 ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
  } else if (family === 6) {
    const normalized = new URL(`https://[${address}]/`).hostname.slice(1, -1)
    const first = parseInt(normalized.split(':')[0]!, 16)
    // Global unicast only; exclude documentation and transition ranges whose
    // embedded destination can otherwise reach private IPv4 networks.
    blocked ||= first < 0x2000 || first > 0x3fff ||
      !Number.isFinite(first) || first === 0x2002 ||
      /^2001:(?:0:|:|db8:)/.test(normalized)
  }
  if (blocked) throw new Error('Image download blocked a non-public IP address.')
}

/**
 * Fetch an untrusted, provider-returned image URL without credentials. DNS
 * validation runs inside the socket lookup, so the connection uses precisely
 * the validated IPs. Redirects and global agents are deliberately disabled.
 * The image CDN must be directly reachable: the model API's proxy cannot be
 * reused because a remote proxy could resolve the hostname to a private IP.
 * Dependencies are an offline-test seam; callers use the two-argument API.
 */
export async function downloadGeneratedImage(
  sourceUrl: string,
  signal: AbortSignal,
  dependencies: DownloadDependencies = {},
): Promise<Buffer> {
  const url = new URL(sourceUrl)
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Image download requires an HTTPS URL without credentials.')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(hostname)) assertPublicAddress(hostname)

  const resolve = dependencies.resolve ?? ((host, callback) => {
    lookup(host, { all: true }, callback)
  })
  const guardedLookup: NonNullable<RequestOptions['lookup']> = (host, options, callback) => {
    resolve(host, (error, addresses) => {
      if (error) {
        callback(error, '', 4)
        return
      }
      try {
        if (!addresses.length) throw new Error('Image download DNS returned no addresses.')
        for (const entry of addresses) assertPublicAddress(entry.address)
      } catch (error) {
        callback(error as NodeJS.ErrnoException, '', 4)
        return
      }
      if (typeof options === 'object' && options.all) {
        callback(null, addresses)
      } else {
        callback(null, addresses[0]!.address, addresses[0]!.family)
      }
    })
  }

  const combined = createCombinedAbortSignal(signal, {
    timeoutMs: dependencies.timeoutMs ?? 60_000,
  })
  try {
    combined.signal.throwIfAborted()
    return await new Promise<Buffer>((resolveResult, reject) => {
      let incoming: IncomingMessage | undefined
      let outgoing: ClientRequest | undefined
      const abort = () => {
        const error = new Error('Image download was aborted or timed out.')
        incoming?.destroy(error)
        outgoing?.destroy(error)
        reject(error)
      }
      combined.signal.addEventListener('abort', abort, { once: true })
      const fail = (error: Error) => {
        incoming?.destroy()
        outgoing?.destroy()
        reject(error)
      }
      try {
        outgoing = (dependencies.request ?? request)(url, {
          method: 'GET',
          agent: false,
          lookup: guardedLookup,
          headers: { Accept: 'image/*' },
        }, (response) => {
          incoming = response
          response.on('error', fail)
          const status = response.statusCode ?? 0
          if (status < 200 || status >= 300) {
            fail(new Error(`Image download failed with HTTP ${status}; redirects are not allowed.`))
            return
          }
          if (Number(response.headers['content-length']) > MAX_IMAGE_BYTES) {
            fail(new Error('The generated image exceeded the 30 MB size limit.'))
            return
          }
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            size += chunk.byteLength
            if (size > MAX_IMAGE_BYTES) {
              fail(new Error('The generated image exceeded the 30 MB size limit.'))
              return
            }
            chunks.push(chunk)
          })
          response.on('aborted', () => fail(new Error('Image download ended prematurely.')))
          response.on('end', () => {
            if (!size) fail(new Error('The generated image was empty.'))
            else resolveResult(Buffer.concat(chunks, size))
          })
        })
        outgoing.on('error', fail)
        outgoing.once('close', () => combined.signal.removeEventListener('abort', abort))
        outgoing.end()
      } catch (error) {
        combined.signal.removeEventListener('abort', abort)
        fail(error as Error)
      }
    })
  } finally {
    combined.cleanup()
  }
}
