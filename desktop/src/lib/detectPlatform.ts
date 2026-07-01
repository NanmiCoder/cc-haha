export type Platform = 'win32' | 'darwin' | 'linux'

/**
 * Detect the renderer-side platform using the modern navigator API with
 * a userAgent fallback. Returns one of the three keys used in plugin /
 * language-server install maps; defaults to `linux` for the unknown
 * case so the shell-style install step is the most likely working
 * option.
 *
 * Platform doesn't change during a session, so callers can detect once
 * at mount.
 */
export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'linux'
  const ua = (navigator as unknown as {
    userAgentData?: { platform?: string }
  }).userAgentData?.platform
  if (typeof ua === 'string') {
    const lower = ua.toLowerCase()
    if (lower.includes('win')) return 'win32'
    if (lower.includes('mac')) return 'darwin'
    if (lower.includes('linux')) return 'linux'
  }
  const fallback = navigator.userAgent || ''
  if (/Windows/i.test(fallback)) return 'win32'
  if (/Mac OS X|Macintosh/i.test(fallback)) return 'darwin'
  return 'linux'
}
