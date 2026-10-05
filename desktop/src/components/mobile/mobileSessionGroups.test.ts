import { describe, expect, it } from 'vitest'
import type { SessionListItem } from '../../types/session'
import {
  buildMobileSessionGroups,
  filterMobileSessions,
  listMobileProjectFilters,
} from './mobileSessionGroups'

const NOW = new Date('2026-10-06T12:00:00').getTime()

function session(id: string, modifiedAt: string, projectRoot = '/work/cc-haha', title = id): SessionListItem {
  return {
    id,
    title,
    createdAt: modifiedAt,
    modifiedAt,
    messageCount: 1,
    projectPath: projectRoot,
    projectRoot,
    workDir: projectRoot,
    workDirExists: true,
  }
}

describe('buildMobileSessionGroups', () => {
  it('puts waiting sessions first, then working ones, then the day buckets', () => {
    const groups = buildMobileSessionGroups(
      [
        session('old', '2026-09-01T10:00:00'),
        session('today', '2026-10-06T09:00:00'),
        session('working', '2026-10-05T10:00:00'),
        session('waiting', '2026-09-20T10:00:00'),
      ],
      new Set(['working', 'waiting']),
      new Set(['waiting']),
      NOW,
    )

    expect(groups.map((group) => [group.id, group.sessions.map((item) => item.id)])).toEqual([
      ['attention', ['waiting']],
      ['running', ['working']],
      ['today', ['today']],
      ['earlier', ['old']],
    ])
  })

  it('lists a session once even when it is both running and waiting', () => {
    const groups = buildMobileSessionGroups(
      [session('both', '2026-10-06T09:00:00')],
      new Set(['both']),
      new Set(['both']),
      NOW,
    )

    expect(groups.flatMap((group) => group.sessions.map((item) => item.id))).toEqual(['both'])
    expect(groups[0]?.id).toBe('attention')
  })

  it('omits the waiting section when nothing waits', () => {
    const groups = buildMobileSessionGroups([session('a', '2026-10-06T09:00:00')], new Set(), new Set(), NOW)
    expect(groups.map((group) => group.id)).toEqual(['today'])
  })
})

describe('mobile session filters', () => {
  const sessions = [
    session('a', '2026-10-01T10:00:00', '/work/cc-haha', 'Fix login i18n'),
    session('b', '2026-10-06T10:00:00', '/work/crawler', 'Export comments'),
    session('c', '2026-10-03T10:00:00', '/work/cc-haha', 'Release notes'),
  ]

  it('orders project chips by their most recent session', () => {
    const filters = listMobileProjectFilters(sessions, (item) => item.projectRoot ?? '')
    expect(filters.map((filter) => filter.key)).toEqual(['/work/crawler', '/work/cc-haha'])
  })

  it('narrows by project and by a case-insensitive title match together', () => {
    expect(filterMobileSessions(sessions, { projectKey: '/work/cc-haha', query: '' }).map((item) => item.id))
      .toEqual(['a', 'c'])
    expect(filterMobileSessions(sessions, { projectKey: '/work/cc-haha', query: 'LOGIN' }).map((item) => item.id))
      .toEqual(['a'])
    expect(filterMobileSessions(sessions, { projectKey: null, query: '  ' }).map((item) => item.id))
      .toEqual(['a', 'b', 'c'])
  })
})
