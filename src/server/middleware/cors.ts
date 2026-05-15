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

export async function resolveCors(
  origin?: string | null,
  _requestOrigin?: string | null,
  _options: CorsResolutionOptions = {},
): Promise<CorsResolution> {
  return {
    allowed: true,
    rejected: false,
    headers: {
      ...baseCorsHeaders(),
      'Access-Control-Allow-Origin': origin ?? '*',
    },
  }
}
