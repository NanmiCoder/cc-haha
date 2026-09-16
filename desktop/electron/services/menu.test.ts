import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { ELECTRON_EVENT_CHANNELS } from '../ipc/channels'
import {
  buildApplicationMenuTemplate,
  buildRendererContextMenuTemplate,
  installApplicationMenu,
  installRendererContextMenu,
} from './menu'

const menuMocksKey = '__electronMenuMocks'

function createElectronMenuMocks() {
  const popup = vi.fn()
  return {
    buildFromTemplate: vi.fn((template: unknown) => ({ template, popup })),
    popup,
    setApplicationMenu: vi.fn(),
  }
}

function getElectronMenuMocks() {
  const store = globalThis as Record<string, unknown>
  const existing = store[menuMocksKey] as ReturnType<typeof createElectronMenuMocks> | undefined
  if (existing) return existing
  const created = createElectronMenuMocks()
  store[menuMocksKey] = created
  return created
}

function rendererContextMenuParams({
  isEditable = false,
  selectionText = '',
  editFlags = {},
}: {
  isEditable?: boolean
  selectionText?: string
  editFlags?: Partial<{
    canUndo: boolean
    canRedo: boolean
    canCut: boolean
    canCopy: boolean
    canPaste: boolean
    canSelectAll: boolean
  }>
} = {}) {
  return {
    isEditable,
    selectionText,
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: false,
      canSelectAll: false,
      ...editFlags,
    },
  }
}

vi.mock('electron', () => {
  const mocks = getElectronMenuMocks()
  return {
    Menu: {
      buildFromTemplate: mocks.buildFromTemplate,
      setApplicationMenu: mocks.setApplicationMenu,
    },
  }
})

describe('Electron application menu service', () => {
  afterEach(() => {
    const mocks = getElectronMenuMocks()
    mocks.buildFromTemplate.mockClear()
    mocks.popup.mockClear()
    mocks.setApplicationMenu.mockClear()
  })

  it('offers native Copy for selected renderer text', () => {
    expect(buildRendererContextMenuTemplate(rendererContextMenuParams({
      selectionText: 'selected reply',
      editFlags: { canCopy: true },
    }))).toEqual([
      { role: 'copy', enabled: true },
    ])
  })

  it('offers native editing actions for editable renderer fields', () => {
    const template = buildRendererContextMenuTemplate(rendererContextMenuParams({
      isEditable: true,
      selectionText: 'draft',
      editFlags: {
        canUndo: true,
        canCut: true,
        canCopy: true,
        canPaste: true,
        canSelectAll: true,
      },
    }))

    expect(template.map(item => item.role ?? item.type)).toEqual([
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'separator',
      'selectAll',
    ])
    expect(template.find(item => item.role === 'redo')?.enabled).toBe(false)
  })

  it('opens the renderer context menu only when native actions are available', async () => {
    const menuMocks = getElectronMenuMocks()
    let contextMenuHandler: ((event: unknown, params: ReturnType<typeof rendererContextMenuParams>) => void) | undefined
    const window = {
      isDestroyed: () => false,
      webContents: {
        on: vi.fn((event: string, handler: typeof contextMenuHandler) => {
          if (event === 'context-menu') contextMenuHandler = handler
        }),
      },
    }

    await installRendererContextMenu(window as never)

    expect(window.webContents.on).toHaveBeenCalledWith('context-menu', expect.any(Function))
    contextMenuHandler?.({}, rendererContextMenuParams())
    expect(menuMocks.buildFromTemplate).not.toHaveBeenCalled()

    contextMenuHandler?.({}, rendererContextMenuParams({
      selectionText: 'selected reply',
      editFlags: { canCopy: true },
    }))
    expect(menuMocks.buildFromTemplate).toHaveBeenCalledWith([
      { role: 'copy', enabled: true },
    ])
    expect(menuMocks.popup).toHaveBeenCalledWith({ window })
  })

  it('emits native navigation destinations from macOS app menu items', () => {
    const onNavigate = vi.fn()
    const template = buildApplicationMenuTemplate('Claude Code Haha', onNavigate, 'darwin')
    const appMenu = template[0]
    expect(appMenu).toBeDefined()
    const submenu = appMenu!.submenu as MenuItemConstructorOptions[]

    const aboutItem = submenu[0]
    const settingsItem = submenu[2]
    expect(aboutItem).toBeDefined()
    expect(settingsItem).toBeDefined()
    aboutItem!.click?.({} as never, {} as never, {} as never)
    settingsItem!.click?.({} as never, {} as never, {} as never)

    expect(onNavigate).toHaveBeenNthCalledWith(1, 'about')
    expect(onNavigate).toHaveBeenNthCalledWith(2, 'settings')
  })

  it('routes macOS Hide through the provided safe hide action', () => {
    const hide = vi.fn()
    const template = buildApplicationMenuTemplate('Claude Code Haha', vi.fn(), 'darwin', { hide })
    const appMenu = template[0]
    const submenu = appMenu!.submenu as MenuItemConstructorOptions[]
    const hideItem = submenu.find(item => item.label === 'Hide Claude Code Haha')

    expect(hideItem).toBeDefined()
    expect(hideItem?.accelerator).toBe('Command+H')
    hideItem?.click?.({} as never, {} as never, {} as never)

    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('keeps explicit window close separate from the tab accelerator', () => {
    const close = vi.fn()
    const template = buildApplicationMenuTemplate('Claude Code Haha', vi.fn(), 'darwin', { close })
    const closeItem = template
      .flatMap(item => (item.submenu as MenuItemConstructorOptions[] | undefined) ?? [])
      .find(item => item.label === 'Close Window')

    expect(closeItem).toBeDefined()
    expect(closeItem?.accelerator).toBeUndefined()
    closeItem?.click?.({} as never, {} as never, {} as never)

    expect(close).toHaveBeenCalledTimes(1)
  })

  it('routes the View fullscreen accelerator through the provided fullscreen action', () => {
    const toggleFullScreen = vi.fn()
    const template = buildApplicationMenuTemplate('Claude Code Haha', vi.fn(), 'darwin', { toggleFullScreen })
    const fullScreenItem = template
      .flatMap(item => (item.submenu as MenuItemConstructorOptions[] | undefined) ?? [])
      .find(item => item.label === 'Toggle Full Screen')

    expect(fullScreenItem).toBeDefined()
    expect(fullScreenItem?.accelerator).toBe('Ctrl+Command+F')
    fullScreenItem?.click?.({} as never, {} as never, {} as never)

    expect(toggleFullScreen).toHaveBeenCalledTimes(1)
  })

  it('uses F11 for custom fullscreen on non-macOS platforms', () => {
    const template = buildApplicationMenuTemplate('Claude Code Haha', vi.fn(), 'linux', {})
    const fullScreenItem = template
      .flatMap(item => (item.submenu as MenuItemConstructorOptions[] | undefined) ?? [])
      .find(item => item.label === 'Toggle Full Screen')

    expect(fullScreenItem?.accelerator).toBe('F11')
  })

  it('keeps a settings entry available on non-macOS platforms', () => {
    const template = buildApplicationMenuTemplate('Claude Code Haha', vi.fn(), 'win32')
    const fileMenu = template[0]
    expect(fileMenu).toBeDefined()
    const fileSubmenu = fileMenu!.submenu as MenuItemConstructorOptions[]

    expect(fileSubmenu.some(item => item.label === 'Settings...')).toBe(true)
  })

  it('installs a native menu that forwards settings navigation to the renderer event channel', async () => {
    const menuMocks = getElectronMenuMocks()
    menuMocks.buildFromTemplate.mockClear()
    menuMocks.setApplicationMenu.mockClear()
    const send = vi.fn()

    await installApplicationMenu(
      { name: 'Claude Code Haha' } as never,
      () => ({ webContents: { send } }) as never,
      'darwin',
    )

    expect(menuMocks.buildFromTemplate).toHaveBeenCalledTimes(1)
    expect(menuMocks.setApplicationMenu).toHaveBeenCalledWith(expect.objectContaining({
      template: menuMocks.buildFromTemplate.mock.calls[0]?.[0],
    }))

    const template = menuMocks.buildFromTemplate.mock.calls[0]?.[0] as MenuItemConstructorOptions[]
    const settingsItem = template
      .flatMap(item => (item.submenu as MenuItemConstructorOptions[] | undefined) ?? [])
      .find(item => item.label === 'Settings...')

    expect(settingsItem).toBeDefined()
    settingsItem?.click?.({} as never, {} as never, {} as never)
    expect(send).toHaveBeenCalledWith(ELECTRON_EVENT_CHANNELS.nativeMenuNavigate, 'settings')
  })

  it('clears the native application menu on Windows so custom chrome owns the top bar', async () => {
    const menuMocks = getElectronMenuMocks()
    menuMocks.buildFromTemplate.mockClear()
    menuMocks.setApplicationMenu.mockClear()

    await installApplicationMenu(
      { name: 'Claude Code Haha' } as never,
      () => ({ webContents: { send: vi.fn() } }) as never,
      'win32',
    )

    expect(menuMocks.buildFromTemplate).not.toHaveBeenCalled()
    expect(menuMocks.setApplicationMenu).toHaveBeenCalledWith(null)
  })

  it('keeps the native application menu installed on Linux', async () => {
    const menuMocks = getElectronMenuMocks()
    menuMocks.buildFromTemplate.mockClear()
    menuMocks.setApplicationMenu.mockClear()
    const send = vi.fn()

    await installApplicationMenu(
      { name: 'Claude Code Haha' } as never,
      () => ({ webContents: { send } }) as never,
      'linux',
    )

    expect(menuMocks.buildFromTemplate).toHaveBeenCalledTimes(1)
    expect(menuMocks.setApplicationMenu).toHaveBeenCalledWith(expect.objectContaining({
      template: menuMocks.buildFromTemplate.mock.calls[0]?.[0],
    }))
  })

  it('installs hide as a safe fullscreen-aware window hide before app hide', async () => {
    const appHide = vi.fn()
    const onceHandlers = new Map<string, (...args: never[]) => void>()
    const window = {
      isFullScreen: () => true,
      isSimpleFullScreen: () => false,
      once: vi.fn((event: string, handler: (...args: never[]) => void) => {
        onceHandlers.set(event, handler)
      }),
      setFullScreen: vi.fn(),
      hide: vi.fn(),
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    }
    const menuMocks = getElectronMenuMocks()

    await installApplicationMenu(
      { name: 'Claude Code Haha', hide: appHide } as never,
      () => window as never,
      'darwin',
    )

    const template = menuMocks.buildFromTemplate.mock.calls[0]?.[0] as MenuItemConstructorOptions[]
    const hideItem = template
      .flatMap(item => (item.submenu as MenuItemConstructorOptions[] | undefined) ?? [])
      .find(item => item.label === 'Hide Claude Code Haha')

    hideItem?.click?.({} as never, {} as never, {} as never)
    expect(window.setFullScreen).toHaveBeenCalledWith(false)
    expect(window.hide).not.toHaveBeenCalled()
    expect(appHide).not.toHaveBeenCalled()

    onceHandlers.get('leave-full-screen')?.()
    expect(window.hide).toHaveBeenCalledTimes(1)
    expect(appHide).toHaveBeenCalledTimes(1)
  })

  it('installs fullscreen as simple fullscreen on macOS instead of native Spaces', async () => {
    const window = {
      isSimpleFullScreen: () => false,
      setSimpleFullScreen: vi.fn(),
      isFullScreen: vi.fn(),
      setFullScreen: vi.fn(),
      webContents: { send: vi.fn() },
    }
    const menuMocks = getElectronMenuMocks()

    await installApplicationMenu(
      { name: 'Claude Code Haha' } as never,
      () => window as never,
      'darwin',
    )

    const template = menuMocks.buildFromTemplate.mock.calls[0]?.[0] as MenuItemConstructorOptions[]
    const fullScreenItem = template
      .flatMap(item => (item.submenu as MenuItemConstructorOptions[] | undefined) ?? [])
      .find(item => item.label === 'Toggle Full Screen')

    fullScreenItem?.click?.({} as never, {} as never, {} as never)
    expect(window.setSimpleFullScreen).toHaveBeenCalledWith(true)
    expect(window.setFullScreen).not.toHaveBeenCalled()
  })
})


it('routes the Close Tab accelerator to the workspace controller without closing the window', async () => {
  const window = { close: vi.fn(), webContents: { send: vi.fn() } }
  const mocks = getElectronMenuMocks()
  mocks.buildFromTemplate.mockClear()
  await installApplicationMenu({ name: 'Test App' } as never, () => window as never, 'darwin')
  const template = mocks.buildFromTemplate.mock.calls[0]?.[0] as MenuItemConstructorOptions[]
  const item = template.flatMap(item => (item.submenu as MenuItemConstructorOptions[] | undefined) ?? []).find(item => item.label === 'Close Tab')!
  expect(item.accelerator).toBe('CmdOrCtrl+W')
  item.click?.({} as never, {} as never, {} as never)
  expect(window.webContents.send).toHaveBeenCalledWith(ELECTRON_EVENT_CHANNELS.workspaceBrowserEvent, { type: 'shortcut', tabId: '', action: 'close-tab' })
  expect(window.close).not.toHaveBeenCalled()
})

it('lets renderer and terminal W keystrokes pass through without a competing menu accelerator', async () => {
  const handlers = new Map<string, (event: unknown, input: unknown) => void>()
  const window = {
    webContents: {
      on: (name: string, handler: (event: unknown, input: unknown) => void) => handlers.set(name, handler),
      setIgnoreMenuShortcuts: vi.fn(),
    },
  }
  await installRendererContextMenu(window as never)
  const preventDefault = vi.fn()
  handlers.get('before-input-event')!({ preventDefault }, { key: 'w', control: true, meta: false })
  expect(window.webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)
  expect(preventDefault).not.toHaveBeenCalled()
  handlers.get('before-input-event')!({ preventDefault }, { key: 'c', control: true, meta: false })
  expect(window.webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
})
