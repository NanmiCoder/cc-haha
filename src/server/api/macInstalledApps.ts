import type { Dirent } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export type InstalledMacApp = {
  bundleId: string
  displayName: string
  path: string
}

type DirectoryEntry = Pick<Dirent, 'name' | 'isDirectory' | 'isSymbolicLink'>

type InstalledAppDependencies = {
  roots?: string[]
  readDirectory?: (root: string) => Promise<DirectoryEntry[]>
  canonicalize?: (candidate: string) => Promise<string>
  readMetadata?: (
    appPath: string,
  ) => Promise<{ bundleId: string; displayName: string } | null>
  maxDepth?: number
  entryLimit?: number
}

const STANDARD_APPLICATION_ROOTS = [
  '/Applications',
  path.join(homedir(), 'Applications'),
  '/System/Applications',
]
const DEFAULT_MAX_DEPTH = 6
const DEFAULT_ENTRY_LIMIT = 10_000

function isDirectChild(root: string, candidate: string): boolean {
  return path.dirname(candidate) === root
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative.length > 0
    && !relative.startsWith(`..${path.sep}`)
    && relative !== '..'
    && !path.isAbsolute(relative)
}

async function readMetadataWithPlutil(
  appPath: string,
): Promise<{ bundleId: string; displayName: string } | null> {
  const plistPath = path.join(appPath, 'Contents', 'Info.plist')
  try {
    const proc = Bun.spawn(
      ['/usr/bin/plutil', '-convert', 'json', '-o', '-', plistPath],
      { stdout: 'pipe', stderr: 'ignore' },
    )
    const stdout = await new Response(proc.stdout).text()
    if (await proc.exited !== 0) return null
    const plist = JSON.parse(stdout) as Record<string, unknown>
    const bundleId = typeof plist.CFBundleIdentifier === 'string'
      ? plist.CFBundleIdentifier.trim()
      : ''
    const configuredName = [
      plist.CFBundleDisplayName,
      plist.CFBundleName,
    ].find(value => typeof value === 'string' && value.trim())
    const displayName = typeof configuredName === 'string'
      ? configuredName.trim()
      : path.basename(appPath, '.app')
    if (!bundleId || !displayName) return null
    return { bundleId, displayName }
  } catch {
    return null
  }
}

/**
 * Enumerate `.app` bundles below standard macOS application roots. Ordinary
 * category/vendor folders are traversed with strict depth/entry limits, but an
 * app bundle is terminal: its Contents/plugins are never scanned. Symlinks,
 * canonical paths outside the root and malformed plists are ignored.
 */
export async function listInstalledMacApps(
  deps: InstalledAppDependencies = {},
): Promise<InstalledMacApp[]> {
  const roots = deps.roots ?? STANDARD_APPLICATION_ROOTS
  const readDirectory = deps.readDirectory
    ?? (async root => await readdir(root, { withFileTypes: true }))
  const canonicalize = deps.canonicalize ?? realpath
  const readMetadata = deps.readMetadata ?? readMetadataWithPlutil
  const maxDepth = deps.maxDepth ?? DEFAULT_MAX_DEPTH
  const entryLimit = deps.entryLimit ?? DEFAULT_ENTRY_LIMIT
  const byBundleId = new Map<string, InstalledMacApp>()

  for (const configuredRoot of roots) {
    const root = path.resolve(configuredRoot)
    let canonicalRoot: string
    try {
      canonicalRoot = await canonicalize(root)
    } catch {
      continue
    }

    const queue: Array<{ directory: string; depth: number }> = [
      { directory: canonicalRoot, depth: 0 },
    ]
    const seenDirectories = new Set<string>()
    let entriesSeen = 0

    while (queue.length > 0 && entriesSeen < entryLimit) {
      const next = queue.shift()
      if (!next || seenDirectories.has(next.directory)) continue
      seenDirectories.add(next.directory)

      let entries: DirectoryEntry[]
      try {
        entries = await readDirectory(next.directory)
      } catch {
        continue
      }

      for (const entry of entries) {
        entriesSeen++
        if (entriesSeen > entryLimit) break
        if (entry.isSymbolicLink() || !entry.isDirectory()) continue
        const candidate = path.resolve(next.directory, entry.name)
        if (!isDirectChild(next.directory, candidate)) continue

        let canonicalCandidate: string
        try {
          canonicalCandidate = await canonicalize(candidate)
        } catch {
          continue
        }
        if (!isContained(canonicalRoot, canonicalCandidate)) continue

        if (!entry.name.endsWith('.app')) {
          if (next.depth < maxDepth) {
            queue.push({ directory: canonicalCandidate, depth: next.depth + 1 })
          }
          continue
        }

        const metadata = await readMetadata(canonicalCandidate)
        if (!metadata?.bundleId || !metadata.displayName) continue
        if (byBundleId.has(metadata.bundleId)) continue
        byBundleId.set(metadata.bundleId, {
          bundleId: metadata.bundleId,
          displayName: metadata.displayName,
          path: canonicalCandidate,
        })
      }
    }
  }

  return [...byBundleId.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName)
      || a.bundleId.localeCompare(b.bundleId))
}
