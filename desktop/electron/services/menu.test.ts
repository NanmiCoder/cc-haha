import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { ELECTRON_EVENT_CHANNELS } from '../ipc/channels'
import { buildApplicationMenuTemplate, installApplicationMenu } from './menu'
import { buildElectronModuleMock, getElectronServiceMocks, resetElectronServiceMocks } from './__electronMock'

const getElectronMenuMocks = getElectronServiceMocks

vi.mock('electron', () => buildElectronModuleMock())

describe('Electron application menu service', () => {
  afterEach(() => {
    resetElectronServiceMocks()
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

  it('routes the Window close accelerator through the provided close action', () => {
    const close = vi.fn()
    const template = buildApplicationMenuTemplate('Claude Code Haha', vi.fn(), 'darwin', { close })
    const closeItem = template
      .flatMap(item => (item.submenu as MenuItemConstructorOptions[] | undefined) ?? [])
      .find(item => item.label === 'Close Window')

    expect(closeItem).toBeDefined()
    expect(closeItem?.accelerator).toBe('CmdOrCtrl+W')
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
    expect(menuMocks.setApplicationMenu).toHaveBeenCalledWith({
      template: menuMocks.buildFromTemplate.mock.calls[0]?.[0],
    })

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
    expect(menuMocks.setApplicationMenu).toHaveBeenCalledWith({
      template: menuMocks.buildFromTemplate.mock.calls[0]?.[0],
    })
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
