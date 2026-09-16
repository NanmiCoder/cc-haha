export type H5RequestKind = 'local-trusted' | 'internal-sdk' | 'h5-browser'
export type H5RequestContext = {
  clientAddress: string | null
  localAccessTokenConfigured?: boolean
  localAccessAuthorized?: boolean
  internalSdkAuthorized?: boolean
}

const LOCAL_DESKTOP_ORIGINS = new Set(['file://'])
const PROXY_TRACE_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'via',
] as const
const PREVIEW_STATIC_DESTINATIONS = new Set([
  'audio',
  'font',
  'image',
  'manifest',
  'script',
  'style',
  'track',
  'video',
  'worker',
])
const PREVIEW_REFERER_PARENT_EXTENSIONS = new Set([
  '.css',
  '.cjs',
  '.js',
  '.mjs',
])

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

function pathnameDirectory(pathname: string): string {
  const slash = pathname.lastIndexOf('/')
  return slash < 0 ? '/' : pathname.slice(0, slash + 1)
}

function pathnameExtension(pathname: string): string {
  const fileName = pathname.slice(pathname.lastIndexOf('/') + 1)
  const dot = fileName.lastIndexOf('.')
  return dot < 0 ? '' : fileName.slice(dot).toLowerCase()
}

function filesystemCapabilityScope(pathname: string): {
  kind: 'preview-fs' | 'local-file'
  root: string
} | null {
  if (pathname.startsWith('/preview-fs/')) {
    const sessionEnd = pathname.indexOf('/', '/preview-fs/'.length)
    if (sessionEnd < 0) return null
    return {
      kind: 'preview-fs',
      root: pathname.slice(0, sessionEnd + 1),
    }
  }
  if (pathname.startsWith('/local-file/')) {
    return { kind: 'local-file', root: '/local-file/' }
  }
  return null
}

/**
 * Preview HTML is sandboxed but keeps its server origin so module scripts,
 * styles, fonts and media can load. Trust only passive/static resource loads
 * that stay below the referring document's filesystem directory. Ordinary
 * fetch/XHR, navigations and every non-filesystem capability remain outside
 * this exception.
 */
function isSameOriginFilesystemAsset(
  request: Request,
  url: URL,
  origin: string | null,
): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  if (request.headers.get('Sec-Fetch-Site') !== 'same-origin') return false
  if (!PREVIEW_STATIC_DESTINATIONS.has(request.headers.get('Sec-Fetch-Dest') ?? '')) {
    return false
  }
  let refererUrl: URL
  try {
    refererUrl = new URL(request.headers.get('Referer') ?? '')
  } catch {
    return false
  }
  if (refererUrl.origin !== url.origin) return false
  if (origin) {
    try {
      if (new URL(origin).origin !== url.origin) return false
    } catch {
      return false
    }
  }

  const requestScope = filesystemCapabilityScope(url.pathname)
  const refererScope = filesystemCapabilityScope(refererUrl.pathname)
  if (
    !requestScope ||
    !refererScope ||
    requestScope.kind !== refererScope.kind ||
    requestScope.root !== refererScope.root
  ) {
    return false
  }

  const refererDirectory = pathnameDirectory(refererUrl.pathname)
  if (url.pathname.startsWith(refererDirectory)) return true

  // A stylesheet or module may load a sibling fonts/chunks directory. Permit
  // one parent only for those nested dependency referrers; the HTML entry
  // point itself never receives this broader scope.
  if (!PREVIEW_REFERER_PARENT_EXTENSIONS.has(pathnameExtension(refererUrl.pathname))) {
    return false
  }
  const parentDirectory = pathnameDirectory(refererDirectory.slice(0, -1))
  return parentDirectory.startsWith(requestScope.root) &&
    url.pathname.startsWith(parentDirectory)
}

/**
 * A cross-site subresource load (`<img>`, `<script>`, `no-cors` fetch) reaches
 * us without an `Origin` header, so it would otherwise be indistinguishable
 * from a genuine local navigation. Fetch Metadata is what tells them apart:
 * a top-level navigation carries `Sec-Fetch-Mode: navigate`, a subresource
 * does not. Clients that send no Fetch Metadata at all (curl, adapters, the
 * CLI subprocess) stay trusted — they are not a browser CSRF vector.
 */
function isCrossSiteSubresource(headers: Headers): boolean {
  const site = headers.get('Sec-Fetch-Site')
  if (site !== 'cross-site' && site !== 'same-site') {
    return false
  }

  const mode = headers.get('Sec-Fetch-Mode')
  return mode !== null && mode !== 'navigate'
}

function isLocalDesktopOrNavigationOrigin(
  request: Request,
  origin: string | null,
  context: H5RequestContext,
): boolean {
  if (!origin) return !isCrossSiteSubresource(request.headers)
  if (LOCAL_DESKTOP_ORIGINS.has(origin)) return true

  // A configured process credential distinguishes the Electron renderer from
  // arbitrary pages served by another loopback process. Keep tokenless
  // navigation, OAuth callbacks and CLI/adapters working above, but never
  // grant an Origin-bearing browser page that credential by locality alone.
  if (context.localAccessTokenConfigured) return false

  return isLoopbackBrowserOrigin(origin)
}

function hasProxyTraceHeaders(headers: Headers): boolean {
  return PROXY_TRACE_HEADERS.some((header) => headers.has(header))
}

function isLocalTrustedRequest(
  request: Request,
  url: URL,
  context: H5RequestContext,
  origin: string | null,
): boolean {
  // The process token the desktop shell injects is the strongest credential we
  // have: it identifies the app's own components (renderer, adapters, the CLI
  // subprocess) regardless of how they reach us.
  if (context.localAccessAuthorized === true) return true
  if (isSameOriginFilesystemAsset(request, url, origin)) return true
  if (
    filesystemCapabilityScope(url.pathname) &&
    request.headers.get('Sec-Fetch-Site') === 'same-origin' &&
    PREVIEW_STATIC_DESTINATIONS.has(request.headers.get('Sec-Fetch-Dest') ?? '')
  ) {
    // Classic scripts, styles and images often omit Origin. Once Fetch
    // Metadata identifies a browser filesystem subresource, it must satisfy
    // the same Referer capability/directory boundary above instead of falling
    // back to broad loopback trust.
    return false
  }

  // Its *absence* must not demote loopback, though. Plenty of legitimate local
  // traffic can never carry that token — the OAuth success page the system
  // browser opens, `/preview-fs` links, a `curl` against the local API. Gating
  // loopback behind the token turned all of those into 401/403 (issue: "Missing
  // H5 access token" on /api/haha-grok-oauth/success). Loopback stays trusted
  // on its own; the Host, proxy-trace and Origin checks below are what keep a
  // remote client from claiming it.
  const clientAddress = context.clientAddress
  if (!clientAddress) return false
  if (hasProxyTraceHeaders(request.headers)) return false

  return isLoopbackHost(clientAddress) &&
    isLoopbackHost(url.hostname) &&
    isLocalDesktopOrNavigationOrigin(request, origin, context)
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
  const localTrusted = isLocalTrustedRequest(request, url, context, origin)
  if (isFilesystemCapabilityPath(url.pathname)) {
    return localTrusted ? 'local-trusted' : 'h5-browser'
  }

  if (url.pathname.startsWith('/sdk/') && (localTrusted || context.internalSdkAuthorized)) {
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

export function isH5AccessControlPath(pathname: string): boolean {
  return pathname.startsWith('/api/h5-access') &&
    pathname !== '/api/h5-access/verify'
}

/**
 * Endpoints that irreversibly destroy user data in a single request. The H5
 * token is minted for a paired phone's convenience, not for bulk deletion, so
 * these require the desktop process token even though they sit under the
 * ordinary `/api` surface.
 */
const LOCAL_CREDENTIAL_ONLY_PATHS: ReadonlySet<string> = new Set([
  '/api/settings/session-cleanup',
])

/**
 * Compare paths the way the router routes them (`split('/').filter(Boolean)`)
 * so `/x/y/`, `//x/y` and `/x/y` cannot slip past a gated endpoint by changing
 * the URL shape — the handler still matches all three.
 */
function normalizeApiPath(pathname: string): string {
  return `/${pathname.split('/').filter(Boolean).join('/')}`
}

export function isLocalCredentialOnlyPath(pathname: string): boolean {
  return LOCAL_CREDENTIAL_ONLY_PATHS.has(normalizeApiPath(pathname))
}

/**
 * The control plane — enabling remote access, minting and revoking H5 tokens —
 * is the one surface where loopback alone is deliberately not enough. Once the
 * desktop shell has injected its process token, only components holding that
 * token may change who can reach this machine; another browser or script on the
 * same box must not be able to publish the user's sessions to the network.
 * This is the boundary `harden desktop request isolation` set out to protect,
 * and it is kept here instead of being applied to every local request.
 *
 * `LOCAL_CREDENTIAL_ONLY_PATHS` joins it for the same reason from the other
 * direction: a stolen H5 token must not be able to wipe the machine's history.
 */
export function requiresLocalAccessCredential(
  pathname: string,
  context: H5RequestContext,
): boolean {
  if (!context.localAccessTokenConfigured) return false
  if (!isH5AccessControlPath(pathname) && !isLocalCredentialOnlyPath(pathname)) {
    return false
  }
  return context.localAccessAuthorized !== true
}

function isH5BrowserCapabilityPath(pathname: string): boolean {
  return pathname.startsWith('/api/') ||
    isFilesystemCapabilityPath(pathname) ||
    pathname.startsWith('/proxy/') ||
    pathname.startsWith('/ws/')
}
