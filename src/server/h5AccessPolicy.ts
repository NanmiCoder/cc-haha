export type H5RequestKind = 'local-trusted' | 'internal-sdk' | 'h5-browser'
export type H5RequestContext = {
  clientAddress: string | null
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
const LOCAL_ORIGINS = new Set([
  'http://tauri.localhost',
  'https://tauri.localhost',
  'tauri://localhost',
])

export function normalizeHostname(hostname: string): string {
  return hostname.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  if (normalized.startsWith('::ffff:')) {
    return isLoopbackHost(normalized.slice('::ffff:'.length))
  }
  return LOCAL_HOSTS.has(normalized)
}

function isLocalOrigin(origin: string | null): boolean {
  if (!origin) return true
  if (LOCAL_ORIGINS.has(origin)) return true

  try {
    return isLoopbackHost(new URL(origin).hostname)
  } catch {
    return false
  }
}

export function classifyH5Request(
  request: Request,
  url: URL,
  context: H5RequestContext,
): H5RequestKind {
  const localTrusted = Boolean(context.clientAddress) &&
    isLoopbackHost(context.clientAddress!) &&
    isLocalOrigin(request.headers.get('Origin'))

  if (url.pathname.startsWith('/sdk/') && localTrusted) {
    return 'internal-sdk'
  }

  if (localTrusted) {
    return 'local-trusted'
  }

  return 'h5-browser'
}

export function shouldRequireH5Token({
  request,
  url,
  h5Enabled,
  context,
}: {
  request: Request
  url: URL
  h5Enabled: boolean
  context: H5RequestContext
}): boolean {
  if (!h5Enabled) {
    return false
  }

  if (!isH5BrowserCapabilityPath(url.pathname)) {
    return false
  }

  return classifyH5Request(request, url, context) === 'h5-browser'
}

export function shouldBlockDisabledH5Access({
  request,
  url,
  h5Enabled,
  explicitAuthRequired,
  context,
}: {
  request: Request
  url: URL
  h5Enabled: boolean
  explicitAuthRequired: boolean
  context: H5RequestContext
}): boolean {
  if (h5Enabled || explicitAuthRequired) {
    return false
  }

  if (!isH5ProtectedCapabilityPath(url.pathname)) {
    return false
  }

  return classifyH5Request(request, url, context) === 'h5-browser'
}

function isH5ProtectedCapabilityPath(pathname: string): boolean {
  return pathname.startsWith('/api/') ||
    pathname.startsWith('/proxy/') ||
    pathname.startsWith('/ws/') ||
    pathname.startsWith('/sdk/')
}

function isH5BrowserCapabilityPath(pathname: string): boolean {
  return pathname.startsWith('/api/') ||
    pathname.startsWith('/proxy/') ||
    pathname.startsWith('/ws/')
}
