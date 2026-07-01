import { describe, expect, it } from 'vitest'
import { pickReusableEmptySession } from './sessionReuse'

const baseSession = {
  workDir: '/tmp/proj-a',
  messageCount: 0,
  modifiedAt: '2026-06-10T00:00:00.000Z',
}

describe('pickReusableEmptySession', () => {
  it('returns the most recently-modified empty session in the same workDir', () => {
    const sessions = [
      { ...baseSession, id: 'older', modifiedAt: '2026-06-10T08:00:00.000Z' },
      { ...baseSession, id: 'fresh', modifiedAt: '2026-06-10T12:00:00.000Z' },
      { ...baseSession, id: 'oldest', modifiedAt: '2026-06-09T00:00:00.000Z' },
    ]
    expect(pickReusableEmptySession(sessions, '/tmp/proj-a')).toBe('fresh')
  })

  it('skips sessions in a different workDir', () => {
    const sessions = [
      { ...baseSession, id: 'wrong-dir', workDir: '/tmp/proj-b' },
    ]
    expect(pickReusableEmptySession(sessions, '/tmp/proj-a')).toBeNull()
  })

  it('skips sessions with any messages (never corrupt user history)', () => {
    const sessions = [
      { ...baseSession, id: 'has-msgs', messageCount: 1 },
      { ...baseSession, id: 'has-many', messageCount: 42 },
    ]
    expect(pickReusableEmptySession(sessions, '/tmp/proj-a')).toBeNull()
  })

  it('skips sessions matching excludeSessionId so the previous session is never reused as the target', () => {
    const sessions = [
      { ...baseSession, id: 'previous-session-being-handed-off-from' },
      { ...baseSession, id: 'reusable', modifiedAt: '2026-06-10T05:00:00.000Z' },
    ]
    expect(
      pickReusableEmptySession(sessions, '/tmp/proj-a', 'previous-session-being-handed-off-from'),
    ).toBe('reusable')
  })

  it('treats null workDir as "no candidates" so we never silently merge non-project sessions', () => {
    const sessions = [{ ...baseSession, id: 'home-dir', workDir: null }]
    expect(pickReusableEmptySession(sessions, '/tmp/proj-a')).toBeNull()
  })

  it('returns null when the requested workDir is empty (defensive — caller must already gate on workDir)', () => {
    expect(pickReusableEmptySession([{ ...baseSession, id: 's1' }], '')).toBeNull()
  })

  it('returns null on empty session list', () => {
    expect(pickReusableEmptySession([], '/tmp/proj-a')).toBeNull()
  })
})
