import { describe, expect, it } from 'vitest'
import {
  parseSlash,
  isValidDirectId,
  isValidTagId,
  mergePick,
  migrateDraftToSession,
  checkSlashAvailability,
  createDraftToken,
} from './contextPicker'

const sampleUuid = '6a9e6023-6fc8-4ae1-80bc-4ef8e0f55f72'

describe('M6 contextPicker', () => {
  it('parseSlash recognises /hh, /ce, /db, /rd and ignores other input', () => {
    expect(parseSlash('/hh list')).toEqual({ kind: 'command', command: 'hh' })
    expect(parseSlash('/ce something')).toEqual({ kind: 'command', command: 'ce' })
    expect(parseSlash('  /db')).toEqual({ kind: 'command', command: 'db' })
    expect(parseSlash('/rd')).toEqual({ kind: 'command', command: 'rd' })
    expect(parseSlash('hello')).toEqual({ kind: 'none' })
    expect(parseSlash(' / not_a_command')).toEqual({ kind: 'none' })
  })

  it('isValidDirectId accepts UUIDs and rejects junk', () => {
    expect(isValidDirectId(sampleUuid)).toBe(true)
    expect(isValidDirectId('not-a-uuid')).toBe(false)
    expect(isValidDirectId('')).toBe(false)
    expect(isValidDirectId('6a9e6023-6fc8-4ae1-80bc')).toBe(false)
  })

  it('isValidTagId accepts reasonable tag ids and rejects empty/unsafe', () => {
    expect(isValidTagId('production')).toBe(true)
    expect(isValidTagId('env.dev')).toBe(true)
    expect(isValidTagId('')).toBe(false)
    expect(isValidTagId('has space')).toBe(false)
  })

  it('mergePick union deduplicates and preserves draftId across mounts', () => {
    const draft1 = { sourceTags: [{ namespace: 'host' as const, id: 'a' }], directIds: [], draftId: 'd1' }
    const draft2 = { sourceTags: [{ namespace: 'host' as const, id: 'a' }, { namespace: 'host' as const, id: 'b' }], directIds: [], draftId: 'd2' }
    const merged = mergePick(draft1, draft2, 'union')
    expect(merged.sourceTags.length).toBe(2)
    expect(merged.draftId).toBe('d1') // draftId preserved for queue isolation
  })

  it('migrateDraftToSession refuses empty draft but commits valid one', () => {
    const empty = { sourceTags: [], directIds: [], draftId: 'd1' }
    expect(migrateDraftToSession(empty, 'sess-1').kind).toBe('cancelled')
    const valid = {
      sourceTags: [],
      directIds: [{ namespace: 'host' as const, id: sampleUuid }],
      draftId: 'd1',
    }
    const result = migrateDraftToSession(valid, 'sess-1')
    expect(result.kind).toBe('migrated')
  })

  it('checkSlashAvailability exposes all four M9 picker commands', () => {
    expect(checkSlashAvailability('hh')).toEqual({ available: true })
    expect(checkSlashAvailability('ce')).toEqual({ available: true })
    expect(checkSlashAvailability('db')).toEqual({ available: true })
    expect(checkSlashAvailability('rd')).toEqual({ available: true })
  })

  it('createDraftToken generates unique tokens per mount', () => {
    const a = createDraftToken()
    const b = createDraftToken()
    expect(a).not.toBe(b)
    expect(a.startsWith('draft_')).toBe(true)
    expect(b.startsWith('draft_')).toBe(true)
  })
})