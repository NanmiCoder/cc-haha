import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installTray, resolveTrayIconPath, shouldInstallTray } from './tray'
import { buildElectronModuleMock, getElectronServiceMocks, resetElectronServiceMocks } from './__electronMock'

vi.mock('electron', () => buildElectronModuleMock())

describe('Electron tray service', () => {
  afterEach(() => {
    resetElectronServiceMocks()
  })

  it('uses the existing desktop icon assets for the tray icon', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'electron-tray-'))
    try {
      const iconPath = path.join(root, 'src-tauri', 'icons', 'icon.png')
      mkdirSync(path.dirname(iconPath), { recursive: true })
      writeFileSync(iconPath, 'png')

      expect(resolveTrayIconPath(root)).toBe(iconPath)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails clearly when no tray icon exists', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'electron-tray-missing-'))
    try {
      expect(() => resolveTrayIconPath(root)).toThrow('Electron tray icon not found')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips the status-bar tray on macOS and keeps it on Windows and Linux', () => {
    expect(shouldInstallTray('darwin')).toBe(false)
    expect(shouldInstallTray('win32')).toBe(true)
    expect(shouldInstallTray('linux')).toBe(true)
  })

  it('installs tray handlers that show the app, quit explicitly, and dispose cleanly', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'electron-tray-install-'))
    try {
      const trayMocks = getElectronServiceMocks()
      const iconPath = path.join(root, 'src-tauri', 'icons', 'icon.png')
      mkdirSync(path.dirname(iconPath), { recursive: true })
      writeFileSync(iconPath, 'png')
      const show = vi.fn()
      const quit = vi.fn()

      const controller = await installTray({
        app: { name: 'Code Council' } as never,
        desktopRoot: root,
        show,
        quit,
      })

      expect(trayMocks.createFromPath).toHaveBeenCalledWith(iconPath)
      expect(trayMocks.Tray).toHaveBeenCalledTimes(1)
      expect(trayMocks.tray.setToolTip).toHaveBeenCalledWith('Code Council')
      expect(trayMocks.buildFromTemplate).toHaveBeenCalledTimes(1)

      const template = trayMocks.buildFromTemplate.mock.calls[0]?.[0] as Array<{ label?: string, click?: () => void, type?: string }>
      expect(template.map(item => item.label ?? item.type)).toEqual([
        'Show Code Council',
        'separator',
        'Quit Code Council',
      ])

      template[0]?.click?.()
      template[2]?.click?.()
      trayMocks.handlers.get('click')?.()

      expect(show).toHaveBeenCalledTimes(2)
      expect(quit).toHaveBeenCalledTimes(1)

      controller.dispose()
      expect(trayMocks.tray.destroy).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
