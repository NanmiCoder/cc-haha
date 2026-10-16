/**
 * A cassette is one scenario's upstream traffic, recorded against a real model
 * and committed so CI can replay it with no network and no credentials.
 *
 * Requests are kept as fingerprints, not bodies: a full Claude Code request is
 * tens of kilobytes of system prompt and tool schemas that would make every
 * prompt edit a giant fixture diff. Hashes of those parts are kept to report
 * drift. Responses are kept whole, as parsed SSE events with their timing.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ApiFormat, RequestFingerprint, SseEvent } from './wire'

export const CASSETTE_DIR = join(import.meta.dir, 'cassettes')

export type RecordedResponse = {
  status: number
  contentType: string
  /** Milliseconds from the request to the response headers (model latency). */
  firstByteMs?: number
  /** Streamed body. `dt` is milliseconds since the previous event. */
  events?: Array<SseEvent & { dt: number }>
  /** Non-streamed JSON body. */
  json?: unknown
  /** Any other body, such as an error page. */
  text?: string
}

export type Interaction = {
  seq: number
  path: string
  /** Requests are matched in order within a queue; see `queueKey`. */
  queue: string
  request: RequestFingerprint & { systemSha: string; toolsSha: string }
  response: RecordedResponse
  /** Tool call ids in the response; the next request in the queue must answer them. */
  toolUseIds: string[]
}

export type Cassette = {
  schemaVersion: 1
  id: string
  format: ApiFormat
  recordedWith: { provider: string; model: string; date: string }
  /**
   * The provider settings the recording ran with, minus key and base URL. A
   * replay registers the same settings, so preset-specific behaviour (model
   * mapping, context window, request compatibility) matches the recording.
   */
  providerConfig: Record<string, unknown>
  interactions: Interaction[]
}

/** Provider fields that shape requests. Never the key, never the base URL. */
export const REPLAYED_PROVIDER_FIELDS = [
  'presetId', 'authStrategy', 'apiFormat', 'runtimeKind', 'models', 'model1mSupport',
  'autoCompactWindow', 'modelContextWindows', 'toolSearchEnabled', 'disableExperimentalBetas',
  'supportsNestedToolResultMedia', 'requestCompatibility',
] as const

export function sha(value: unknown) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex').slice(0, 12)
}

/**
 * The CLI sends several kinds of model calls, some concurrently: the main
 * agent loop, subagents, teammates in an agent team, and tool-less side calls
 * such as a session title. Each is its own ordered queue, so their interleaving
 * does not matter. An agent loop (a request that offers tools) is identified by
 * its first user message, the prompt that started it; a tool list that changed
 * since recording is drift, not a different queue. Side calls are told apart by
 * the first line of their system prompt, which is a fixed template.
 *
 * `fingerprint` must already be normalised, or the key would differ per run.
 */
export function queueKey(path: string, fingerprint: RequestFingerprint, normalizedSystem: string): string {
  if (/count_tokens/.test(path)) return 'count_tokens'
  // A clock-minted value (learned per run, see normalize.ts) must not change the queue.
  if (fingerprint.toolNames.length > 0) return `agent:${sha(fingerprint.firstUserText.replace(/\{\{V\d+\}\}|\b1[6-9]\d{11}\b/g, '{{V}}'))}`
  const firstLine = normalizedSystem.split('\n').find((line) => line.trim()) ?? ''
  return `plain:${sha(firstLine.slice(0, 200))}`
}

/** Queues whose order and count a replay enforces. Side calls are best effort. */
export function isStrictQueue(queue: string) {
  return queue.startsWith('agent:')
}

export function systemText(format: ApiFormat, body: Record<string, unknown>): string {
  if (format === 'anthropic') {
    const system = body.system
    if (typeof system === 'string') return system
    if (Array.isArray(system)) return system.map((part) => (part as { text?: string }).text ?? '').join('\n')
    return ''
  }
  const messages = Array.isArray(body.messages) ? body.messages as Array<{ role?: string; content?: unknown }> : []
  return messages
    .filter((message) => message.role === 'system' || message.role === 'developer')
    .map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
    .join('\n')
}

export function cassettePath(id: string, dir = CASSETTE_DIR) {
  return join(dir, `${id}.json`)
}

export function loadCassette(id: string, dir = CASSETTE_DIR): Cassette | null {
  const path = cassettePath(id, dir)
  if (!existsSync(path)) return null
  const cassette = JSON.parse(readFileSync(path, 'utf8')) as Cassette
  if (cassette.schemaVersion !== 1 || cassette.id !== id || !Array.isArray(cassette.interactions)) {
    throw new Error(`${path} is not a schemaVersion 1 cassette for ${id}`)
  }
  return cassette
}

/** Pretty JSON with one SSE event per line, so a re-recording diffs event by event. */
export function serializeCassette(cassette: Cassette): string {
  const streams: string[] = []
  const marked = {
    ...cassette,
    interactions: cassette.interactions.map((interaction) => interaction.response.events
      ? { ...interaction, response: { ...interaction.response, events: `@@events:${streams.push(interaction.response.events.map((event) => JSON.stringify(event)).join(',\n      ')) - 1}@@` } }
      : interaction),
  }
  return `${JSON.stringify(marked, null, 2).replace(/"@@events:(\d+)@@"/g, (_, index: string) => `[\n      ${streams[Number(index)]}\n     ]`)}\n`
}

export function saveCassette(cassette: Cassette, dir = CASSETTE_DIR) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(cassettePath(cassette.id, dir), serializeCassette(cassette))
}

export function listCassetteIds(dir = CASSETTE_DIR) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)).sort()
}
