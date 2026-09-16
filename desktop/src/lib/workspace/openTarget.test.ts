import { beforeEach, describe, expect, it, vi } from 'vitest'

type HoistedVi = typeof vi & { hoisted?: <T>(factory: () => T) => T }
if (typeof (vi as HoistedVi).hoisted !== 'function') {
  ;(vi as HoistedVi).hoisted = <T>(factory: () => T) => factory()
}

const mocks = vi.hoisted(() => ({
  destroyTerminalRuntime: vi.fn(),
  releaseWorkspaceBrowserTab: vi.fn(),
}))

vi.mock('../terminalRuntime', () => ({ destroyTerminalRuntime: mocks.destroyTerminalRuntime }))
vi.mock('./browserHost', () => ({ releaseWorkspaceBrowserTab: mocks.releaseWorkspaceBrowserTab }))

import { useTabStore } from '../../stores/tabStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { openWorkspaceTarget, workspaceOpen } from './openTarget'

const FOREGROUND = 'session-foreground'
const BACKGROUND = 'session-background'

beforeEach(() => {
  useWorkspaceStore.setState({ bySession: {} })
  useTabStore.setState({ tabs: [], activeTabId: FOREGROUND })
})

describe('openWorkspaceTarget', () => {
  it('activates what the foreground task asked for', () => {
    const id = openWorkspaceTarget({ sessionId: FOREGROUND, target: { kind: 'file', path: 'a.ts' } })
    expect(useWorkspaceStore.getState().getSession(FOREGROUND).activeSideTabId).toBe(id)
    expect(useWorkspaceStore.getState().getSession(FOREGROUND).layout).toBe('split')
  })

  it('lands a request for another task in that task and never steals focus', () => {
    const foregroundTab = openWorkspaceTarget({
      sessionId: FOREGROUND,
      target: { kind: 'file', path: 'a.ts' },
    })
    const backgroundTab = openWorkspaceTarget({
      sessionId: BACKGROUND,
      target: { kind: 'file', path: 'b.ts' },
    })

    expect(useWorkspaceStore.getState().getTabs(BACKGROUND, 'side')).toHaveLength(1)
    // The background task's own workspace still activates the new tab — what it
    // must not do is disturb the task the user is looking at.
    expect(useWorkspaceStore.getState().getSession(BACKGROUND).activeSideTabId).toBe(backgroundTab)
    expect(useWorkspaceStore.getState().getSession(FOREGROUND).activeSideTabId).toBe(foregroundTab)
  })

  it('honours an explicit background request even in the foreground task', () => {
    const first = workspaceOpen.file(FOREGROUND, 'a.ts')
    workspaceOpen.file(FOREGROUND, 'b.ts', { background: true })
    expect(useWorkspaceStore.getState().getSession(FOREGROUND).activeSideTabId).toBe(first)
  })

  it('passes preview through so a single click stays replaceable', () => {
    workspaceOpen.file(FOREGROUND, 'a.ts', { preview: true })
    workspaceOpen.file(FOREGROUND, 'b.ts', { preview: true })
    expect(useWorkspaceStore.getState().getTabs(FOREGROUND, 'side')).toHaveLength(1)
  })

  it('carries a line reference into the tab', () => {
    const id = workspaceOpen.file(FOREGROUND, 'a.ts', { line: 42, column: 3 })!
    expect(useWorkspaceStore.getState().getTab(FOREGROUND, id)).toMatchObject({
      reveal: { line: 42, column: 3 },
    })
  })

  it('routes each helper to its own tab kind', () => {
    workspaceOpen.browser(FOREGROUND, 'http://localhost:3000/')
    workspaceOpen.review(FOREGROUND, { source: { kind: 'staged' } })
    workspaceOpen.terminal(FOREGROUND, '/repo', { dock: 'bottom' })

    expect(useWorkspaceStore.getState().getTabs(FOREGROUND, 'side').map((tab) => tab.kind))
      .toEqual(['browser', 'review'])
    expect(useWorkspaceStore.getState().getTabs(FOREGROUND, 'bottom').map((tab) => tab.kind))
      .toEqual(['terminal'])
  })
})
