import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  destroy: vi.fn(),
  close: vi.fn(),
  remove: vi.fn(),
  batchRemove: vi.fn(),
}))

vi.mock('../lib/terminalRuntime', () => ({ destroyTerminalRuntime: mocks.destroy }))
vi.mock('../lib/workspace/browserHost', () => ({ releaseWorkspaceBrowserTab: mocks.close }))
vi.mock('../api/sessions', () => ({
  sessionsApi: { delete: mocks.remove, batchDelete: mocks.batchRemove },
}))
vi.mock('../lib/recentProjectsCache', () => ({ invalidateRecentProjectsCache: vi.fn() }))

import { releaseWorkspaceSession } from '../lib/workspace/releaseSession'
import { serializeWorkspace } from '../lib/workspace/persistence'
import { useSessionStore } from './sessionStore'
import { useTabStore } from './tabStore'
import { useWorkspaceStore } from './workspaceStore'

const OLD = 'old-empty-task'
const OTHER = 'other-task'

function openResources(sessionId: string) {
  const store = useWorkspaceStore.getState()
  store.openTarget(sessionId, { kind: 'terminal', cwd: '/fixtures/project' })
  store.openTarget(sessionId, { kind: 'browser', url: 'http://127.0.0.1:3333/' })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.remove.mockResolvedValue({})
  useWorkspaceStore.setState({ bySession: {} })
  useSessionStore.setState({ sessions: [], activeSessionId: OLD })
  useTabStore.setState({
    tabs: [{ sessionId: OLD, title: 'Empty task', type: 'session', status: 'idle' }],
    activeTabId: OLD,
  })
})

describe('session deletion owns workspace resource release', () => {
  it('releases the old empty task after its successful replacement and stops persisting it', async () => {
    openResources(OLD)
    openResources(OTHER)
    // The same public boundary used by ChatInput.replaceEmptySession after creation.
    useTabStore.getState().replaceTabSession(OLD, 'replacement-task')
    await useSessionStore.getState().deleteSession(OLD)

    const workspace = useWorkspaceStore.getState()
    expect(workspace.bySession[OLD]).toBeUndefined()
    expect(workspace.bySession[OTHER]?.tabs).toHaveLength(2)
    expect(mocks.destroy).toHaveBeenCalledTimes(1)
    expect(mocks.close).toHaveBeenCalledTimes(1)
    expect(serializeWorkspace(workspace.bySession, workspace).sessions[OLD]).toBeUndefined()

    // Existing explicit-close callers may also release; it must be harmless.
    releaseWorkspaceSession(OLD)
    expect(mocks.destroy).toHaveBeenCalledTimes(1)
    expect(mocks.close).toHaveBeenCalledTimes(1)
  })

  it('keeps the task and its resources when deletion fails', async () => {
    openResources(OLD)
    mocks.remove.mockRejectedValueOnce(new Error('delete failed'))
    await expect(useSessionStore.getState().deleteSession(OLD)).rejects.toThrow('delete failed')
    expect(useWorkspaceStore.getState().bySession[OLD]?.tabs).toHaveLength(2)
    expect(useSessionStore.getState().activeSessionId).toBe(OLD)
    expect(mocks.destroy).not.toHaveBeenCalled()
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it('releases only successful batch deletions', async () => {
    openResources(OLD)
    openResources(OTHER)
    mocks.batchRemove.mockResolvedValueOnce({
      successes: [OLD],
      failures: [{ sessionId: OTHER, error: 'delete failed' }],
    })
    await useSessionStore.getState().deleteSessions([OLD, OTHER])
    expect(useWorkspaceStore.getState().bySession[OLD]).toBeUndefined()
    expect(useWorkspaceStore.getState().bySession[OTHER]?.tabs).toHaveLength(2)
    expect(mocks.destroy).toHaveBeenCalledTimes(1)
    expect(mocks.close).toHaveBeenCalledTimes(1)
  })

  it('keeps resources alive during an ordinary task switch', () => {
    openResources(OLD)
    useSessionStore.getState().setActiveSession(OTHER)
    expect(useWorkspaceStore.getState().bySession[OLD]?.tabs).toHaveLength(2)
    expect(mocks.destroy).not.toHaveBeenCalled()
    expect(mocks.close).not.toHaveBeenCalled()
  })
})
