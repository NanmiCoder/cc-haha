import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { detectDesktopPlatform } from './platform.js'

const userAgents = {
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
  windowsChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
  androidChrome: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  iPhoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
  chromeOS: 'Mozilla/5.0 (X11; CrOS x86_64 16181.47.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
}

describe('desktop platform detection', () => {
  it('names the desktop package for macOS, Windows, and Linux browsers', () => {
    assert.equal(detectDesktopPlatform({ userAgent: userAgents.macSafari, platform: 'MacIntel' }), 'macOS')
    assert.equal(detectDesktopPlatform({ userAgent: userAgents.windowsChrome, platform: 'Win32' }), 'Windows')
    assert.equal(detectDesktopPlatform({ userAgent: userAgents.linuxFirefox, platform: 'Linux x86_64' }), 'Linux')
  })

  it('prefers client hints when the user agent string is reduced', () => {
    assert.equal(detectDesktopPlatform({ userAgent: userAgents.windowsChrome, platform: 'macOS' }), 'macOS')
    assert.equal(detectDesktopPlatform({ userAgent: '', platform: 'Windows' }), 'Windows')
  })

  it('falls back for phones even though Android reports Linux', () => {
    assert.equal(detectDesktopPlatform({ userAgent: userAgents.androidChrome, platform: 'Linux armv81' }), null)
    assert.equal(detectDesktopPlatform({ userAgent: userAgents.androidChrome, platform: 'Android' }), null)
    assert.equal(detectDesktopPlatform({ userAgent: userAgents.iPhoneSafari, platform: 'iPhone' }), null)
  })

  it('falls back for iPadOS, which presents a Mac user agent with touch support', () => {
    assert.equal(detectDesktopPlatform({ userAgent: userAgents.macSafari, platform: 'MacIntel', maxTouchPoints: 5 }), null)
  })

  it('falls back for ChromeOS and unknown environments', () => {
    assert.equal(detectDesktopPlatform({ userAgent: userAgents.chromeOS, platform: 'Linux x86_64' }), null)
    assert.equal(detectDesktopPlatform({ userAgent: userAgents.chromeOS, platform: 'Chrome OS' }), null)
    assert.equal(detectDesktopPlatform({}), null)
  })
})
