import { beforeEach, describe, expect, it, vi } from 'vitest'

type HoistedVi = typeof vi & {
  hoisted?: <T>(factory: () => T) => T
}

if (typeof (vi as HoistedVi).hoisted !== 'function') {
  ;(vi as HoistedVi).hoisted = <T>(factory: () => T) => factory()
}

const mocks = vi.hoisted(() => ({
  destroyTerminalRuntime: vi.fn(),
  releaseWorkspaceBrowserTab: vi.fn(),
}))

vi.mock('../terminalRuntime', () => ({
  destroyTerminalRuntime: mocks.destroyTerminalRuntime,
}))

vi.mock('./browserHost', () => ({
  releaseWorkspaceBrowserTab: mocks.releaseWorkspaceBrowserTab,
}))

import { useWorkspaceStore } from '../../stores/workspaceStore'
import {
  WORKSPACE_STORAGE_KEY,
  WORKSPACE_STORAGE_VERSION,
  hydrateWorkspace,
  readWorkspaceStorage,
  serializeWorkspace,
  writeWorkspaceStorage,
} from './persistence'
import { initWorkspacePersistence } from './persistenceBridge'
import { runDesktopPersistenceMigrations } from '../persistenceMigrations'
import type { WorkspaceBrowserTab, WorkspaceTerminalTab } from './types'

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
  }
}

let counter = 0
const makeId = (prefix: string) => `${prefix}-${++counter}`

beforeEach(() => {
  counter = 0
  useWorkspaceStore.setState({ bySession: {}, sideWidth: 860, bottomHeight: 420 })
  mocks.destroyTerminalRuntime.mockClear()
  mocks.releaseWorkspaceBrowserTab.mockClear()
})

describe('serialize', () => {
  it('keeps navigation state and drops every live handle', () => {
    const store = useWorkspaceStore.getState()
    store.openTarget('s1', { kind: 'file', path: 'src/a.ts', reveal: { line: 7 } })
    store.openTarget('s1', { kind: 'browser', url: 'http://localhost:3000/x' })
    store.openTarget('s1', { kind: 'review', source: { kind: 'branch', baseRef: 'main' } })
    store.openTarget('s1', { kind: 'terminal', cwd: '/repo', dock: 'bottom' })

    const state = useWorkspaceStore.getState()
    const payload = serializeWorkspace(state.bySession, { sideWidth: 900, bottomHeight: 300 })
    const encoded = JSON.stringify(payload)

    expect(encoded).not.toMatch(/browserTabId/)
    expect(encoded).not.toMatch(/runtimeId/)
    expect(encoded).not.toMatch(/loadError/)
    expect(payload.sessions.s1!.tabs).toHaveLength(4)
    expect(payload.sessions.s1!.tabs[0]).toMatchObject({ kind: 'file', path: 'src/a.ts', line: 7 })
    expect(payload.sessions.s1!.tabs[2]).toMatchObject({
      kind: 'review',
      source: { kind: 'branch', baseRef: 'main' },
    })
  })

  it('omits sessions with no tabs but keeps the panel sizes', () => {
    const storage = memoryStorage()
    writeWorkspaceStorage(storage, serializeWorkspace({}, { sideWidth: 640, bottomHeight: 300 }))

    const written = JSON.parse(storage.getItem(WORKSPACE_STORAGE_KEY)!)
    expect(written.sessions).toEqual({})
    // Closing the last tab must not reset a panel the user deliberately resized.
    expect(written.sideWidth).toBe(640)
    expect(written.bottomHeight).toBe(300)
  })
})

describe('hydrate', () => {
  it('repairs duplicate file identities and preview slots written by the old undo behavior', () => {
    const restored = hydrateWorkspace({
      version: WORKSPACE_STORAGE_VERSION,
      sessions: {
        s1: {
          layout: 'split',
          activeSideTabId: 'current',
          tabs: [
            { kind: 'file', id: 'old', path: 'a.ts', line: 1, preview: true },
            { kind: 'file', id: 'other', path: 'b.ts', preview: true },
            { kind: 'file', id: 'current', path: 'a.ts', line: 42, preview: true },
          ],
        },
      },
    }, makeId)
    expect(restored.bySession.s1?.tabs).toHaveLength(2)
    expect(restored.bySession.s1?.tabs.filter((tab) => tab.preview)).toEqual([
      expect.objectContaining({ id: 'current', path: 'a.ts', reveal: { line: 42, nonce: 0 } }),
    ])
    expect(restored.bySession.s1?.activeSideTabId).toBe('current')
  })

  it('round-trips viewed files and the exact turn checkpoint identity', () => {
    const state = useWorkspaceStore.getState()
    const id = state.openTarget('s1', {
      kind: 'review',
      source: { kind: 'turn', turnKey: 'message-1', userMessageIndex: 4 },
    })!
    state.setReviewViewedPaths('s1', id, ['src/a.ts', 'src/b.ts'], 'snapshot-1')
    const latest = useWorkspaceStore.getState()
    const restored = hydrateWorkspace(serializeWorkspace(latest.bySession, latest), makeId)

    expect(restored.bySession.s1?.tabs[0]).toMatchObject({
      kind: 'review',
      source: { kind: 'turn', turnKey: 'message-1', userMessageIndex: 4 },
      viewedPaths: ['src/a.ts', 'src/b.ts'],
    })
  })

  it('round-trips the valid Files launcher before any file selection', () => {
    const id = useWorkspaceStore.getState().openTarget('s1', { kind: 'file', path: '' }, { preview: true })
    useWorkspaceStore.getState().toggleFullscreen('s1')
    const state = useWorkspaceStore.getState()
    const restored = hydrateWorkspace(serializeWorkspace(state.bySession, state), makeId)

    expect(restored.bySession.s1).toMatchObject({
      layout: 'full',
      activeSideTabId: id,
      tabs: [{ kind: 'file', id, path: '', preview: true }],
    })
  })

  it('restores an old Files launcher fixture but rejects absent and non-string paths', () => {
    const storage = memoryStorage()
    storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessions: {
        s1: {
          layout: 'split',
          activeSideTabId: 'files',
          tabs: [
            { kind: 'file', id: 'missing', preview: false },
            { kind: 'file', id: 'invalid', path: 42, preview: false },
            { kind: 'file', id: 'files', path: '', preview: true },
          ],
        },
      },
    }))
    runDesktopPersistenceMigrations(storage)
    const restored = hydrateWorkspace(readWorkspaceStorage(storage), makeId)

    expect(restored.bySession.s1).toMatchObject({
      layout: 'split',
      activeSideTabId: 'files',
      tabs: [{ id: 'files', path: '' }],
    })
  })

  it('round-trips a workspace through storage', () => {
    const store = useWorkspaceStore.getState()
    store.openTarget('s1', { kind: 'file', path: 'src/a.ts' })
    store.openTarget('s1', { kind: 'terminal', cwd: '/repo', dock: 'bottom' })

    const before = useWorkspaceStore.getState()
    const storage = memoryStorage()
    writeWorkspaceStorage(
      storage,
      serializeWorkspace(before.bySession, { sideWidth: 700, bottomHeight: 320 }),
    )

    const restored = hydrateWorkspace(readWorkspaceStorage(storage), makeId)
    expect(restored.sideWidth).toBe(700)
    expect(restored.bottomHeight).toBe(320)
    expect(restored.bySession.s1!.tabs.map((tab) => tab.kind)).toEqual(['file', 'terminal'])
    expect(restored.bySession.s1!.layout).toBe('split')
    expect(restored.bySession.s1!.bottomOpen).toBe(true)
  })

  it('brings terminals back stopped, with a fresh runtime and no replay', () => {
    const restored = hydrateWorkspace(
      {
        version: WORKSPACE_STORAGE_VERSION,
        sideWidth: 860,
        bottomHeight: 420,
        sessions: {
          s1: {
            layout: 'split',
            bottomOpen: true,
            activeSideTabId: null,
            activeBottomTabId: 't1',
            nextTerminalOrdinal: 2,
            tabs: [{ kind: 'terminal', id: 't1', dock: 'bottom', cwd: '/repo', ordinal: 1 }],
          },
        },
      },
      makeId,
    )

    const terminal = restored.bySession.s1!.tabs[0] as WorkspaceTerminalTab
    expect(terminal.status).toBe('exited')
    expect(terminal.runtimeId).toBe('wterm-1')
    // No side tabs left, so the side panel must not claim to be showing one.
    expect(restored.bySession.s1!.layout).toBe('hidden')
  })

  it('restores a page by its restore identity, with a fresh webContents id', () => {
    const restored = hydrateWorkspace(
      {
        version: WORKSPACE_STORAGE_VERSION,
        sideWidth: 860,
        bottomHeight: 420,
        sessions: {
          s1: {
            layout: 'split',
            bottomOpen: false,
            activeSideTabId: 'b1',
            activeBottomTabId: null,
            nextTerminalOrdinal: 1,
            tabs: [{
              kind: 'browser',
              id: 'b1',
              preview: false,
              storageId: 'page-42',
              restoreUrl: 'http://localhost:3000/',
              title: 'Dev',
            }],
          },
        },
      },
      makeId,
    )

    const page = restored.bySession.s1!.tabs[0] as WorkspaceBrowserTab
    expect(page.storageId).toBe('page-42')
    expect(page.url).toBe('http://localhost:3000/')
    expect(page.browserTabId).toBe('wb-1')
  })

  it('rejects a payload written by a different schema version', () => {
    const restored = hydrateWorkspace(
      {
        version: 99,
        sideWidth: 860,
        bottomHeight: 420,
        sessions: {
          s1: {
            layout: 'split',
            bottomOpen: false,
            activeSideTabId: 'f1',
            activeBottomTabId: null,
            nextTerminalOrdinal: 1,
            // Real tabs, so the assertion fails if the version guard is removed.
            tabs: [{ kind: 'file', id: 'f1', preview: false, path: 'src/a.ts' }],
          },
        },
      },
      makeId,
    )
    expect(restored.bySession).toEqual({})
  })

  it('validates each active id against its own dock', () => {
    const restored = hydrateWorkspace(
      {
        version: WORKSPACE_STORAGE_VERSION,
        sideWidth: 860,
        bottomHeight: 420,
        sessions: {
          s1: {
            layout: 'split',
            bottomOpen: true,
            // Names a bottom tab. A flat id check accepts this and the side
            // panel then renders a populated strip over a blank pane.
            activeSideTabId: 't1',
            activeBottomTabId: null,
            nextTerminalOrdinal: 2,
            tabs: [
              { kind: 'file', id: 'f1', preview: false, path: 'src/a.ts' },
              { kind: 'terminal', id: 't1', dock: 'bottom', cwd: '/repo', ordinal: 1 },
            ],
          },
        },
      },
      makeId,
    )

    expect(restored.bySession.s1!.activeSideTabId).toBe('f1')
    expect(restored.bySession.s1!.activeBottomTabId).toBe('t1')
  })

  it('drops duplicate tab ids rather than letting one close two tabs', () => {
    const restored = hydrateWorkspace(
      {
        version: WORKSPACE_STORAGE_VERSION,
        sideWidth: 860,
        bottomHeight: 420,
        sessions: {
          s1: {
            layout: 'split',
            bottomOpen: false,
            activeSideTabId: 'f1',
            activeBottomTabId: null,
            nextTerminalOrdinal: 1,
            tabs: [
              { kind: 'file', id: 'f1', preview: false, path: 'a.ts' },
              { kind: 'file', id: 'f1', preview: false, path: 'b.ts' },
            ],
          },
        },
      },
      makeId,
    )
    expect(restored.bySession.s1!.tabs).toHaveLength(1)
  })

  it('refuses a non-finite terminal ordinal instead of labelling every terminal NaN', () => {
    const restored = hydrateWorkspace(
      {
        version: WORKSPACE_STORAGE_VERSION,
        sideWidth: 860,
        bottomHeight: 420,
        sessions: {
          s1: {
            layout: 'hidden',
            bottomOpen: true,
            activeSideTabId: null,
            activeBottomTabId: 't1',
            nextTerminalOrdinal: Number.NaN,
            tabs: [{ kind: 'terminal', id: 't1', dock: 'bottom', cwd: '/repo', ordinal: 1 }],
          },
        },
      },
      makeId,
    )
    expect(restored.bySession.s1!.nextTerminalOrdinal).toBe(2)
  })

  it('caps how many tabs one session may restore', () => {
    const tabs = Array.from({ length: 500 }, (_, index) => ({
      kind: 'file', id: `f${index}`, preview: false, path: `src/${index}.ts`,
    }))
    const restored = hydrateWorkspace(
      {
        version: WORKSPACE_STORAGE_VERSION,
        sideWidth: 860,
        bottomHeight: 420,
        sessions: {
          s1: {
            layout: 'split',
            bottomOpen: false,
            activeSideTabId: 'f0',
            activeBottomTabId: null,
            nextTerminalOrdinal: 1,
            tabs,
          },
        },
      },
      makeId,
    )
    expect(restored.bySession.s1!.tabs.length).toBeLessThanOrEqual(200)
  })

  it('drops corrupt tab entries but keeps the sound ones', () => {
    const restored = hydrateWorkspace(
      {
        version: WORKSPACE_STORAGE_VERSION,
        sideWidth: 860,
        bottomHeight: 420,
        sessions: {
          s1: {
            layout: 'split',
            bottomOpen: false,
            activeSideTabId: 'f1',
            activeBottomTabId: null,
            nextTerminalOrdinal: 1,
            tabs: [
              { kind: 'file', id: 'f1', preview: false, path: 'src/a.ts' },
              { kind: 'file', id: 'f2', preview: false },
              { kind: 'wormhole', id: 'x1' },
              null,
            ],
          },
        },
      },
      makeId,
    )
    expect(restored.bySession.s1!.tabs.map((tab) => tab.id)).toEqual(['f1'])
  })

  it('survives a corrupt storage entry rather than throwing at startup', () => {
    const storage = memoryStorage()
    storage.setItem(WORKSPACE_STORAGE_KEY, '{not json')
    expect(readWorkspaceStorage(storage)).toBeNull()
  })

  it('never hands back a terminal ordinal that is already in use', () => {
    const restored = hydrateWorkspace(
      {
        version: WORKSPACE_STORAGE_VERSION,
        sideWidth: 860,
        bottomHeight: 420,
        sessions: {
          s1: {
            layout: 'split',
            bottomOpen: false,
            activeSideTabId: null,
            activeBottomTabId: null,
            nextTerminalOrdinal: 1,
            tabs: [{ kind: 'terminal', id: 't9', dock: 'side', cwd: '/repo', ordinal: 9 }],
          },
        },
      },
      makeId,
    )
    expect(restored.bySession.s1!.nextTerminalOrdinal).toBe(10)
  })
})

describe('bridge', () => {
  it('loads on init and writes back after a change', () => {
    vi.useFakeTimers()
    const storage = memoryStorage()
    storage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        version: WORKSPACE_STORAGE_VERSION,
        sideWidth: 720,
        bottomHeight: 300,
        sessions: {
          s1: {
            layout: 'split',
            bottomOpen: false,
            activeSideTabId: 'f1',
            activeBottomTabId: null,
            nextTerminalOrdinal: 1,
            tabs: [{ kind: 'file', id: 'f1', preview: false, path: 'src/a.ts' }],
          },
        },
      }),
    )

    const stop = initWorkspacePersistence(storage, { debounceMs: 10 })
    expect(useWorkspaceStore.getState().getTabs('s1', 'side')).toHaveLength(1)
    expect(useWorkspaceStore.getState().sideWidth).toBe(720)

    useWorkspaceStore.getState().openTarget('s1', { kind: 'file', path: 'src/b.ts' })
    vi.advanceTimersByTime(20)

    const written = JSON.parse(storage.getItem(WORKSPACE_STORAGE_KEY)!)
    expect(written.sessions.s1.tabs).toHaveLength(2)

    stop()
    vi.useRealTimers()
  })
})

describe('primary-window gate', () => {
  it('only the main window owns the workspace document', async () => {
    const { isPrimaryWorkspaceWindow } = await import('../../main')

    expect(isPrimaryWorkspaceWindow('')).toBe(true)
    // Pet and trace windows share this origin and load the same entry. The
    // document is written whole, so a second writer would overwrite the main
    // window's state with whatever it hydrated when it opened.
    expect(isPrimaryWorkspaceWindow('?petWindow=1')).toBe(false)
    expect(isPrimaryWorkspaceWindow('?traceWindow=1&traceSessionId=abc')).toBe(false)
  })

  it('discards legacy viewed marks without a comparison fingerprint', () => {
    const state = useWorkspaceStore.getState()
    const id = state.openTarget('s1', { kind: 'review' })!
    state.setReviewViewedPaths('s1', id, ['src/a.ts'])
    const latest = useWorkspaceStore.getState()
    const restored = hydrateWorkspace(serializeWorkspace(latest.bySession, latest), makeId)
    expect(restored.bySession.s1?.tabs[0]).toMatchObject({ kind: 'review', viewedPaths: [] })
  })

})
