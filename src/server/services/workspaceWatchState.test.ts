import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createWorkspaceWatchScan, readWorkspaceWatchState, WORKSPACE_WATCH_RECONCILIATION } from './workspaceWatchState.js'

let root: string
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-watch-state-')))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

it('caps each incremental chunk and parallel metadata operations, retaining a bounded metadata map', async () => {
  const limit = WORKSPACE_WATCH_RECONCILIATION.entriesPerDirectory
  await Promise.all(Array.from({ length: limit + 1 }, (_, index) => fs.writeFile(path.join(root, `${index}.txt`), 'fixture')))
  const nativeStat = fs.lstat
  let active = 0
  let peak = 0
  let total = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const statSpy = spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === root) return nativeStat(...args)
    total++
    active++
    peak = Math.max(peak, active)
    if (active === WORKSPACE_WATCH_RECONCILIATION.statConcurrency) started()
    try {
      await gate
      return await nativeStat(...args)
    } finally {
      active--
    }
  }) as typeof fs.lstat)
  try {
    const scan = createWorkspaceWatchScan(root, new AbortController().signal, () => false)
    const pending = scan.readChunk()
    await entered
    expect(total).toBe(WORKSPACE_WATCH_RECONCILIATION.statConcurrency)
    release()
    expect(await pending).toBeNull()
    expect(total).toBe(limit)
    expect(peak).toBe(WORKSPACE_WATCH_RECONCILIATION.statConcurrency)
    const result = await scan.readChunk()
    expect(result!.large).toBe(true)
    expect(result!.entries.size).toBe(0)
    expect(total).toBe(limit + 1)
    expect(result!.fingerprint).toStartWith(`${limit + 1}:`)
    await scan.close()
  } finally {
    release()
    statSpy.mockRestore()
  }
})

it('does not descend into a directory or follow an entry symlink', async () => {
  await fs.mkdir(path.join(root, 'nested'))
  await fs.writeFile(path.join(root, 'nested/content.txt'), 'nested')
  await fs.symlink(path.join(root, 'nested'), path.join(root, 'alias'))
  await fs.mkdir(path.join(root, '.git'))
  const result = await readWorkspaceWatchState(root, new AbortController().signal, name => name === '.git')
  expect([...result.entries.keys()].sort()).toEqual(['alias', 'nested'])
  expect(result.large).toBe(false)
})
