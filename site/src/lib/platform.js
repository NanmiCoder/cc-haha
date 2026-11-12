/**
 * The hero's main download button shows the desktop build for the visitor's OS. Phones, tablets (including iPadOS posing as a Mac in its UA)
 * and ChromeOS have no directly installable desktop package, so this returns null and the caller shows the generic "Get the desktop app".
 */
export function detectDesktopPlatform({ userAgent = '', platform = '', maxTouchPoints = 0 } = {}) {
  if (/Android|iOS|iPhone|iPad|iPod|Chrome OS|CrOS/i.test(platform)) return null
  if (/Android|iPhone|iPad|iPod|Mobile|CrOS/i.test(userAgent)) return null
  if (/Mac/i.test(platform) || /Macintosh|Mac OS X/.test(userAgent)) {
    return maxTouchPoints > 1 ? null : 'macOS'
  }
  if (/Win/i.test(platform) || /Windows/.test(userAgent)) return 'Windows'
  if (/Linux/i.test(platform) || /Linux|X11/.test(userAgent)) return 'Linux'
  return null
}

export function currentDesktopPlatform() {
  if (typeof navigator === 'undefined') return null
  return detectDesktopPlatform({
    userAgent: navigator.userAgent || '',
    platform: navigator.userAgentData?.platform || navigator.platform || '',
    maxTouchPoints: navigator.maxTouchPoints || 0
  })
}
