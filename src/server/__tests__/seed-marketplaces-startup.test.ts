/**
 * Server-side seed marketplace registration tests.
 *
 * These cover the integration that startServer() in src/server/index.ts
 * triggers — calling registerSeedMarketplaces() at boot so the desktop's
 * Settings → Plugins page sees the cc-haha-builtin marketplace shipped
 * with the Electron package.
 *
 * The shape we exercise:
 *
 *   $CLAUDE_CODE_PLUGIN_SEED_DIR/
 *     known_marketplaces.json
 *     marketplaces/
 *       cc-haha-builtin/
 *         .claude-plugin/
 *           marketplace.json
 *
 * is what desktop/scripts/build-plugin-seed.ts produces during
 * `bun run electron:build`. registerSeedMarketplaces() reads the seed,
 * resolves the real installLocation via findSeedMarketplaceLocation(),
 * and writes it into the user's primary
 * ~/.claude/plugins/known_marketplaces.json.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { registerSeedMarketplaces } from '../../utils/plugins/marketplaceManager.js'

const MARKETPLACE_NAME = 'cc-haha-builtin'

let originalConfigDir: string | undefined
let originalSeedDir: string | undefined
let tmpRoot: string

async function makeSeed(seedDir: string): Promise<void> {
  const marketplaceRoot = path.join(seedDir, 'marketplaces', MARKETPLACE_NAME)
  await fs.mkdir(path.join(marketplaceRoot, '.claude-plugin'), { recursive: true })

  // Marketplace manifest the loader will read.
  await fs.writeFile(
    path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    JSON.stringify(
      {
        name: MARKETPLACE_NAME,
        owner: { name: 'cc-haha' },
        plugins: [],
      },
      null,
      2,
    ),
    'utf-8',
  )

  // Seed-side known_marketplaces.json (build-plugin-seed.ts writes this
  // with placeholder paths — registerSeedMarketplaces resolves them
  // against the actual seed dir at runtime).
  await fs.writeFile(
    path.join(seedDir, 'known_marketplaces.json'),
    JSON.stringify(
      {
        [MARKETPLACE_NAME]: {
          source: { source: 'directory', path: '/placeholder' },
          installLocation: '/placeholder',
          lastUpdated: new Date().toISOString(),
          autoUpdate: false,
        },
      },
      null,
      2,
    ),
    'utf-8',
  )
}

beforeEach(async () => {
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalSeedDir = process.env.CLAUDE_CODE_PLUGIN_SEED_DIR
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-seed-test-'))
  // Pin the user-config dir into our tmp so we don't pollute the real
  // ~/.claude when the registration writes back.
  process.env.CLAUDE_CONFIG_DIR = path.join(tmpRoot, 'claude-config')
  await fs.mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalSeedDir === undefined) delete process.env.CLAUDE_CODE_PLUGIN_SEED_DIR
  else process.env.CLAUDE_CODE_PLUGIN_SEED_DIR = originalSeedDir
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('registerSeedMarketplaces (server boot integration)', () => {
  test('returns false and does not write when CLAUDE_CODE_PLUGIN_SEED_DIR is unset', async () => {
    delete process.env.CLAUDE_CODE_PLUGIN_SEED_DIR
    const result = await registerSeedMarketplaces()
    expect(result).toBe(false)
  })

  test('registers the seeded marketplace when env var points at a valid seed', async () => {
    const seedDir = path.join(tmpRoot, 'seed')
    await makeSeed(seedDir)
    process.env.CLAUDE_CODE_PLUGIN_SEED_DIR = seedDir

    const result = await registerSeedMarketplaces()
    expect(result).toBe(true)

    // The primary known_marketplaces.json under CLAUDE_CONFIG_DIR/plugins
    // must now contain the seeded marketplace, with installLocation pointing
    // INTO the seed dir (not the placeholder string).
    const primaryPath = path.join(
      process.env.CLAUDE_CONFIG_DIR!,
      'plugins',
      'known_marketplaces.json',
    )
    const primaryRaw = await fs.readFile(primaryPath, 'utf-8')
    const primary = JSON.parse(primaryRaw) as Record<
      string,
      { installLocation: string; source: { source: string } }
    >
    expect(primary[MARKETPLACE_NAME]).toBeDefined()
    expect(primary[MARKETPLACE_NAME]!.installLocation).toContain(seedDir)
    // Crucially, the runtime-resolved location is NOT the placeholder
    // baked into the seed JSON by build-plugin-seed.ts.
    expect(primary[MARKETPLACE_NAME]!.installLocation).not.toBe('/placeholder')
  })

  test('is idempotent — calling twice with the same seed leaves the primary entry intact', async () => {
    const seedDir = path.join(tmpRoot, 'seed')
    await makeSeed(seedDir)
    process.env.CLAUDE_CODE_PLUGIN_SEED_DIR = seedDir

    // First call: actually registers (returns true).
    expect(await registerSeedMarketplaces()).toBe(true)
    const primaryPath = path.join(
      process.env.CLAUDE_CONFIG_DIR!,
      'plugins',
      'known_marketplaces.json',
    )
    const first = await fs.readFile(primaryPath, 'utf-8')

    // Second call: registerSeedMarketplaces returns false to signal
    // "nothing new to write" (the seed is already represented in primary).
    // The contract this test locks: even when the function returns false
    // on a repeat call, the primary entry MUST still be present and
    // resolved — startServer() invokes this every boot, so a flaky
    // "second-call returns false" must NEVER mean "marketplace was
    // unregistered".
    await registerSeedMarketplaces()
    const second = await fs.readFile(primaryPath, 'utf-8')

    const firstParsed = JSON.parse(first)
    const secondParsed = JSON.parse(second)
    expect(secondParsed[MARKETPLACE_NAME]).toBeDefined()
    expect(secondParsed[MARKETPLACE_NAME]?.installLocation).toBe(
      firstParsed[MARKETPLACE_NAME]?.installLocation,
    )
  })

  test('returns false when the env var points at a nonexistent dir (graceful no-op)', async () => {
    process.env.CLAUDE_CODE_PLUGIN_SEED_DIR = path.join(tmpRoot, 'does-not-exist')
    const result = await registerSeedMarketplaces()
    expect(result).toBe(false)

    // Primary known_marketplaces.json was either never created or has no
    // cc-haha-builtin entry — startup must not crash on a missing seed.
    const primaryPath = path.join(
      process.env.CLAUDE_CONFIG_DIR!,
      'plugins',
      'known_marketplaces.json',
    )
    const primaryExists = await fs.stat(primaryPath).then(
      () => true,
      () => false,
    )
    if (primaryExists) {
      const primary = JSON.parse(await fs.readFile(primaryPath, 'utf-8')) as Record<
        string,
        unknown
      >
      expect(primary[MARKETPLACE_NAME]).toBeUndefined()
    }
  })
})
