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
})
