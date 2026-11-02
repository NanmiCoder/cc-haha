import { describe, expect, it } from 'vitest'
import { resolveMobileShellLayout } from './mobileShellLayout'

describe('resolveMobileShellLayout', () => {
  it('keeps Electron on the desktop shell at any size', () => {
    expect(resolveMobileShellLayout({ desktopRuntime: true, coarsePointer: true, narrow: true })).toBe('desktop')
  })

  it('treats any narrow browser window as a phone', () => {
    expect(resolveMobileShellLayout({ desktopRuntime: false, coarsePointer: false, narrow: true })).toBe('phone')
    expect(resolveMobileShellLayout({ desktopRuntime: false, coarsePointer: true, narrow: true })).toBe('phone')
  })

  it('makes a wide window a tablet only when its primary pointer is touch', () => {
    // iPad or an Android tablet.
    expect(resolveMobileShellLayout({ desktopRuntime: false, coarsePointer: true, narrow: false })).toBe('tablet')
    // A desktop, or a laptop whose screen also takes touch: mouse or trackpad first.
    expect(resolveMobileShellLayout({ desktopRuntime: false, coarsePointer: false, narrow: false })).toBe('desktop')
  })
})
