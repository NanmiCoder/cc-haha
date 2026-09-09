import type { SessionApiFormat, SessionProtocolState } from '../../shared/sessionProtocol.js'
import { resolveProviderApiFormat, isSessionApiFormat } from '../../shared/sessionProtocol.js'
import { parseOpenAIReasoningEnvelope } from '../../utils/openAIReasoningEnvelope.js'

export class SessionProtocolError extends Error {
  readonly statusCode = 409
  readonly code: 'SESSION_PROTOCOL_UNRESOLVED' | 'SESSION_PROTOCOL_MISMATCH'
  constructor(
    public readonly currentFormat: SessionProtocolState,
    public readonly requestedFormat: SessionApiFormat,
  ) {
    super(
      currentFormat === 'mixed' || currentFormat === 'unknown'
        ? `This session's API protocol is ${currentFormat}. Start a new session to use ${requestedFormat}.`
        : `This session uses ${currentFormat}; switching to ${requestedFormat} requires a new session.`)
    this.name = 'SessionProtocolError'
    this.code = currentFormat === 'mixed' || currentFormat === 'unknown'
      ? 'SESSION_PROTOCOL_UNRESOLVED'
      : 'SESSION_PROTOCOL_MISMATCH'
  }
}

export function assertSessionApiFormat(
  current: SessionProtocolState | undefined,
  requested: SessionApiFormat,
): void {
  if (current && current !== requested) throw new SessionProtocolError(current, requested)
}

type HistoryEntry = {
  type?: string
  isMeta?: boolean
  message?: { id?: unknown; role?: string; model?: string; content?: unknown }
  [key: string]: unknown
}

/** Derives a read-only forward view of old transcripts; never guesses from model names
 * or today's mutable saved-provider configuration. The durable lock is additive metadata. */
type ProtocolAccumulatorSeed = {
  formats: Set<SessionApiFormat>
  lockedFormat?: SessionProtocolState
  runtimeFormat?: SessionApiFormat
  hasMessages: boolean
  userFormat?: SessionApiFormat
  hasAssistant: boolean
  unknownResponses: Set<string>
  knownResponses: Set<string>
  anonymousResponseCount: number
}

type SessionProtocolAccumulator = {
  clone(): SessionProtocolAccumulator
  add(entry: HistoryEntry): void
  get(): SessionProtocolState | undefined
}

export function createSessionProtocolAccumulator(seed?: ProtocolAccumulatorSeed): SessionProtocolAccumulator {
  const formats = new Set<SessionApiFormat>(seed?.formats)
  let lockedFormat = seed?.lockedFormat
  let runtimeFormat = seed?.runtimeFormat
  let hasMessages = seed?.hasMessages ?? false
  let userFormat = seed?.userFormat
  let hasAssistant = seed?.hasAssistant ?? false
  const unknownResponses = new Set(seed?.unknownResponses)
  const knownResponses = new Set(seed?.knownResponses)
  let anonymousResponseCount = seed?.anonymousResponseCount ?? 0

  return {
    clone() {
      return createSessionProtocolAccumulator({
        formats, lockedFormat, runtimeFormat, hasMessages, userFormat, hasAssistant,
        unknownResponses, knownResponses, anonymousResponseCount,
      })
    },
    add(entry: HistoryEntry): void {
      if (entry.type === 'session-meta') {
        const format = entry.sessionApiFormat
        if (isSessionApiFormat(format)) {
          formats.add(format)
          lockedFormat = format
        } else if (format === 'mixed' || format === 'unknown') {
          lockedFormat = format
        } else if (format !== undefined) {
          lockedFormat = 'unknown'
        }
        // These explicit routing snapshots are usable when present in imported
        // history. Merely selecting a route does not count as having used it.
        if (isSessionApiFormat(entry.runtimeApiFormat)) {
          runtimeFormat = entry.runtimeApiFormat
        } else if (Object.prototype.hasOwnProperty.call(entry, 'runtimeProviderId')) {
          runtimeFormat = resolveProviderApiFormat(entry.runtimeProviderId as string | null)
        }
        return
      }
      if (entry.isMeta || (entry.type !== 'user' && entry.type !== 'assistant') || !entry.message?.role) return
      if (entry.type === 'assistant' && entry.message.model === '<synthetic>') return
      hasMessages = true
      if (entry.type !== 'assistant') {
        userFormat = runtimeFormat
        return
      }
      hasAssistant = true
      const hasResponsesEnvelope = Array.isArray(entry.message.content) && entry.message.content.some(block => (
        block && typeof block === 'object' && block.type === 'redacted_thinking' &&
        typeof block.data === 'string' && parseOpenAIReasoningEnvelope(block.data) !== null
      ))
      const format = hasResponsesEnvelope ? 'openai_responses' : runtimeFormat
      // One streamed reply may occupy several JSONL content-block entries.
      const responseId = typeof entry.message.id === 'string'
        ? entry.message.id
        : `anonymous:${++anonymousResponseCount}`
      if (format) {
        formats.add(format)
        knownResponses.add(responseId)
        unknownResponses.delete(responseId)
      } else if (!knownResponses.has(responseId)) {
        unknownResponses.add(responseId)
      }
    },
    get(): SessionProtocolState | undefined {
      if (formats.size > 1 || lockedFormat === 'mixed') return 'mixed'
      if (lockedFormat) return lockedFormat
      if (!hasMessages) return undefined
      if (unknownResponses.size > 0) return 'unknown'
      if (!hasAssistant) return userFormat ?? 'unknown'
      return formats.values().next().value ?? 'unknown'
    },
  }
}

export function inferSessionApiFormat(entries: HistoryEntry[]): SessionProtocolState | undefined {
  const accumulator = createSessionProtocolAccumulator()
  for (const entry of entries) accumulator.add(entry)
  return accumulator.get()
}
