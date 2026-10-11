import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { applyWindowsAppUserModelId, applyWindowsTaskbarIdentity, resolveWindowsWindowIcon, WINDOWS_APP_USER_MODEL_ID } from './appIdentity'

describe('applyWindowsAppUserModelId', () => {
  it('sets the AppUserModelID on Windows so toast notifications are attributed to the app', () => {
    const setAppUserModelId = vi.fn()
    const result = applyWindowsAppUserModelId({ setAppUserModelId }, 'win32')
    expect(result).toBe(true)
    expect(setAppUserModelId).toHaveBeenCalledWith(WINDOWS_APP_USER_MODEL_ID)
  })

  it('is a no-op on macOS and Linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const setAppUserModelId = vi.fn()
      expect(applyWindowsAppUserModelId({ setAppUserModelId }, platform)).toBe(false)
      expect(setAppUserModelId).not.toHaveBeenCalled()
    }
  })

  it('keeps the AppUserModelID in sync with build.appId in package.json', () => {
    const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json')
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { build?: { appId?: string } }
    expect(WINDOWS_APP_USER_MODEL_ID).toBe(pkg.build?.appId)
  })
})

describe('Windows window and pinned taskbar identity', () => {
  function fixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'electron-app-identity-'))
    const desktopRoot = path.join(root, 'resources', 'app.asar')
    const resourcesPath = path.join(root, 'resources')
    const executablePath = path.join(root, 'Claude Code Haha.exe')
    const externalIcon = path.join(resourcesPath, 'app-icon.ico')
    const bundledIcon = path.join(desktopRoot, 'src-tauri', 'icons', 'icon.ico')
    const write = (file: string) => {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, 'icon')
    }
    return { root, desktopRoot, resourcesPath, executablePath, externalIcon, bundledIcon, write }
  }

  it('uses the real resource icon for a packaged Windows window and pin', () => {
    const f = fixture()
    try {
      f.write(f.externalIcon)
      f.write(f.bundledIcon)
      const window = { setAppDetails: vi.fn() }
      expect(resolveWindowsWindowIcon(f, 'win32')).toBe(f.externalIcon)
      expect(applyWindowsTaskbarIdentity(window, { ...f, isPackaged: true }, 'win32')).toBe(true)
      expect(window.setAppDetails).toHaveBeenCalledWith({
        appId: WINDOWS_APP_USER_MODEL_ID,
        appIconPath: f.externalIcon,
        appIconIndex: 0,
        relaunchCommand: `"${f.executablePath}"`,
        relaunchDisplayName: 'Claude Code Haha',
      })
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('falls back to the bundled window icon while keeping ASAR paths away from the Windows shell', () => {
    const f = fixture()
    try {
      f.write(f.bundledIcon)
      const window = { setAppDetails: vi.fn() }
      expect(resolveWindowsWindowIcon(f, 'win32')).toBe(f.bundledIcon)
      applyWindowsTaskbarIdentity(window, { ...f, isPackaged: true }, 'win32')
      expect(window.setAppDetails.mock.calls[0]?.[0].appIconPath).toBe(f.executablePath)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('leaves pin relaunch metadata alone for development runs and other platforms', () => {
    const f = fixture()
    try {
      f.write(f.bundledIcon)
      const window = { setAppDetails: vi.fn() }
      expect(resolveWindowsWindowIcon(f, 'win32')).toBe(f.bundledIcon)
      expect(applyWindowsTaskbarIdentity(window, { ...f, isPackaged: false }, 'win32')).toBe(false)
      for (const platform of ['darwin', 'linux'] as const) {
        expect(resolveWindowsWindowIcon(f, platform)).toBeUndefined()
        expect(applyWindowsTaskbarIdentity(window, { ...f, isPackaged: true }, platform)).toBe(false)
      }
      expect(window.setAppDetails).not.toHaveBeenCalled()
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('does not fail startup when an icon is absent', () => {
    const f = fixture()
    try {
      const window = { setAppDetails: vi.fn() }
      expect(resolveWindowsWindowIcon(f, 'win32')).toBeUndefined()
      expect(() => applyWindowsTaskbarIdentity(window, { ...f, isPackaged: true }, 'win32')).not.toThrow()
      expect(window.setAppDetails.mock.calls[0]?.[0].appIconPath).toBe(f.executablePath)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('applies both identities to the actual main-window construction before it is shown', async () => {
    const f = fixture()
    try {
      f.write(f.externalIcon)
      const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
      const source = readFileSync(path.join(desktopDir, 'electron', 'main.ts'), 'utf8')
      const start = source.indexOf('async function createMainWindow()')
      const end = source.indexOf('  // Before any guest can exist:', start)
      const window = { setAppDetails: vi.fn() }
      const BrowserWindow = vi.fn(function (_options: unknown) { return window })
      const context = {
        app: { isPackaged: true },
        process: { resourcesPath: f.resourcesPath, execPath: f.executablePath, platform: 'win32' },
        appRoot: () => f.desktopRoot,
        mainWindow: null,
        screen: { getAllDisplays: () => [] },
        readWindowState: () => null,
        windowOptionsFromState: () => ({}),
        windowChromeOptionsForPlatform: () => ({}),
        resolveStartupWindowBackground: () => '#ffffff',
        preloadPath: () => 'preload.cjs',
        MIN_WINDOW_WIDTH: 400,
        MIN_WINDOW_HEIGHT: 300,
        BrowserWindow,
        resolveWindowsWindowIcon: (paths: Parameters<typeof resolveWindowsWindowIcon>[0]) => resolveWindowsWindowIcon(paths, 'win32'),
        applyWindowsTaskbarIdentity: (host: Parameters<typeof applyWindowsTaskbarIdentity>[0], paths: Parameters<typeof applyWindowsTaskbarIdentity>[1]) => applyWindowsTaskbarIdentity(host, paths, 'win32'),
        createMainWindow: undefined as undefined | (() => Promise<unknown>),
      }
      await runInNewContext(`${source.slice(start, end)}\n}`, context)
      await context.createMainWindow!()
      expect(BrowserWindow.mock.calls[0]?.[0]).toMatchObject({ show: false, icon: f.externalIcon })
      expect(window.setAppDetails.mock.calls[0]?.[0]).toMatchObject({ appId: WINDOWS_APP_USER_MODEL_ID, appIconPath: f.externalIcon })
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })
})
