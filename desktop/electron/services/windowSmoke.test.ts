import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { writeWindowSmokeScreenshot, writeWindowSmokeSnapshot } from './windowSmoke'

describe('Electron window smoke diagnostics', () => {
  it('stays disabled unless a log path is configured', () => {
    expect(() => writeWindowSmokeSnapshot(null, 'disabled', {})).not.toThrow()
  })

  it('captures a PNG only when a screenshot path is configured', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cc-haha-window-smoke-shot-'))
    const screenshotPath = join(tempDir, 'window.png')
    const capturePage = vi.fn(async () => ({ toPNG: () => Buffer.from('fake-png') }))
    const window = {
      isDestroyed: () => false,
      webContents: { capturePage },
    } as never
    try {
      await writeWindowSmokeScreenshot(window, {})
      expect(capturePage).not.toHaveBeenCalled()
      await writeWindowSmokeScreenshot(window, {
        CC_HAHA_ELECTRON_WINDOW_SMOKE_SCREENSHOT: screenshotPath,
      })
      expect(capturePage).toHaveBeenCalledTimes(1)
      expect(existsSync(screenshotPath)).toBe(true)
      expect(readFileSync(screenshotPath)).toEqual(Buffer.from('fake-png'))
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('writes a focused visible window snapshot for packaged UI diagnostics', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cc-haha-window-smoke-'))
    const logPath = join(tempDir, 'window-smoke.jsonl')
    try {
      writeWindowSmokeSnapshot({
        getBounds: () => ({ x: 10, y: 20, width: 1280, height: 820 }),
        getTitle: () => 'Claude Code Companion',
        isDestroyed: () => false,
        isFocused: () => true,
        isFullScreen: () => false,
        isMaximized: () => false,
        isMinimized: () => false,
        isVisible: () => true,
        webContents: {
          getURL: () => 'file:///app.asar/dist/index.html',
          isLoading: vi.fn(() => false),
        },
      } as never, 'did-finish-load', {
        CC_HAHA_ELECTRON_WINDOW_SMOKE_LOG: logPath,
      })

      expect(JSON.parse(readFileSync(logPath, 'utf8')).trim).toBeUndefined()
      const payload = JSON.parse(readFileSync(logPath, 'utf8'))
      expect(payload).toMatchObject({
        reason: 'did-finish-load',
        title: 'Claude Code Companion',
        visible: true,
        focused: true,
        minimized: false,
        url: 'file:///app.asar/dist/index.html',
      })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
