import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// main.ts boots Electron the moment it is imported, so the wiring is asserted
// on its source — the same shape as the other lifecycle guard tests.
function createMainWindowSource() {
  const desktopDir = path.basename(process.cwd()) === 'desktop'
    ? process.cwd()
    : path.join(process.cwd(), 'desktop')
  const source = readFileSync(path.join(desktopDir, 'electron', 'main.ts'), 'utf8')

  return source.slice(
    source.indexOf('async function createMainWindow()'),
    source.indexOf('if (!acquireSingleInstanceLock'),
  )
}

describe('Windows drag hit-test lifecycle', () => {
  it('re-arms the drag hit test from window events, not only at startup', () => {
    const createWindow = createMainWindowSource()

    expect(createWindow).toContain('installWindowsDragHitTestRefresh(mainWindow)')
    // The listeners must be attached before the window is shown so a startup
    // maximize (restoreWindowMaximized) is caught too.
    expect(createWindow.indexOf('installWindowsDragHitTestRefresh')).toBeLessThan(
      createWindow.indexOf('loadAndRevealMainWindow'),
    )
    // The startup one-shot stays: the first frameless show has no state-change
    // event to wait for.
    expect(createWindow).toContain('refreshWindowsDragHitTest(mainWindow, process.platform)')
  })
})
