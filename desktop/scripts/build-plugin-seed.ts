#!/usr/bin/env bun
/**
 * Build plugin seed directory for Electron packaging.
 *
 * Converts the repository's plugins/ directory into a seed structure
 * that the Electron app can load at runtime via CLAUDE_CODE_PLUGIN_SEED_DIR.
 *
 * Seed structure:
 *   desktop/plugin-seed/
 *     known_marketplaces.json
 *     marketplaces/
 *       cc-haha-builtin/
 *         .claude-plugin/
 *           marketplace.json
 *         image-gen/
 *         reverse-engineering/
 */

import { mkdir, rm, cp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const DESKTOP_ROOT = join(REPO_ROOT, 'desktop')
const PLUGINS_SOURCE = join(REPO_ROOT, 'plugins')
const SEED_OUTPUT = join(DESKTOP_ROOT, 'plugin-seed')

async function main() {
  console.log('[build-plugin-seed] Cleaning old seed...')
  await rm(SEED_OUTPUT, { recursive: true, force: true })
  await mkdir(SEED_OUTPUT, { recursive: true })

  console.log('[build-plugin-seed] Copying marketplace to seed...')
  const marketplacesDir = join(SEED_OUTPUT, 'marketplaces')
  await mkdir(marketplacesDir, { recursive: true })

  const marketplaceDest = join(marketplacesDir, 'cc-haha-builtin')
  await cp(PLUGINS_SOURCE, marketplaceDest, { recursive: true })

  console.log('[build-plugin-seed] Generating known_marketplaces.json...')
  // installLocation is a placeholder - registerSeedMarketplaces() will recompute
  // it by calling findSeedMarketplaceLocation(seedDir, name) at runtime.
  const knownMarketplaces = {
    'cc-haha-builtin': {
      source: {
        source: 'directory',
        path: '/placeholder/will-be-resolved-at-runtime',
      },
      installLocation: '/placeholder/will-be-resolved-at-runtime',
      lastUpdated: new Date().toISOString(),
      autoUpdate: false,
    },
  }

  await writeFile(
    join(SEED_OUTPUT, 'known_marketplaces.json'),
    JSON.stringify(knownMarketplaces, null, 2),
    'utf-8',
  )

  console.log('[build-plugin-seed] ✓ Plugin seed built at', SEED_OUTPUT)
}

main().catch((error) => {
  console.error('[build-plugin-seed] Failed:', error)
  process.exit(1)
})
