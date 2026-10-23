import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('app mode restart lifecycle', () => {
  it('synchronously stops Windows sidecars before relaunching with another data directory', () => {
    const desktopDir = path.basename(process.cwd()) === 'desktop'
      ? process.cwd()
      : path.join(process.cwd(), 'desktop')
    const source = readFileSync(path.join(desktopDir, 'electron', 'main.ts'), 'utf8')
    const handler = source.match(
      /registerHandler\(ELECTRON_IPC_CHANNELS\.appModePrepareRestart,[\s\S]*?\n\s*registerHandler/,
    )?.[0]

    expect(handler).toContain('getServerRuntime().stopAll(true)')
  })

  it('waits for the runtime to exit before an update relaunch and fails the install otherwise', () => {
    const desktopDir = path.basename(process.cwd()) === 'desktop'
      ? process.cwd()
      : path.join(process.cwd(), 'desktop')
    const source = readFileSync(path.join(desktopDir, 'electron', 'main.ts'), 'utf8')
    const handler = source.match(
      /registerHandler\(ELECTRON_IPC_CHANNELS\.updatePrepareInstall,[\s\S]*?\n\s*registerHandler/,
    )?.[0]

    // The NSIS installer spawned by quitAndInstall overwrites the sidecar in
    // place; a fire-and-forget stopAll() let it race live processes.
    expect(handler).toContain('await getServerRuntime().stopAllAndWait()')
    expect(handler).not.toMatch(/getServerRuntime\(\)\.stopAll\(\)/)
    expect(handler).toMatch(/catch[\s\S]*throw new Error/)
  })

  it('keeps the Electron host alive until graceful server shutdown finishes', () => {
    const desktopDir = path.basename(process.cwd()) === 'desktop'
      ? process.cwd()
      : path.join(process.cwd(), 'desktop')
    const source = readFileSync(path.join(desktopDir, 'electron', 'main.ts'), 'utf8')
    const handler = source.match(/app\.on\('before-quit',[\s\S]*\n\}\)\s*$/)?.[0]

    expect(handler).toContain('event.preventDefault()')
    expect(handler).toContain('getServerRuntime().stopAllAndWait()')
    expect(handler).toMatch(/stopAllAndWait\(\)[\s\S]*app\.quit\(\)/)
  })
})
