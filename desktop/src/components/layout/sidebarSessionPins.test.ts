import { beforeEach, describe, expect, it } from 'vitest'
import type { MessageEntry, SessionListItem } from '../../types/session'
import {
  ARCHIVED_SESSIONS_GROUP_KEY,
  PINNED_SESSIONS_GROUP_KEY,
  buildSessionTranscriptMarkdown,
  groupPinnedAndArchivedSessions,
  isSyntheticSessionGroupKey,
  readStoredArchivedSessions,
  readStoredSessionPins,
  sessionMarkdownFileName,
  toggleIdInSet,
  writeStoredArchivedSessions,
  writeStoredSessionPins,
  type SidebarSessionGroup,
} from './sidebarSessionPins'

function makeSession(id: string, overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id,
    title: `Session ${id}`,
    createdAt: '2026-08-01T00:00:00.000Z',
    modifiedAt: '2026-08-01T00:00:00.000Z',
    messageCount: 2,
    projectPath: '/Users/dev/.claude/projects/encoded',
    projectRoot: '/Users/dev/work/alpha',
    workDir: '/Users/dev/work/alpha',
    workDirExists: true,
    ...overrides,
  }
}

function makeGroup(key: string, sessions: SessionListItem[]): SidebarSessionGroup {
  return { key, title: key, subtitle: null, workDir: `/work/${key}`, sessions }
}

const LABELS = { pinned: 'Pinned sessions', archived: 'Archived' }

describe('sidebar session pin and archive storage', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('round-trips pinned and archived session ids', () => {
    writeStoredSessionPins(new Set(['a', 'b']))
    writeStoredArchivedSessions(new Set(['c']))

    expect([...readStoredSessionPins()]).toEqual(['a', 'b'])
    expect([...readStoredArchivedSessions()]).toEqual(['c'])
  })

  it('ignores malformed stored payloads instead of throwing', () => {
    window.localStorage.setItem('cc-haha-sidebar-pinned-sessions', '{not json')
    window.localStorage.setItem('cc-haha-sidebar-archived-sessions', '{"a":1}')

    expect(readStoredSessionPins().size).toBe(0)
    expect(readStoredArchivedSessions().size).toBe(0)
  })
})

describe('groupPinnedAndArchivedSessions', () => {
  it('returns the input untouched when nothing is pinned or archived', () => {
    const groups = [makeGroup('alpha', [makeSession('a')])]

    expect(groupPinnedAndArchivedSessions(groups, new Set(), new Set(), LABELS)).toBe(groups)
  })

  it('lifts pinned sessions into a leading group and archived into a trailing one', () => {
    const groups = [
      makeGroup('alpha', [makeSession('a1'), makeSession('a2')]),
      makeGroup('beta', [makeSession('b1')]),
    ]

    const result = groupPinnedAndArchivedSessions(
      groups,
      new Set(['a2']),
      new Set(['b1']),
      LABELS,
    )

    expect(result.map((group) => group.key)).toEqual([
      PINNED_SESSIONS_GROUP_KEY,
      'alpha',
      ARCHIVED_SESSIONS_GROUP_KEY,
    ])
    expect(result[0]?.sessions.map((session) => session.id)).toEqual(['a2'])
    expect(result[0]?.title).toBe('Pinned sessions')
    expect(result[1]?.sessions.map((session) => session.id)).toEqual(['a1'])
    expect(result[2]?.sessions.map((session) => session.id)).toEqual(['b1'])
    expect(result[2]?.title).toBe('Archived')
  })

  it('drops a project group that loses every session to pinning', () => {
    const groups = [makeGroup('alpha', [makeSession('a1')]), makeGroup('beta', [makeSession('b1')])]

    const result = groupPinnedAndArchivedSessions(groups, new Set(['a1']), new Set(), LABELS)

    expect(result.map((group) => group.key)).toEqual([PINNED_SESSIONS_GROUP_KEY, 'beta'])
  })

  it('moves each session exactly once so no row renders twice', () => {
    const groups = [makeGroup('alpha', [makeSession('a1')])]

    const result = groupPinnedAndArchivedSessions(groups, new Set(['a1']), new Set(), LABELS)

    const renderedIds = result.flatMap((group) => group.sessions.map((session) => session.id))
    expect(renderedIds).toEqual(['a1'])
  })

  it('prefers pinning when a session is in both sets', () => {
    const groups = [makeGroup('alpha', [makeSession('a1')])]

    const result = groupPinnedAndArchivedSessions(groups, new Set(['a1']), new Set(['a1']), LABELS)

    expect(result.map((group) => group.key)).toEqual([PINNED_SESSIONS_GROUP_KEY])
  })

  it('treats the synthetic group keys as non-project keys', () => {
    expect(isSyntheticSessionGroupKey(PINNED_SESSIONS_GROUP_KEY)).toBe(true)
    expect(isSyntheticSessionGroupKey(ARCHIVED_SESSIONS_GROUP_KEY)).toBe(true)
    expect(isSyntheticSessionGroupKey('/Users/dev/work/alpha')).toBe(false)
  })
})

describe('toggleIdInSet', () => {
  it('adds then removes without mutating the input', () => {
    const original = new Set(['a'])
    const added = toggleIdInSet(original, 'b')
    const removed = toggleIdInSet(added, 'a')

    expect([...original]).toEqual(['a'])
    expect([...added]).toEqual(['a', 'b'])
    expect([...removed]).toEqual(['b'])
  })
})

describe('buildSessionTranscriptMarkdown', () => {
  const session = { id: 'session-1', title: 'Fix the sidebar' }

  it('renders the session header and every message', () => {
    const messages: MessageEntry[] = [
      { id: 'm1', type: 'user', content: 'hello', timestamp: '2026-08-01T10:00:00.000Z' },
      { id: 'm2', type: 'assistant', content: [{ type: 'text', text: 'hi there' }], timestamp: '2026-08-01T10:00:01.000Z' },
    ]

    const markdown = buildSessionTranscriptMarkdown(session, messages, {
      projectPath: '/Users/dev/work/alpha',
      sessionFilePath: '/Users/dev/.claude/projects/encoded/session-1.jsonl',
      exportedAt: '2026-08-02T00:00:00.000Z',
    })

    expect(markdown).toContain('# Fix the sidebar')
    expect(markdown).toContain('- Session ID: session-1')
    expect(markdown).toContain('- Session Path: /Users/dev/.claude/projects/encoded/session-1.jsonl')
    expect(markdown).toContain('## user - 2026-08-01T10:00:00.000Z')
    expect(markdown).toContain('hello')
    expect(markdown).toContain('## assistant - 2026-08-01T10:00:01.000Z')
    expect(markdown).toContain('hi there')
  })

  it('falls back to a JSON block for structured content and never emits undefined', () => {
    const messages: MessageEntry[] = [
      { id: 'm1', type: 'tool_use', content: { name: 'Read', input: { file: 'a.ts' } }, timestamp: '' },
    ]

    const markdown = buildSessionTranscriptMarkdown(session, messages)

    expect(markdown).toContain('```json')
    expect(markdown).toContain('"name": "Read"')
    expect(markdown).not.toContain('undefined')
  })

  it('uses the untitled fallback when a session has no title', () => {
    const markdown = buildSessionTranscriptMarkdown({ id: 'session-2', title: '' }, [])

    expect(markdown.startsWith('# Untitled')).toBe(true)
  })
})

describe('sessionMarkdownFileName', () => {
  it('strips characters that are illegal in file names', () => {
    expect(sessionMarkdownFileName('a/b:c*d?e"f<g>h|i', 'session-1'))
      .toBe('a_b_c_d_e_f_g_h_i-session-1.md')
  })

  it('falls back to a generic name for an empty title', () => {
    expect(sessionMarkdownFileName('   ', 'session-1')).toBe('session-session-1.md')
  })
})
