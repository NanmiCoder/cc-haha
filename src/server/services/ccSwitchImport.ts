/**
 * cc-switch import — read provider configs from a locally installed cc-switch app
 *
 * Supported cc-switch versions: **v3.1.0 and newer**.
 *   - v3.8.0+  SQLite `cc-switch.db` (the primary path). The `providers` table
 *              has never renamed or dropped a column across v3.8.0..v3.18.0 —
 *              only `in_failover_queue` was added — so this path is stable.
 *   - v3.1.0+  legacy `config.json` format v2, read only when no database exists.
 *   - v3.0.x and older wrote config format v1, which cc-switch itself dropped in
 *              v3.6.0; we refuse it explicitly rather than appear to find nothing.
 *
 * Storage layout:
 *   <dir>/cc-switch.db   SQLite `providers` table — the primary store
 *   <dir>/config.json    legacy v2 JSON fallback (app keys flattened at top level)
 *   <dir>/settings.json  `currentProviderClaude` marks the active Claude provider
 *
 * `<dir>` defaults to $HOME/.cc-switch and can be relocated through the Tauri
 * store file `app_paths.json` (key `app_config_dir_override`).
 *
 * Everything here is read-only: the user's live cc-switch database must never be
 * mutated, so SQLite is opened with `readonly: true` and always closed again.
 * The mapping rules mirror the settings.json import already implemented in the
 * desktop provider form, so both paths produce identical providers.
 */

import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import {
  MODEL_CONTEXT_WINDOWS_ENV_KEY,
  MODEL_CONTEXT_WINDOW_MAX,
  MODEL_CONTEXT_WINDOW_MIN,
} from '../../utils/model/modelContextWindows.js'
import { PROVIDER_PRESETS } from '../config/providerPresets.js'
import type {
  ApiFormat,
  CreateProviderInput,
  Model1mSupport,
  ModelMapping,
  ProviderAuthStrategy,
  SavedProvider,
} from '../types/provider.js'
import {
  normalizeDisableExperimentalBetas,
  normalizeModelMapping,
  normalizeToolSearchEnabled,
} from './providerRuntimeEnv.js'

// ─── Public contract ──────────────────────────────────────────────────────────

export type CcSwitchAppType = 'claude' | 'claude-desktop'
export type CcSwitchSource = 'sqlite' | 'json'
export type CcSwitchUnavailableReason =
  | 'not-found'
  | 'unreadable'
  | 'sqlite-unavailable'
  /**
   * The store opened, but its structure is not one we understand — cc-switch is
   * a separate app on its own release schedule, and it has already migrated its
   * storage once (JSON → SQLite). Kept distinct from `unreadable` so the user
   * is told to upgrade rather than sent to check file permissions.
   */
  | 'schema-unsupported'
  /**
   * The store is a *known* format from before our support window (config v1,
   * cc-switch <= v3.0.x). Distinct from `schema-unsupported` because the advice
   * is the opposite: upgrade cc-switch, not cc-haha.
   */
  | 'version-too-old'
export type CcSwitchSkipReason =
  | 'no-base-url'
  | 'no-api-key'
  | 'no-model'
  | 'unsupported-format'
  | 'full-url-endpoint'

export type CcSwitchCandidate = {
  /** `${appType}:${id}` — opaque, unique across cc-switch apps */
  sourceId: string
  appType: CcSwitchAppType
  name: string
  baseUrl: string
  /** Masked key, e.g. "sk-ant…4f2a". Never the full secret. */
  apiKeyPreview: string
  hasApiKey: boolean
  models: ModelMapping
  model1mSupport: Model1mSupport
  apiFormat: ApiFormat
  authStrategy: ProviderAuthStrategy
  presetId: string
  isCurrent: boolean
  importable: boolean
  skipReason?: CcSwitchSkipReason
  duplicate?: { id: string; name: string }
  notes?: string
}

export type CcSwitchScanResult = {
  available: boolean
  reason?: CcSwitchUnavailableReason
  source?: CcSwitchSource
  configDir?: string
  candidates: CcSwitchCandidate[]
}

/** One scanned cc-switch provider, together with the secrets it resolved to. */
export type CcSwitchEntry = {
  candidate: CcSwitchCandidate
  /** Full API key — server-side only, never serialize it into a response. */
  apiKey: string
  /** Ready-to-persist provider input; null when the candidate is not importable. */
  createInput: CreateProviderInput | null
}

/** Scan result that still carries the resolved secrets — server-side only. */
export type CcSwitchScan = {
  available: boolean
  reason?: CcSwitchUnavailableReason
  source?: CcSwitchSource
  configDir?: string
  entries: CcSwitchEntry[]
}

export type CcSwitchScanOptions = {
  /** Saved cc-haha providers, used for duplicate detection. */
  existingProviders?: SavedProvider[]
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CC_SWITCH_APP_IDENTIFIER = 'com.ccswitch.desktop'
const APP_PATHS_FILE = 'app_paths.json'
const APP_CONFIG_DIR_OVERRIDE_KEY = 'app_config_dir_override'
const CC_SWITCH_DIR_NAME = '.cc-switch'
const CC_SWITCH_DB_FILE = 'cc-switch.db'
const LEGACY_CONFIG_FILES = ['config.json', 'config.json.migrated']
const CC_SWITCH_SETTINGS_FILE = 'settings.json'
const CURRENT_CLAUDE_PROVIDER_KEY = 'currentProviderClaude'
const SUPPORTED_APP_TYPES: CcSwitchAppType[] = ['claude', 'claude-desktop']
const SUPPORTED_API_FORMATS: ApiFormat[] = ['anthropic', 'openai_chat', 'openai_responses']
const DEFAULT_SORT_INDEX = 999_999
const DEFAULT_AUTH_STRATEGY: ProviderAuthStrategy = 'auth_token'
const AUTO_COMPACT_WINDOW_ENV_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
const TOOL_SEARCH_ENV_KEY = 'ENABLE_TOOL_SEARCH'
const DISABLE_EXPERIMENTAL_BETAS_ENV_KEY = 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'

// ─── Row model ────────────────────────────────────────────────────────────────

/**
 * A cc-switch provider row, normalized across the SQLite and legacy JSON stores.
 * `settingsConfig` / `meta` stay untyped because SQLite keeps them as JSON
 * strings while config.json keeps them as nested objects.
 */
type CcSwitchProviderRow = {
  id: string
  appType: CcSwitchAppType
  name: string
  settingsConfig: unknown
  meta: unknown
  notes: string | undefined
  sortIndex: number | null
  createdAt: number | null
  isCurrent: boolean
}

type RowsResult =
  | { ok: true; rows: CcSwitchProviderRow[] }
  | { ok: false; reason: CcSwitchUnavailableReason }

// ─── Small helpers ────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** cc-switch stores JSON columns as strings in SQLite and as objects in config.json. */
function parseJsonLike(value: unknown): unknown {
  if (isRecord(value)) return value
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function toOptionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

/** Bun caches os.homedir() at startup, so read the env first for testability. */
function resolveHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir()
}

function expandHomePath(value: string, home: string): string {
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2))
  return value
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    return (await fs.stat(dirPath)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile()
  } catch {
    return false
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, 'utf-8')
  return JSON.parse(raw) as unknown
}

// ─── Config directory resolution ──────────────────────────────────────────────

function getTauriStoreFilePath(home: string): string {
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', CC_SWITCH_APP_IDENTIFIER, APP_PATHS_FILE)
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    return path.join(appData, CC_SWITCH_APP_IDENTIFIER, APP_PATHS_FILE)
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
  return path.join(configHome, CC_SWITCH_APP_IDENTIFIER, APP_PATHS_FILE)
}

async function readConfigDirOverride(home: string): Promise<string | null> {
  try {
    const store = await readJsonFile(getTauriStoreFilePath(home))
    if (!isRecord(store)) return null
    const override = toOptionalString(store[APP_CONFIG_DIR_OVERRIDE_KEY])
    return override ? expandHomePath(override, home) : null
  } catch {
    return null
  }
}

/** Resolve the cc-switch data directory, or null when the app is not installed. */
async function resolveCcSwitchConfigDir(): Promise<string | null> {
  const home = resolveHomeDir()
  const override = await readConfigDirOverride(home)
  // An override pointing at a directory that no longer exists is ignored.
  if (override && (await isDirectory(override))) return override

  const defaultDir = path.join(home, CC_SWITCH_DIR_NAME)
  return (await isDirectory(defaultDir)) ? defaultDir : null
}

// ─── Store readers ────────────────────────────────────────────────────────────

type SqliteRow = Record<string, unknown>
type SqliteStatement = { all: () => SqliteRow[] }
type SqliteDatabase = { query: (sql: string) => SqliteStatement; close: () => void }
type SqliteDatabaseConstructor = new (
  filename: string,
  options?: { readonly?: boolean },
) => SqliteDatabase

/**
 * Deliberately column-light: `sortRows()` reproduces cc-switch's canonical
 * ordering in JS, so naming `sort_index`/`created_at` in an ORDER BY would buy
 * nothing while making the whole feature fail closed the day cc-switch renames
 * or drops either column. Only `app_type` — the one column we filter on — is
 * assumed.
 */
const PROVIDERS_QUERY = `
  SELECT * FROM providers
  WHERE app_type IN ('claude', 'claude-desktop')
`

function toSqliteRow(raw: SqliteRow): CcSwitchProviderRow | null {
  const id = toOptionalString(raw.id)
  const appType = toOptionalString(raw.app_type)
  if (!id || !appType) return null
  if (!SUPPORTED_APP_TYPES.includes(appType as CcSwitchAppType)) return null

  return {
    id,
    appType: appType as CcSwitchAppType,
    name: typeof raw.name === 'string' ? raw.name : '',
    settingsConfig: raw.settings_config,
    meta: raw.meta,
    notes: toOptionalString(raw.notes),
    sortIndex: toOptionalNumber(raw.sort_index),
    createdAt: toOptionalNumber(raw.created_at),
    isCurrent: toBoolean(raw.is_current),
  }
}

/**
 * The columns we cannot do anything useful without. Everything else
 * (`name`, `meta`, `notes`, `sort_index`, `created_at`, `is_current`) is
 * optional and degrades to a sensible default, so cc-switch can keep adding
 * and removing those without breaking import.
 */
const REQUIRED_PROVIDER_COLUMNS = ['id', 'app_type', 'settings_config']

/**
 * Every app cc-switch is known to ship. Used only to tell "this user simply has
 * no Claude Code providers" apart from "cc-switch renamed its apps".
 */
const KNOWN_CC_SWITCH_APP_TYPES = new Set([
  'claude', 'claude-desktop', 'codex', 'gemini',
  'grokbuild', 'opencode', 'openclaw', 'hermes',
])

function inspectProvidersSchema(db: SqliteDatabase): 'ok' | 'schema-unsupported' {
  const table = db
    .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'providers'`)
    .all()
  if (table.length === 0) return 'schema-unsupported'

  const columns = new Set(
    db.query('PRAGMA table_info(providers)').all()
      .map((column) => toOptionalString((column as SqliteRow).name))
      .filter((name): name is string => name !== undefined),
  )
  return REQUIRED_PROVIDER_COLUMNS.every((column) => columns.has(column))
    ? 'ok'
    : 'schema-unsupported'
}

/** True when the table holds rows but not one of them names an app we recognise. */
function hasOnlyUnknownAppTypes(db: SqliteDatabase): boolean {
  const appTypes = db.query('SELECT DISTINCT app_type FROM providers').all()
    .map((row) => toOptionalString((row as SqliteRow).app_type))
    .filter((appType): appType is string => appType !== undefined)

  return appTypes.length > 0 && !appTypes.some((appType) => KNOWN_CC_SWITCH_APP_TYPES.has(appType))
}

/**
 * Read the primary SQLite store.
 *
 * `bun:sqlite` is imported lazily so a non-Bun runtime degrades to the legacy
 * JSON path instead of crashing at module load.
 */
async function readProvidersFromSqlite(dbPath: string): Promise<RowsResult> {
  if (!(await isFile(dbPath))) return { ok: false, reason: 'not-found' }

  let Database: SqliteDatabaseConstructor
  try {
    const sqlite = await import('bun:sqlite')
    Database = sqlite.Database as unknown as SqliteDatabaseConstructor
    if (typeof Database !== 'function') return { ok: false, reason: 'sqlite-unavailable' }
  } catch {
    return { ok: false, reason: 'sqlite-unavailable' }
  }

  let db: SqliteDatabase | null = null
  try {
    // Read-only: the user's live cc-switch database must never be mutated.
    db = new Database(dbPath, { readonly: true })

    // Check the shape before trusting the contents. Without this, a renamed
    // column silently yields rows whose every field reads as undefined, and the
    // scan reports a confident list of empty candidates.
    const schema = inspectProvidersSchema(db)
    if (schema !== 'ok') return { ok: false, reason: schema }

    const rawRows = db.query(PROVIDERS_QUERY).all()
    const rows = rawRows
      .map(toSqliteRow)
      .filter((row): row is CcSwitchProviderRow => row !== null)

    // Rows exist, none are in an app we support, and none are in an app
    // cc-switch is known to ship: the app taxonomy moved under us. Distinct
    // from a genuine "this user only configured codex" empty result.
    if (rows.length === 0 && hasOnlyUnknownAppTypes(db)) {
      return { ok: false, reason: 'schema-unsupported' }
    }

    return { ok: true, rows: sortRows(rows) }
  } catch {
    // Locked, corrupt, or unreadable on disk.
    return { ok: false, reason: 'unreadable' }
  } finally {
    try {
      db?.close()
    } catch {
      // Closing a half-open handle is best effort.
    }
  }
}

/**
 * Read the legacy v2 config.json. Its app keys are flattened at the top level:
 * `{ version: 2, claude: { providers: {...}, current: "id" }, codex: {...} }`.
 */
function toLegacyRows(config: unknown): CcSwitchProviderRow[] {
  if (!isRecord(config)) return []

  const rows: CcSwitchProviderRow[] = []
  for (const appType of SUPPORTED_APP_TYPES) {
    const app = config[appType]
    if (!isRecord(app)) continue
    const providers = app.providers
    if (!isRecord(providers)) continue
    const current = toOptionalString(app.current)

    for (const [key, value] of Object.entries(providers)) {
      if (!isRecord(value)) continue
      const id = toOptionalString(value.id) ?? key
      rows.push({
        id,
        appType,
        name: typeof value.name === 'string' ? value.name : '',
        settingsConfig: value.settingsConfig,
        meta: value.meta,
        notes: toOptionalString(value.notes),
        sortIndex: toOptionalNumber(value.sortIndex),
        createdAt: toOptionalNumber(value.createdAt),
        isCurrent: current !== undefined && current === id,
      })
    }
  }
  return sortRows(rows)
}

/**
 * Detect the pre-v3.1.0 "v1" config, using the same rule cc-switch itself uses
 * (`app_config.rs`): a top-level `providers` map plus a `current` string, with
 * no per-app keys. cc-switch dropped support for it in v3.6.0 and hard-errors
 * on it; we cannot read it either, and saying so beats reporting a successful
 * scan that happens to find nothing.
 */
function isLegacyV1Config(config: unknown): boolean {
  if (!isRecord(config)) return false
  if (!isRecord(config.providers) || typeof config.current !== 'string') return false
  return !SUPPORTED_APP_TYPES.some((appType) => isRecord(config[appType]))
}

async function readProvidersFromLegacyJson(configDir: string): Promise<RowsResult> {
  let lastReason: CcSwitchUnavailableReason = 'not-found'
  for (const fileName of LEGACY_CONFIG_FILES) {
    const filePath = path.join(configDir, fileName)
    if (!(await isFile(filePath))) continue
    try {
      const config = await readJsonFile(filePath)
      if (isLegacyV1Config(config)) return { ok: false, reason: 'version-too-old' }
      return { ok: true, rows: toLegacyRows(config) }
    } catch {
      lastReason = 'unreadable'
    }
  }
  return { ok: false, reason: lastReason }
}

function sortRows(rows: CcSwitchProviderRow[]): CcSwitchProviderRow[] {
  return [...rows].sort((a, b) => {
    const bySortIndex = (a.sortIndex ?? DEFAULT_SORT_INDEX) - (b.sortIndex ?? DEFAULT_SORT_INDEX)
    if (bySortIndex !== 0) return bySortIndex
    const byCreatedAt = (a.createdAt ?? 0) - (b.createdAt ?? 0)
    if (byCreatedAt !== 0) return byCreatedAt
    // Binary comparison, matching SQLite's default collation.
    if (a.id === b.id) return 0
    return a.id < b.id ? -1 : 1
  })
}

/**
 * cc-switch pins settings.json to `$HOME/.cc-switch` on purpose — it holds the
 * directory override itself, so it cannot live inside the overridden directory
 * (`settings.rs`: "settings.json 必须使用固定路径，不能被 app_config_dir 覆盖").
 * Reading it from the resolved dir would silently miss it whenever an override
 * is set, so try the fixed location too.
 */
async function readCurrentClaudeProviderId(configDir: string): Promise<string | undefined> {
  const candidates = [
    path.join(configDir, CC_SWITCH_SETTINGS_FILE),
    path.join(resolveHomeDir(), CC_SWITCH_DIR_NAME, CC_SWITCH_SETTINGS_FILE),
  ]

  for (const filePath of candidates) {
    try {
      const settings = await readJsonFile(filePath)
      if (!isRecord(settings)) continue
      const current = toOptionalString(settings[CURRENT_CLAUDE_PROVIDER_KEY])
      if (current) return current
    } catch {
      // Missing or unparseable — fall through to the next location.
    }
  }
  return undefined
}

// ─── Mapping (mirrors desktop/src/pages/Settings.tsx) ─────────────────────────

function readEnvString(env: Record<string, unknown>, key: string): string | undefined {
  const value = env[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  // cc-switch presets seed keys with empty strings — treat those as absent.
  return trimmed || undefined
}

/**
 * Values cc-switch (and our own settings JSON) writes in place of a real
 * credential. They must not be imported as if they were keys — mirrors
 * `isSecretDisplayValue` in desktop/src/lib/providerSettingsJson.ts.
 * `dummy` is deliberately NOT listed: it is a real `dual_dummy` strategy for
 * upstreams that ignore the credential.
 */
const PLACEHOLDER_CREDENTIALS = new Set([
  '(your api key)',
  'proxy-managed',
  'proxy_managed',
  '••••••••',
])

function readCredential(env: Record<string, unknown>, key: string): string | undefined {
  const value = readEnvString(env, key)
  if (value === undefined) return undefined
  return PLACEHOLDER_CREDENTIALS.has(value.toLowerCase()) ? undefined : value
}

/** Keep raw string values so empty-string markers stay observable. */
function toStringEnv(env: Record<string, unknown>): Record<string, string> {
  const stringEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') stringEnv[key] = value
  }
  return stringEnv
}

function inferAuthStrategyFromEnv(env: Record<string, string>): ProviderAuthStrategy | null {
  if (env.ANTHROPIC_API_KEY === 'dummy' && env.ANTHROPIC_AUTH_TOKEN === 'dummy') return 'dual_dummy'
  if (env.ANTHROPIC_API_KEY === '' && env.ANTHROPIC_AUTH_TOKEN) return 'auth_token_empty_api_key'
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_AUTH_TOKEN && env.ANTHROPIC_API_KEY === env.ANTHROPIC_AUTH_TOKEN) return 'dual_same_token'
  if (env.ANTHROPIC_AUTH_TOKEN) return 'auth_token'
  if (env.ANTHROPIC_API_KEY) return 'api_key'
  return null
}

function readApiKeyField(meta: unknown): 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN' | undefined {
  const parsed = parseJsonLike(meta)
  if (!isRecord(parsed)) return undefined
  const field = toOptionalString(parsed.apiKeyField)?.toUpperCase()
  if (field === 'ANTHROPIC_API_KEY' || field === 'ANTHROPIC_AUTH_TOKEN') return field
  return undefined
}

function readProviderCredential(
  env: Record<string, unknown>,
  apiKeyField: 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN' | undefined,
): string {
  if (apiKeyField) {
    const selected = readCredential(env, apiKeyField)
    if (selected) return selected
  }
  return readCredential(env, 'ANTHROPIC_AUTH_TOKEN') ?? readCredential(env, 'ANTHROPIC_API_KEY') ?? ''
}

function readModelMappingFromSettingsEnv(env: Record<string, unknown>): Partial<ModelMapping> {
  const hasModelEnv = [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
  ].some((key) => Object.prototype.hasOwnProperty.call(env, key))
  const fable = readEnvString(env, 'ANTHROPIC_DEFAULT_FABLE_MODEL')
  const haiku = readEnvString(env, 'ANTHROPIC_DEFAULT_HAIKU_MODEL')
  const sonnet = readEnvString(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL')
  const opus = readEnvString(env, 'ANTHROPIC_DEFAULT_OPUS_MODEL')
  const main = readEnvString(env, 'ANTHROPIC_MODEL') ?? sonnet ?? haiku ?? opus

  return {
    ...(main ? { main } : {}),
    ...(hasModelEnv ? { fable } : {}),
    ...(haiku ? { haiku } : {}),
    ...(sonnet ? { sonnet } : {}),
    ...(opus ? { opus } : {}),
  }
}

function hasModel1mMarker(model: string): boolean {
  return /\[1m\]$/i.test(model.trim()) || /:1m$/i.test(model.trim())
}

function stripModel1mMarker(model: string): string {
  return model.trim().replace(/\[1m\]$/i, '').replace(/:1m$/i, '').trim()
}

function stripModel1mMarkers(models: ModelMapping): ModelMapping {
  return {
    main: stripModel1mMarker(models.main),
    ...(models.fable ? { fable: stripModel1mMarker(models.fable) } : {}),
    haiku: stripModel1mMarker(models.haiku),
    sonnet: stripModel1mMarker(models.sonnet),
    opus: stripModel1mMarker(models.opus),
  }
}

function readModel1mSupport(models: ModelMapping): Model1mSupport {
  return {
    main: hasModel1mMarker(models.main),
    haiku: hasModel1mMarker(models.haiku),
    sonnet: hasModel1mMarker(models.sonnet),
    opus: hasModel1mMarker(models.opus),
  }
}

function parseContextWindow(value: unknown): number | undefined {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value.trim())
      : Number.NaN
  if (!Number.isInteger(numeric)) return undefined
  if (numeric < MODEL_CONTEXT_WINDOW_MIN || numeric > MODEL_CONTEXT_WINDOW_MAX) return undefined
  return numeric
}

function readModelContextWindows(env: Record<string, unknown>): Record<string, number> | undefined {
  const parsed = parseJsonLike(env[MODEL_CONTEXT_WINDOWS_ENV_KEY])
  if (!isRecord(parsed)) return undefined

  const windows: Record<string, number> = {}
  for (const [model, value] of Object.entries(parsed)) {
    const key = model.trim()
    const window = parseContextWindow(value)
    if (key && window !== undefined) windows[key] = window
  }
  return Object.keys(windows).length > 0 ? windows : undefined
}

/**
 * cc-switch's `meta.isFullUrl` means the stored base URL is already a complete
 * endpoint (e.g. `https://gw/v1/chat/completions`) that must not have a path
 * appended. cc-haha always appends (`${base}/v1/messages` and friends), so such
 * a provider would import cleanly and then 404 on every request. Refuse it
 * rather than hand the user a silently broken entry.
 */
function readIsFullUrl(meta: unknown): boolean {
  const parsed = parseJsonLike(meta)
  return isRecord(parsed) && parsed.isFullUrl === true
}

/** Blank out a credential that leaked into free text. */
function redactSecret(text: string | undefined, secret: string): string | undefined {
  if (!text || secret.length < 8) return text
  return text.split(secret).join('[REDACTED]')
}

function readApiFormat(meta: unknown): ApiFormat | null {
  const parsed = parseJsonLike(meta)
  if (!isRecord(parsed)) return 'anthropic'
  const apiFormat = toOptionalString(parsed.apiFormat)
  if (!apiFormat) return 'anthropic'
  // gemini_native and anything else we do not speak cannot be imported.
  return SUPPORTED_API_FORMATS.includes(apiFormat as ApiFormat) ? (apiFormat as ApiFormat) : null
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').toLowerCase()
}

function matchPresetId(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl)
  if (!normalized) return 'custom'
  // Presets without a base URL (official, custom) can never be matched by URL.
  // Retired (`deprecated`) presets are matched on purpose: an import maps a config the
  // user already has elsewhere, so inheriting that preset's env beats landing on custom.
  const preset = PROVIDER_PRESETS.find((candidate) =>
    [candidate.baseUrl, ...(candidate.regionalEndpoints?.map((endpoint) => endpoint.baseUrl) ?? [])]
      .some((endpoint) => endpoint && normalizeBaseUrl(endpoint) === normalized),
  )
  return preset?.id ?? 'custom'
}

function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim()
  if (!trimmed) return ''
  if (trimmed.length < 8) return '…'
  if (trimmed.length < 16) return `…${trimmed.slice(-4)}`
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`
}

function findDuplicate(
  existingProviders: SavedProvider[],
  baseUrl: string,
  name: string,
  apiKey: string,
): { id: string; name: string } | undefined {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  if (!normalizedBaseUrl) return undefined
  const normalizedName = name.trim().toLowerCase()

  const match = existingProviders.find((provider) => (
    normalizeBaseUrl(provider.baseUrl) === normalizedBaseUrl &&
    (
      provider.name.trim().toLowerCase() === normalizedName ||
      (!!apiKey && provider.apiKey === apiKey)
    )
  ))
  return match ? { id: match.id, name: match.name } : undefined
}

function toEntry(
  row: CcSwitchProviderRow,
  context: { currentClaudeProviderId: string | undefined; existingProviders: SavedProvider[] },
): CcSwitchEntry {
  const settingsConfig = parseJsonLike(row.settingsConfig)
  const env = isRecord(settingsConfig) && isRecord(settingsConfig.env) ? settingsConfig.env : {}
  const stringEnv = toStringEnv(env)

  const name = row.name.trim() || row.id
  const baseUrl = readEnvString(env, 'ANTHROPIC_BASE_URL') ?? ''
  const apiKeyField = readApiKeyField(row.meta)
  const apiKey = readProviderCredential(env, apiKeyField)
  // cc-switch's explicit meta field controls which header reaches the
  // upstream. It may intentionally disagree with a historical env key.
  const authStrategy = apiKeyField === 'ANTHROPIC_API_KEY'
    ? 'api_key'
    : apiKeyField === 'ANTHROPIC_AUTH_TOKEN'
      ? 'auth_token'
      : inferAuthStrategyFromEnv(stringEnv) ?? DEFAULT_AUTH_STRATEGY
  const apiFormat = readApiFormat(row.meta)

  const partialModels = readModelMappingFromSettingsEnv(env)
  const normalizedModels = normalizeModelMapping({
    main: partialModels.main ?? '',
    ...(partialModels.fable ? { fable: partialModels.fable } : {}),
    haiku: partialModels.haiku ?? '',
    sonnet: partialModels.sonnet ?? '',
    opus: partialModels.opus ?? '',
  })
  const model1mSupport = readModel1mSupport(normalizedModels)
  const models = stripModel1mMarkers(normalizedModels)

  const skipReason: CcSwitchSkipReason | undefined =
    !baseUrl ? 'no-base-url'
      : !apiKey ? 'no-api-key'
        : !models.main ? 'no-model'
          : apiFormat === null ? 'unsupported-format'
            : readIsFullUrl(row.meta) ? 'full-url-endpoint'
              : undefined

  const isCurrent = row.appType === 'claude' && context.currentClaudeProviderId !== undefined
    ? context.currentClaudeProviderId === row.id
    : row.isCurrent

  const duplicate = findDuplicate(context.existingProviders, baseUrl, name, apiKey)
  const notes = row.notes
  // The candidate is client-facing and must not carry a full credential.
  // Notes are free text, and users do paste keys into them.
  const safeNotes = redactSecret(notes, apiKey)
  const presetId = matchPresetId(baseUrl)

  const candidate: CcSwitchCandidate = {
    sourceId: `${row.appType}:${row.id}`,
    appType: row.appType,
    name,
    baseUrl,
    apiKeyPreview: maskApiKey(apiKey),
    hasApiKey: apiKey.length > 0,
    models,
    model1mSupport,
    apiFormat: apiFormat ?? 'anthropic',
    authStrategy,
    presetId,
    isCurrent,
    importable: skipReason === undefined,
    ...(skipReason ? { skipReason } : {}),
    ...(duplicate ? { duplicate } : {}),
    ...(safeNotes ? { notes: safeNotes } : {}),
  }

  if (skipReason !== undefined || apiFormat === null) {
    return { candidate, apiKey, createInput: null }
  }

  const autoCompactWindow = parseContextWindow(env[AUTO_COMPACT_WINDOW_ENV_KEY])
  const modelContextWindows = readModelContextWindows(env)
  const hasToolSearchKey = Object.prototype.hasOwnProperty.call(env, TOOL_SEARCH_ENV_KEY)
  const hasDisableBetasKey = Object.prototype.hasOwnProperty.call(env, DISABLE_EXPERIMENTAL_BETAS_ENV_KEY)

  const createInput: CreateProviderInput = {
    presetId,
    name,
    apiKey,
    authStrategy,
    baseUrl,
    apiFormat,
    runtimeKind: 'anthropic_compatible',
    models,
    model1mSupport,
    ...(autoCompactWindow !== undefined && { autoCompactWindow }),
    ...(modelContextWindows !== undefined && { modelContextWindows }),
    // Reuse the same lenient readers the provider form uses, so a given env
    // maps identically whether it arrives by cc-switch import or JSON paste.
    ...(hasToolSearchKey && {
      toolSearchEnabled: normalizeToolSearchEnabled(stringEnv[TOOL_SEARCH_ENV_KEY]),
    }),
    ...(hasDisableBetasKey && {
      disableExperimentalBetas: normalizeDisableExperimentalBetas(
        stringEnv[DISABLE_EXPERIMENTAL_BETAS_ENV_KEY],
      ),
    }),
    ...(notes ? { notes } : {}),
  }

  return { candidate, apiKey, createInput }
}

/**
 * Fingerprint an entry by *what importing it would produce*, so two entries
 * only ever collapse when picking either one yields an identical provider.
 * Using `createInput` keeps every imported field in the key — notes, context
 * windows and the boolean toggles included; a partial key would silently drop
 * configurations the user can tell apart.
 */
function importFingerprint(entry: CcSwitchEntry): string {
  const c = entry.candidate
  if (entry.createInput) return JSON.stringify(['importable', entry.createInput])
  return JSON.stringify([
    'skipped',
    c.name.trim().toLowerCase(),
    normalizeBaseUrl(c.baseUrl),
    entry.apiKey,
    c.skipReason ?? null,
  ])
}

/**
 * cc-switch keeps a separate provider set per app, and users commonly hold the
 * same upstream under both `claude` and `claude-desktop`. Importing both would
 * create indistinguishable same-name pairs, so drop the `claude-desktop` copy
 * when an identical `claude` (Claude Code) one exists — that is the app
 * cc-haha corresponds to.
 *
 * Collapsing is strictly cross-app: two rows inside the *same* app are two
 * things the user deliberately created, and are always both kept even when
 * they look identical to us.
 */
function dedupeAcrossApps(entries: CcSwitchEntry[]): CcSwitchEntry[] {
  const claudeFingerprints = new Set(
    entries
      .filter((entry) => entry.candidate.appType === 'claude')
      .map(importFingerprint),
  )

  return entries.filter(
    (entry) =>
      entry.candidate.appType === 'claude' || !claudeFingerprints.has(importFingerprint(entry)),
  )
}

// ─── Entry points ─────────────────────────────────────────────────────────────

/**
 * Scan the local cc-switch installation.
 *
 * The returned entries still carry full API keys, so only
 * `toCcSwitchScanResult()` output may be sent to a client.
 */
export async function readCcSwitchProviders(
  options: CcSwitchScanOptions = {},
): Promise<CcSwitchScan> {
  const existingProviders = options.existingProviders ?? []

  const configDir = await resolveCcSwitchConfigDir()
  if (!configDir) return { available: false, reason: 'not-found', entries: [] }

  let rows: CcSwitchProviderRow[] | null = null
  let source: CcSwitchSource | undefined
  let reason: CcSwitchUnavailableReason | undefined

  const sqliteResult = await readProvidersFromSqlite(path.join(configDir, CC_SWITCH_DB_FILE))
  if (sqliteResult.ok) {
    rows = sqliteResult.rows
    source = 'sqlite'
  } else {
    reason = sqliteResult.reason
  }

  // The legacy JSON store is only trustworthy when there is no database at
  // all. Once cc-switch has migrated it archives the old config as
  // `config.json.migrated`, so if a database exists but we failed to read it,
  // falling back would silently present pre-migration data — revoked keys and
  // stale base URLs — as a normal, successful scan. Report the failure instead.
  if (rows === null && reason === 'not-found') {
    const legacyResult = await readProvidersFromLegacyJson(configDir)
    if (legacyResult.ok) {
      rows = legacyResult.rows
      source = 'json'
      reason = undefined
    } else {
      reason = legacyResult.reason
    }
  }

  if (rows === null) {
    return { available: false, reason: reason ?? 'not-found', configDir, entries: [] }
  }

  const currentClaudeProviderId = await readCurrentClaudeProviderId(configDir)
  const entries = dedupeAcrossApps(
    rows.map((row) => toEntry(row, { currentClaudeProviderId, existingProviders })),
  )

  return { available: true, source, configDir, entries }
}

/** Strip the resolved secrets, leaving the client-safe scan payload. */
export function toCcSwitchScanResult(scan: CcSwitchScan): CcSwitchScanResult {
  return {
    available: scan.available,
    ...(scan.reason ? { reason: scan.reason } : {}),
    ...(scan.source ? { source: scan.source } : {}),
    ...(scan.configDir ? { configDir: scan.configDir } : {}),
    candidates: scan.entries.map((entry) => entry.candidate),
  }
}

export async function scanCcSwitchProviders(
  options: CcSwitchScanOptions = {},
): Promise<CcSwitchScanResult> {
  return toCcSwitchScanResult(await readCcSwitchProviders(options))
}

/**
 * Resolve the selected candidates into provider inputs.
 *
 * Unknown ids and non-importable candidates are reported instead of silently
 * dropped, so the desktop can explain what did not come across.
 */
export function resolveCcSwitchImports(
  scan: CcSwitchScan,
  sourceIds: string[],
): { inputs: CreateProviderInput[]; skipped: { sourceId: string; reason: string }[] } {
  const entriesBySourceId = new Map(scan.entries.map((entry) => [entry.candidate.sourceId, entry]))
  const missingReason = scan.available ? 'not-found' : scan.reason ?? 'not-found'

  const inputs: CreateProviderInput[] = []
  const skipped: { sourceId: string; reason: string }[] = []
  for (const sourceId of [...new Set(sourceIds)]) {
    const entry = entriesBySourceId.get(sourceId)
    if (!entry) {
      skipped.push({ sourceId, reason: missingReason })
      continue
    }
    if (!entry.createInput) {
      skipped.push({ sourceId, reason: entry.candidate.skipReason ?? 'unsupported-format' })
      continue
    }
    inputs.push(entry.createInput)
  }

  return { inputs, skipped }
}
