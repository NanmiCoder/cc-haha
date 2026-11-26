import { describe, expect, it } from 'vitest'
import type { SessionListItem } from '../../types/session'
import {
  buildSearchableProjects,
  findHighlightRanges,
  searchProjects,
} from './projectSearch'

function makeSession(
  id: string,
  projectRoot: string,
  modifiedAt: string,
  overrides?: Partial<SessionListItem>,
): SessionListItem {
  return {
    id,
    title: `Session ${id}`,
    createdAt: modifiedAt,
    modifiedAt,
    messageCount: 2,
    projectPath: projectRoot.replace(/[\\/]/g, '-'),
    projectRoot,
    workDir: projectRoot,
    workDirExists: true,
    ...overrides,
  }
}

describe('projectSearch', () => {
  it('groups non-archived sessions by project, honors custom display names, and retains archive-only projects', () => {
    const sessions = [
      makeSession('s1', '/Users/dev/code/cc-haha', '2026-06-02T00:00:00.000Z'),
      makeSession('s2', '/Users/dev/code/cc-haha', '2026-06-03T00:00:00.000Z'),
      makeSession('s3', '/Users/dev/code/cc-haha', '2026-06-04T00:00:00.000Z', { archived: true }),
      makeSession('s4', '/Users/dev/code/other-app', '2026-06-01T00:00:00.000Z'),
    ]
    const displayNames = new Map([['/Users/dev/code/cc-haha', 'Main Workspace']])

    const projects = buildSearchableProjects(
      sessions,
      { '/Users/dev/code/cc-haha': 12 },
      { '/Users/dev/code/archived-repo': 3 },
      (key) => displayNames.get(key) ?? null,
    )

    const main = projects.find((p) => p.key === '/Users/dev/code/cc-haha')
    expect(main).toMatchObject({
      title: 'Main Workspace',
      defaultTitle: 'cc-haha',
      path: '/Users/dev/code/cc-haha',
      sessionCount: 12,
      archivedCount: 0,
      modifiedAt: '2026-06-03T00:00:00.000Z',
    })
    expect(main?.latestSession?.id).toBe('s2')

    const archivedOnly = projects.find((p) => p.key === '/Users/dev/code/archived-repo')
    expect(archivedOnly).toMatchObject({
      title: 'archived-repo',
      sessionCount: 0,
      archivedCount: 3,
      latestSession: null,
    })
  })

  it('ignores stale projectSessionTotals entries that no longer have active or archived sessions', () => {
    const sessions = [
      makeSession('s1', '/Users/dev/code/active-repo', '2026-06-02T00:00:00.000Z'),
    ]

    const projects = buildSearchableProjects(
      sessions,
      {
        '/Users/dev/code/active-repo': 4,
        '/Users/dev/code/deleted-repo': 1,
      },
      {},
      () => null,
    )

    expect(projects.map((p) => p.key)).toEqual(['/Users/dev/code/active-repo'])
    expect(searchProjects(projects, 'deleted-repo')).toEqual([])
  })

  it('ranks exact title > prefix > substring > original folder name > path match, then recency', () => {
    const sessions = [
      makeSession('s-path', '/Users/dev/alpha-group/unrelated', '2026-06-10T00:00:00.000Z'),
      makeSession('s-renamed', '/Users/dev/code/alpha-orig', '2026-06-09T00:00:00.000Z'),
      makeSession('s-sub', '/Users/dev/code/my-alpha-app', '2026-06-08T00:00:00.000Z'),
      makeSession('s-prefix-old', '/Users/dev/code/alpha-old', '2026-06-01T00:00:00.000Z'),
      makeSession('s-prefix-new', '/Users/dev/code/alpha-new', '2026-06-07T00:00:00.000Z'),
      makeSession('s-exact', '/Users/dev/code/alpha', '2026-06-02T00:00:00.000Z'),
    ]
    const displayNames = new Map([['/Users/dev/code/alpha-orig', 'Renamed Service']])
    const projects = buildSearchableProjects(
      sessions,
      {},
      {},
      (key) => displayNames.get(key) ?? null,
    )

    const hits = searchProjects(projects, 'alpha')
    expect(hits.map((h) => h.key)).toEqual([
      '/Users/dev/code/alpha',
      '/Users/dev/code/alpha-new',
      '/Users/dev/code/alpha-old',
      '/Users/dev/code/my-alpha-app',
      '/Users/dev/code/alpha-orig',
      '/Users/dev/alpha-group/unrelated',
    ])

    // Exact title match highlights the whole title.
    expect(hits[0]?.titleHighlights).toEqual([{ start: 0, end: 5 }])
    // Renamed project matched by original folder name highlights path excerpt.
    expect(hits[4]?.title).toBe('Renamed Service')
    expect(hits[4]?.titleHighlights).toEqual([])
    expect(hits[4]?.displayPath).toContain('alpha-orig')
    expect(hits[4]?.pathHighlights.length).toBeGreaterThan(0)
    // Path-only match highlights the matched segment in the displayed path.
    expect(hits[5]?.displayPath).toContain('alpha-group')
    expect(hits[5]?.pathHighlights.length).toBeGreaterThan(0)
  })

  it('matches Windows paths with either slash style and supports CJK display names', () => {
    const sessions = [
      makeSession('w1', 'C:\\Users\\dev\\work\\billing-service', '2026-06-02T00:00:00.000Z'),
      makeSession('c1', '/Users/dev/fe-app', '2026-06-03T00:00:00.000Z'),
    ]
    const displayNames = new Map([['/Users/dev/fe-app', '前端主项目']])
    const projects = buildSearchableProjects(
      sessions,
      {},
      {},
      (key) => displayNames.get(key) ?? null,
    )

    expect(searchProjects(projects, 'work\\billing').map((p) => p.title)).toEqual(['billing-service'])
    expect(searchProjects(projects, 'work/billing').map((p) => p.title)).toEqual(['billing-service'])
    expect(searchProjects(projects, '主项目').map((p) => p.key)).toEqual(['/Users/dev/fe-app'])
  })

  it('returns empty results for blank queries and respects limit', () => {
    const sessions = [
      makeSession('1', '/w/proj-1', '2026-06-01T00:00:00.000Z'),
      makeSession('2', '/w/proj-2', '2026-06-02T00:00:00.000Z'),
      makeSession('3', '/w/proj-3', '2026-06-03T00:00:00.000Z'),
    ]
    const projects = buildSearchableProjects(sessions, {}, {}, () => null)

    expect(searchProjects(projects, '   ')).toEqual([])
    expect(searchProjects(projects, 'proj', 2)).toHaveLength(2)
  })

  it('finds all non-overlapping highlight ranges case-insensitively', () => {
    expect(findHighlightRanges('FooBarFoo', 'foo')).toEqual([
      { start: 0, end: 3 },
      { start: 6, end: 9 },
    ])
  })
})
