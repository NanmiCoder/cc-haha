import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { App } from 'electron'
import { afterEach, describe, expect, it } from 'vitest'
import { areStorageWritesFrozen, setStorageWritesFrozen } from './storageMaintenance'
import { writeWindowState } from './windows'
import { writeAppearanceState } from './nativeAppearance'
import { writePetWindowPosition } from './petWindow'
import { appendHostDiagnostic } from './sidecarManager'

let root: string | undefined
afterEach(() => {
  setStorageWritesFrozen(false)
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = undefined
})

describe('host data migration write barrier', () => {
  it('freezes event and quit-time root writers while leaving them available after rollback', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'haha-host-maintenance-'))
    const fakeApp = { getPath() { return root! } } as unknown as App
    const configDir = path.join(root, 'data')
    const env = { CLAUDE_CONFIG_DIR: configDir }
    const writeAll = () => {
      writeWindowState(fakeApp, { x: 1, y: 2, width: 1200, height: 800, maximized: false }, env)
      writeAppearanceState(fakeApp, { isDark: false, background: '#ffffff', lightBackground: '#ffffff', followSystem: false }, env)
      writePetWindowPosition({ x: 10, y: 20 }, env, root!)
      appendHostDiagnostic(path.join(configDir, 'cc-haha', 'diagnostics', 'electron-host.log'), 'fixture', { homeDir: root! })
    }
    setStorageWritesFrozen(true)
    expect(areStorageWritesFrozen()).toBe(true)
    writeAll()
    expect(fs.existsSync(configDir)).toBe(false)
    setStorageWritesFrozen(false)
    writeAll()
    expect(fs.existsSync(path.join(configDir, 'window-state.json'))).toBe(true)
    expect(fs.existsSync(path.join(configDir, 'appearance-state.json'))).toBe(true)
    expect(fs.existsSync(path.join(configDir, 'cc-haha', 'pet-window.json'))).toBe(true)
    expect(fs.existsSync(path.join(configDir, 'cc-haha', 'diagnostics', 'electron-host.log'))).toBe(true)
  })
})
