import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'
import { WorkspaceService } from '../services/workspaceService.js'

const cleanupDirs = new Set<string>()

function trackDir(dir: string): string {
  cleanupDirs.add(dir)
  return dir
}

async function makeTempDir(prefix: string): Promise<string> {
  return trackDir(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  })
}

async function initCommittedRepo(prefix: string): Promise<string> {
  const repoDir = await makeTempDir(prefix)
  git(repoDir, 'init')
  git(repoDir, 'config', 'user.email', 'repro-1989@example.com')
  git(repoDir, 'config', 'user.name', 'Repro 1989')
  await fs.writeFile(path.join(repoDir, 'README.md'), 'initial\n')
  git(repoDir, 'add', 'README.md')
  git(repoDir, 'commit', '-m', 'initial')
  return repoDir
}

afterEach(async () => {
  for (const dir of cleanupDirs) {
    await fs.rm(dir, { recursive: true, force: true })
  }
  cleanupDirs.clear()
})

describe('Issue #1989 large-repo workspace bottlenecks (repro)', () => {
  it('Bottleneck 2a: getStatus() should handle >2MB git status output without overflowing MAX_GIT_BUFFER_BYTES or leaking raw stdout into error', async () => {
    const repoDir = await initCommittedRepo('repro-1989-git-maxbuffer-')

    // Deep nested untracked directory (~800 bytes per relative path) so 2,600 untracked files
    // generate >2.1 MB of `git status --porcelain=v1 -z --untracked-files=all` output quickly,
    // reproducing the 75k-entry large-repo failure without creating 75k files on disk.
    const nestedDir = path.join(
      repoDir,
      'd'.repeat(100),
      'd'.repeat(100),
      'd'.repeat(100),
      'd'.repeat(100),
      'd'.repeat(100),
      'd'.repeat(100),
      'd'.repeat(100),
      'd'.repeat(100),
    )
    await fs.mkdir(nestedDir, { recursive: true })

    const fileCount = 2_600
    for (let batch = 0; batch < fileCount; batch += 200) {
      const writes: Promise<void>[] = []
      const end = Math.min(batch + 200, fileCount)
      for (let i = batch; i < end; i++) {
        writes.push(fs.writeFile(path.join(nestedDir, `untracked-${String(i).padStart(5, '0')}.txt`), 'x\n'))
      }
      await Promise.all(writes)
    }

    const service = new WorkspaceService(async (sessionId) => sessionId === 'session-1' ? repoDir : null)
    const startedAt = performance.now()
    const result = await service.getStatus('session-1')
    const elapsedMs = Math.round(performance.now() - startedAt)

    console.info(
      `[repro-1989][2a] files=${fileCount} state=${result.state} changedFiles=${result.changedFiles.length} errorLength=${result.error?.length ?? 0} elapsedMs=${elapsedMs}`,
    )

    // Expected healthy behavior: large untracked trees must not fail getStatus() with a ~2MB stdout dump.
    expect(result.error?.length ?? 0).toBeLessThan(4_096)
    expect(result.state).toBe('ok')
  }, 30_000)

  it('Bottleneck 2b: getStatus() should bound concurrent realpath/stat/readFile calls for untracked files instead of unbounded Promise.all', async () => {
    const repoDir = await initCommittedRepo('repro-1989-unbounded-io-')
    const batchDir = path.join(repoDir, 'untracked')
    await fs.mkdir(batchDir, { recursive: true })

    const fileCount = 1_200
    for (let batch = 0; batch < fileCount; batch += 200) {
      const writes: Promise<void>[] = []
      const end = Math.min(batch + 200, fileCount)
      for (let i = batch; i < end; i++) {
        writes.push(fs.writeFile(path.join(batchDir, `f-${String(i).padStart(4, '0')}.txt`), 'line1\nline2\n'))
      }
      await Promise.all(writes)
    }

    const realRealpath = fs.realpath.bind(fs)
    const realStat = fs.stat.bind(fs)
    const realReadFile = fs.readFile.bind(fs)

    let activeRealpath = 0
    let peakRealpath = 0
    let totalRealpath = 0

    let activeStat = 0
    let peakStat = 0
    let totalStat = 0

    let activeReadFile = 0
    let peakReadFile = 0
    let totalReadFile = 0

    const realpathSpy = spyOn(fs, 'realpath').mockImplementation((async (...args: Parameters<typeof fs.realpath>) => {
      totalRealpath++
      activeRealpath++
      if (activeRealpath > peakRealpath) peakRealpath = activeRealpath
      try {
        return await realRealpath(...args)
      } finally {
        activeRealpath--
      }
    }) as typeof fs.realpath)

    const statSpy = spyOn(fs, 'stat').mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
      totalStat++
      activeStat++
      if (activeStat > peakStat) peakStat = activeStat
      try {
        return await realStat(...args)
      } finally {
        activeStat--
      }
    }) as typeof fs.stat)

    const readFileSpy = spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      totalReadFile++
      activeReadFile++
      if (activeReadFile > peakReadFile) peakReadFile = activeReadFile
      try {
        return await realReadFile(...args)
      } finally {
        activeReadFile--
      }
    }) as typeof fs.readFile)

    try {
      const service = new WorkspaceService(async (sessionId) => sessionId === 'session-1' ? repoDir : null)
      const startedAt = performance.now()
      const result = await service.getStatus('session-1')
      const elapsedMs = Math.round(performance.now() - startedAt)

      console.info(
        `[repro-1989][2b] files=${fileCount} state=${result.state} changedFiles=${result.changedFiles.length} ` +
        `peakRealpath=${peakRealpath} totalRealpath=${totalRealpath} ` +
        `peakStat=${peakStat} totalStat=${totalStat} ` +
        `peakReadFile=${peakReadFile} totalReadFile=${totalReadFile} elapsedMs=${elapsedMs}`,
      )

      expect(result.state).toBe('ok')
      // Expected healthy behavior: per-file fs I/O concurrency must be bounded (e.g. <= 64).
      expect(peakRealpath).toBeLessThanOrEqual(64)
      expect(peakStat).toBeLessThanOrEqual(64)
      expect(peakReadFile).toBeLessThanOrEqual(64)
    } finally {
      realpathSpy.mockRestore()
      statSpy.mockRestore()
      readFileSpy.mockRestore()
    }
  }, 30_000)

  it('Bottleneck 3a: readTree() should bound returned entries for oversized directories', async () => {
    const workDir = await makeTempDir('repro-1989-huge-tree-')
    const entryCount = 5_000

    for (let batch = 0; batch < entryCount; batch += 250) {
      const writes: Promise<void>[] = []
      const end = Math.min(batch + 250, entryCount)
      for (let i = batch; i < end; i++) {
        writes.push(fs.writeFile(path.join(workDir, `item-${String(i).padStart(5, '0')}.txt`), ''))
      }
      await Promise.all(writes)
    }

    const service = new WorkspaceService(async (sessionId) => sessionId === 'session-1' ? workDir : null)
    const startedAt = performance.now()
    const result = await service.readTree('session-1', '')
    const elapsedMs = Math.round(performance.now() - startedAt)

    console.info(
      `[repro-1989][3a] diskEntries=${entryCount} state=${result.state} returnedEntries=${result.entries.length} elapsedMs=${elapsedMs}`,
    )

    expect(result.state).toBe('ok')
    // Expected healthy behavior: readTree() caps or paginates giant directories instead of returning all 5,000 entries unfiltered.
    expect(result.entries.length).toBeLessThanOrEqual(1_000)
  }, 30_000)
})
