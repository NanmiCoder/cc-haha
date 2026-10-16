/**
 * Loopback recording proxy in front of a real provider.
 *
 * The server and CLI under test are given this proxy as the provider base URL
 * and a fake key. The proxy swaps in the real key, which it holds in memory
 * only, forwards the request unchanged, streams the response back as it
 * arrives, and keeps every SSE event with its timing. The key never reaches
 * the sandbox, a log, or a cassette.
 */

import { normalizedFingerprint, normalizeEvents, normalizeJson, normalizeString, volatileTokens, type PlaceholderTable } from './normalize'
import { queueKey, sha, systemText, type Cassette, type Interaction, type RecordedResponse } from './cassette'
import { parseSse, responseToolUseIds, type ApiFormat, type SseEvent } from './wire'

export type RawInteraction = {
  seq: number
  path: string
  body: Record<string, unknown>
  response: RecordedResponse
}

export type Recorder = {
  url: string
  interactions: RawInteraction[]
  /** Resolves once no request has been in flight for `quietMs`. */
  settle(quietMs?: number, timeoutMs?: number): Promise<void>
  take(): RawInteraction[]
  stop(): Promise<void>
}

const DROPPED_REQUEST_HEADERS = new Set(['host', 'content-length', 'authorization', 'x-api-key', 'accept-encoding', 'connection'])
const DROPPED_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection'])

export function startRecorder(options: {
  format: ApiFormat
  /** e.g. https://api.deepseek.com/anthropic or https://api.deepseek.com */
  upstreamBase: string
  apiKey: string
  /** Test seam: the fetch used to reach the upstream. */
  fetchUpstream?: typeof fetch
}): Recorder {
  const fetchUpstream = options.fetchUpstream ?? fetch
  const interactions: RawInteraction[] = []
  let seq = 0
  let inFlight = 0
  let lastActivity = Date.now()

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === 'GET') {
        // Model listings carry nothing a scenario replays; never forward them.
        return Response.json({ data: [], has_more: false })
      }
      inFlight += 1
      lastActivity = Date.now()
      const received = performance.now()
      const bodyText = await req.text()
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(bodyText) } catch { /* recorded as empty */ }
      const headers = new Headers()
      req.headers.forEach((value, name) => { if (!DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value) })
      headers.set('accept-encoding', 'identity')
      if (options.format === 'anthropic') headers.set('x-api-key', options.apiKey)
      headers.set('authorization', `Bearer ${options.apiKey}`)

      const record: RawInteraction = { seq: seq++, path: url.pathname, body, response: { status: 0, contentType: '' } }
      interactions.push(record)
      // A stopped stream can end through both `cancel` and a failed read; count it once.
      let finished = false
      const done = () => {
        if (finished) return
        finished = true
        inFlight -= 1
        lastActivity = Date.now()
      }

      let upstream: Response
      try {
        upstream = await fetchUpstream(`${options.upstreamBase.replace(/\/+$/, '')}${url.pathname}${url.search}`, {
          method: 'POST',
          headers,
          body: bodyText,
        })
      } catch (error) {
        record.response = { status: 599, contentType: 'text/plain', text: `recorder could not reach upstream: ${error instanceof Error ? error.message : String(error)}` }
        done()
        return new Response(record.response.text, { status: 502 })
      }
      const contentType = upstream.headers.get('content-type') ?? ''
      const responseHeaders = new Headers()
      upstream.headers.forEach((value, name) => { if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders.set(name, value) })
      record.response = { status: upstream.status, contentType, firstByteMs: Math.round(performance.now() - received) }

      if (!contentType.includes('text/event-stream') || !upstream.body) {
        const text = await upstream.text()
        try { record.response.json = JSON.parse(text) } catch { record.response.text = text }
        done()
        return new Response(text, { status: upstream.status, headers: responseHeaders })
      }

      // Tee the stream: the client sees bytes as they arrive; the recorder
      // timestamps each complete SSE event.
      const decoder = new TextDecoder()
      const events: Array<SseEvent & { dt: number }> = []
      let buffer = ''
      let last = performance.now()
      const take = (final: boolean) => {
        const parts = buffer.replace(/\r\n/g, '\n').split('\n\n')
        buffer = final ? '' : parts.pop() ?? ''
        for (const part of parts) {
          for (const event of parseSse(`${part}\n\n`)) {
            const now = performance.now()
            events.push({ ...event, dt: Math.round(now - last) })
            last = now
          }
        }
      }
      const reader = upstream.body.getReader()
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done: ended, value } = await reader.read()
            if (ended) {
              buffer += decoder.decode()
              take(true)
              record.response.events = events
              done()
              controller.close()
              return
            }
            buffer += decoder.decode(value, { stream: true })
            take(false)
            controller.enqueue(value)
          } catch (error) {
            record.response.events = events
            done()
            controller.error(error)
          }
        },
        cancel() {
          // The client hung up (a user's stop). Keep what arrived; a replay
          // serves the same prefix and the same hang-up happens again.
          record.response.events = events
          void reader.cancel()
          done()
        },
      })
      return new Response(stream, { status: upstream.status, headers: responseHeaders })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    interactions,
    async settle(quietMs = 1500, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (inFlight === 0 && Date.now() - lastActivity >= quietMs) return
        await Bun.sleep(100)
      }
      throw new Error(`upstream traffic did not settle within ${timeoutMs}ms (${inFlight} in flight)`)
    },
    take() {
      return interactions.splice(0)
    },
    async stop() {
      await server.stop(true)
    },
  }
}

/** Turns raw traffic into a committed cassette: fingerprints, normalised responses. */
export function buildCassette(options: {
  id: string
  format: ApiFormat
  provider: string
  model: string
  providerConfig: Record<string, unknown>
  raw: RawInteraction[]
  table: PlaceholderTable
}): Cassette {
  // Clock-minted values the app sent become learned slots ({{V1}}…), in the
  // fingerprints and in any reply that quotes them back.
  const tokens = volatileTokens(options.raw.flatMap((raw) => {
    const fingerprint = normalizedFingerprint(options.format, raw.body, options.table)
    return [fingerprint.firstUserText, fingerprint.lastUserText]
  }))
  const table: PlaceholderTable = [...options.table, ...tokens.map((value, index) => ({ name: `V${index + 1}`, values: [value] }))]
  const interactions: Interaction[] = options.raw.map((raw, index) => {
    const fingerprint = normalizedFingerprint(options.format, raw.body, table)
    const system = normalizeString(systemText(options.format, raw.body), table)
    const response: RecordedResponse = {
      status: raw.response.status,
      contentType: raw.response.contentType,
      ...(raw.response.firstByteMs !== undefined ? { firstByteMs: raw.response.firstByteMs } : {}),
      ...(raw.response.events ? { events: normalizeEvents(options.format, raw.response.events, table) as Array<SseEvent & { dt: number }> } : {}),
      ...(raw.response.json !== undefined ? { json: normalizeJson(raw.response.json, table) } : {}),
      ...(raw.response.text !== undefined ? { text: normalizeString(raw.response.text, table) } : {}),
    }
    return {
      seq: index,
      path: raw.path,
      queue: queueKey(raw.path, fingerprint, system),
      request: {
        ...fingerprint,
        systemSha: sha(system),
        toolsSha: sha(normalizeJson(raw.body.tools ?? null, table)),
      },
      response,
      toolUseIds: responseToolUseIds(options.format, raw.response.events ?? [], raw.response.json),
    }
  })
  return {
    schemaVersion: 1,
    id: options.id,
    format: options.format,
    recordedWith: { provider: options.provider, model: options.model, date: new Date().toISOString().slice(0, 10) },
    providerConfig: options.providerConfig,
    interactions,
  }
}

/** Fails a recording that would commit a secret or a real home path. */
export function scanForSecrets(serialized: string, secrets: string[]): string[] {
  const problems: string[] = []
  for (const secret of [...new Set(secrets)].filter((value) => value && value.length >= 6)) {
    if (serialized.includes(secret)) problems.push(`contains a forbidden value (${secret.slice(0, 3)}…)`)
  }
  for (const match of serialized.matchAll(/\bsk-[A-Za-z0-9_-]{16,}/g)) problems.push(`contains an API-key-shaped string ${match[0].slice(0, 6)}…`)
  return problems
}
