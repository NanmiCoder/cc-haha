#!/usr/bin/env bun
/**
 * Release script for Claude Code Haha Desktop
 *
 * Usage:
 *   bun run scripts/release.ts patch       # 0.1.0 → 0.1.1
 *   bun run scripts/release.ts minor       # 0.1.0 → 0.2.0
 *   bun run scripts/release.ts major       # 0.1.0 → 1.0.0
 *   bun run scripts/release.ts 2.0.0       # explicit version
 *   bun run scripts/release.ts patch --dry  # preview without changes
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dir, '..')

const VERSION_FILES = [
  {
    path: path.join(root, 'desktop/package.json'),
    update(content: string, version: string) {
      return content.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`)
    },
  },
  {
    path: path.join(root, 'desktop/src-tauri/tauri.conf.json'),
    update(content: string, version: string) {
      return content.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`)
    },
  },
  {
    path: path.join(root, 'desktop/src-tauri/Cargo.toml'),
    update(content: string, version: string) {
      return content.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`)
    },
  },
]

function getCurrentVersion(): string {
  const tauriConf = JSON.parse(
    readFileSync(path.join(root, 'desktop/src-tauri/tauri.conf.json'), 'utf-8'),
  )
  return tauriConf.version
}

function getReleaseNotesPath(version: string): string {
  return path.join(root, 'release-notes', `v${version}.md`)
}

function bumpVersion(current: string, bump: string): string {
  if (/^\d+\.\d+\.\d+$/.test(bump)) {
    return bump
  }

  const [major, minor, patch] = current.split('.').map(Number)

  switch (bump) {
    case 'patch':
      return `${major}.${minor}.${patch + 1}`
    case 'minor':
      return `${major}.${minor + 1}.0`
    case 'major':
      return `${major + 1}.0.0`
    default:
      console.error(`Invalid bump type: ${bump}`)
      console.error('Usage: bun run scripts/release.ts <patch|minor|major|x.y.z> [--dry]')
      process.exit(1)
  }
}

async function run(cmd: string[], cwd = root) {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`Command failed: ${cmd.join(' ')}\n${stderr || stdout}`)
  }
  return stdout.trim()
}

// ── Main ──────────────────────────────────────────────

const args = process.argv.slice(2)
const dryRun = args.includes('--dry')
const bumpArg = args.find((a) => a !== '--dry')

if (!bumpArg) {
  console.error('Usage: bun run scripts/release.ts <patch|minor|major|x.y.z> [--dry]')
  process.exit(1)
}

const current = getCurrentVersion()
const next = bumpVersion(current, bumpArg)
const releaseNotesPath = getReleaseNotesPath(next)

console.log(`\n  Version: ${current} → ${next}`)
console.log(`  Tag:     v${next}`)
console.log(`  Notes:   ${path.relative(root, releaseNotesPath)}`)
console.log(`  Dry run: ${dryRun}\n`)

if (dryRun) {
  console.log('Files that would be updated:')
  for (const file of VERSION_FILES) {
    console.log(`  - ${path.relative(root, file.path)}`)
  }
  console.log(`  - ${path.relative(root, releaseNotesPath)} ${existsSync(releaseNotesPath) ? '(present)' : '(missing)'}`)
  process.exit(0)
}

if (!existsSync(releaseNotesPath)) {
  console.error(`Missing release notes file: ${path.relative(root, releaseNotesPath)}`)
  console.error(`Create it before releasing so GitHub Release can use it automatically.`)
  process.exit(1)
}

// Update version in all files
for (const file of VERSION_FILES) {
  const content = readFileSync(file.path, 'utf-8')
  const updated = file.update(content, next)
  writeFileSync(file.path, updated)
  console.log(`  Updated: ${path.relative(root, file.path)}`)
}

// Regenerate Cargo.lock
console.log('\n  Updating Cargo.lock...')
await run(['cargo', 'generate-lockfile'], path.join(root, 'desktop/src-tauri'))

// Git commit + tag
console.log('  Creating git commit...')
await run([
  'git',
  'add',
  'desktop/package.json',
  'desktop/src-tauri/tauri.conf.json',
  'desktop/src-tauri/Cargo.toml',
  'desktop/src-tauri/Cargo.lock',
  path.relative(root, releaseNotesPath),
])
await run(['git', 'commit', '-m', `release: v${next}`])
await run(['git', 'tag', '-a', `v${next}`, '-m', `Release v${next}`])

console.log(`\n  Done! Created commit and tag v${next}`)
console.log(`\n  To trigger the build:\n    git push origin main --tags\n`)
