export type H5RequestKind = 'local-trusted' | 'internal-sdk' | 'h5-browser'
export type H5RequestContext = {
  clientAddress: string | null
}

const LOCAL_DESKTOP_ORIGINS = new Set(['file://'])

export function normalizeHostname(hostname: string): string {
  return hostname.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  if (normalized.startsWith('::ffff:')) {
    return isLoopbackHost(normalized.slice('::ffff:'.length))
  }
  return normalized === 'localhost' || normalized === '::1' || isLoopbackIPv4(normalized)
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

  return isLoopbackHost(parsed.hostname)
}

function isLocalDesktopOrNavigationOrigin(origin: string | null): boolean {
  if (!origin) return true
  return LOCAL_DESKTOP_ORIGINS.has(origin) || isLoopbackBrowserOrigin(origin)
}

function isFilesystemCapabilityPath(pathname: string): boolean {
  return pathname.startsWith('/local-file/') ||
    pathname.startsWith('/preview-fs/')
}

export function classifyH5Request(
  request: Request,
  url: URL,
  context: H5RequestContext,
): H5RequestKind {
  const origin = request.headers.get('Origin')
  if (isFilesystemCapabilityPath(url.pathname)) {
    const localFilesystemTrusted = Boolean(context.clientAddress) &&
      isLoopbackHost(context.clientAddress!) &&
      isLocalDesktopOrNavigationOrigin(origin)

    return localFilesystemTrusted ? 'local-trusted' : 'h5-browser'
  }

  const localTrusted = Boolean(context.clientAddress) &&
    isLoopbackHost(context.clientAddress!) &&
    isLocalDesktopOrNavigationOrigin(origin)

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
    isFilesystemCapabilityPath(pathname) ||
    pathname.startsWith('/proxy/') ||
    pathname.startsWith('/ws/') ||
    pathname.startsWith('/sdk/')
}

function isH5BrowserCapabilityPath(pathname: string): boolean {
  return pathname.startsWith('/api/') ||
    isFilesystemCapabilityPath(pathname) ||
    pathname.startsWith('/proxy/') ||
    pathname.startsWith('/ws/')
}
