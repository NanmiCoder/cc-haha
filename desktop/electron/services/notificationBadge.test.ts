import type { NativeImage } from 'electron'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import { createNotificationBadge } from './notificationBadge'

function fixture(platform: NodeJS.Platform) {
  const app = { setBadgeCount: vi.fn(() => true) }
  const icon = {} as NativeImage
  const image = { crop: vi.fn(() => icon) }
  const loadWindowsIcons = vi.fn(() => image)
  const listeners = new Map<string, () => void>()
  const window = {
    on: (event: string, callback: () => void) => { listeners.set(event, callback) },
    isDestroyed: vi.fn(() => false),
    setOverlayIcon: vi.fn(),
  }
  const set = createNotificationBadge({ platform, app, window, loadWindowsIcons })
  return { set, app, window, loadWindowsIcons, image, icon, listeners }
}

describe('Electron notification badge', () => {
  it('ships ten distinct 16px red badges with white lettering on a transparent background', async () => {
    const path = resolve(dirname(fileURLToPath(import.meta.url)), '../../src-tauri/icons/windows/taskbar-badges.png')
    const sheet = sharp(path)
    const { width, height, channels } = await sheet.metadata()
    expect([width, height, channels]).toEqual([160, 16, 4])
    const badges = new Set<string>()
    for (let x = 0; x < 160; x += 16) {
      const pixels = await sheet.clone().extract({ left: x, top: 0, width: 16, height: 16 }).raw().toBuffer()
      expect(pixels[3]).toBe(0)
      expect(pixels.indexOf(Buffer.from([208, 44, 48, 255]))).toBeGreaterThanOrEqual(0)
      expect(pixels.indexOf(Buffer.from([255, 255, 255, 255]))).toBeGreaterThanOrEqual(0)
      badges.add(pixels.toString('hex'))
    }
    expect(badges.size).toBe(10)
  })

  it('sets and clears the macOS Dock badge', () => {
    const { set, app, window, loadWindowsIcons } = fixture('darwin')
    expect(set(2, '2 sessions')).toBe(true)
    expect(set(0, '')).toBe(true)
    expect(app.setBadgeCount.mock.calls).toEqual([[2], [0]])
    expect(window.setOverlayIcon).not.toHaveBeenCalled()
    expect(loadWindowsIcons).not.toHaveBeenCalled()
  })

  it('uses a numbered 16px overlay on Windows and reads the exact count past 9', () => {
    const { set, app, window, loadWindowsIcons, image, icon } = fixture('win32')
    for (const count of [1, 9, 10, 427]) expect(set(count, `${count} sessions`)).toBe(true)
    expect(loadWindowsIcons).toHaveBeenCalledTimes(1)
    expect(image.crop.mock.calls).toEqual([0, 128, 144, 144].map(x => [{ x, y: 0, width: 16, height: 16 }]))
    expect(window.setOverlayIcon.mock.calls).toEqual([1, 9, 10, 427].map(count => [icon, `${count} sessions`]))
    expect(set(0, '')).toBe(true)
    expect(window.setOverlayIcon).toHaveBeenLastCalledWith(null, '')
    expect(app.setBadgeCount).not.toHaveBeenCalled()
  })

  it('restores the latest overlay when the taskbar button returns and never revives a cleared badge', () => {
    const { set, listeners, window, icon } = fixture('win32')
    set(4, '4 sessions')
    listeners.get('show')?.()
    listeners.get('focus')?.()
    expect(window.setOverlayIcon.mock.calls).toEqual(Array(3).fill([icon, '4 sessions']))
    set(0, '')
    listeners.get('show')?.()
    expect(window.setOverlayIcon).toHaveBeenCalledTimes(4)
    expect(window.setOverlayIcon).toHaveBeenLastCalledWith(null, '')
    window.isDestroyed.mockReturnValue(true)
    expect(set(2, '2 sessions')).toBe(false)
  })

  it('ignores unsupported platforms and rejects invalid payloads before touching either OS', () => {
    expect(fixture('linux').set(2, '2 sessions')).toBe(false)
    const { set, app, window } = fixture('win32')
    for (const invalid of [-1, 1.5, 2 ** 31, NaN, '2', undefined]) {
      expect(() => set(invalid, 'invalid')).toThrow('Invalid notification badge count')
    }
    for (const invalid of [null, 1, '', '   ']) {
      expect(() => set(2, invalid)).toThrow('Invalid notification badge description')
    }
    expect(app.setBadgeCount).not.toHaveBeenCalled()
    expect(window.setOverlayIcon).not.toHaveBeenCalled()
  })
})
