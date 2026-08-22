/**
 * Unit tests for the cc-switch import scanner and its REST routes.
 *
 * Every fixture lives in a temp HOME: the user's real ~/.cc-switch database must
 * never be opened by the test suite.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { handleProvidersApi } from '../api/providers.js'
import { ProviderService } from './providerService.js'
import { readCcSwitchProviders, scanCcSwitchProviders } from './ccSwitchImport.js'
import type { CcSwitchCandidate } from './ccSwitchImport.js'
import type { CreateProviderInput, SavedProvider } from '../types/provider.js'

// ─── Test helpers ─────────────────────────────────────────────────────────────

const ENV_KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'APPDATA'] as const

let tmpDir: string
let ccSwitchDir: string
const originalEnv: Partial<Record<typeof ENV_KEYS[number], string | undefined>> = {}

async function setup() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-switch-import-test-'))
  ccSwitchDir = path.join(tmpDir, '.cc-switch')
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key]
  }
  process.env.HOME = tmpDir
  process.env.USERPROFILE = tmpDir
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  process.env.XDG_CONFIG_HOME = path.join(tmpDir, '.config')
  process.env.APPDATA = path.join(tmpDir, '.config')
}

async function teardown() {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
}

/** Mirror of the platform-specific Tauri store location. */
function tauriStoreFilePath(): string {
  const identifier = 'com.ccswitch.desktop'
  if (process.platform === 'darwin') {
    return path.join(tmpDir, 'Library', 'Application Support', identifier, 'app_paths.json')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA as string, identifier, 'app_paths.json')
  }
  return path.join(process.env.XDG_CONFIG_HOME as string, identifier, 'app_paths.json')
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

async function writeDirOverride(target: string): Promise<void> {
  await writeJsonFile(tauriStoreFilePath(), { app_config_dir_override: target })
}

type DbRow = {
  id: string
  appType?: string
  name?: string
  env?: Record<string, unknown>
  settingsConfig?: string
  notes?: string | null
  meta?: string | null
  createdAt?: number | null
  sortIndex?: number | null
  isCurrent?: boolean
}

const CREATE_PROVIDERS_TABLE = `
  CREATE TABLE providers (
    id TEXT NOT NULL,
    app_type TEXT NOT NULL,
    name TEXT NOT NULL,
    settings_config TEXT NOT NULL,
    website_url TEXT,
    category TEXT,
    created_at INTEGER,
    sort_index INTEGER,
    notes TEXT,
    icon TEXT,
    icon_color TEXT,
    meta TEXT,
    is_current BOOLEAN DEFAULT 0,
    in_failover_queue BOOLEAN DEFAULT 0,
    PRIMARY KEY (id, app_type)
  )
`

/** Build a throwaway cc-switch database that matches the real schema. */
async function writeFixtureDb(rows: DbRow[], dir = ccSwitchDir): Promise<void> {
  const { Database } = await import('bun:sqlite')
  await fs.mkdir(dir, { recursive: true })
  const db = new Database(path.join(dir, 'cc-switch.db'), { create: true })
  try {
    db.run(CREATE_PROVIDERS_TABLE)
    const insert = db.prepare(`
      INSERT INTO providers (
        id, app_type, name, settings_config, website_url, category,
        created_at, sort_index, notes, icon, icon_color, meta,
        is_current, in_failover_queue
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    try {
      for (const row of rows) {
        insert.run(
          row.id,
          row.appType ?? 'claude',
          row.name ?? row.id,
          row.settingsConfig ?? JSON.stringify({ env: row.env ?? {} }),
          'https://example.com',
          'third_party',
          row.createdAt ?? null,
          row.sortIndex ?? null,
          row.notes ?? null,
          null,
          null,
          row.meta ?? null,
          row.isCurrent ? 1 : 0,
          0,
        )
      }
    } finally {
      insert.finalize()
    }
  } finally {
    db.close()
  }
}

// ─── Historical cc-switch DDL ─────────────────────────────────────────────────
//
// cc-switch ships on its own release schedule and has changed its store twice
// (flat JSON → multi-app JSON in v3.4.0, JSON → SQLite in v3.8.0). Each DDL
// below is copied verbatim from `src-tauri/src/database/schema.rs` at the tag
// named, so the generation tests exercise the real historical shape.

/** v3.8.0 .. v3.9.0-2 (PRAGMA user_version 1–2) — before `in_failover_queue`. */
const CC_SWITCH_V3_8_PROVIDERS_DDL = `
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT NOT NULL,
    app_type TEXT NOT NULL,
    name TEXT NOT NULL,
    settings_config TEXT NOT NULL,
    website_url TEXT,
    category TEXT,
    created_at INTEGER,
    sort_index INTEGER,
    notes TEXT,
    icon TEXT,
    icon_color TEXT,
    meta TEXT NOT NULL DEFAULT '{}',
    is_current BOOLEAN NOT NULL DEFAULT 0,
    PRIMARY KEY (id, app_type)
  )
`

/** v3.9.0-3 onward (user_version 2+) — adds `in_failover_queue`. */
const CC_SWITCH_V3_9_PROVIDERS_DDL = `
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT NOT NULL,
    app_type TEXT NOT NULL,
    name TEXT NOT NULL,
    settings_config TEXT NOT NULL,
    website_url TEXT,
    category TEXT,
    created_at INTEGER,
    sort_index INTEGER,
    notes TEXT,
    icon TEXT,
    icon_color TEXT,
    meta TEXT NOT NULL DEFAULT '{}',
    is_current BOOLEAN NOT NULL DEFAULT 0,
    in_failover_queue BOOLEAN NOT NULL DEFAULT 0,
    PRIMARY KEY (id, app_type)
  )
`

/**
 * What an installed cc-switch database actually holds: `create_tables()` plus
 * the four columns `migrate_v0_to_v1()` back-fills on every launch. Taken from
 * `PRAGMA table_info(providers)` on a live install, not from the DDL — a fresh
 * database and an upgraded one converge on this.
 */
const CC_SWITCH_LIVE_PROVIDERS_DDL = `
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT NOT NULL,
    app_type TEXT NOT NULL,
    name TEXT NOT NULL,
    settings_config TEXT NOT NULL,
    website_url TEXT,
    category TEXT,
    created_at INTEGER,
    sort_index INTEGER,
    notes TEXT,
    icon TEXT,
    icon_color TEXT,
    meta TEXT NOT NULL DEFAULT '{}',
    is_current BOOLEAN NOT NULL DEFAULT 0,
    in_failover_queue BOOLEAN NOT NULL DEFAULT 0,
    cost_multiplier TEXT NOT NULL DEFAULT '1.0',
    limit_daily_usd TEXT,
    limit_monthly_usd TEXT,
    provider_type TEXT,
    PRIMARY KEY (id, app_type)
  )
`

/**
 * Build a database from one generation's exact DDL. Columns are taken from each
 * row object, so a fixture can only name columns that generation really had.
 */
async function writeGenerationDb(
  ddl: string,
  userVersion: number,
  rows: Record<string, unknown>[],
): Promise<void> {
  const { Database } = await import('bun:sqlite')
  await fs.mkdir(ccSwitchDir, { recursive: true })
  const db = new Database(path.join(ccSwitchDir, 'cc-switch.db'), { create: true })
  try {
    db.run(ddl)
    // cc-switch tracks its schema generation here and nowhere else.
    db.run(`PRAGMA user_version = ${userVersion}`)
    for (const row of rows) {
      const columns = Object.keys(row)
      db.run(
        `INSERT INTO providers (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map((column) => row[column]) as never,
      )
    }
  } finally {
    db.close()
  }
}

/** Legacy v2 config.json — app keys are flattened at the top level. */
async function writeLegacyConfig(
  apps: Record<string, { providers: Record<string, unknown>; current?: string }>,
  fileName = 'config.json',
  dir = ccSwitchDir,
): Promise<void> {
  await writeJsonFile(path.join(dir, fileName), { version: 2, ...apps, mcp: {} })
}

async function writeCcSwitchSettings(value: Record<string, unknown>, dir = ccSwitchDir): Promise<void> {
  await writeJsonFile(path.join(dir, 'settings.json'), value)
}

function makeRequest(
  method: string,
  urlStr: string,
  body?: Record<string, unknown>,
): { req: Request; url: URL; segments: string[] } {
  const url = new URL(urlStr, 'http://localhost:3456')
  const init: RequestInit = { method }
  if (body) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const req = new Request(url.toString(), init)
  const segments = url.pathname.split('/').filter(Boolean)
  return { req, url, segments }
}

async function callProvidersApi(
  method: string,
  urlStr: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { req, url, segments } = makeRequest(method, urlStr, body)
  const res = await handleProvidersApi(req, url, segments)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function scanCandidates(): Promise<CcSwitchCandidate[]> {
  return (await scanCcSwitchProviders()).candidates
}

function candidateById(candidates: CcSwitchCandidate[], sourceId: string): CcSwitchCandidate {
  const candidate = candidates.find((entry) => entry.sourceId === sourceId)
  if (!candidate) throw new Error(`Candidate not found: ${sourceId}`)
  return candidate
}

async function readProvidersConfig(): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(tmpDir, 'cc-haha', 'providers.json'), 'utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

function sampleProviderInput(overrides?: Partial<CreateProviderInput>): CreateProviderInput {
  return {
    presetId: 'custom',
    name: 'Existing Provider',
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-existing-key',
    apiFormat: 'anthropic',
    runtimeKind: 'anthropic_compatible',
    models: { main: 'm', haiku: 'm', sonnet: 'm', opus: 'm' },
    ...overrides,
  }
}

const FULL_KEY = 'sk-ant-0123456789abcdef0123456789abcdef4f2a'

function claudeEnv(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    ANTHROPIC_BASE_URL: 'https://api.example.com',
    ANTHROPIC_AUTH_TOKEN: FULL_KEY,
    ANTHROPIC_MODEL: 'model-main',
    ...overrides,
  }
}

// =============================================================================
// Store discovery
// =============================================================================

describe('cc-switch store discovery', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('reports not-found when cc-switch is not installed', async () => {
    const result = await scanCcSwitchProviders()

    expect(result).toEqual({ available: false, reason: 'not-found', candidates: [] })
  })

  test('reports not-found when the data directory holds no readable store', async () => {
    await fs.mkdir(ccSwitchDir, { recursive: true })

    const result = await scanCcSwitchProviders()

    expect(result.available).toBe(false)
    expect(result.reason).toBe('not-found')
    expect(result.configDir).toBe(ccSwitchDir)
    expect(result.candidates).toEqual([])
  })

  test('reads the SQLite store in cc-switch order', async () => {
    await writeFixtureDb([
      { id: 'zeta', name: 'Zeta', env: claudeEnv(), sortIndex: null, createdAt: 5 },
      { id: 'beta', name: 'Beta', env: claudeEnv(), sortIndex: 2, createdAt: 30 },
      { id: 'alpha', name: 'Alpha', env: claudeEnv(), sortIndex: 1, createdAt: 40 },
      { id: 'delta', name: 'Delta', env: claudeEnv(), sortIndex: null, createdAt: 1 },
      { id: 'codex-only', name: 'Codex', env: claudeEnv(), appType: 'codex' },
    ])

    const result = await scanCcSwitchProviders()

    expect(result.available).toBe(true)
    expect(result.source).toBe('sqlite')
    expect(result.configDir).toBe(ccSwitchDir)
    // sort_index first (NULL last), then created_at, then id.
    expect(result.candidates.map((candidate) => candidate.name)).toEqual([
      'Alpha',
      'Beta',
      'Delta',
      'Zeta',
    ])
  })

  test('releases the SQLite store after scanning', async () => {
    await writeFixtureDb([
      { id: 'releasable', name: 'Releasable', env: claudeEnv() },
    ])

    const result = await scanCcSwitchProviders()

    expect(result.available).toBe(true)
    await expect(fs.rm(ccSwitchDir, { recursive: true })).resolves.toBeUndefined()
  })

  test('reads claude-desktop rows alongside claude rows', async () => {
    await writeFixtureDb([
      { id: 'one', name: 'Claude Row', env: claudeEnv(), sortIndex: 1 },
      { id: 'one', name: 'Desktop Row', env: claudeEnv(), sortIndex: 2, appType: 'claude-desktop' },
    ])

    const candidates = await scanCandidates()

    expect(candidates.map((candidate) => candidate.sourceId)).toEqual([
      'claude:one',
      'claude-desktop:one',
    ])
    expect(candidates[1].appType).toBe('claude-desktop')
  })

  test('falls back to the flattened legacy config.json when no database exists', async () => {
    await writeLegacyConfig({
      claude: {
        providers: {
          'id-b': {
            id: 'id-b',
            name: 'Legacy B',
            settingsConfig: { env: claudeEnv() },
            sortIndex: 2,
            createdAt: 10,
            notes: 'legacy note',
          },
          'id-a': {
            id: 'id-a',
            name: 'Legacy A',
            settingsConfig: { env: claudeEnv() },
            sortIndex: 1,
            createdAt: 20,
          },
        },
        current: 'id-b',
      },
      codex: { providers: { other: { id: 'other', name: 'Codex' } } },
    })

    const result = await scanCcSwitchProviders()

    expect(result.available).toBe(true)
    expect(result.source).toBe('json')
    expect(result.candidates.map((candidate) => candidate.name)).toEqual(['Legacy A', 'Legacy B'])
    expect(candidateById(result.candidates, 'claude:id-b')).toMatchObject({
      isCurrent: true,
      notes: 'legacy note',
      importable: true,
    })
    expect(candidateById(result.candidates, 'claude:id-a').isCurrent).toBe(false)
  })

  test('falls back to config.json.migrated when config.json is absent', async () => {
    await writeLegacyConfig(
      { claude: { providers: { kept: { id: 'kept', name: 'Kept', settingsConfig: { env: claudeEnv() } } } } },
      'config.json.migrated',
    )

    const result = await scanCcSwitchProviders()

    expect(result.source).toBe('json')
    expect(result.candidates.map((candidate) => candidate.sourceId)).toEqual(['claude:kept'])
  })

  test('refuses to serve the archived JSON store when a database exists but fails', async () => {
    // Once cc-switch migrates it archives the old config, so a config.json
    // sitting next to a database is pre-migration data — revoked keys and
    // stale URLs. Presenting it as a normal scan would be worse than failing.
    await fs.mkdir(ccSwitchDir, { recursive: true })
    await fs.writeFile(path.join(ccSwitchDir, 'cc-switch.db'), 'not a sqlite database', 'utf-8')
    await writeLegacyConfig({
      claude: { providers: { stale: { id: 'stale', name: 'Stale', settingsConfig: { env: claudeEnv() } } } },
    })

    const result = await scanCcSwitchProviders()

    expect(result.available).toBe(false)
    expect(result.reason).toBe('unreadable')
    expect(result.candidates).toEqual([])
  })

  test('survives cc-switch dropping a column we do not filter on', async () => {
    // The query must not name sort_index/created_at: sortRows() reproduces the
    // ordering in JS, so a schema change there should not kill the feature.
    await fs.mkdir(ccSwitchDir, { recursive: true })
    const { Database } = await import('bun:sqlite')
    const db = new Database(path.join(ccSwitchDir, 'cc-switch.db'), { create: true })
    db.run('CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, meta TEXT, is_current BOOLEAN)')
    db.run('INSERT INTO providers VALUES (?,?,?,?,?,?)', [
      'drifted', 'claude', 'Drifted', JSON.stringify({ env: claudeEnv() }), '{}', 0,
    ])
    db.close()

    const result = await scanCcSwitchProviders()

    expect(result.available).toBe(true)
    expect(result.source).toBe('sqlite')
    expect(result.candidates.map((candidate) => candidate.sourceId)).toEqual(['claude:drifted'])
  })

  // cc-switch is a separate app on its own release schedule and has already
  // migrated its storage once. These pin the degradation contract: a structure
  // we do not understand must say so, and must stay distinguishable from a
  // file we simply could not read.
  describe('cc-switch schema drift', () => {
    async function writeRawDb(ddl: string, insert?: { sql: string; values: unknown[] }) {
      await fs.mkdir(ccSwitchDir, { recursive: true })
      const { Database } = await import('bun:sqlite')
      const db = new Database(path.join(ccSwitchDir, 'cc-switch.db'), { create: true })
      db.run(ddl)
      if (insert) db.run(insert.sql, insert.values as never)
      db.close()
    }

    const SETTINGS = JSON.stringify({ env: claudeEnv() })

    test('reports schema-unsupported when the providers table is gone', async () => {
      await writeRawDb('CREATE TABLE provider_v2 (id TEXT, app_type TEXT)')

      const result = await scanCcSwitchProviders()

      expect(result.available).toBe(false)
      expect(result.reason).toBe('schema-unsupported')
    })

    test.each(['id', 'app_type', 'settings_config'])(
      'reports schema-unsupported when the %s column is missing',
      async (missing) => {
        const columns = ['id TEXT', 'app_type TEXT', 'name TEXT', 'settings_config TEXT']
          .filter((column) => !column.startsWith(`${missing} `))
        await writeRawDb(`CREATE TABLE providers (${columns.join(', ')})`)

        const result = await scanCcSwitchProviders()

        expect(result.available).toBe(false)
        expect(result.reason).toBe('schema-unsupported')
      },
    )

    test('reports schema-unsupported when every row names an unknown app', async () => {
      await writeRawDb(
        'CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT)',
        { sql: 'INSERT INTO providers VALUES (?,?,?,?)', values: ['a', 'claude-next', 'A', SETTINGS] },
      )

      const result = await scanCcSwitchProviders()

      expect(result.available).toBe(false)
      expect(result.reason).toBe('schema-unsupported')
    })

    test('a user with only codex providers is an empty success, not drift', async () => {
      await writeRawDb(
        'CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT)',
        { sql: 'INSERT INTO providers VALUES (?,?,?,?)', values: ['c', 'codex', 'Codex', '{}'] },
      )

      const result = await scanCcSwitchProviders()

      expect(result.available).toBe(true)
      expect(result.candidates).toEqual([])
    })

    test('an empty providers table is an empty success', async () => {
      await writeRawDb('CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT)')

      const result = await scanCcSwitchProviders()

      expect(result.available).toBe(true)
      expect(result.candidates).toEqual([])
    })

    test('columns cc-switch adds later are ignored, not fatal', async () => {
      await writeRawDb(
        'CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, meta TEXT, is_current BOOLEAN, brand_new TEXT)',
        {
          sql: 'INSERT INTO providers VALUES (?,?,?,?,?,?,?)',
          values: ['fwd', 'claude', 'Forward', SETTINGS, '{}', 0, 'whatever'],
        },
      )

      const result = await scanCcSwitchProviders()

      expect(result.available).toBe(true)
      expect(result.candidates.map((candidate) => candidate.sourceId)).toEqual(['claude:fwd'])
    })

    test('one malformed row does not take the readable ones down with it', async () => {
      await fs.mkdir(ccSwitchDir, { recursive: true })
      const { Database } = await import('bun:sqlite')
      const db = new Database(path.join(ccSwitchDir, 'cc-switch.db'), { create: true })
      db.run('CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, meta TEXT, is_current BOOLEAN)')
      db.run('INSERT INTO providers VALUES (?,?,?,?,?,?)', ['bad', 'claude', 'Bad', '{not json', '{}', 0])
      db.run('INSERT INTO providers VALUES (?,?,?,?,?,?)', ['good', 'claude', 'Good', SETTINGS, '{}', 0])
      db.close()

      const result = await scanCcSwitchProviders()

      expect(result.available).toBe(true)
      expect(candidateById(result.candidates, 'claude:good').importable).toBe(true)
      expect(candidateById(result.candidates, 'claude:bad').importable).toBe(false)
    })
  })

  test('reports unreadable when neither store can be parsed', async () => {
    await fs.mkdir(ccSwitchDir, { recursive: true })
    await fs.writeFile(path.join(ccSwitchDir, 'cc-switch.db'), 'not a sqlite database', 'utf-8')
    await fs.writeFile(path.join(ccSwitchDir, 'config.json'), '{not json', 'utf-8')

    const result = await scanCcSwitchProviders()

    expect(result.available).toBe(false)
    expect(result.reason).toBe('unreadable')
    expect(result.candidates).toEqual([])
  })

  test('honours the app_paths.json directory override', async () => {
    const relocated = path.join(tmpDir, 'relocated-cc-switch')
    await writeFixtureDb([{ id: 'moved', name: 'Moved', env: claudeEnv() }], relocated)
    // The default directory also exists, so the override has to win.
    await writeFixtureDb([{ id: 'default', name: 'Default', env: claudeEnv() }])
    await writeDirOverride(relocated)

    const result = await scanCcSwitchProviders()

    expect(result.configDir).toBe(relocated)
    expect(result.candidates.map((candidate) => candidate.name)).toEqual(['Moved'])
  })

  test('expands a ~-prefixed directory override', async () => {
    const relocated = path.join(tmpDir, 'home-relative')
    await writeFixtureDb([{ id: 'tilde', name: 'Tilde', env: claudeEnv() }], relocated)
    await writeDirOverride('~/home-relative')

    const result = await scanCcSwitchProviders()

    expect(result.configDir).toBe(relocated)
    expect(result.candidates.map((candidate) => candidate.name)).toEqual(['Tilde'])
  })

  test('ignores a directory override that no longer exists', async () => {
    await writeFixtureDb([{ id: 'default', name: 'Default', env: claudeEnv() }])
    await writeDirOverride(path.join(tmpDir, 'deleted-directory'))

    const result = await scanCcSwitchProviders()

    expect(result.configDir).toBe(ccSwitchDir)
    expect(result.candidates.map((candidate) => candidate.name)).toEqual(['Default'])
  })

  test('finds settings.json at its fixed home path when the directory is overridden', async () => {
    // cc-switch pins settings.json to ~/.cc-switch even when the data
    // directory moves — it is the file that holds the override. Looking only
    // inside the relocated directory would lose the active-provider marker.
    const relocated = path.join(tmpDir, 'relocated-cc-switch')
    await writeFixtureDb([
      { id: 'first', name: 'First', env: claudeEnv(), sortIndex: 1, isCurrent: true },
      { id: 'second', name: 'Second', env: claudeEnv(), sortIndex: 2 },
    ], relocated)
    await writeDirOverride(relocated)
    await fs.mkdir(ccSwitchDir, { recursive: true })
    await writeCcSwitchSettings({ currentProviderClaude: 'second' })

    const result = await scanCcSwitchProviders()

    expect(result.configDir).toBe(relocated)
    expect(candidateById(result.candidates, 'claude:first').isCurrent).toBe(false)
    expect(candidateById(result.candidates, 'claude:second').isCurrent).toBe(true)
  })

  test('marks the active provider from cc-switch settings.json', async () => {
    await writeFixtureDb([
      { id: 'first', name: 'First', env: claudeEnv(), sortIndex: 1, isCurrent: true },
      { id: 'second', name: 'Second', env: claudeEnv(), sortIndex: 2 },
    ])
    // currentProviderClaude is the source of truth and overrides the is_current column.
    await writeCcSwitchSettings({ currentProviderClaude: 'second' })

    const candidates = await scanCandidates()

    expect(candidateById(candidates, 'claude:first').isCurrent).toBe(false)
    expect(candidateById(candidates, 'claude:second').isCurrent).toBe(true)
  })

  test('falls back to the is_current column when settings.json has no marker', async () => {
    await writeFixtureDb([
      { id: 'first', name: 'First', env: claudeEnv(), sortIndex: 1 },
      { id: 'second', name: 'Second', env: claudeEnv(), sortIndex: 2, isCurrent: true },
    ])
    await writeCcSwitchSettings({ language: 'zh' })

    const candidates = await scanCandidates()

    expect(candidateById(candidates, 'claude:first').isCurrent).toBe(false)
    expect(candidateById(candidates, 'claude:second').isCurrent).toBe(true)
  })
})

// =============================================================================
// Historical cc-switch generations
// =============================================================================

/**
 * cc-switch has changed its store twice — flat JSON → multi-app JSON in v3.4.0,
 * JSON → SQLite in v3.8.0 — and each of those shapes is still sitting on disk
 * for someone. These pin one fixture per generation, built from the DDL and
 * serde structs at that tag.
 *
 * Every test asserts the mapped values, not just a candidate count: a scan that
 * reports success with blank names and base URLs is a worse outcome than one
 * that fails outright, and only field-level assertions can tell them apart.
 *
 * Support starts at v3.1.0, the release that introduced the multi-app store.
 * v2.0.3 .. v3.0.1 wrote a flat `{ providers, current }` file with no per-app
 * key, which has no reader here and must fail honestly.
 */
describe('cc-switch format generations', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('v3.1.0–v3.3.1 JSON: the oldest store we support', async () => {
    // The multi-app store starts here, but a provider entry is still only
    // id/name/settingsConfig/websiteUrl — no category, createdAt, sortIndex,
    // notes or meta yet.
    await writeLegacyConfig({
      claude: {
        providers: {
          'p-vendor': {
            id: 'p-vendor',
            name: 'Vendor',
            settingsConfig: { env: claudeEnv({ ANTHROPIC_MODEL: 'vendor-main' }) },
            websiteUrl: 'https://vendor.example',
          },
        },
        current: 'p-vendor',
      },
      codex: { providers: {}, current: '' },
    })

    const result = await scanCcSwitchProviders()

    expect(result).toMatchObject({ available: true, source: 'json' })
    expect(candidateById(result.candidates, 'claude:p-vendor')).toMatchObject({
      name: 'Vendor',
      baseUrl: 'https://api.example.com',
      hasApiKey: true,
      apiKeyPreview: 'sk-ant…4f2a',
      apiFormat: 'anthropic',
      authStrategy: 'auth_token',
      // No settings.json existed before v3.8, so `current` is the only marker.
      isCurrent: true,
      importable: true,
    })
    expect(candidateById(result.candidates, 'claude:p-vendor').models.main).toBe('vendor-main')
  })

  test('v3.7.0–v3.7.1 JSON: the last pre-SQLite store', async () => {
    // Every field the JSON era ever gained: category/createdAt (v3.4.0),
    // sortIndex (v3.6.0), notes and meta (v3.7.0).
    await writeLegacyConfig({
      claude: {
        providers: {
          'p-vendor': {
            id: 'p-vendor',
            name: 'Vendor',
            settingsConfig: { env: claudeEnv({ ANTHROPIC_MODEL: 'vendor-main' }) },
            websiteUrl: 'https://vendor.example',
            category: 'third_party',
            createdAt: 1_700_000_000_000,
            sortIndex: 1,
            notes: 'work account',
            // In the JSON store meta is a real object, not the JSON string
            // SQLite keeps, and it predates meta.apiFormat entirely.
            meta: { isPartner: false },
          },
        },
        current: 'p-vendor',
      },
    })

    const candidate = candidateById(await scanCandidates(), 'claude:p-vendor')

    expect(candidate).toMatchObject({
      name: 'Vendor',
      notes: 'work account',
      // apiFormat only arrives in v3.10.3; anthropic is the right default.
      apiFormat: 'anthropic',
      isCurrent: true,
      importable: true,
    })
    expect(candidate.models.main).toBe('vendor-main')
  })

  test('v3.8.0–v3.8.3 SQLite: schema v1, before in_failover_queue', async () => {
    await writeGenerationDb(CC_SWITCH_V3_8_PROVIDERS_DDL, 1, [
      {
        id: 'p-vendor',
        app_type: 'claude',
        name: 'Vendor',
        settings_config: JSON.stringify({ env: claudeEnv({ ANTHROPIC_MODEL: 'vendor-main' }) }),
        meta: JSON.stringify({ isPartner: false }),
        notes: 'work account',
        sort_index: 1,
        is_current: 0,
      },
    ])
    // v3.8.0 moved the current-provider marker into settings.json and archived
    // the pre-migration JSON beside the new database.
    await writeCcSwitchSettings({ currentProviderClaude: 'p-vendor', language: 'zh' })
    await writeLegacyConfig(
      { claude: { providers: { stale: { id: 'stale', name: 'Stale', settingsConfig: { env: claudeEnv() } } } } },
      'config.json.migrated',
    )

    const result = await scanCcSwitchProviders()

    // The database wins over the archive it replaced.
    expect(result.source).toBe('sqlite')
    expect(result.candidates.map((candidate) => candidate.sourceId)).toEqual(['claude:p-vendor'])
    expect(candidateById(result.candidates, 'claude:p-vendor')).toMatchObject({
      name: 'Vendor',
      baseUrl: 'https://api.example.com',
      hasApiKey: true,
      notes: 'work account',
      apiFormat: 'anthropic',
      // settings.json overrides the is_current column, which reads 0 here.
      isCurrent: true,
      importable: true,
    })
    expect(candidateById(result.candidates, 'claude:p-vendor').models.main).toBe('vendor-main')
  })

  test('v3.9.0–v3.9.1 SQLite (user_version 3): in_failover_queue lands and is ignored', async () => {
    // The column itself arrives one pre-release earlier, in v3.9.0-3, while
    // user_version is still 2 — so both DDLs exist under that version number.
    await writeGenerationDb(CC_SWITCH_V3_9_PROVIDERS_DDL, 3, [
      {
        id: 'p-vendor',
        app_type: 'claude',
        name: 'Vendor',
        settings_config: JSON.stringify({ env: claudeEnv({ ANTHROPIC_MODEL: 'vendor-main' }) }),
        meta: JSON.stringify({ isPartner: false }),
        is_current: 1,
        in_failover_queue: 1,
      },
      {
        id: 'p-codex',
        app_type: 'codex',
        name: 'Codex Vendor',
        settings_config: JSON.stringify({ env: claudeEnv() }),
        meta: '{}',
        is_current: 0,
        in_failover_queue: 0,
      },
    ])

    const result = await scanCcSwitchProviders()

    expect(result.source).toBe('sqlite')
    expect(result.candidates.map((candidate) => candidate.sourceId)).toEqual(['claude:p-vendor'])
    expect(candidateById(result.candidates, 'claude:p-vendor')).toMatchObject({
      name: 'Vendor',
      hasApiKey: true,
      // No settings.json, so the is_current column is the marker again.
      isCurrent: true,
      importable: true,
    })
  })

  test('v3.16.3–v3.16.5 SQLite (user_version 11): the installed shape', async () => {
    // cost_multiplier / limit_* / provider_type are not in create_tables() —
    // migrate_v0_to_v1() adds them, so every live database carries them.
    await writeGenerationDb(CC_SWITCH_LIVE_PROVIDERS_DDL, 11, [
      {
        id: 'p-vendor',
        app_type: 'claude',
        name: 'Vendor',
        settings_config: JSON.stringify({
          env: claudeEnv({
            ANTHROPIC_MODEL: 'vendor-main',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'vendor-haiku',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'vendor-sonnet',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'vendor-opus',
          }),
        }),
        meta: JSON.stringify({ apiFormat: 'anthropic', apiKeyField: 'ANTHROPIC_AUTH_TOKEN', isFullUrl: false }),
        notes: 'work account',
        sort_index: 1,
        is_current: 0,
        in_failover_queue: 0,
        cost_multiplier: '1.0',
        provider_type: null,
      },
    ])
    await writeCcSwitchSettings({ currentProviderClaude: 'p-vendor' })

    const candidate = candidateById(await scanCandidates(), 'claude:p-vendor')

    expect(candidate).toMatchObject({
      name: 'Vendor',
      baseUrl: 'https://api.example.com',
      hasApiKey: true,
      apiKeyPreview: 'sk-ant…4f2a',
      apiFormat: 'anthropic',
      notes: 'work account',
      isCurrent: true,
      importable: true,
    })
    expect(candidate.models).toEqual({
      main: 'vendor-main',
      haiku: 'vendor-haiku',
      sonnet: 'vendor-sonnet',
      opus: 'vendor-opus',
    })
  })

  test('v3.18.0 SQLite: current schema, with the claude-desktop app', async () => {
    await writeGenerationDb(CC_SWITCH_LIVE_PROVIDERS_DDL, 16, [
      {
        id: 'p-vendor',
        app_type: 'claude',
        name: 'Vendor',
        settings_config: JSON.stringify({ env: claudeEnv({ ANTHROPIC_MODEL: 'vendor-main' }) }),
        meta: JSON.stringify({
          apiFormat: 'anthropic',
          apiKeyField: 'ANTHROPIC_AUTH_TOKEN',
          isFullUrl: false,
          commonConfigEnabled: true,
        }),
        sort_index: 1,
        is_current: 0,
      },
      {
        // claude-desktop only exists from v3.15 onward.
        id: 'p-desktop',
        app_type: 'claude-desktop',
        name: 'Desktop Vendor',
        settings_config: JSON.stringify({
          env: claudeEnv({ ANTHROPIC_BASE_URL: 'https://desktop.example', ANTHROPIC_MODEL: 'desktop-main' }),
        }),
        meta: JSON.stringify({ apiFormat: 'anthropic', claudeDesktopMode: 'direct' }),
        sort_index: 2,
        is_current: 0,
      },
    ])
    await writeCcSwitchSettings({
      currentProviderClaude: 'p-vendor',
      currentProviderClaudeDesktop: 'p-desktop',
    })

    const candidates = await scanCandidates()

    expect(candidates.map((candidate) => candidate.sourceId)).toEqual([
      'claude:p-vendor',
      'claude-desktop:p-desktop',
    ])
    expect(candidateById(candidates, 'claude:p-vendor')).toMatchObject({
      isCurrent: true,
      importable: true,
      apiFormat: 'anthropic',
    })
    expect(candidateById(candidates, 'claude-desktop:p-desktop')).toMatchObject({
      name: 'Desktop Vendor',
      baseUrl: 'https://desktop.example',
      hasApiKey: true,
      importable: true,
    })
  })

  // The far side of the boundary. cc-switch v2.0.3 .. v3.0.1 wrote a flat
  // `{ providers, current }` file with no per-app key, and nothing here reads
  // it. Reporting an empty success would be indistinguishable, to a user with
  // providers sitting on disk, from "you have none" — so it must say the
  // structure is one we do not understand.
  test('v2.0.3–v3.0.1 flat JSON is refused as version-too-old, not silently empty', async () => {
    await writeJsonFile(path.join(ccSwitchDir, 'config.json'), {
      providers: {
        'p-vendor': {
          id: 'p-vendor',
          name: 'Vendor',
          settingsConfig: { env: claudeEnv() },
          websiteUrl: 'https://vendor.example',
        },
      },
      current: 'p-vendor',
    })

    const result = await scanCcSwitchProviders()

    expect(result.available).toBe(false)
    expect(result.reason).toBe('version-too-old')
    expect(result.source).toBeUndefined()
    expect(result.candidates).toEqual([])
  })

  // cc-switch's own rule (`app_config.rs:577-583`) keys on the shape, not the
  // version field — its comment says outright that `version`/`mcp` "可能存在但
  // 不作为 v2 判据". So a stray `version: 2` does not make a file v2.
  test('v1 JSON carrying a stray version:2 is still refused', async () => {
    await writeJsonFile(path.join(ccSwitchDir, 'config.json'), {
      version: 2,
      providers: { 'p-vendor': { id: 'p-vendor', name: 'Vendor', settingsConfig: { env: claudeEnv() } } },
      current: 'p-vendor',
    })

    const result = await scanCcSwitchProviders()

    expect(result.available).toBe(false)
    expect(result.reason).toBe('version-too-old')
  })

  // The v1 detector keys on the shape, so an empty v2 store — same top-level
  // `providers`-less layout, real app keys — must stay an empty success.
  test('an empty but well-formed v2 store is still a success, not v1', async () => {
    await writeLegacyConfig({
      claude: { providers: {}, current: '' },
      codex: { providers: {}, current: '' },
    })

    const result = await scanCcSwitchProviders()

    expect(result.available).toBe(true)
    expect(result.source).toBe('json')
    expect(result.candidates).toEqual([])
  })
})

// =============================================================================
// Mapping
// =============================================================================

describe('cc-switch candidate mapping', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('maps a complete provider into an importable candidate', async () => {
    await writeFixtureDb([{
      id: 'full',
      name: 'Full Provider',
      notes: 'work account',
      meta: JSON.stringify({ apiFormat: 'anthropic', apiKeyField: 'ANTHROPIC_AUTH_TOKEN' }),
      env: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic/',
        ANTHROPIC_AUTH_TOKEN: FULL_KEY,
        ANTHROPIC_MODEL: 'model-main',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'model-haiku',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'model-sonnet',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'model-opus',
      },
    }])

    const candidate = candidateById(await scanCandidates(), 'claude:full')

    expect(candidate).toMatchObject({
      sourceId: 'claude:full',
      appType: 'claude',
      name: 'Full Provider',
      baseUrl: 'https://api.deepseek.com/anthropic/',
      hasApiKey: true,
      apiFormat: 'anthropic',
      authStrategy: 'auth_token',
      // Trailing slash and casing are ignored when matching bundled presets.
      presetId: 'deepseek',
      importable: true,
      notes: 'work account',
    })
    expect(candidate.models).toEqual({
      main: 'model-main',
      haiku: 'model-haiku',
      sonnet: 'model-sonnet',
      opus: 'model-opus',
    })
    expect(candidate.model1mSupport).toEqual({
      main: false,
      haiku: false,
      sonnet: false,
      opus: false,
    })
    expect(candidate.skipReason).toBeUndefined()
  })

  test('masks the API key and never exposes the full secret', async () => {
    await writeFixtureDb([
      { id: 'long', name: 'Long', env: claudeEnv() },
      { id: 'medium', name: 'Medium', env: claudeEnv({ ANTHROPIC_AUTH_TOKEN: 'sk-12345678f2a4' }) },
      { id: 'short', name: 'Short', env: claudeEnv({ ANTHROPIC_AUTH_TOKEN: 'sk-123' }) },
    ])

    const candidates = await scanCandidates()

    expect(candidateById(candidates, 'claude:long').apiKeyPreview).toBe('sk-ant…4f2a')
    expect(candidateById(candidates, 'claude:medium').apiKeyPreview).toBe('…f2a4')
    expect(candidateById(candidates, 'claude:short').apiKeyPreview).toBe('…')
    expect(JSON.stringify(candidates)).not.toContain(FULL_KEY)
    expect(JSON.stringify(candidates)).not.toContain('sk-12345678f2a4')
  })

  test('detects 1M markers per slot and strips them from the stored model ids', async () => {
    await writeFixtureDb([{
      id: 'onem',
      name: 'One M',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.example.com',
        ANTHROPIC_AUTH_TOKEN: FULL_KEY,
        ANTHROPIC_MODEL: 'gemini-3.6-flash-high[1M]',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gemini-3.6-flash-lite',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'gemini-3.6-flash-high:1m',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'gemini-3.6-pro[1m]',
      },
    }])

    const candidate = candidateById(await scanCandidates(), 'claude:onem')

    expect(candidate.models).toEqual({
      main: 'gemini-3.6-flash-high',
      haiku: 'gemini-3.6-flash-lite',
      sonnet: 'gemini-3.6-flash-high',
      opus: 'gemini-3.6-pro',
    })
    expect(candidate.model1mSupport).toEqual({
      main: true,
      haiku: false,
      sonnet: true,
      opus: true,
    })
  })

  test('ignores *_MODEL_NAME display labels', async () => {
    await writeFixtureDb([{
      id: 'labels',
      name: 'Labels',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.example.com',
        ANTHROPIC_AUTH_TOKEN: FULL_KEY,
        ANTHROPIC_MODEL: 'real-model',
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Pretty Sonnet Label',
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'Pretty Opus Label',
      },
    }])

    const candidate = candidateById(await scanCandidates(), 'claude:labels')

    expect(candidate.models).toEqual({
      main: 'real-model',
      haiku: 'real-model',
      sonnet: 'real-model',
      opus: 'real-model',
    })
    expect(JSON.stringify(candidate)).not.toContain('Pretty Sonnet Label')
  })

  test('treats empty-string env values as absent', async () => {
    await writeFixtureDb([{
      id: 'blanks',
      name: 'Blanks',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.example.com',
        ANTHROPIC_AUTH_TOKEN: FULL_KEY,
        ANTHROPIC_MODEL: 'only-main',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
        ANTHROPIC_DEFAULT_SONNET_MODEL: '   ',
        ANTHROPIC_DEFAULT_OPUS_MODEL: '',
      },
    }])

    const candidate = candidateById(await scanCandidates(), 'claude:blanks')

    expect(candidate.models).toEqual({
      main: 'only-main',
      haiku: 'only-main',
      sonnet: 'only-main',
      opus: 'only-main',
    })
    expect(candidate.importable).toBe(true)
  })

  test('falls back to the sonnet model when ANTHROPIC_MODEL is missing', async () => {
    await writeFixtureDb([
      {
        id: 'sonnet-only',
        name: 'Sonnet Only',
        sortIndex: 1,
        env: {
          ANTHROPIC_BASE_URL: 'https://api.example.com',
          ANTHROPIC_AUTH_TOKEN: FULL_KEY,
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'from-sonnet',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'from-haiku',
        },
      },
      {
        id: 'haiku-only',
        name: 'Haiku Only',
        sortIndex: 2,
        env: {
          ANTHROPIC_BASE_URL: 'https://api.example.com',
          ANTHROPIC_AUTH_TOKEN: FULL_KEY,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'from-haiku',
        },
      },
      {
        id: 'opus-only',
        name: 'Opus Only',
        sortIndex: 3,
        env: {
          ANTHROPIC_BASE_URL: 'https://api.example.com',
          ANTHROPIC_AUTH_TOKEN: FULL_KEY,
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'from-opus',
        },
      },
    ])

    const candidates = await scanCandidates()

    expect(candidateById(candidates, 'claude:sonnet-only').models.main).toBe('from-sonnet')
    expect(candidateById(candidates, 'claude:haiku-only').models.main).toBe('from-haiku')
    expect(candidateById(candidates, 'claude:opus-only').models.main).toBe('from-opus')
  })

  test('infers the auth strategy from the settings env', async () => {
    await writeFixtureDb([
      {
        id: 'dummy',
        sortIndex: 1,
        env: {
          ANTHROPIC_BASE_URL: 'https://api.example.com',
          ANTHROPIC_API_KEY: 'dummy',
          ANTHROPIC_AUTH_TOKEN: 'dummy',
          ANTHROPIC_MODEL: 'm',
        },
      },
      {
        id: 'empty-api-key',
        sortIndex: 2,
        env: {
          ANTHROPIC_BASE_URL: 'https://api.example.com',
          ANTHROPIC_API_KEY: '',
          ANTHROPIC_AUTH_TOKEN: FULL_KEY,
          ANTHROPIC_MODEL: 'm',
        },
      },
      {
        id: 'dual-same',
        sortIndex: 3,
        env: {
          ANTHROPIC_BASE_URL: 'https://api.example.com',
          ANTHROPIC_API_KEY: FULL_KEY,
          ANTHROPIC_AUTH_TOKEN: FULL_KEY,
          ANTHROPIC_MODEL: 'm',
        },
      },
      {
        id: 'api-key',
        sortIndex: 4,
        env: {
          ANTHROPIC_BASE_URL: 'https://api.example.com',
          ANTHROPIC_API_KEY: FULL_KEY,
          ANTHROPIC_MODEL: 'm',
        },
      },
    ])

    const candidates = await scanCandidates()

    expect(candidateById(candidates, 'claude:dummy').authStrategy).toBe('dual_dummy')
    expect(candidateById(candidates, 'claude:empty-api-key').authStrategy).toBe('auth_token_empty_api_key')
    expect(candidateById(candidates, 'claude:dual-same').authStrategy).toBe('dual_same_token')
    expect(candidateById(candidates, 'claude:api-key').authStrategy).toBe('api_key')
    // ANTHROPIC_API_KEY is the fallback secret when no auth token is present.
    expect(candidateById(candidates, 'claude:api-key').hasApiKey).toBe(true)
  })

  test('reads the api format from meta and rejects formats we cannot proxy', async () => {
    await writeFixtureDb([
      { id: 'chat', sortIndex: 1, meta: JSON.stringify({ apiFormat: 'openai_chat' }), env: claudeEnv() },
      { id: 'responses', sortIndex: 2, meta: JSON.stringify({ apiFormat: 'openai_responses' }), env: claudeEnv() },
      { id: 'gemini', sortIndex: 3, meta: JSON.stringify({ apiFormat: 'gemini_native' }), env: claudeEnv() },
      { id: 'unknown', sortIndex: 4, meta: JSON.stringify({ apiFormat: 'llamacpp' }), env: claudeEnv() },
      { id: 'no-meta', sortIndex: 5, meta: null, env: claudeEnv() },
    ])

    const candidates = await scanCandidates()

    expect(candidateById(candidates, 'claude:chat')).toMatchObject({ apiFormat: 'openai_chat', importable: true })
    expect(candidateById(candidates, 'claude:responses')).toMatchObject({ apiFormat: 'openai_responses', importable: true })
    expect(candidateById(candidates, 'claude:gemini')).toMatchObject({ importable: false, skipReason: 'unsupported-format' })
    expect(candidateById(candidates, 'claude:unknown')).toMatchObject({ importable: false, skipReason: 'unsupported-format' })
    expect(candidateById(candidates, 'claude:no-meta')).toMatchObject({ apiFormat: 'anthropic', importable: true })
  })

  test('reports every skip reason', async () => {
    await writeFixtureDb([
      // The "official" cc-switch entry seeds an empty env.
      { id: 'official', sortIndex: 1, settingsConfig: JSON.stringify({ env: {} }) },
      { id: 'blank-url', sortIndex: 2, env: { ANTHROPIC_BASE_URL: '  ', ANTHROPIC_AUTH_TOKEN: FULL_KEY, ANTHROPIC_MODEL: 'm' } },
      { id: 'no-key', sortIndex: 3, env: { ANTHROPIC_BASE_URL: 'https://api.example.com', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_MODEL: 'm' } },
      { id: 'no-model', sortIndex: 4, env: { ANTHROPIC_BASE_URL: 'https://api.example.com', ANTHROPIC_AUTH_TOKEN: FULL_KEY } },
      { id: 'bad-format', sortIndex: 5, meta: JSON.stringify({ apiFormat: 'gemini_native' }), env: claudeEnv() },
    ])

    const candidates = await scanCandidates()

    expect(candidateById(candidates, 'claude:official')).toMatchObject({
      importable: false,
      skipReason: 'no-base-url',
      hasApiKey: false,
      apiKeyPreview: '',
      // The official preset has an empty base URL and must never be matched.
      presetId: 'custom',
    })
    expect(candidateById(candidates, 'claude:blank-url').skipReason).toBe('no-base-url')
    expect(candidateById(candidates, 'claude:no-key').skipReason).toBe('no-api-key')
    expect(candidateById(candidates, 'claude:no-model').skipReason).toBe('no-model')
    expect(candidateById(candidates, 'claude:bad-format').skipReason).toBe('unsupported-format')
    expect(candidates.every((candidate) => candidate.importable === false)).toBe(true)
  })

  test('matches bundled presets by normalized base URL and falls back to custom', async () => {
    await writeFixtureDb([
      { id: 'kimi', sortIndex: 1, env: claudeEnv({ ANTHROPIC_BASE_URL: 'HTTPS://API.KIMI.COM/CODING/' }) },
      { id: 'glm-cn', sortIndex: 2, env: claudeEnv({ ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic' }) },
      { id: 'glm-global', sortIndex: 3, env: claudeEnv({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic/' }) },
      { id: 'minimax-cn', sortIndex: 4, env: claudeEnv({ ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic/' }) },
      { id: 'minimax-global', sortIndex: 5, env: claudeEnv({ ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic' }) },
      { id: 'unknown', sortIndex: 6, env: claudeEnv({ ANTHROPIC_BASE_URL: 'https://gateway.internal/anthropic' }) },
    ])

    const candidates = await scanCandidates()

    expect(candidateById(candidates, 'claude:kimi').presetId).toBe('kimi')
    expect(candidateById(candidates, 'claude:glm-cn').presetId).toBe('zhipuglm')
    expect(candidateById(candidates, 'claude:glm-global').presetId).toBe('zhipuglm')
    expect(candidateById(candidates, 'claude:minimax-cn').presetId).toBe('minimax')
    expect(candidateById(candidates, 'claude:minimax-global').presetId).toBe('minimax')
    expect(candidateById(candidates, 'claude:unknown').presetId).toBe('custom')
  })

  test('carries range-checked context windows and boolean toggles into the provider input', async () => {
    await writeFixtureDb([{
      id: 'tuned',
      name: 'Tuned',
      env: claudeEnv({
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '64000',
        CLAUDE_CODE_MODEL_CONTEXT_WINDOWS: JSON.stringify({
          'model-main': 300000,
          'too-small': 500,
          'too-large': 99000000,
          'not-a-number': 'abc',
        }),
        ENABLE_TOOL_SEARCH: 'false',
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
        API_TIMEOUT_MS: '3000000',
      }),
    }])

    const scan = await readCcSwitchProviders()
    const entry = scan.entries.find((item) => item.candidate.sourceId === 'claude:tuned')

    expect(entry?.createInput).toMatchObject({
      autoCompactWindow: 64000,
      modelContextWindows: { 'model-main': 300000 },
      toolSearchEnabled: false,
      disableExperimentalBetas: true,
    })
    expect(entry?.apiKey).toBe(FULL_KEY)
  })

  test('drops out-of-range auto compact windows', async () => {
    await writeFixtureDb([
      { id: 'too-small', sortIndex: 1, env: claudeEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000' }) },
      { id: 'not-int', sortIndex: 2, env: claudeEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'many' }) },
      { id: 'ok', sortIndex: 3, env: claudeEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '32000' }) },
    ])

    const scan = await readCcSwitchProviders()
    const windows = Object.fromEntries(scan.entries.map((entry) => [
      entry.candidate.sourceId,
      entry.createInput?.autoCompactWindow,
    ]))

    expect(windows['claude:too-small']).toBeUndefined()
    expect(windows['claude:not-int']).toBeUndefined()
    expect(windows['claude:ok']).toBe(32000)
  })

  test('refuses a provider whose base URL is a full endpoint', async () => {
    // cc-haha always appends /v1/messages etc., so importing one of these would
    // produce an entry that 404s on every request.
    await writeFixtureDb([{
      id: 'full',
      name: 'Full URL',
      env: claudeEnv({ ANTHROPIC_BASE_URL: 'https://gw.example.com/v1/chat/completions' }),
      meta: JSON.stringify({ isFullUrl: true }),
    }])

    const candidate = candidateById(await scanCandidates(), 'claude:full')

    expect(candidate.importable).toBe(false)
    expect(candidate.skipReason).toBe('full-url-endpoint')
  })

  test('imports normally when isFullUrl is absent or false', async () => {
    await writeFixtureDb([
      { id: 'off', name: 'Off', env: claudeEnv(), meta: JSON.stringify({ isFullUrl: false }) },
      { id: 'absent', name: 'Absent', env: claudeEnv({ ANTHROPIC_MODEL: 'other' }), meta: '{}' },
    ])

    const candidates = await scanCandidates()

    expect(candidateById(candidates, 'claude:off').importable).toBe(true)
    expect(candidateById(candidates, 'claude:absent').importable).toBe(true)
  })

  test('never collapses two rows inside the same app, however alike', async () => {
    // Two rows the user deliberately created. They differ only in fields that
    // an incomplete fingerprint would miss, so a regression here is silent.
    await writeFixtureDb([
      {
        id: 'a',
        name: 'Same Name',
        env: claudeEnv({ ENABLE_TOOL_SEARCH: 'true', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '120000' }),
        sortIndex: 1,
        notes: 'work',
      },
      {
        id: 'b',
        name: 'Same Name',
        env: claudeEnv({ ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' }),
        sortIndex: 2,
        notes: 'personal',
      },
    ])

    const candidates = await scanCandidates()

    expect(candidates.map((candidate) => candidate.sourceId)).toEqual(['claude:a', 'claude:b'])
  })

  test('keeps cross-app entries that differ only in a non-model field', async () => {
    await writeFixtureDb([
      { id: 'x', name: 'Vendor', env: claudeEnv({ ENABLE_TOOL_SEARCH: 'true' }), sortIndex: 1 },
      {
        id: 'x',
        name: 'Vendor',
        env: claudeEnv({ ENABLE_TOOL_SEARCH: 'false' }),
        sortIndex: 2,
        appType: 'claude-desktop',
      },
    ])

    const candidates = await scanCandidates()

    expect(candidates.map((candidate) => candidate.sourceId)).toEqual([
      'claude:x',
      'claude-desktop:x',
    ])
  })

  test('redacts a credential pasted into the cc-switch notes field', async () => {
    await writeFixtureDb([{
      id: 'noted',
      name: 'Noted',
      env: claudeEnv(),
      notes: `backup key is ${FULL_KEY} — keep private`,
    }])

    const candidate = candidateById(await scanCandidates(), 'claude:noted')

    expect(candidate.notes).not.toContain(FULL_KEY)
    expect(candidate.notes).toContain('[REDACTED]')
  })

  test('collapses a provider held identically under claude and claude-desktop', async () => {
    // Users commonly keep the same upstream in both cc-switch apps; importing
    // both would create indistinguishable same-name pairs.
    await writeFixtureDb([
      { id: 'shared', name: 'Shared Vendor', env: claudeEnv(), sortIndex: 1, appType: 'claude-desktop' },
      { id: 'shared', name: 'Shared Vendor', env: claudeEnv(), sortIndex: 2 },
    ])

    const candidates = await scanCandidates()

    // The claude (Claude Code) copy wins regardless of cc-switch ordering.
    expect(candidates.map((candidate) => candidate.sourceId)).toEqual(['claude:shared'])
  })

  test('keeps same-name cross-app entries whose configuration differs', async () => {
    await writeFixtureDb([
      { id: 'split', name: 'Split Vendor', env: claudeEnv(), sortIndex: 1 },
      {
        id: 'split',
        name: 'Split Vendor',
        env: claudeEnv({ ANTHROPIC_MODEL: 'a-different-model' }),
        sortIndex: 2,
        appType: 'claude-desktop',
      },
    ])

    const candidates = await scanCandidates()

    expect(candidates.map((candidate) => candidate.sourceId)).toEqual([
      'claude:split',
      'claude-desktop:split',
    ])
  })

  test('treats placeholder credentials as a missing API key', async () => {
    await writeFixtureDb([
      { id: 'ph1', name: 'Placeholder', env: claudeEnv({ ANTHROPIC_AUTH_TOKEN: '(your API key)' }) },
      { id: 'ph2', name: 'Proxy Managed', env: claudeEnv({ ANTHROPIC_AUTH_TOKEN: 'proxy-managed' }) },
      { id: 'ph3', name: 'Masked', env: claudeEnv({ ANTHROPIC_AUTH_TOKEN: '••••••••' }) },
    ])

    const candidates = await scanCandidates()

    for (const sourceId of ['claude:ph1', 'claude:ph2', 'claude:ph3']) {
      const candidate = candidateById(candidates, sourceId)
      expect(candidate.hasApiKey).toBe(false)
      expect(candidate.importable).toBe(false)
      expect(candidate.skipReason).toBe('no-api-key')
    }
  })

  test('keeps a dummy credential, which is a real auth strategy', async () => {
    await writeFixtureDb([{
      id: 'dummy',
      name: 'Dummy Auth',
      env: claudeEnv({ ANTHROPIC_AUTH_TOKEN: 'dummy', ANTHROPIC_API_KEY: 'dummy' }),
    }])

    const candidate = candidateById(await scanCandidates(), 'claude:dummy')

    expect(candidate.hasApiKey).toBe(true)
    expect(candidate.authStrategy).toBe('dual_dummy')
    expect(candidate.importable).toBe(true)
  })

  test('flags duplicates of already saved providers but keeps them importable', async () => {
    const svc = new ProviderService()
    const byName = await svc.addProvider(sampleProviderInput({
      name: 'Shared Name',
      baseUrl: 'https://api.example.com/',
      apiKey: 'sk-different-key',
    }))
    const byKey = await svc.addProvider(sampleProviderInput({
      name: 'Totally Different',
      baseUrl: 'https://api.other.com',
      apiKey: FULL_KEY,
    }))
    const { providers } = await svc.listProviders()

    await writeFixtureDb([
      { id: 'same-name', sortIndex: 1, name: 'shared name', env: claudeEnv() },
      { id: 'same-key', sortIndex: 2, name: 'Renamed Locally', env: claudeEnv({ ANTHROPIC_BASE_URL: 'https://api.other.com' }) },
      { id: 'no-match', sortIndex: 3, name: 'Fresh', env: claudeEnv({ ANTHROPIC_BASE_URL: 'https://api.fresh.com' }) },
    ])

    const scan = await readCcSwitchProviders({ existingProviders: providers })
    const candidates = scan.entries.map((entry) => entry.candidate)

    expect(candidateById(candidates, 'claude:same-name').duplicate).toEqual({ id: byName.id, name: 'Shared Name' })
    expect(candidateById(candidates, 'claude:same-key').duplicate).toEqual({ id: byKey.id, name: 'Totally Different' })
    expect(candidateById(candidates, 'claude:no-match').duplicate).toBeUndefined()
    expect(candidates.every((candidate) => candidate.importable)).toBe(true)
  })
})

// =============================================================================
// REST API
// =============================================================================

describe('cc-switch REST routes', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('GET /api/providers/cc-switch/scan never returns full API keys', async () => {
    await writeFixtureDb([
      { id: 'importable', sortIndex: 1, name: 'Importable', env: claudeEnv() },
      { id: 'official', sortIndex: 2, name: 'Official', settingsConfig: JSON.stringify({ env: {} }) },
    ])

    const { status, body } = await callProvidersApi('GET', '/api/providers/cc-switch/scan')

    expect(status).toBe(200)
    expect(body.available).toBe(true)
    expect(body.source).toBe('sqlite')
    expect(JSON.stringify(body)).not.toContain(FULL_KEY)
    const candidates = body.candidates as CcSwitchCandidate[]
    expect(candidates).toHaveLength(2)
    expect(candidates[0].apiKeyPreview).toBe('sk-ant…4f2a')
    expect(candidates.some((candidate) => 'apiKey' in candidate)).toBe(false)
  })

  test('GET /api/providers/cc-switch/scan reports an absent installation', async () => {
    const { status, body } = await callProvidersApi('GET', '/api/providers/cc-switch/scan')

    expect(status).toBe(200)
    expect(body).toEqual({ available: false, reason: 'not-found', candidates: [] })
  })

  test('POST /api/providers/cc-switch/import persists the selected providers', async () => {
    await writeFixtureDb([
      {
        id: 'first',
        sortIndex: 1,
        name: 'First Import',
        notes: 'imported',
        env: claudeEnv({ ANTHROPIC_MODEL: 'first-main[1m]' }),
      },
      {
        id: 'second',
        sortIndex: 2,
        name: 'Second Import',
        meta: JSON.stringify({ apiFormat: 'openai_chat' }),
        env: claudeEnv({ ANTHROPIC_BASE_URL: 'https://api.second.com', ANTHROPIC_MODEL: 'second-main' }),
      },
      { id: 'skipped', sortIndex: 3, name: 'Skipped', settingsConfig: JSON.stringify({ env: {} }) },
    ])

    const { status, body } = await callProvidersApi('POST', '/api/providers/cc-switch/import', {
      sourceIds: ['claude:first', 'claude:second', 'claude:skipped', 'claude:ghost'],
    })

    expect(status).toBe(200)
    const imported = body.imported as SavedProvider[]
    expect(imported.map((provider) => provider.name)).toEqual(['First Import', 'Second Import'])
    expect(imported[0]).toMatchObject({
      presetId: 'custom',
      apiKey: FULL_KEY,
      authStrategy: 'auth_token',
      apiFormat: 'anthropic',
      runtimeKind: 'anthropic_compatible',
      models: { main: 'first-main', haiku: 'first-main', sonnet: 'first-main', opus: 'first-main' },
      model1mSupport: { main: true, haiku: true, sonnet: true, opus: true },
      notes: 'imported',
    })
    expect(imported[1].apiFormat).toBe('openai_chat')
    expect(body.skipped).toEqual([
      { sourceId: 'claude:skipped', reason: 'no-base-url' },
      { sourceId: 'claude:ghost', reason: 'not-found' },
    ])

    // Persisted in a single index write, appended to the display order.
    const config = await readProvidersConfig()
    const persisted = config.providers as SavedProvider[]
    expect(persisted.map((provider) => provider.name)).toEqual(['First Import', 'Second Import'])
    expect(config.activeId).toBeNull()
    expect(config.providerOrder).toEqual([
      imported[0].id,
      imported[1].id,
      'claude-official',
      'openai-official',
      'grok-official',
    ])
  })

  test('POST import preserves cc-switch meta.apiKeyField through provider testing', async () => {
    await writeFixtureDb([{
      id: 'explicit-api-key-header',
      name: 'Explicit API Key Header',
      meta: JSON.stringify({
        apiFormat: 'anthropic',
        apiKeyField: 'ANTHROPIC_API_KEY',
      }),
      // cc-switch treats meta.apiKeyField as the source of truth. Historical
      // entries can still retain the credential under AUTH_TOKEN in settings.
      env: claudeEnv({ ANTHROPIC_AUTH_TOKEN: FULL_KEY }),
    }])

    const { body } = await callProvidersApi('POST', '/api/providers/cc-switch/import', {
      sourceIds: ['claude:explicit-api-key-header'],
    })
    const [imported] = body.imported as SavedProvider[]

    const originalFetch = globalThis.fetch
    const calls: Headers[] = []
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(new Headers(init?.headers))
      return new Response(JSON.stringify({
        type: 'message',
        model: imported.models.main,
        content: [],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const result = await new ProviderService().testProvider(imported.id)

      expect(result.connectivity.success).toBe(true)
      expect(calls[0].get('x-api-key')).toBe(FULL_KEY)
      expect(calls[0].get('authorization')).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('POST /api/providers/cc-switch/import keeps previously saved providers', async () => {
    const svc = new ProviderService()
    const existing = await svc.addProvider(sampleProviderInput({ name: 'Kept', baseUrl: 'https://api.kept.com' }))
    await writeFixtureDb([{ id: 'new', name: 'Newcomer', env: claudeEnv() }])

    const { body } = await callProvidersApi('POST', '/api/providers/cc-switch/import', {
      sourceIds: ['claude:new'],
    })

    const imported = body.imported as SavedProvider[]
    const { providers } = await svc.listProviders()
    expect(providers.map((provider) => provider.id)).toEqual([existing.id, imported[0].id])
  })

  test('POST /api/providers/cc-switch/import rejects an empty selection', async () => {
    const { status, body } = await callProvidersApi('POST', '/api/providers/cc-switch/import', {
      sourceIds: [],
    })

    expect(status).toBe(400)
    expect(body.error).toBe('BAD_REQUEST')
  })

  test('POST /api/providers/cc-switch/import reports every id when cc-switch is missing', async () => {
    const { status, body } = await callProvidersApi('POST', '/api/providers/cc-switch/import', {
      sourceIds: ['claude:gone'],
    })

    expect(status).toBe(200)
    expect(body.imported).toEqual([])
    expect(body.skipped).toEqual([{ sourceId: 'claude:gone', reason: 'not-found' }])
  })

  test('rejects unknown cc-switch sub-routes and wrong methods', async () => {
    const unknown = await callProvidersApi('GET', '/api/providers/cc-switch/unknown')
    const wrongMethod = await callProvidersApi('POST', '/api/providers/cc-switch/scan', {})

    expect(unknown.status).toBe(404)
    expect(wrongMethod.status).toBe(405)
  })

  test('POST /api/providers/models proxies the model catalog result', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ data: [{ id: 'model-a', owned_by: 'vendor' }, { id: 'model-b' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch

    try {
      const { status, body } = await callProvidersApi('POST', '/api/providers/models', {
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-models-key',
        modelsUrl: 'https://api.example.com/v1/models',
      })

      expect(status).toBe(200)
      expect(body).toEqual({
        ok: true,
        models: [{ id: 'model-a', ownedBy: 'vendor' }, { id: 'model-b' }],
        endpoint: 'https://api.example.com/v1/models',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('POST /api/providers/models rejects an incomplete body', async () => {
    const { status, body } = await callProvidersApi('POST', '/api/providers/models', {
      baseUrl: 'https://api.example.com',
    })

    expect(status).toBe(400)
    expect(body.error).toBe('BAD_REQUEST')
  })
})
