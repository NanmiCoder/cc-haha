import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type { Dir, Dirent, Stats } from 'node:fs'

// Per subscription: one non-overlapping timer, four chunks per tick, 256
// direct entries per chunk, eight concurrent stats, at most 64 open scans.
export const WORKSPACE_WATCH_RECONCILIATION = {
  intervalMs: 250,
  directoriesPerTick: 4,
  entriesPerDirectory: 256,
  statConcurrency: 8,
} as const

export interface WorkspaceWatchState {
  identity: string | null
  entries: Map<string, string>
  large: boolean
  fingerprint: string
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function signature(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
}

const HASH_MASK = (1n << 256n) - 1n

/** Bounded metadata chunks: no recursion, file content or entry symlink following. */
export function createWorkspaceWatchScan(
  directory: string,
  signal: AbortSignal,
  ignore: (name: string) => boolean,
) {
  let handle: Dir | undefined
  let next: Dirent | null | undefined
  let busy = false
  let closed = false
  let count = 0
  let digest = 0n
  const state: WorkspaceWatchState = { identity: null, entries: new Map(), large: false, fingerprint: '' }
  const closeHandle = async () => {
    const current = handle
    handle = undefined
    if (current) await current.close()
  }
  const close = async () => {
    closed = true
    // An active read closes in finally; never race Dir.read with Dir.close.
    if (!busy) await closeHandle()
  }
  const readChunk = async (): Promise<WorkspaceWatchState | null> => {
    signal.throwIfAborted()
    if (closed || busy) throw new Error('Workspace directory scan is closed or already running')
    busy = true
    try {
      if (!handle) {
        try {
          const stat = await fs.lstat(directory)
          signal.throwIfAborted()
          if (!stat.isDirectory()) throw new Error(`Watch path is no longer a directory: ${directory}`)
          state.identity = `${stat.dev}:${stat.ino}`
          handle = await fs.opendir(directory)
          signal.throwIfAborted()
          // Dir has no public fd/fstat API. Recheck identity after open and
          // before reading; service also revalidates canonical paths per chunk.
          const opened = await fs.lstat(directory)
          if (!opened.isDirectory() || `${opened.dev}:${opened.ino}` !== state.identity) {
            throw new Error(`Watch directory changed while opening: ${directory}`)
          }
        } catch (error) {
          if (!missing(error)) throw error
          state.identity = null
          closed = true
          return state
        }
      }
      const names: string[] = []
      for (let scanned = 0; scanned < WORKSPACE_WATCH_RECONCILIATION.entriesPerDirectory; scanned++) {
        signal.throwIfAborted()
        const entry = next === undefined ? await handle.read() : next
        next = undefined
        if (!entry) { next = null; break }
        if (!ignore(entry.name)) names.push(entry.name)
      }
      for (let offset = 0; offset < names.length; offset += WORKSPACE_WATCH_RECONCILIATION.statConcurrency) {
        signal.throwIfAborted()
        await Promise.allSettled(names.slice(offset, offset + WORKSPACE_WATCH_RECONCILIATION.statConcurrency).map(async name => {
          try {
            const stat = await fs.lstat(path.join(directory, name))
            signal.throwIfAborted()
            const value = signature(stat)
            // Commutative 256-bit sum makes enumeration order irrelevant.
            digest = (digest + BigInt(`0x${createHash('sha256').update(JSON.stringify([name, value])).digest('hex')}`)) & HASH_MASK
            count++
            if (count <= WORKSPACE_WATCH_RECONCILIATION.entriesPerDirectory) state.entries.set(name, value)
            else { state.large = true; state.entries.clear() }
          } catch (error) {
            if (!missing(error)) throw error
          }
        })).then(results => {
          const failure = results.find(result => result.status === 'rejected')
          if (failure?.status === 'rejected') throw failure.reason
        })
      }
      signal.throwIfAborted()
      if (next === undefined) next = await handle.read()
      if (next) return null
      state.fingerprint = `${count}:${digest.toString(16)}`
      closed = true
      return state
    } catch (error) {
      closed = true
      throw error
    } finally {
      busy = false
      if (closed || signal.aborted) {
        await closeHandle()
      }
    }
  }
  return { readChunk, close }
}

/** Initial baseline completes before ready, with the same bounded IO concurrency. */
export async function readWorkspaceWatchState(directory: string, signal: AbortSignal, ignore: (name: string) => boolean) {
  const scan = createWorkspaceWatchScan(directory, signal, ignore)
  try {
    for (;;) {
      const state = await scan.readChunk()
      if (state) return state
    }
  } finally {
    await scan.close()
  }
}

export function changedWorkspaceWatchEntries(before: WorkspaceWatchState, after: WorkspaceWatchState): string[] {
  // Large directories carry a bounded digest; emit one coarse change only
  // after a completed scan differs from its previous digest.
  if (before.large || after.large) return []
  const names = new Set([...before.entries.keys(), ...after.entries.keys()])
  return [...names].filter(name => before.entries.get(name) !== after.entries.get(name))
}
