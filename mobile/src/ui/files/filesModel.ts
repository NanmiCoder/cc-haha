import { splitPath, type BadgeStatus } from '../../core/changesView'
import { plural } from '../../core/plural'

/* Pure logic of the files page (session "…" menu → Files): modified list, directory tree expansion, search. */

export type FilesTab = 'changed' | 'all'

/** Route param tab: only `all` goes to "All files", everything else (including absent) goes to "Modified". */
export const parseFilesTab = (value?: string): FilesTab => (value === 'all' ? 'all' : 'changed')

/* ───────────── Modified ───────────── */

export type ChangedRow = {
  path: string
  name: string
  /** Directory part, keeping the trailing slash; empty string for files at the root. */
  dir: string
  /** Empty while the diff is not loaded yet, rather than guessing "modified". */
  badge?: BadgeStatus
  added?: number
  removed?: number
}

/** Checkpoints only give paths; M/A/D and line counts come from per-file diffs, using whatever has been read. */
export function changedRows(
  paths: readonly string[],
  summary: (path: string) => { badge: BadgeStatus; added: number; removed: number } | undefined
): ChangedRow[] {
  return paths.map((path) => {
    const { name, dir } = splitPath(path)
    const known = summary(path)
    return { path, name, dir, badge: known?.badge, added: known?.added, removed: known?.removed }
  })
}

/** Matches only when every space-separated word appears in the path (case-insensitive); an empty query matches everything. */
export function matchesFile(path: string, query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const haystack = path.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

export const filterChanged = (rows: readonly ChangedRow[], query: string) =>
  rows.filter((row) => matchesFile(row.path, query))

/** Screen reader text for the row: file name, status, additions/deletions. */
export function changedRowLabel(row: ChangedRow) {
  const status = row.badge
    ? { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', '?': 'untracked' }[row.badge]
    : ''
  const stats = [row.added ? `${plural(row.added, 'line')} added` : '', row.removed ? `${plural(row.removed, 'line')} deleted` : '']
    .filter(Boolean)
    .join(', ')
  return [row.path, status, stats].filter(Boolean).join(', ')
}

/* ───────────── All files ───────────── */

export type DirEntry = { name: string; path: string; isDirectory: boolean }

/** Result of reading a directory: loading, loaded (possibly empty), or error. */
export type DirState = 'loading' | { entries: DirEntry[] } | { error: string }

/** Normalize the `/workspace/tree` response into DirState; any state other than ok counts as an error. */
export function dirState(response: {
  state?: string
  entries?: DirEntry[]
  error?: string
}): DirState {
  if (response.state !== 'ok' || !Array.isArray(response.entries))
    return { error: response.error || 'Directory cannot be read' }
  return { entries: response.entries }
}

/** Folders first, each sorted by name (case-insensitive, numbers by value). */
export function sortEntries(entries: readonly DirEntry[]) {
  return [...entries].sort(
    (a, b) =>
      Number(b.isDirectory) - Number(a.isDirectory) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  )
}

export type TreeItem =
  | { kind: 'entry'; key: string; entry: DirEntry; depth: number; open: boolean }
  | {
      kind: 'note'
      key: string
      depth: number
      text: string
      tone: 'ink3' | 'err'
      /** Directory to retry reading when tapping an error row. */
      retry?: string
    }

/**
 * Flatten read directories into a list by expansion state: an expanded folder is followed by its contents, 
 * with loading / error / empty folder each taking a note row, indent deepening with level.
 */
export function treeItems(
  dirs: Readonly<Record<string, DirState>>,
  open: ReadonlySet<string>,
  root = ''
): TreeItem[] {
  const items: TreeItem[] = []
  const walk = (path: string, depth: number) => {
    const state = dirs[path]
    if (!state || state === 'loading') {
      items.push({ kind: 'note', key: `${path}\u0000loading`, depth, text: 'Loading…', tone: 'ink3' })
      return
    }
    if ('error' in state) {
      items.push({
        kind: 'note',
        key: `${path}\u0000error`,
        depth,
        text: `${state.error}, tap to retry`,
        tone: 'err',
        retry: path,
      })
      return
    }
    if (!state.entries.length) {
      items.push({ kind: 'note', key: `${path}\u0000empty`, depth, text: 'Empty folder', tone: 'ink3' })
      return
    }
    for (const entry of sortEntries(state.entries)) {
      const expanded = entry.isDirectory && open.has(entry.path)
      items.push({ kind: 'entry', key: entry.path, entry, depth, open: expanded })
      if (expanded) walk(entry.path, depth + 1)
    }
  }
  walk(root, 0)
  return items
}

/* ───────────── Search results ───────────── */

export type SearchRow = { path: string; name: string; dir: string }

/** Server search only returns files; organize into file name + directory. */
export function searchRows(entries: readonly DirEntry[]): SearchRow[] {
  return entries
    .filter((entry) => !entry.isDirectory)
    .map((entry) => ({ path: entry.path, ...splitPath(entry.path) }))
}

/** Trim leading and trailing whitespace before searching; empty queries send no request. */
export const searchQuery = (value: string) => value.trim()
