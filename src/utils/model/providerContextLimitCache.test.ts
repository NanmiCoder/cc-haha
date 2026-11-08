import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'

let cacheModule: typeof import('./providerContextLimitCache.js')
let contextModule: typeof import('../context.js')
let root: string
let originalEnv: NodeJS.ProcessEnv

const KEY = 'http://127.0.0.1:9\u0000custom-200k'
const OTHER_KEY = 'http://127.0.0.1:9\u0000other-model'
// The file stores digests, never the base URL itself.
const STORED_KEY = createHash('sha256').update(KEY).digest('hex')
const STORED_OTHER_KEY = createHash('sha256').update(OTHER_KEY).digest('hex')
const NOW = 1_800_000_000_000

beforeAll(async () => {
  originalEnv = { ...process.env }
  root = await mkdtemp(join(tmpdir(), 'provider-context-limit-cache-'))
  const env = createSandboxedTestEnvironment(root, {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    ANTHROPIC_API_KEY: 'sk-ant-test-fake',
    CLAUDE_CODE_MODEL_CONTEXT_WINDOWS: JSON.stringify({ 'custom-200k': 200_000 }),
  })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  cacheModule = await import('./providerContextLimitCache.js')
  contextModule = await import('../context.js')
})

afterEach(() => {
  contextModule.resetProviderReportedContextLimitsForTesting()
  // The reset removes what the module wrote; tests also write files by hand.
  rmCacheDir()
})

afterAll(async () => {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  await rm(root, { recursive: true, force: true })
})

function cacheDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR!, 'cache')
}

function cachePath(): string {
  return join(cacheDir(), 'provider-context-limits.json')
}

function rmCacheDir(): void {
  rmSync(cacheDir(), { recursive: true, force: true })
}

function readCacheFile(): unknown {
  return JSON.parse(readFileSync(cachePath(), 'utf8'))
}

function writeCacheFile(content: string): void {
  mkdirSync(cacheDir(), { recursive: true })
  writeFileSync(cachePath(), content)
}

// A later CLI process: nothing in memory, the same config directory on disk.
function startAnotherProcess(): void {
  cacheModule.resetProviderContextLimitCacheForTesting({ keepPersisted: true })
}

describe('provider context limit cache', () => {
  test('a limit one process learned is read back by a later process', () => {
    expect(cacheModule.readPersistedProviderContextLimit(KEY, NOW)).toBeUndefined()

    cacheModule.persistProviderContextLimit(KEY, 80_000, NOW)

    expect(readCacheFile()).toEqual({
      version: 1,
      entries: { [STORED_KEY]: { limit: 80_000, updatedAt: NOW } },
    })
    expect(readFileSync(cachePath(), 'utf8')).not.toContain('127.0.0.1')
    startAnotherProcess()
    expect(cacheModule.readPersistedProviderContextLimit(KEY, NOW + 1_000)).toBe(80_000)
    expect(cacheModule.readPersistedProviderContextLimit(OTHER_KEY, NOW + 1_000)).toBeUndefined()
    // No temporary file is left next to the cache.
    expect(readdirSync(cacheDir())).toEqual(['provider-context-limits.json'])
  })

  test('keeps the smaller of the stored and the new limit, and other entries on disk', () => {
    writeCacheFile(JSON.stringify({
      version: 1,
      entries: { [STORED_OTHER_KEY]: { limit: 120_000, updatedAt: NOW - 1_000 } },
    }))

    cacheModule.persistProviderContextLimit(KEY, 80_000, NOW)
    cacheModule.persistProviderContextLimit(KEY, 100_000, NOW + 1)
    startAnotherProcess()
    expect(cacheModule.readPersistedProviderContextLimit(KEY, NOW + 2)).toBe(80_000)

    cacheModule.persistProviderContextLimit(KEY, 64_000, NOW + 3)
    startAnotherProcess()
    expect(cacheModule.readPersistedProviderContextLimit(KEY, NOW + 4)).toBe(64_000)
    expect(cacheModule.readPersistedProviderContextLimit(OTHER_KEY, NOW + 4)).toBe(120_000)
    expect(readCacheFile()).toEqual({
      version: 1,
      entries: {
        [STORED_KEY]: { limit: 64_000, updatedAt: NOW + 3 },
        [STORED_OTHER_KEY]: { limit: 120_000, updatedAt: NOW - 1_000 },
      },
    })
  })

  test('takes the smaller limit another process wrote after this one first read the file', () => {
    expect(cacheModule.readPersistedProviderContextLimit(KEY, NOW)).toBeUndefined()
    writeCacheFile(JSON.stringify({
      version: 1,
      entries: { [STORED_KEY]: { limit: 70_000, updatedAt: NOW } },
    }))

    cacheModule.persistProviderContextLimit(KEY, 90_000, NOW + 1)

    startAnotherProcess()
    expect(cacheModule.readPersistedProviderContextLimit(KEY, NOW + 2)).toBe(70_000)
  })

  test('an entry older than the TTL is ignored and replaced rather than merged', () => {
    const ttl = cacheModule.PROVIDER_CONTEXT_LIMIT_TTL_MS
    expect(ttl).toBe(7 * 24 * 60 * 60 * 1000)
    cacheModule.persistProviderContextLimit(KEY, 64_000, NOW)
    cacheModule.persistProviderContextLimit(OTHER_KEY, 50_000, NOW)
    startAnotherProcess()

    expect(cacheModule.readPersistedProviderContextLimit(KEY, NOW + ttl - 1)).toBe(64_000)
    expect(cacheModule.readPersistedProviderContextLimit(KEY, NOW + ttl)).toBeUndefined()

    // The provider raised its limit; the stale lower value must not win.
    cacheModule.persistProviderContextLimit(KEY, 128_000, NOW + ttl)
    startAnotherProcess()
    expect(cacheModule.readPersistedProviderContextLimit(KEY, NOW + ttl + 1)).toBe(128_000)
    // Expired entries are dropped from the file when it is rewritten.
    expect(readCacheFile()).toEqual({
      version: 1,
      entries: { [STORED_KEY]: { limit: 128_000, updatedAt: NOW + ttl } },
    })
  })

  test('a corrupt or mismatched file reads as empty and is replaced on the next write', () => {
    for (const content of [
      '{not json',
      JSON.stringify({ version: 2, entries: { [STORED_KEY]: { limit: 1_000, updatedAt: NOW } } }),
      JSON.stringify({ version: 1, entries: { [STORED_KEY]: { limit: 'small', updatedAt: NOW } } }),
      JSON.stringify([1, 2, 3]),
    ]) {
      writeCacheFile(content)
      startAnotherProcess()
      expect(cacheModule.readPersistedProviderContextLimit(KEY, NOW)).toBeUndefined()
    }

    expect(() => cacheModule.persistProviderContextLimit(KEY, 80_000, NOW)).not.toThrow()
    expect(readCacheFile()).toEqual({
      version: 1,
      entries: { [STORED_KEY]: { limit: 80_000, updatedAt: NOW } },
    })
  })

  test('a write that cannot reach the disk is dropped without throwing', () => {
    // A file where the cache directory should be makes every write fail.
    mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true })
    writeFileSync(cacheDir(), 'not a directory')
    try {
      expect(() => cacheModule.persistProviderContextLimit(KEY, 80_000, NOW)).not.toThrow()
      startAnotherProcess()
      expect(cacheModule.readPersistedProviderContextLimit(KEY, NOW)).toBeUndefined()
    } finally {
      rmSync(cacheDir(), { force: true })
    }
  })

  test('ignores limits that are not positive integers', () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      cacheModule.persistProviderContextLimit(KEY, limit, NOW)
    }
    expect(existsSync(cachePath())).toBe(false)
  })

  test('a test reset removes what this process persisted', () => {
    cacheModule.persistProviderContextLimit(KEY, 80_000, NOW)
    expect(existsSync(cachePath())).toBe(true)

    cacheModule.resetProviderContextLimitCacheForTesting()

    expect(existsSync(cachePath())).toBe(false)
    expect(cacheModule.readPersistedProviderContextLimit(KEY, NOW)).toBeUndefined()
  })
})

describe('getEffectiveModelContextWindow with a persisted provider limit', () => {
  test('a later process follows the limit a provider stated in an earlier one', () => {
    expect(contextModule.getEffectiveModelContextWindow('custom-200k')).toBe(200_000)

    contextModule.rememberProviderContextLimit('custom-200k', 80_000)
    expect(contextModule.getEffectiveModelContextWindow('custom-200k')).toBe(80_000)

    // Memory gone, file kept: what a new desktop session's CLI starts with.
    contextModule.resetProviderReportedContextLimitsForTesting({ keepPersisted: true })
    expect(contextModule.getEffectiveModelContextWindow('custom-200k')).toBe(80_000)

    // The limit belongs to that provider, not to the model name.
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:10'
    try {
      expect(contextModule.getEffectiveModelContextWindow('custom-200k')).toBe(200_000)
    } finally {
      process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
    }
  })

  test('the smaller of the in-memory and persisted limits wins', () => {
    const writeDisk = (limit: number) => writeCacheFile(JSON.stringify({
      version: 1,
      entries: { [STORED_KEY]: { limit, updatedAt: Date.now() } },
    }))

    // Keeps this process's in-memory limit; only the file is read again.
    const rereadDisk = () =>
      cacheModule.resetProviderContextLimitCacheForTesting({ keepPersisted: true })

    // Disk lower than memory: another process learned a tighter limit.
    contextModule.rememberProviderContextLimit('custom-200k', 120_000)
    writeDisk(90_000)
    rereadDisk()
    expect(contextModule.getEffectiveModelContextWindow('custom-200k')).toBe(90_000)

    // Memory lower than disk: the file was rewritten with a looser value.
    contextModule.rememberProviderContextLimit('custom-200k', 80_000)
    writeDisk(150_000)
    rereadDisk()
    expect(contextModule.getEffectiveModelContextWindow('custom-200k')).toBe(80_000)
  })

  test('a reset between tests leaves no learned limit behind', () => {
    contextModule.rememberProviderContextLimit('custom-200k', 80_000)

    contextModule.resetProviderReportedContextLimitsForTesting()

    expect(contextModule.getEffectiveModelContextWindow('custom-200k')).toBe(200_000)
  })
})
