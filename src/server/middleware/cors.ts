/**
 * CORS middleware for desktop and temporary open H5 access.
 */

export function corsHeaders(origin?: string | null): Record<string, string> {
  const allowedOrigin = origin || 'http://localhost:3000'
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function baseCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

export type CorsResolution = {
  allowed: boolean
  rejected: boolean
  headers: Record<string, string>
}

export type CorsResolutionOptions = {
  h5Enabled?: boolean
  isOriginAllowed?: (origin: string) => Promise<boolean>
}

const LOCAL_DESKTOP_ORIGINS = new Set(['file://'])

function isLocalOrigin(origin?: string | null): boolean {
  if (!origin) {
    return true
  }

  return LOCAL_DESKTOP_ORIGINS.has(origin) || isLoopbackBrowserOrigin(origin)
}

function isLoopbackBrowserOrigin(origin: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return false
  }

  const hostname = parsed.hostname
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .toLowerCase()

  return hostname === 'localhost' || hostname === '::1' || isLoopbackIPv4(hostname)
}

function isLoopbackIPv4(hostname: string): boolean {
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts[0] !== '127') {
    return false
  }

  return parts.every((part) => {
    if (!/^\d+$/.test(part)) {
      return false
    }

    const value = Number(part)
    return value >= 0 && value <= 255
  })
}

export async function resolveCors(
  origin?: string | null,
  _requestOrigin?: string | null,
  options: CorsResolutionOptions = {},
): Promise<CorsResolution> {
  if (!origin) {
    return {
      allowed: true,
      rejected: false,
      headers: corsHeaders(origin),
    }
  }

  if (!options.h5Enabled || isLocalOrigin(origin)) {
    return {
      allowed: true,
      rejected: false,
      headers: {
        ...baseCorsHeaders(),
        'Access-Control-Allow-Origin': origin,
      },
    }
  }

  if (options.isOriginAllowed && await options.isOriginAllowed(origin)) {
    return {
      allowed: true,
      rejected: false,
      headers: {
        ...baseCorsHeaders(),
        'Access-Control-Allow-Origin': origin,
      },
    }
  }

  return {
    allowed: false,
    rejected: true,
    headers: baseCorsHeaders(),
  }
}
