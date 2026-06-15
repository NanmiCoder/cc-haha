import { createHash, randomBytes } from 'node:crypto'
import os from 'node:os'
import { ApiError } from '../middleware/errorHandler.js'
import { ManagedSettingsService } from './managedSettingsService.js'
import { ProviderService } from './providerService.js'

export type H5AccessSettings = {
  enabled: boolean
  /**
   * Full access token. Persisted so it can be recovered at any time from the
   * desktop app (issue #767: tokens used to be shown once and lost on
   * restart, forcing regeneration that invalidated every connected phone).
   * Only ever served to local-trusted requests — the `/api/h5-access` route
   * (except `verify`) is rejected for remote callers before reaching this
   * service.
   */
  token: string | null
  tokenPreview: string | null
  allowedOrigins: string[]
  publicBaseUrl: string | null
  /**
   * Preferred fixed TCP port for the desktop server. The desktop launchers
   * (Electron and Tauri) read this before spawning the sidecar so reverse
   * proxies and phone bookmarks keep working across app restarts. Applied on
   * next launch.
   */
  fixedPort: number | null
  /**
   * Idle grace period (seconds) before an unobserved session's CLI subprocess
   * is stopped after the last client disconnects (issue #764). A turn that is
   * actively running is never interrupted regardless of this value — the grace
   * timer only starts once the session is idle with no clients attached, so a
   * phone that locks its screen mid-task lets the task finish in the
   * background and shows the result on reconnect. null = built-in 30s default.
   */
  disconnectGraceSeconds: number | null
}

export type H5AccessEnableResult = {
  settings: H5AccessSettings
  token: string
}

export type H5HostStaleness = 'ok' | 'unreachable' | 'proxy' | 'unset'

export type H5AccessDiagnostics = {
  storedHostStaleness: H5HostStaleness
  storedPublicBaseUrl: string | null
  effectivePublicBaseUrl: string | null
  suggestedHost: string | null
  localInterfaceHosts: string[]
  /** Port the running server is actually bound to. Lets the UI flag a fixedPort that has not taken effect yet. */
  activePort: number
}

export type H5PublicBaseUrlClassification = 'plain-lan' | 'proxy'

export type H5PublicBaseUrlValidationResult =
  | { ok: true; kind: H5PublicBaseUrlClassification }
  | { ok: false; reason: string; suggestedHost: string | null }

type StoredH5AccessSettings = H5AccessSettings & {
  tokenHash: string | null
}

const DEFAULT_STORED_SETTINGS: StoredH5AccessSettings = {
  enabled: false,
  token: null,
  tokenHash: null,
  tokenPreview: null,
  allowedOrigins: [],
  publicBaseUrl: null,
  fixedPort: null,
  disconnectGraceSeconds: null,
}

const TOKEN_HASH_RE = /^[a-f0-9]{64}$/
// Tokens must survive URL query params and Authorization headers, so restrict
// to visible ASCII. The 16-char floor keeps hand-edited tokens from being
// trivially guessable while still allowing users to pin their own value.
const TOKEN_RE = /^[\x21-\x7e]{16,512}$/
const MIN_FIXED_PORT = 1024
const MAX_FIXED_PORT = 65535
// Disconnect grace bounds. Floor at 5s so a transient renderer reconnect is
// always tolerated; ceiling at 24h so a stuck phone cannot pin a subprocess
// forever. Mirrored in the desktop UI validator.
const MIN_DISCONNECT_GRACE_SECONDS = 5
const MAX_DISCONNECT_GRACE_SECONDS = 86_400
export const DEFAULT_DISCONNECT_GRACE_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function toPublicSettings(settings: StoredH5AccessSettings): H5AccessSettings {
  return {
    enabled: settings.enabled,
    token: settings.token,
    tokenPreview: settings.tokenPreview,
    allowedOrigins: settings.allowedOrigins,
    fixedPort: settings.fixedPort,
    disconnectGraceSeconds: settings.disconnectGraceSeconds,
    publicBaseUrl: resolveEffectiveH5PublicBaseUrl({
      enabled: settings.enabled,
      storedPublicBaseUrl: settings.publicBaseUrl,
      configuredPublicBaseUrl: resolveConfiguredPublicBaseUrl(),
      autoPublicBaseUrl: resolveAutoLanPublicBaseUrl(),
      localInterfaceHosts: collectLocalIPv4Hosts(),
    }),
  }
}

function describeH5AccessDiagnostics(stored: StoredH5AccessSettings): H5AccessDiagnostics {
  const localInterfaceHosts = collectLocalIPv4Hosts()
  const autoPublicBaseUrl = resolveAutoLanPublicBaseUrl()
  const configuredPublicBaseUrl = resolveConfiguredPublicBaseUrl()
  const effectivePublicBaseUrl = resolveEffectiveH5PublicBaseUrl({
    enabled: stored.enabled,
    storedPublicBaseUrl: stored.publicBaseUrl,
    configuredPublicBaseUrl,
    autoPublicBaseUrl,
    localInterfaceHosts,
  })

  const suggestedHost = pickPreferredLanHost(localInterfaceHosts)
  let storedHostStaleness: H5HostStaleness = 'unset'
  if (stored.publicBaseUrl) {
    const classification = classifyH5PublicBaseUrl(stored.publicBaseUrl)
    if (classification === 'plain-lan') {
      try {
        const u = new URL(stored.publicBaseUrl)
        storedHostStaleness = localInterfaceHosts.includes(u.hostname) ? 'ok' : 'unreachable'
      } catch {
        storedHostStaleness = 'unreachable'
      }
    } else if (classification === 'proxy') {
      storedHostStaleness = 'proxy'
    } else {
      storedHostStaleness = 'unreachable'
    }
  }

  return {
    storedHostStaleness,
    storedPublicBaseUrl: stored.publicBaseUrl,
    effectivePublicBaseUrl,
    suggestedHost,
    localInterfaceHosts,
    activePort: ProviderService.getServerPort(),
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function createToken(): string {
  return `h5_${randomBytes(32).toString('base64url')}`
}

function createTokenPreview(token: string): string {
  return `${token.slice(0, 7)}...${token.slice(-4)}`
}

function normalizeOriginInput(origin: string, fieldName = 'allowedOrigins'): string {
  if (origin.includes('*')) {
    throw ApiError.badRequest(`${fieldName} must not contain wildcard origins`)
  }

  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw ApiError.badRequest(`Invalid origin: ${origin}`)
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw ApiError.badRequest(`Invalid origin protocol: ${origin}`)
  }

  if (parsed.username || parsed.password) {
    throw ApiError.badRequest(`Invalid origin credentials: ${origin}`)
  }

  return parsed.origin
}

function normalizeAllowedOrigins(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw ApiError.badRequest('allowedOrigins must be an array of strings')
  }

  const normalized = input.map((origin) => {
    if (typeof origin !== 'string') {
      throw ApiError.badRequest('allowedOrigins must be an array of strings')
    }
    return normalizeOriginInput(origin)
  })

  return [...new Set(normalized)]
}

function normalizePublicBaseUrl(input: unknown): string | null {
  if (input === null || input === undefined || input === '') {
    return null
  }

  if (typeof input !== 'string') {
    throw ApiError.badRequest('publicBaseUrl must be a string or null')
  }

  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw ApiError.badRequest(`Invalid publicBaseUrl: ${input}`)
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw ApiError.badRequest(`Invalid publicBaseUrl protocol: ${input}`)
  }

  if (parsed.username || parsed.password) {
    throw ApiError.badRequest(`Invalid publicBaseUrl credentials: ${input}`)
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.origin}${normalizedPath === '/' ? '' : normalizedPath}`
}

function resolveConfiguredPublicBaseUrl(): string | null {
  const configured = process.env.CLAUDE_H5_PUBLIC_BASE_URL
  if (configured) {
    try {
      return normalizePublicBaseUrl(configured)
    } catch {
      return null
    }
  }

  return null
}

function resolveAutoLanPublicBaseUrl(): string | null {
  if (process.env.CLAUDE_H5_AUTO_PUBLIC_URL !== '1') {
    return null
  }

  const host = findPrivateLanAddress()
  if (!host) {
    return null
  }

  return `http://${host}:${ProviderService.getServerPort()}`
}

export function resolveEffectiveH5PublicBaseUrl({
  enabled,
  storedPublicBaseUrl,
  configuredPublicBaseUrl,
  autoPublicBaseUrl,
  localInterfaceHosts,
}: {
  enabled: boolean
  storedPublicBaseUrl: string | null
  configuredPublicBaseUrl: string | null
  autoPublicBaseUrl: string | null
  localInterfaceHosts?: string[]
}): string | null {
  if (!enabled) {
    return storedPublicBaseUrl
  }

  if (configuredPublicBaseUrl) {
    return configuredPublicBaseUrl
  }

  if (!autoPublicBaseUrl) {
    return storedPublicBaseUrl
  }

  if (!storedPublicBaseUrl || isLocalPublicBaseUrl(storedPublicBaseUrl)) {
    return autoPublicBaseUrl
  }

  // Stale-host fallback: stored is a plain private-LAN URL pointing at an IP
  // that no longer belongs to any of this machine's interfaces (e.g. user
  // switched Wi-Fi). Fall back to the auto-discovered URL without overwriting
  // the stored value, so reconnecting to the original network restores it.
  if (
    Array.isArray(localInterfaceHosts) &&
    isStaleLanPublicBaseUrl(storedPublicBaseUrl, localInterfaceHosts)
  ) {
    return autoPublicBaseUrl
  }

  const refreshedLanUrl = refreshLanPublicBaseUrlPort(storedPublicBaseUrl, autoPublicBaseUrl)
  if (refreshedLanUrl) {
    return refreshedLanUrl
  }

  return storedPublicBaseUrl
}

function isStaleLanPublicBaseUrl(value: string, localInterfaceHosts: string[]): boolean {
  if (classifyH5PublicBaseUrl(value) !== 'plain-lan') return false
  try {
    const hostname = new URL(value).hostname
    return !localInterfaceHosts.includes(hostname)
  } catch {
    return false
  }
}

/**
 * Classify a stored or input H5 publicBaseUrl. A "plain-lan" URL is a bare
 * `http://<private-ipv4>:<port>` with no path and no userinfo — we know we
 * can reach it only if the host is bound to one of our local interfaces.
 * Everything else (https, custom path, hostname/proxy URL) is treated as a
 * user-managed proxy URL we cannot reachability-check.
 */
export function classifyH5PublicBaseUrl(value: string): H5PublicBaseUrlClassification | 'invalid' {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'invalid'
  }

  if (!['http:', 'https:'].includes(url.protocol)) return 'invalid'
  if (url.username || url.password) return 'invalid'

  const path = url.pathname.replace(/\/+$/, '')
  if (url.protocol === 'http:' && path === '' && isPrivateIPv4(url.hostname)) {
    return 'plain-lan'
  }
  return 'proxy'
}

function isLocalPublicBaseUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname
      .trim()
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .toLowerCase()
    return isLocalHost(hostname)
  } catch {
    return false
  }
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname === '::'
}

function refreshLanPublicBaseUrlPort(storedPublicBaseUrl: string, autoPublicBaseUrl: string): string | null {
  try {
    const stored = new URL(storedPublicBaseUrl)
    const auto = new URL(autoPublicBaseUrl)
    const storedPath = stored.pathname.replace(/\/+$/, '')

    if (
      stored.protocol !== 'http:' ||
      storedPath !== '' ||
      !isPrivateIPv4(stored.hostname) ||
      !auto.port
    ) {
      return null
    }

    return `${stored.protocol}//${stored.hostname}:${auto.port}`
  } catch {
    return null
  }
}

type NetworkInterfaces = ReturnType<typeof os.networkInterfaces>

export function collectLocalIPv4Hosts(networkInterfaces: NetworkInterfaces = os.networkInterfaces()): string[] {
  const hosts: string[] = []
  for (const entries of Object.values(networkInterfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        hosts.push(entry.address)
      }
    }
  }
  return hosts
}

function pickPreferredLanHost(localHosts: string[]): string | null {
  for (const host of localHosts) {
    if (host.startsWith('192.168.')) return host
  }
  for (const host of localHosts) {
    if (host.startsWith('10.')) return host
  }
  for (const host of localHosts) {
    if (is172PrivateIPv4(host)) return host
  }
  return localHosts[0] ?? null
}

export function validateH5PublicBaseUrl(
  publicBaseUrl: string,
  localInterfaceHosts: string[] = collectLocalIPv4Hosts(),
): H5PublicBaseUrlValidationResult {
  const kind = classifyH5PublicBaseUrl(publicBaseUrl)
  if (kind === 'invalid') {
    return {
      ok: false,
      reason: `Invalid H5 publicBaseUrl: ${publicBaseUrl}`,
      suggestedHost: pickPreferredLanHost(localInterfaceHosts),
    }
  }

  if (kind === 'plain-lan') {
    try {
      const hostname = new URL(publicBaseUrl).hostname
      if (!localInterfaceHosts.includes(hostname)) {
        const suggested = pickPreferredLanHost(localInterfaceHosts)
        const availableList = localInterfaceHosts.length > 0
          ? localInterfaceHosts.join(', ')
          : 'none'
        return {
          ok: false,
          reason: `H5 host ${hostname} is not bound to any local network interface on this machine. Available LAN IPv4: ${availableList}`,
          suggestedHost: suggested,
        }
      }
    } catch {
      return {
        ok: false,
        reason: `Invalid H5 publicBaseUrl: ${publicBaseUrl}`,
        suggestedHost: pickPreferredLanHost(localInterfaceHosts),
      }
    }
  }

  return { ok: true, kind }
}

const PHYSICAL_INTERFACE_RE = /\b(wi-?fi|wlan|wireless|ethernet|lan|en\d+|eth\d+)\b/i
const VIRTUAL_INTERFACE_RE = /\b(wsl|docker|hyper-?v|veth|vethernet|virtual|virtualbox|vmware|podman|container|bridge|br-|tailscale|zerotier|utun|vpn)\b/i

export function findPrivateLanAddress(networkInterfaces: NetworkInterfaces = os.networkInterfaces()): string | null {
  const candidates: Array<{
    address: string
    interfaceName: string
    index: number
    score: number
  }> = []

  let index = 0
  for (const [interfaceName, entries] of Object.entries(networkInterfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !isPrivateIPv4(entry.address)) {
        continue
      }

      candidates.push({
        address: entry.address,
        interfaceName,
        index,
        score: scoreLanAddressCandidate(interfaceName, entry.address),
      })
      index += 1
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.index - b.index)
  return candidates[0]?.address ?? null
}

function scoreLanAddressCandidate(interfaceName: string, address: string): number {
  let score = 0

  if (PHYSICAL_INTERFACE_RE.test(interfaceName)) {
    score += 100
  }
  if (VIRTUAL_INTERFACE_RE.test(interfaceName)) {
    score -= 200
  }

  if (address.startsWith('192.168.')) {
    score += 30
  } else if (address.startsWith('10.')) {
    score += 20
  } else if (is172PrivateIPv4(address)) {
    score += 10
  } else if (address.startsWith('169.254.')) {
    score -= 100
  }

  return score
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4 || !parts.every((part) => /^\d+$/.test(part))) {
    return false
  }

  const [a = -1, b = -1] = parts.map((part) => Number(part))
  return (
    a === 10 ||
    is172PrivateIPv4(address) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  )
}

function is172PrivateIPv4(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4 || !parts.every((part) => /^\d+$/.test(part))) {
    return false
  }

  const [a = -1, b = -1] = parts.map((part) => Number(part))
  return a === 172 && b >= 16 && b <= 31
}

function normalizeFixedPort(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return null
  }
  if (value < MIN_FIXED_PORT || value > MAX_FIXED_PORT) {
    return null
  }
  return value
}

function normalizeDisconnectGraceSeconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return null
  }
  if (value < MIN_DISCONNECT_GRACE_SECONDS || value > MAX_DISCONNECT_GRACE_SECONDS) {
    return null
  }
  return value
}

function normalizeStoredSettings(value: unknown): StoredH5AccessSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_STORED_SETTINGS }
  }

  const allowedOrigins = Array.isArray(value.allowedOrigins)
    ? [...new Set(value.allowedOrigins.flatMap((origin) => {
        if (typeof origin !== 'string') {
          return []
        }

        try {
          return [normalizeOriginInput(origin)]
        } catch {
          return []
        }
      }))]
    : []

  let publicBaseUrl: string | null = null
  if (typeof value.publicBaseUrl === 'string') {
    try {
      publicBaseUrl = normalizePublicBaseUrl(value.publicBaseUrl)
    } catch {
      publicBaseUrl = null
    }
  }

  // The plaintext token is the source of truth: hash and preview are derived
  // from it, so hand-editing `token` in settings.json pins a custom token.
  // The stored hash only matters for pre-#767 data that never kept plaintext.
  const token = typeof value.token === 'string' && TOKEN_RE.test(value.token)
    ? value.token
    : null
  const storedTokenHash = typeof value.tokenHash === 'string' && TOKEN_HASH_RE.test(value.tokenHash)
    ? value.tokenHash
    : null
  const tokenHash = token ? hashToken(token) : storedTokenHash
  const tokenPreview = token
    ? createTokenPreview(token)
    : tokenHash && typeof value.tokenPreview === 'string' ? value.tokenPreview : null

  return {
    enabled: value.enabled === true && tokenHash !== null,
    token,
    tokenHash,
    tokenPreview,
    allowedOrigins,
    publicBaseUrl,
    fixedPort: normalizeFixedPort(value.fixedPort),
    disconnectGraceSeconds: normalizeDisconnectGraceSeconds(value.disconnectGraceSeconds),
  }
}

export class H5AccessService {
  private managedSettingsService = new ManagedSettingsService()

  private async readStoredSettings(): Promise<{
    managedSettings: Record<string, unknown>
    h5Access: StoredH5AccessSettings
  }> {
    const managedSettings = await this.managedSettingsService.readSettings()
    return {
      managedSettings,
      h5Access: normalizeStoredSettings(managedSettings.h5Access),
    }
  }

  private async setToken(
    managedSettings: Record<string, unknown>,
    current: StoredH5AccessSettings,
    { reuseExistingToken }: { reuseExistingToken: boolean },
  ): Promise<{
    settings: Record<string, unknown>
    result: H5AccessEnableResult
  }> {
    const token = reuseExistingToken && current.token ? current.token : createToken()
    const nextSettings: StoredH5AccessSettings = {
      ...current,
      enabled: true,
      token,
      tokenHash: hashToken(token),
      tokenPreview: createTokenPreview(token),
    }

    return {
      settings: {
        ...managedSettings,
        h5Access: nextSettings,
      },
      result: {
        settings: toPublicSettings(nextSettings),
        token,
      },
    }
  }

  async getSettings(): Promise<H5AccessSettings> {
    const { h5Access } = await this.readStoredSettings()
    return toPublicSettings(h5Access)
  }

  async enable(): Promise<H5AccessEnableResult> {
    // Re-enabling keeps the existing token (issue #767: a stable token means
    // phones that already paired keep working). Use regenerateToken to rotate.
    return this.managedSettingsService.updateSettings(async (current) => {
      return this.setToken(current, normalizeStoredSettings(current.h5Access), {
        reuseExistingToken: true,
      })
    })
  }

  async disable(): Promise<H5AccessSettings> {
    // Keep the token so a later re-enable restores access for already-paired
    // phones. While disabled, validateToken rejects everything regardless.
    return this.managedSettingsService.updateSettings(async (current) => {
      const h5Access = normalizeStoredSettings(current.h5Access)
      const nextSettings: StoredH5AccessSettings = {
        ...h5Access,
        enabled: false,
      }

      return {
        settings: {
          ...current,
          h5Access: nextSettings,
        },
        result: toPublicSettings(nextSettings),
      }
    })
  }

  async regenerateToken(): Promise<H5AccessEnableResult> {
    return this.managedSettingsService.updateSettings(async (current) => {
      return this.setToken(current, normalizeStoredSettings(current.h5Access), {
        reuseExistingToken: false,
      })
    })
  }

  async updateSettings(input: {
    allowedOrigins?: string[]
    publicBaseUrl?: string | null
    fixedPort?: number | null
    disconnectGraceSeconds?: number | null
  }): Promise<H5AccessSettings> {
    return this.managedSettingsService.updateSettings(async (current) => {
      const h5Access = normalizeStoredSettings(current.h5Access)
      let nextPublicBaseUrl: string | null
      if (input.publicBaseUrl === undefined) {
        nextPublicBaseUrl = h5Access.publicBaseUrl
      } else {
        nextPublicBaseUrl = normalizePublicBaseUrl(input.publicBaseUrl)
        if (nextPublicBaseUrl !== null) {
          const validation = validateH5PublicBaseUrl(nextPublicBaseUrl)
          if (!validation.ok) {
            throw ApiError.badRequest(validation.reason)
          }
        }
      }

      let nextFixedPort: number | null
      if (input.fixedPort === undefined) {
        nextFixedPort = h5Access.fixedPort
      } else if (input.fixedPort === null) {
        nextFixedPort = null
      } else {
        nextFixedPort = normalizeFixedPort(input.fixedPort)
        if (nextFixedPort === null) {
          throw ApiError.badRequest(
            `fixedPort must be an integer between ${MIN_FIXED_PORT} and ${MAX_FIXED_PORT}`,
          )
        }
      }

      let nextDisconnectGraceSeconds: number | null
      if (input.disconnectGraceSeconds === undefined) {
        nextDisconnectGraceSeconds = h5Access.disconnectGraceSeconds
      } else if (input.disconnectGraceSeconds === null) {
        nextDisconnectGraceSeconds = null
      } else {
        nextDisconnectGraceSeconds = normalizeDisconnectGraceSeconds(input.disconnectGraceSeconds)
        if (nextDisconnectGraceSeconds === null) {
          throw ApiError.badRequest(
            `disconnectGraceSeconds must be an integer between ${MIN_DISCONNECT_GRACE_SECONDS} and ${MAX_DISCONNECT_GRACE_SECONDS}`,
          )
        }
      }

      const nextSettings: StoredH5AccessSettings = {
        ...h5Access,
        allowedOrigins: input.allowedOrigins === undefined
          ? h5Access.allowedOrigins
          : normalizeAllowedOrigins(input.allowedOrigins),
        publicBaseUrl: nextPublicBaseUrl,
        fixedPort: nextFixedPort,
        disconnectGraceSeconds: nextDisconnectGraceSeconds,
      }

      return {
        settings: {
          ...current,
          h5Access: nextSettings,
        },
        result: toPublicSettings(nextSettings),
      }
    })
  }

  async getDiagnostics(): Promise<H5AccessDiagnostics> {
    const { h5Access } = await this.readStoredSettings()
    return describeH5AccessDiagnostics(h5Access)
  }

  /**
   * Idle grace period (ms) before an unobserved session is stopped after the
   * last client disconnects. Reads the configured value, falling back to the
   * built-in default. Used by the WebSocket handler's disconnect cleanup.
   */
  async getDisconnectGraceMs(): Promise<number> {
    const { h5Access } = await this.readStoredSettings()
    return h5Access.disconnectGraceSeconds !== null
      ? h5Access.disconnectGraceSeconds * 1000
      : DEFAULT_DISCONNECT_GRACE_MS
  }

  async validateToken(token: string | null | undefined): Promise<boolean> {
    if (!token) {
      return false
    }

    const { h5Access } = await this.readStoredSettings()
    if (!h5Access.enabled || !h5Access.tokenHash) {
      return false
    }

    return hashToken(token) === h5Access.tokenHash
  }

  async isOriginAllowed(origin: string | null | undefined): Promise<boolean> {
    if (!origin) {
      return false
    }

    const { h5Access } = await this.readStoredSettings()
    if (!h5Access.enabled) {
      return false
    }

    try {
      const normalizedOrigin = normalizeOriginInput(origin, 'origin')
      return h5Access.allowedOrigins.includes(normalizedOrigin)
    } catch {
      return false
    }
  }
}
