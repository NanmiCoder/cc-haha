#!/usr/bin/env bun
/**
 * Dev mode for the reverse-engineering plugin.
 *
 * The plugin loader caches each plugin under
 *   ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/
 * and only re-materialises that cache when the manifest version changes
 * (via /api/plugins/update). That means iterating on SKILL.md / agent
 * prompts during development requires a `version` bump every time —
 * painful.
 *
 * This script replaces the cache directory for the current version with
 * a Windows directory junction (mklink /J) pointing at the in-repo
 * plugin source, so changes show up after a plain
 *   POST /api/plugins/reload
 * No version bump, no /update call.
 *
 * Usage from repo root:
 *   bun run plugins/reverse-engineering/scripts/dev-link.ts            # link
 *   bun run plugins/reverse-engineering/scripts/dev-link.ts --restore  # undo
 *
 * Effects:
 *   - Reads plugin.json to get the current `version`.
 *   - Backs up <cache>/<version>/ to <cache>/<version>.backup/ (idempotent).
 *   - Creates a directory junction at <cache>/<version>/ -> repo plugin dir.
 *   - --restore removes the junction and restores the backup if present.
 *
 * Limitations:
 *   - Windows-only (uses mklink /J). On macOS/Linux a symlink would do; not
 *     implemented since this repo's primary dev path is Windows.
 *   - Run BEFORE the server is up. If the server is already running,
 *     reload after linking.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { readFile, rename, rm } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

const repoRoot = path.resolve(import.meta.dir, '..', '..', '..')
const pluginRoot = path.join(repoRoot, 'plugins', 'reverse-engineering')
const manifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json')

async function readVersion(): Promise<string> {
  const raw = await readFile(manifestPath, 'utf8')
  const data = JSON.parse(raw) as { version?: string }
  if (!data.version) {
    throw new Error(`No "version" in ${manifestPath}`)
  }
  return data.version
}

function getCacheDir(version: string): string {
  return path.join(
    homedir(),
    '.claude',
    'plugins',
    'cache',
    'cc-haha-builtin',
    'reverse-engineering',
    version,
  )
}

function isJunction(p: string): boolean {
  // On Windows, statSync follows junctions; lstat-style check via symlinkSync
  // is tricky from Bun. Use cmd /c dir to detect <JUNCTION> attribute.
  if (platform() !== 'win32') return false
  try {
    const out = spawnSync('cmd', ['/c', 'dir', '/AL', path.dirname(p)], {
      encoding: 'utf8',
    }).stdout || ''
    return out.includes(path.basename(p)) && out.includes('<JUNCTION>')
  } catch {
    return false
  }
}

async function link(): Promise<void> {
  if (platform() !== 'win32') {
    // biome-ignore lint/suspicious/noConsole:: developer tool
    console.error(
      'dev-link is Windows-only (uses mklink /J). On macOS/Linux, manually:\n' +
        `  ln -s "${pluginRoot}" <cache>/<version>`,
    )
    process.exit(1)
  }

  const version = await readVersion()
  const cacheDir = getCacheDir(version)
  const backupDir = `${cacheDir}.backup`

  if (existsSync(cacheDir)) {
    if (isJunction(cacheDir)) {
      // biome-ignore lint/suspicious/noConsole:: developer tool
      console.log(`Already linked: ${cacheDir} -> ${pluginRoot}`)
      return
    }
    if (existsSync(backupDir)) {
      await rm(backupDir, { recursive: true, force: true })
    }
    await rename(cacheDir, backupDir)
    // biome-ignore lint/suspicious/noConsole:: developer tool
    console.log(`Backed up real cache: ${cacheDir} -> ${backupDir}`)
  } else {
    mkdirSync(path.dirname(cacheDir), { recursive: true })
  }

  const r = spawnSync('cmd', ['/c', 'mklink', '/J', cacheDir, pluginRoot], {
    encoding: 'utf8',
  })
  if (r.status !== 0) {
    // biome-ignore lint/suspicious/noConsole:: developer tool
    console.error(`mklink failed: ${r.stderr || r.stdout}`)
    process.exit(2)
  }
  // biome-ignore lint/suspicious/noConsole:: developer tool
  console.log(`Linked: ${cacheDir} -> ${pluginRoot}`)
  // biome-ignore lint/suspicious/noConsole:: developer tool
  console.log(
    'Now changes to plugin sources are picked up after POST /api/plugins/reload — no version bump required.',
  )
}

async function restore(): Promise<void> {
  if (platform() !== 'win32') {
    // biome-ignore lint/suspicious/noConsole:: developer tool
    console.error('dev-link --restore is Windows-only.')
    process.exit(1)
  }

  const version = await readVersion()
  const cacheDir = getCacheDir(version)
  const backupDir = `${cacheDir}.backup`

  if (existsSync(cacheDir) && isJunction(cacheDir)) {
    // rmdir without /S removes the junction itself, not the target
    const r = spawnSync('cmd', ['/c', 'rmdir', cacheDir], { encoding: 'utf8' })
    if (r.status !== 0) {
      // biome-ignore lint/suspicious/noConsole:: developer tool
      console.error(`rmdir failed: ${r.stderr || r.stdout}`)
      process.exit(2)
    }
    // biome-ignore lint/suspicious/noConsole:: developer tool
    console.log(`Removed junction: ${cacheDir}`)
  }

  if (existsSync(backupDir)) {
    if (existsSync(cacheDir)) {
      await rm(cacheDir, { recursive: true, force: true })
    }
    await rename(backupDir, cacheDir)
    // biome-ignore lint/suspicious/noConsole:: developer tool
    console.log(`Restored cache: ${backupDir} -> ${cacheDir}`)
  } else {
    // biome-ignore lint/suspicious/noConsole:: developer tool
    console.log(
      `No backup found at ${backupDir}. Cache directory is empty; reinstall via the desktop UI to repopulate.`,
    )
  }
}

// Touch statSync to keep the import even when not directly used in some branches.
void statSync

const mode = process.argv[2] === '--restore' ? 'restore' : 'link'
if (mode === 'link') {
  await link()
} else {
  await restore()
}
