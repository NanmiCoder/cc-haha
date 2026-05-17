/**
 * CORS middleware for desktop, mobile, and temporary open H5 access.
 */

import { isLoopbackHost } from '../h5AccessPolicy.js'

let mobileMode = false

export function setMobileMode(enabled: boolean): void {
  mobileMode = enabled
}

export function isMobileMode(): boolean {
  return mobileMode
}

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

const LOCAL_ORIGINS = new Set([
  'http://tauri.localhost',
  'https://tauri.localhost',
  'tauri://localhost',
])

function isLocalOrigin(origin?: string | null): boolean {
  if (!origin) {
    return true
  }

  if (LOCAL_ORIGINS.has(origin)) {
    return true
  }

  try {
    return isLoopbackHost(new URL(origin).hostname)
  } catch {
    return false
  }
}

export async function resolveCors(
  origin?: string | null,
  _requestOrigin?: string | null,
  options: CorsResolutionOptions = {},
): Promise<CorsResolution> {
  // Mobile mode: allow all origins
  if (mobileMode) {
    return {
      allowed: true,
      rejected: false,
      headers: {
        ...baseCorsHeaders(),
        'Access-Control-Allow-Origin': '*',
      },
    }
  }

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
