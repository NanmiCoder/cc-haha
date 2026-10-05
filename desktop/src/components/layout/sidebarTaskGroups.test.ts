import { describe, expect, it } from 'vitest'
import type { SessionListItem } from '../../types/session'
import {
  buildSidebarTaskGroups,
  getSessionWorkspaceLabel,
  isWorktreeSession,
  type SidebarTaskGroupId,
} from './sidebarTaskGroups'

function makeSession(overrides: Partial<SessionListItem> & { id: string }): SessionListItem {
  return {
    title: `Session ${overrides.id}`,
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

/** 本地时间构造，避免测试跟着运行机器的时区漂。 */
function localIso(year: number, month: number, day: number, hour = 12, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString()
}

function localTime(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

const NO_DISPLAY_NAME = () => null

function groupIds(groups: ReturnType<typeof buildSidebarTaskGroups>): SidebarTaskGroupId[] {
  return groups.map((group) => group.id)
}

function sessionIdsIn(
  groups: ReturnType<typeof buildSidebarTaskGroups>,
  id: SidebarTaskGroupId,
): string[] {
  return groups.find((group) => group.id === id)?.sessions.map((session) => session.id) ?? []
}

describe('buildSidebarTaskGroups', () => {
  it('buckets by calendar day, not by elapsed hours', () => {
    // 23:50 收工，第二天 00:10 打开：只差 20 分钟，但它属于昨天。
    const lateLastNight = makeSession({ id: 'late', modifiedAt: localIso(2026, 8, 22, 23, 50) })
    const now = localTime(2026, 8, 23, 0, 10)

    const groups = buildSidebarTaskGroups([lateLastNight], new Set(), now)

    expect(groupIds(groups)).toEqual(['yesterday'])
  })

  it('splits the five time buckets in order', () => {
    const now = localTime(2026, 8, 23, 12, 0)
    const sessions = [
      makeSession({ id: 'earlier', modifiedAt: localIso(2026, 5, 15) }),
      makeSession({ id: 'today', modifiedAt: localIso(2026, 8, 23, 9) }),
      makeSession({ id: 'last30', modifiedAt: localIso(2026, 8, 3) }),
      makeSession({ id: 'yesterday', modifiedAt: localIso(2026, 8, 22) }),
      makeSession({ id: 'last7', modifiedAt: localIso(2026, 8, 20) }),
    ]

    const groups = buildSidebarTaskGroups(sessions, new Set(), now)

    expect(groupIds(groups)).toEqual(['today', 'yesterday', 'last7Days', 'last30Days', 'earlier'])
    expect(sessionIdsIn(groups, 'today')).toEqual(['today'])
    expect(sessionIdsIn(groups, 'yesterday')).toEqual(['yesterday'])
    expect(sessionIdsIn(groups, 'last7Days')).toEqual(['last7'])
    expect(sessionIdsIn(groups, 'last30Days')).toEqual(['last30'])
    expect(sessionIdsIn(groups, 'earlier')).toEqual(['earlier'])
  })

  // now = 2026-08-23。每个用例都钉住一侧的桶边界，写反了会红。
  it.each([
    ['seven days ago is still last7Days', 8, 16, 'last7Days'],
    ['eight days ago rolls into last30Days', 8, 15, 'last30Days'],
    ['thirty days ago is still last30Days', 7, 24, 'last30Days'],
    ['thirty-one days ago rolls into earlier', 7, 23, 'earlier'],
  ])('%s', (_label, month, dayOfMonth, expected) => {
    const now = localTime(2026, 8, 23, 12, 0)
    const session = makeSession({ id: 'edge', modifiedAt: localIso(2026, month, dayOfMonth) })

    expect(groupIds(buildSidebarTaskGroups([session], new Set(), now))).toEqual([expected])
  })

  it('hoists running sessions out of their time bucket instead of listing them twice', () => {
    const now = localTime(2026, 8, 23, 12, 0)
    const finished = makeSession({ id: 'finished', modifiedAt: localIso(2026, 8, 23, 10) })
    const running = makeSession({ id: 'running', modifiedAt: localIso(2026, 8, 23, 11) })

    const groups = buildSidebarTaskGroups([finished, running], new Set(['running']), now)

    expect(groupIds(groups)).toEqual(['running', 'today'])
    expect(sessionIdsIn(groups, 'running')).toEqual(['running'])
    expect(sessionIdsIn(groups, 'today')).toEqual(['finished'])
  })

  it('omits empty groups so the caller can map straight over the result', () => {
    const now = localTime(2026, 8, 23, 12, 0)
    const session = makeSession({ id: 'only', modifiedAt: localIso(2026, 8, 23, 8) })

    expect(buildSidebarTaskGroups([session], new Set(), now)).toHaveLength(1)
  })

  it('returns no groups at all for an empty session list', () => {
    expect(buildSidebarTaskGroups([], new Set(), localTime(2026, 8, 23))).toEqual([])
  })

  it('orders each group newest first', () => {
    const now = localTime(2026, 8, 23, 12, 0)
    const sessions = [
      makeSession({ id: 'morning', modifiedAt: localIso(2026, 8, 23, 8) }),
      makeSession({ id: 'noon', modifiedAt: localIso(2026, 8, 23, 11, 30) }),
      makeSession({ id: 'dawn', modifiedAt: localIso(2026, 8, 23, 6) }),
    ]

    const groups = buildSidebarTaskGroups(sessions, new Set(), now)

    expect(sessionIdsIn(groups, 'today')).toEqual(['noon', 'morning', 'dawn'])
  })

  it('orders the running group newest first too', () => {
    const now = localTime(2026, 8, 23, 12, 0)
    const sessions = [
      makeSession({ id: 'older', modifiedAt: localIso(2026, 8, 20) }),
      makeSession({ id: 'newer', modifiedAt: localIso(2026, 8, 23, 11) }),
    ]

    const groups = buildSidebarTaskGroups(sessions, new Set(['older', 'newer']), now)

    expect(sessionIdsIn(groups, 'running')).toEqual(['newer', 'older'])
  })

  it('drops an unparseable timestamp into earlier rather than today', () => {
    const now = localTime(2026, 8, 23, 12, 0)
    const broken = makeSession({ id: 'broken', modifiedAt: 'not-a-date' })

    expect(groupIds(buildSidebarTaskGroups([broken], new Set(), now))).toEqual(['earlier'])
  })

  it('keeps a future timestamp in today instead of pushing it past every bucket', () => {
    const now = localTime(2026, 8, 23, 12, 0)
    const skewed = makeSession({ id: 'skewed', modifiedAt: localIso(2026, 8, 25) })

    expect(groupIds(buildSidebarTaskGroups([skewed], new Set(), now))).toEqual(['today'])
  })
})

describe('getSessionWorkspaceLabel', () => {
  it('prefers the user-set project display name', () => {
    const session = makeSession({ id: 'a', projectRoot: '/Users/dev/work/alpha' })

    expect(getSessionWorkspaceLabel(session, (key) =>
      key === '/Users/dev/work/alpha' ? '雷鸟 AI 眼镜' : null)).toBe('雷鸟 AI 眼镜')
  })

  it('falls back to the last path segment when there is no display name', () => {
    const session = makeSession({ id: 'a', projectRoot: '/Users/dev/work/claude-code-haha' })

    expect(getSessionWorkspaceLabel(session, NO_DISPLAY_NAME)).toBe('claude-code-haha')
  })

  it('falls back to workDir when the session has no projectRoot', () => {
    const session = makeSession({ id: 'a', projectRoot: null, workDir: '/Users/dev/work/beta' })

    expect(getSessionWorkspaceLabel(session, NO_DISPLAY_NAME)).toBe('beta')
  })

  it('looks the display name up under the same key the sidebar groups by', () => {
    // projectRoot 缺失时分组 key 退到 workDir；显示名必须跟着退，否则任务视图
    // 会对同一个工作区显示两个不同的名字。
    const session = makeSession({ id: 'a', projectRoot: null, workDir: '/Users/dev/work/beta' })

    expect(getSessionWorkspaceLabel(session, (key) =>
      key === '/Users/dev/work/beta' ? 'Beta 工作区' : null)).toBe('Beta 工作区')
  })
})

describe('isWorktreeSession', () => {
  it('flags a .claude/worktrees checkout', () => {
    expect(isWorktreeSession(makeSession({
      id: 'a',
      projectRoot: '/Users/dev/work/alpha',
      workDir: '/Users/dev/work/alpha/.claude/worktrees/feature',
    }))).toBe(true)
  })

  it('does not flag the project root itself', () => {
    expect(isWorktreeSession(makeSession({
      id: 'a',
      projectRoot: '/Users/dev/work/alpha',
      workDir: '/Users/dev/work/alpha',
    }))).toBe(false)
  })

  it('does not flag a subdirectory of the project root', () => {
    expect(isWorktreeSession(makeSession({
      id: 'a',
      projectRoot: '/Users/dev/work/alpha',
      workDir: '/Users/dev/work/alpha/packages/web',
    }))).toBe(false)
  })

  it('flags a workDir that lives outside the project root', () => {
    expect(isWorktreeSession(makeSession({
      id: 'a',
      projectRoot: '/Users/dev/work/alpha',
      workDir: '/Users/dev/work/alpha-experiment',
    }))).toBe(true)
  })

  // git resolves the root through the macOS `/var` → `/private/var` symlink
  // while the work dir keeps the shell's spelling. Without folding the alias,
  // every session under a temp dir wore the worktree branch glyph.
  it.each([
    ['/private/var/folders/x/T/proj', '/var/folders/x/T/proj'],
    ['/var/folders/x/T/proj', '/private/var/folders/x/T/proj/src'],
    ['/private/tmp/proj', '/tmp/proj'],
  ])('does not flag a work dir that is the root %s spelled through /private', (projectRoot, workDir) => {
    expect(isWorktreeSession(makeSession({ id: 'a', projectRoot, workDir }))).toBe(false)
  })

  it('still flags a sibling checkout behind the /private alias', () => {
    expect(isWorktreeSession(makeSession({
      id: 'a',
      projectRoot: '/private/var/folders/x/T/proj',
      workDir: '/var/folders/x/T/proj-feature',
    }))).toBe(true)
  })
})
