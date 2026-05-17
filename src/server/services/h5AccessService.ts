import { createHash, randomBytes } from 'node:crypto'
import os from 'node:os'
import { ApiError } from '../middleware/errorHandler.js'
import { ManagedSettingsService } from './managedSettingsService.js'
import { ProviderService } from './providerService.js'

export type H5AccessSettings = {
  enabled: boolean
  tokenPreview: string | null
  allowedOrigins: string[]
  publicBaseUrl: string | null
}

export type H5AccessEnableResult = {
  settings: H5AccessSettings
  token: string
}

type StoredH5AccessSettings = H5AccessSettings & {
  tokenHash: string | null
}

const DEFAULT_STORED_SETTINGS: StoredH5AccessSettings = {
  enabled: false,
  tokenHash: null,
  tokenPreview: null,
  allowedOrigins: [],
  publicBaseUrl: null,
}

const TOKEN_HASH_RE = /^[a-f0-9]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function toPublicSettings(settings: StoredH5AccessSettings): H5AccessSettings {
  return {
    enabled: settings.enabled,
    tokenPreview: settings.tokenPreview,
    allowedOrigins: settings.allowedOrigins,
    publicBaseUrl: resolveEffectiveH5PublicBaseUrl({
      enabled: settings.enabled,
      storedPublicBaseUrl: settings.publicBaseUrl,
      configuredPublicBaseUrl: resolveConfiguredPublicBaseUrl(),
      autoPublicBaseUrl: resolveAutoLanPublicBaseUrl(),
    }),
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
}: {
  enabled: boolean
  storedPublicBaseUrl: string | null
  configuredPublicBaseUrl: string | null
  autoPublicBaseUrl: string | null
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

  if (!storedPublicBaseUrl || isLocalOrPrivatePublicBaseUrl(storedPublicBaseUrl)) {
    return autoPublicBaseUrl
  }

  return storedPublicBaseUrl
}

function isLocalOrPrivatePublicBaseUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname
      .trim()
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .toLowerCase()
    return isLocalOrPrivateHost(hostname)
  } catch {
    return false
  }
}

function isLocalOrPrivateHost(hostname: string): boolean {
  return hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    isPrivateIPv4(hostname) ||
    hostname.startsWith('fc') ||
    hostname.startsWith('fd') ||
    hostname.startsWith('fe80:')
}

function findPrivateLanAddress(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !isPrivateIPv4(entry.address)) {
        continue
      }
      return entry.address
    }
  }
  return null
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4 || !parts.every((part) => /^\d+$/.test(part))) {
    return false
  }

  const [a = -1, b = -1] = parts.map((part) => Number(part))
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  )
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

  const tokenHash = typeof value.tokenHash === 'string' && TOKEN_HASH_RE.test(value.tokenHash)
    ? value.tokenHash
    : null

  return {
    enabled: value.enabled === true && tokenHash !== null,
    tokenHash,
    tokenPreview: tokenHash && typeof value.tokenPreview === 'string' ? value.tokenPreview : null,
    allowedOrigins,
    publicBaseUrl,
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
  ): Promise<{
    settings: Record<string, unknown>
    result: H5AccessEnableResult
  }> {
    const token = createToken()
    const nextSettings: StoredH5AccessSettings = {
      ...current,
      enabled: true,
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
    return this.managedSettingsService.updateSettings(async (current) => {
      return this.setToken(current, normalizeStoredSettings(current.h5Access))
    })
  }

  async disable(): Promise<H5AccessSettings> {
    return this.managedSettingsService.updateSettings(async (current) => {
      const h5Access = normalizeStoredSettings(current.h5Access)
      const nextSettings: StoredH5AccessSettings = {
        ...h5Access,
        enabled: false,
        tokenHash: null,
        tokenPreview: null,
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
      return this.setToken(current, normalizeStoredSettings(current.h5Access))
    })
  }

  async updateSettings(input: {
    allowedOrigins?: string[]
    publicBaseUrl?: string | null
  }): Promise<H5AccessSettings> {
    return this.managedSettingsService.updateSettings(async (current) => {
      const h5Access = normalizeStoredSettings(current.h5Access)
      const nextSettings: StoredH5AccessSettings = {
        ...h5Access,
        allowedOrigins: input.allowedOrigins === undefined
          ? h5Access.allowedOrigins
          : normalizeAllowedOrigins(input.allowedOrigins),
        publicBaseUrl: input.publicBaseUrl === undefined
          ? h5Access.publicBaseUrl
          : normalizePublicBaseUrl(input.publicBaseUrl),
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
