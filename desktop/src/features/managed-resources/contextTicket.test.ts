import { describe, expect, it } from 'vitest'
import {
  prepareContextTicket,
  attachEntriesToTicket,
  isReplayable,
  ContextTicketCache,
} from './contextTicket'

const sampleUuid = '6a9e6023-6fc8-4ae1-80bc-4ef8e0f55f72'

describe('M7 contextTicket', () => {
  it('prepareContextTicket refuses includePasswords=true with SECRET_DISCLOSURE_NOT_READY', () => {
    const result = prepareContextTicket({
      sessionId: 'sess-1',
      sourceTags: [],
      directIds: [],
      includePasswords: true,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SECRET_DISCLOSURE_NOT_READY')
  })

  it('prepareContextTicket returns a public manifest for includePasswords=false', () => {
    const result = prepareContextTicket({
      sessionId: 'sess-1',
      sourceTags: [{ namespace: 'host', id: 'production' }],
      directIds: [{ namespace: 'host', id: sampleUuid }],
      includePasswords: false,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.ticket.containsSecrets).toBe(false)
      expect(result.ticket.secretFieldCount).toBe(0)
      expect(result.ticket.requestId).toMatch(/^ticket_/)
      expect(result.ticket.sessionId).toBe('sess-1')
    }
  })

  it('prepareContextTicket caps the manifest at 64 KiB', () => {
    const huge: Array<{ namespace: 'host'; id: string }> = []
    for (let i = 0; i < 4000; i++) {
      huge.push({ namespace: 'host', id: 'a'.repeat(50) + '_' + i })
    }
    const result = prepareContextTicket({
      sessionId: 'sess-huge',
      sourceTags: huge,
      directIds: [],
      includePasswords: false,
    })
    // sourceTags alone fit (each tag id ~50 chars * 4000 = 200k chars > 64k).
    // So we expect INVALID_ARGUMENT.
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_ARGUMENT')
  })

  it('attachEntriesToTicket never adds containsSecrets=true', () => {
    const prepared = prepareContextTicket({
      sessionId: 'sess-1',
      sourceTags: [],
      directIds: [{ namespace: 'host', id: sampleUuid }],
      includePasswords: false,
    })
    expect(prepared.ok).toBe(true)
    if (prepared.ok) {
      const result = attachEntriesToTicket(prepared.ticket, [
        { kind: 'host', hostId: sampleUuid, name: 'prod', address: '10.0.0.1', tagIds: ['prod'] },
        { kind: 'concept', conceptId: sampleUuid, title: 'Glossary', summary: 'Look here' },
      ])
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.ticket.containsSecrets).toBe(false)
        expect(result.ticket.entries.length).toBe(2)
        expect(result.ticket.estimatedTokens).toBeGreaterThan(0)
      }
    }
  })

  it('isReplayable rejects tickets older than the replay window', () => {
    const prepared = prepareContextTicket({
      sessionId: 'sess-1',
      sourceTags: [],
      directIds: [{ namespace: 'host', id: sampleUuid }],
      includePasswords: false,
    })
    expect(prepared.ok).toBe(true)
    if (prepared.ok) {
      const future = Date.now() + 6 * 60 * 1000
      expect(isReplayable(prepared.ticket, future)).toBe(false)
    }
  })

  it('ContextTicketCache stores, returns, and evicts stale tickets', () => {
    const cache = new ContextTicketCache()
    const prepared = prepareContextTicket({
      sessionId: 'sess-1',
      sourceTags: [],
      directIds: [{ namespace: 'host', id: sampleUuid }],
      includePasswords: false,
    })
    expect(prepared.ok).toBe(true)
    if (prepared.ok) {
      cache.put(prepared.ticket)
      expect(cache.get(prepared.ticket.requestId)).not.toBeNull()
      const future = Date.now() + 6 * 60 * 1000
      expect(cache.get(prepared.ticket.requestId, future)).toBeNull()
      expect(cache.size()).toBe(0)
    }
  })
})