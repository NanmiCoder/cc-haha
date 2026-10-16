#!/usr/bin/env bun
/**
 * Release script for Claude Code Haha Desktop
 *
 * main is protected (the PR gate must pass, admins included), so a release is
 * two steps: a release PR, then a tag on the merged commit.
 *
 * Usage:
 *   bun run scripts/release.ts patch       # 0.1.0 → 0.1.1, on branch release/v0.1.1
 *   bun run scripts/release.ts minor       # 0.1.0 → 0.2.0
 *   bun run scripts/release.ts major       # 0.1.0 → 1.0.0
 *   bun run scripts/release.ts 2.0.0       # explicit version
 *   bun run scripts/release.ts patch --dry # preview without changes
 *   bun run scripts/release.ts --tag 0.1.1 # after the release PR merged: tag origin/main
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const VERSION_FILES = [
  {
    path: 'desktop/package.json',
    update(content: string, version: string) {
      return content.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`)
    },
  },
]

const USAGE = 'Usage: bun run scripts/release.ts <patch|minor|major|x.y.z> [--dry] | --tag <x.y.z>'

export function bumpVersion(current: string, bump: string): string | null {
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
      return null
  }
}

async function run(cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`Command failed: ${cmd.join(' ')}\n${stderr || stdout}`)
  }
  return stdout.trim()
}

function releaseNotesPath(version: string) {
  return path.join('release-notes', `v${version}.md`)
}

/** Step 1: bump the version and commit it with its notes on release/v<version>. */
export async function prepareRelease(root: string, bumpArg: string, options: { dryRun?: boolean, log?: (line: string) => void } = {}) {
  const log = options.log ?? console.log
  const current = JSON.parse(readFileSync(path.join(root, 'desktop/package.json'), 'utf-8')).version as string
  const next = bumpVersion(current, bumpArg)
  if (!next) throw new Error(`Invalid bump type: ${bumpArg}\n${USAGE}`)
  const notes = releaseNotesPath(next)
  const branch = `release/v${next}`

  log(`\n  Version: ${current} → ${next}`)
  log(`  Branch:  ${branch}`)
  log(`  Notes:   ${notes}`)
  log(`  Dry run: ${Boolean(options.dryRun)}\n`)

  if (options.dryRun) {
    log('Files that would be updated:')
    for (const file of VERSION_FILES) log(`  - ${file.path}`)
    log(`  - ${notes} ${existsSync(path.join(root, notes)) ? '(present)' : '(missing)'}`)
    return { version: next, branch, committed: false }
  }

  if (!existsSync(path.join(root, notes))) {
    throw new Error(`Missing release notes file: ${notes}\nCreate it before releasing so GitHub Release can use it automatically.`)
  }

  await run(['git', 'switch', '-c', branch], root)
  for (const file of VERSION_FILES) {
    const target = path.join(root, file.path)
    writeFileSync(target, file.update(readFileSync(target, 'utf-8'), next))
    log(`  Updated: ${file.path}`)
  }
  await run(['git', 'add', ...VERSION_FILES.map(file => file.path), notes], root)
  await run(['git', 'commit', '-m', `release: v${next}`], root)

  log(`\n  Done! Committed v${next} on ${branch}.`)
  log('\n  Open the release PR and merge it once PR Quality is green:')
  log(`    git push -u origin ${branch}`)
  log(`    gh pr create --base main --head ${branch} --title "release: v${next}" --body-file ${notes}`)
  log('\n  Then tag the merged commit:')
  log(`    bun run scripts/release.ts --tag ${next}\n`)
  return { version: next, branch, committed: true }
}

/** Step 2: tag the merged release commit on origin/main. Only the tag is pushed. */
export async function tagRelease(root: string, version: string, options: { ref?: string, fetch?: boolean, log?: (line: string) => void } = {}) {
  const log = options.log ?? console.log
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid version: ${version}\n${USAGE}`)
  const ref = options.ref ?? 'origin/main'
  if (options.fetch ?? true) await run(['git', 'fetch', 'origin', 'main'], root)

  const commit = await run(['git', 'rev-parse', `${ref}^{commit}`], root)
  const merged = JSON.parse(await run(['git', 'show', `${commit}:desktop/package.json`], root)).version
  if (merged !== version) {
    throw new Error(`${ref} has desktop version ${merged}, not ${version}. Merge the release PR first.`)
  }
  await run(['git', 'cat-file', '-e', `${commit}:${releaseNotesPath(version)}`], root).catch(() => {
    throw new Error(`${ref} has no ${releaseNotesPath(version)}.`)
  })

  await run(['git', 'tag', '-a', `v${version}`, commit, '-m', `Release v${version}`], root)
  log(`\n  Tagged ${commit.slice(0, 9)} as v${version}.`)
  log(`\n  Push the tag (main itself is not pushed):\n    git push origin v${version}\n`)
  return { tag: `v${version}`, commit }
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, '..')
  const args = process.argv.slice(2)
  try {
    const tagIndex = args.indexOf('--tag')
    if (tagIndex !== -1) {
      const version = args[tagIndex + 1]
      if (!version) throw new Error(USAGE)
      await tagRelease(root, version)
    } else {
      const bumpArg = args.find((a) => a !== '--dry')
      if (!bumpArg) throw new Error(USAGE)
      await prepareRelease(root, bumpArg, { dryRun: args.includes('--dry') })
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
