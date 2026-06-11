import { vi } from 'vitest'

/**
 * Shared Electron module mock.
 *
 * `check:electron` runs the whole suite through a single `bun test` process.
 * `vi.mock('electron', factory)` registers a *process-global* mock keyed by the
 * specifier `'electron'`, and bun keeps only one factory per specifier — the
 * last one registered wins. `tray.test.ts` and `menu.test.ts` both mock
 * `'electron'`, so whichever factory loses still has to satisfy the other
 * file's runtime `await import('electron')`.
 *
 * To stay correct regardless of file load order, every factory returns the
 * *union* of the Electron surface both files need (Menu, Tray, nativeImage),
 * all backed by this single shared store.
 */

const electronMockKey = '__electronServiceMocks'

export type ElectronServiceMocks = {
  handlers: Map<string, () => void>
  buildFromTemplate: ReturnType<typeof vi.fn>
  setApplicationMenu: ReturnType<typeof vi.fn>
  createFromPath: ReturnType<typeof vi.fn>
  tray: {
    setToolTip: ReturnType<typeof vi.fn>
    setContextMenu: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
  }
  Tray: ReturnType<typeof vi.fn>
}

function createElectronServiceMocks(): ElectronServiceMocks {
  const handlers = new Map<string, () => void>()
  return {
    handlers,
    buildFromTemplate: vi.fn((template: unknown) => ({ template })),
    setApplicationMenu: vi.fn(),
    createFromPath: vi.fn((iconPath: string) => ({ iconPath })),
    tray: {
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      on: vi.fn((event: string, handler: () => void) => {
        handlers.set(event, handler)
      }),
      destroy: vi.fn(),
    },
    Tray: vi.fn(),
  }
}

/** Returns the shared mock store, lazily creating it on first access. */
export function getElectronServiceMocks(): ElectronServiceMocks {
  const store = globalThis as Record<string, unknown>
  const existing = store[electronMockKey] as ElectronServiceMocks | undefined
  if (existing) return existing
  const created = createElectronServiceMocks()
  store[electronMockKey] = created
  return created
}

/** Resets every mock fn between tests without tearing down the shared store. */
export function resetElectronServiceMocks(): void {
  const mocks = getElectronServiceMocks()
  mocks.buildFromTemplate.mockClear()
  mocks.setApplicationMenu.mockClear()
  mocks.createFromPath.mockClear()
  mocks.Tray.mockClear()
  mocks.tray.setToolTip.mockClear()
  mocks.tray.setContextMenu.mockClear()
  mocks.tray.on.mockClear()
  mocks.tray.destroy.mockClear()
  mocks.handlers.clear()
}

/** Builds the mocked `electron` module exports from the shared store. */
export function buildElectronModuleMock() {
  const mocks = getElectronServiceMocks()
  return {
    Menu: {
      buildFromTemplate: mocks.buildFromTemplate,
      setApplicationMenu: mocks.setApplicationMenu,
    },
    Tray: mocks.Tray.mockImplementation(() => mocks.tray),
    nativeImage: {
      createFromPath: mocks.createFromPath,
    },
  }
}
