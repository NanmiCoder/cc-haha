import { readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'

export type ProjectIdentitySnapshot = { roots: string[]; revision: string }
const snapshots = new Map<string, { signature: string; snapshot: ProjectIdentitySnapshot }>()

/** Older preferences register no independent roots; folder aliases never imply one. */
export function normalizeExplicitProjectRoots(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((root): root is string => typeof root === 'string' && path.isAbsolute(root) && !root.includes('\0')))].slice(0, 2000)
    : []
}

/** Match path components, taking the nearest explicitly registered project. */
export function findExplicitProjectRoot(candidate: string, roots: readonly string[], paths: Pick<typeof path, 'relative' | 'sep' | 'isAbsolute'> = path): string | null {
  let selected: string | null = null
  for (const root of roots) {
    const relative = paths.relative(root, candidate)
    if (relative === '' || (relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative))) {
      if (!selected || root.length > selected.length) selected = root
    }
  }
  return selected
}

/** Project identity reads share one parsed preference snapshot across all rows.
 * Revision tracks only roots so unrelated preference edits do not expire history. */
export function readProjectIdentity(configDir: string): ProjectIdentitySnapshot {
  const filePath = path.join(configDir, 'cc-haha', 'desktop-ui.json')
  let signature: string
  try {
    const stat = statSync(filePath)
    signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { roots: [], revision: '[]' }
  }
  const previous = snapshots.get(filePath)
  if (previous?.signature === signature) return previous.snapshot
  let roots: string[] = []
  try {
    const record = JSON.parse(readFileSync(filePath, 'utf8'))
    roots = normalizeExplicitProjectRoots(record?.explicitProjectRoots)
  } catch (error) {
    // Invalid UI state is recovered by its owning service. Reads of transcripts
    // keep the legacy grouping while that happens; they never rewrite preferences.
    if (!(error instanceof SyntaxError)) throw error
  }
  const snapshot = { roots, revision: JSON.stringify(roots) }
  snapshots.delete(filePath)
  snapshots.set(filePath, { signature, snapshot })
  while (snapshots.size > 16) snapshots.delete(snapshots.keys().next().value!)
  return snapshot
}
