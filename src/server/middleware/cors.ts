/**
 * CORS middleware for local desktop app and mobile app communication
 */

const ALLOWED_ORIGIN_RE =
  /^(?:https?:\/\/(?:localhost|127\.0\.0\.1|tauri\.localhost)(?::\d+)?|tauri:\/\/localhost|asset:\/\/localhost)$/

let mobileMode = false

export function setMobileMode(enabled: boolean): void {
  mobileMode = enabled
}

export function isMobileMode(): boolean {
  return mobileMode
}

export function corsHeaders(origin?: string | null): Record<string, string> {
  // In mobile mode, allow all origins (mobile apps and PWA have no fixed origin)
  if (mobileMode) {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    }
  }

  // Allow localhost origins (http/https) and Tauri WebView origins
  const allowedOrigin =
    origin && ALLOWED_ORIGIN_RE.test(origin) ? origin : 'http://localhost:3000'
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  }
}
