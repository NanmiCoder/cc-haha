import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  getScheduledRunReadModelDiagnosticsForTests,
  projectScheduledRunsAfterCanonicalWrite,
  readScheduledRunPage,
  resetScheduledRunReadModelForTests,
  setScheduledRunFingerprintAfterInitialStatHookForTests,
  setScheduledRunProjectionBeforeCommitHookForTests,
} from './scheduledRunReadModel.js'
import { getScheduledRunIndexDatabasePath } from './scheduledRunIndex.js'
import { CronScheduler } from '../cronScheduler.js'

let tmpDir: string | undefined
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalLocalIndexMode = process.env.CC_HAHA_LOCAL_INDEX
const exactFileTime = new Date(1_700_000_000_000)

afterEach(async () => {
  await resetScheduledRunReadModelForTests()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalLocalIndexMode === undefined) delete process.env.CC_HAHA_LOCAL_INDEX
  else process.env.CC_HAHA_LOCAL_INDEX = originalLocalIndexMode
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
  tmpDir = undefined
})

describe('scheduled run read model', () => {
  test('parses a changed canonical file once and keeps warm summary polls off the JSON hot path', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-run-read-model-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    const sourcePath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const largeOutput = 'x'.repeat(512 * 1024)
    await fs.writeFile(sourcePath, JSON.stringify({ runs: [{
      id: 'run-1',
      taskId: 'task-1',
      taskName: 'Task',
      startedAt: '2026-07-15T00:00:00.000Z',
      status: 'completed',
      prompt: 'prompt',
      output: largeOutput,
    }] }))

    const first = await readScheduledRunPage(sourcePath, { summaryOnly: true, limit: 10 })
    const second = await readScheduledRunPage(sourcePath, { summaryOnly: true, limit: 10 })

    expect(first?.runs[0]).toMatchObject({ hasOutput: true, hasError: false })
    for (const field of [
      'taskName',
      'prompt',
      'output',
      'error',
      'outputPreview',
      'errorPreview',
    ]) {
      expect(first?.runs[0]).not.toHaveProperty(field)
    }
    expect(second?.runs).toEqual(first?.runs)
    expect(getScheduledRunReadModelDiagnosticsForTests()).toEqual({
      canonicalReadCount: 1,
      rebuildCount: 1,
    })

    await fs.writeFile(sourcePath, JSON.stringify({ runs: [] }))
    expect((await readScheduledRunPage(sourcePath, { summaryOnly: true }))?.runs).toEqual([])
    expect(getScheduledRunReadModelDiagnosticsForTests()).toEqual({
      canonicalReadCount: 2,
      rebuildCount: 2,
    })
  })

  test('falls back to the canonical file when the independent database cannot open', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-run-read-model-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CC_HAHA_LOCAL_INDEX = 'on'
    const sourcePath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const canonical = { runs: [{
      id: 'canonical-run',
      taskId: 'task-1',
      taskName: 'Task',
      startedAt: '2026-07-15T00:00:00.000Z',
      status: 'completed' as const,
      prompt: 'prompt',
      output: 'canonical output',
    }] }
    await fs.writeFile(sourcePath, JSON.stringify(canonical))
    const dbPath = path.join(tmpDir, 'cc-haha', 'db', 'scheduled-runs-v1.sqlite')
    await fs.mkdir(dbPath, { recursive: true })
    const unrelated = path.join(tmpDir, 'cc-haha', 'db', 'trace-index-v1.sqlite')
    await fs.writeFile(unrelated, 'trace-owned-data')

    const scheduler = new CronScheduler()
    expect(await scheduler.getRecentRuns()).toEqual(canonical.runs)
    expect(await fs.readFile(sourcePath, 'utf8')).toBe(JSON.stringify(canonical))
    expect(await fs.readFile(unrelated, 'utf8')).toBe('trace-owned-data')
  })

  test('falls back within the foreground budget on first busy and stays near-immediate during cooldown', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-run-read-model-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CC_HAHA_LOCAL_INDEX = 'on'
    const sourcePath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const serialize = (id: string) => JSON.stringify({ runs: [{
      id,
      taskId: 'task-1',
      taskName: 'Private task name',
      startedAt: '2026-07-15T00:00:00.000Z',
      status: 'completed',
      prompt: 'private prompt',
    }] })
    await fs.writeFile(sourcePath, serialize('initial'))
    const scheduler = new CronScheduler()
    await scheduler.getRunsPage({ summaryOnly: true })

    const locker = new Database(getScheduledRunIndexDatabasePath())
    locker.exec('BEGIN IMMEDIATE')
    await fs.writeFile(sourcePath, serialize('busy-fallback'))
    try {
      const firstStartedAt = performance.now()
      const first = await scheduler.getRunsPage({ summaryOnly: true })
      const firstElapsedMs = performance.now() - firstStartedAt
      const secondStartedAt = performance.now()
      const second = await scheduler.getRunsPage({ summaryOnly: true })
      const secondElapsedMs = performance.now() - secondStartedAt

      expect(first.runs.map(run => run.id)).toEqual(['busy-fallback'])
      expect(second.runs.map(run => run.id)).toEqual(['busy-fallback'])
      expect(firstElapsedMs).toBeLessThan(500)
      expect(secondElapsedMs).toBeLessThan(100)
    } finally {
      locker.exec('ROLLBACK')
      locker.close(true)
    }
  })

  test('does not create or read the scheduled-run database while the rollout mode is off', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-run-read-model-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CC_HAHA_LOCAL_INDEX = 'off'
    const sourcePath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const canonical = { runs: [{
      id: 'canonical-off',
      taskId: 'task-1',
      taskName: 'Task',
      startedAt: '2026-07-15T00:00:00.000Z',
      status: 'completed' as const,
      prompt: 'prompt',
    }] }
    await fs.writeFile(sourcePath, JSON.stringify(canonical))

    const scheduler = new CronScheduler()
    expect(await scheduler.getRecentRuns()).toEqual(canonical.runs)
    await expect(fs.stat(getScheduledRunIndexDatabasePath())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('drops a queued projection when rollout switches off before commit', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-run-read-model-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CC_HAHA_LOCAL_INDEX = 'on'
    const sourcePath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const runs = [{
      id: 'queued-before-off',
      taskId: 'task-1',
      taskName: 'Task',
      startedAt: '2026-07-15T00:00:00.000Z',
      status: 'completed',
      prompt: 'prompt',
    }]
    const serialized = JSON.stringify({ runs })
    await fs.writeFile(sourcePath, serialized)

    let releaseProjection: () => void = () => {}
    const blockedProjection = new Promise<void>((resolve) => {
      releaseProjection = resolve
    })
    let signalProjection: () => void = () => {}
    const projectionReachedCommit = new Promise<void>((resolve) => {
      signalProjection = resolve
    })
    setScheduledRunProjectionBeforeCommitHookForTests(async () => {
      signalProjection()
      await blockedProjection
    })

    const projection = projectScheduledRunsAfterCanonicalWrite(
      sourcePath,
      serialized,
      runs,
    )
    await projectionReachedCommit
    process.env.CC_HAHA_LOCAL_INDEX = 'off'
    releaseProjection()
    await projection

    expect(await fs.readFile(sourcePath, 'utf8')).toBe(serialized)
    await expect(fs.stat(getScheduledRunIndexDatabasePath())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('keeps a queued projection in the config scope captured before commit', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-run-read-model-'))
    const scopeA = path.join(tmpDir, 'scope-a')
    const scopeB = path.join(tmpDir, 'scope-b')
    process.env.CLAUDE_CONFIG_DIR = scopeA
    process.env.CC_HAHA_LOCAL_INDEX = 'on'
    const sourcePath = path.join(scopeA, 'scheduled_tasks_log.json')
    const runs = [{
      id: 'scope-a-run',
      taskId: 'task-1',
      taskName: 'scope-a-private-name',
      startedAt: '2026-07-15T00:00:00.000Z',
      status: 'completed',
      prompt: 'scope-a-private-prompt',
      output: 'scope-a-private-output',
    }]
    const serialized = JSON.stringify({ runs })
    await fs.mkdir(scopeA, { recursive: true })
    await fs.writeFile(sourcePath, serialized)

    let releaseProjection: () => void = () => {}
    const blockedProjection = new Promise<void>(resolve => {
      releaseProjection = resolve
    })
    let signalCommit: () => void = () => {}
    const reachedCommit = new Promise<void>(resolve => {
      signalCommit = resolve
    })
    setScheduledRunProjectionBeforeCommitHookForTests(async () => {
      setScheduledRunProjectionBeforeCommitHookForTests(null)
      signalCommit()
      await blockedProjection
    })

    const projection = projectScheduledRunsAfterCanonicalWrite(
      sourcePath,
      serialized,
      runs,
    )
    await reachedCommit
    process.env.CLAUDE_CONFIG_DIR = scopeB
    releaseProjection()
    await projection

    const databaseAPath = path.join(
      scopeA,
      'cc-haha',
      'db',
      'scheduled-runs-v1.sqlite',
    )
    const databaseBPath = path.join(
      scopeB,
      'cc-haha',
      'db',
      'scheduled-runs-v1.sqlite',
    )
    const databaseA = new Database(databaseAPath, { readonly: true })
    expect(databaseA.query<{ source_path: string }, []>(
      'SELECT source_path FROM scheduled_run_source WHERE singleton = 1',
    ).get()).toEqual({ source_path: sourcePath })
    expect(databaseA.query<{ run_id: string }, []>(
      'SELECT run_id FROM scheduled_runs',
    ).all()).toEqual([{ run_id: 'scope-a-run' }])
    databaseA.close(true)
    await expect(fs.stat(databaseBPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('keeps a summary request fallback in the config scope captured at entry', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-run-read-model-'))
    const scopeA = path.join(tmpDir, 'scope-a')
    const scopeB = path.join(tmpDir, 'scope-b')
    const sourceA = path.join(scopeA, 'scheduled_tasks_log.json')
    const sourceB = path.join(scopeB, 'scheduled_tasks_log.json')
    const serialize = (id: string) => JSON.stringify({ runs: [{
      id,
      taskId: 'task-1',
      taskName: 'Task',
      startedAt: '2026-07-15T00:00:00.000Z',
      status: 'completed',
      prompt: id,
    }] })
    await fs.mkdir(scopeA, { recursive: true })
    await fs.mkdir(scopeB, { recursive: true })
    await fs.writeFile(sourceA, serialize('scope-a-run'))
    await fs.writeFile(sourceB, serialize('scope-b-run'))
    process.env.CLAUDE_CONFIG_DIR = scopeA
    process.env.CC_HAHA_LOCAL_INDEX = 'on'
    const scheduler = new CronScheduler()
    expect((await scheduler.getRunsPage({ summaryOnly: true })).runs.map(run => run.id))
      .toEqual(['scope-a-run'])

    setScheduledRunFingerprintAfterInitialStatHookForTests(async () => {
      setScheduledRunFingerprintAfterInitialStatHookForTests(null)
      process.env.CLAUDE_CONFIG_DIR = scopeB
      throw new Error('force canonical fallback after the request has started')
    })

    expect((await scheduler.getRunsPage({ summaryOnly: true })).runs.map(run => run.id))
      .toEqual(['scope-a-run'])
  })

  test('returns canonical pages in shadow mode when the projection differs', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-run-read-model-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CC_HAHA_LOCAL_INDEX = 'shadow'
    const sourcePath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const canonical = { runs: [{
      id: 'canonical-shadow',
      taskId: 'task-1',
      taskName: 'Task',
      startedAt: '2026-07-15T00:00:00.000Z',
      status: 'completed' as const,
      prompt: 'prompt',
    }] }
    await fs.writeFile(sourcePath, JSON.stringify(canonical))
    await readScheduledRunPage(sourcePath, { summaryOnly: true })
    const database = new Database(getScheduledRunIndexDatabasePath())
    database.query('UPDATE scheduled_runs SET status = ? WHERE run_id = ?')
      .run('failed', canonical.runs[0].id)
    database.close(true)

    const scheduler = new CronScheduler()
    const page = await scheduler.getRunsPage({ limit: 10, summaryOnly: true })
    expect(page.runs).toEqual([expect.objectContaining({
      id: 'canonical-shadow',
      status: 'completed',
    })])
    const diagnosticsPath = path.join(
      tmpDir,
      'cc-haha',
      'diagnostics',
      'diagnostics.jsonl',
    )
    const events = (await fs.readFile(diagnosticsPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as {
        type: string
        details?: Record<string, unknown>
      })
    expect(events.at(-1)).toMatchObject({
      type: 'local_index_scheduled_run_shadow_comparison',
      details: {
        operation: 'getRunsPage',
        fileCount: 1,
        indexedCount: 1,
        fileHash: expect.any(String),
        indexedHash: expect.any(String),
      },
    })
    expect(JSON.stringify(events.at(-1))).not.toContain('canonical-shadow')
  })

  test('rebuilds after a same-size rewrite even when the source mtime is restored', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-run-read-model-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    const sourcePath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const serialize = (id: string) => JSON.stringify({ runs: [{
      id,
      taskId: 'task-1',
      taskName: 'Task',
      startedAt: '2026-07-15T00:00:00.000Z',
      status: 'completed',
      prompt: 'prompt',
    }] })
    await fs.writeFile(sourcePath, serialize('run-a'))
    await fs.utimes(sourcePath, exactFileTime, exactFileTime)
    const original = await fs.stat(sourcePath)

    expect((await readScheduledRunPage(sourcePath, { summaryOnly: true }))?.runs[0]?.id).toBe('run-a')

    await fs.writeFile(sourcePath, serialize('run-b'))
    await fs.utimes(sourcePath, exactFileTime, exactFileTime)
    const restored = await fs.stat(sourcePath)
    expect(restored.size).toBe(original.size)
    expect(restored.mtimeMs).toBe(original.mtimeMs)

    expect((await readScheduledRunPage(sourcePath, { summaryOnly: true }))?.runs[0]?.id).toBe('run-b')
    expect(getScheduledRunReadModelDiagnosticsForTests()).toEqual({
      canonicalReadCount: 2,
      rebuildCount: 2,
    })
  })

  test('detects a restored-mtime rewrite in the unbounded middle of a large JSON file', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-run-read-model-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    const sourcePath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const half = 128 * 1024
    const serialize = (middle: string) => JSON.stringify({ runs: [{
      id: 'large-run',
      taskId: 'task-1',
      taskName: 'Task',
      startedAt: '2026-07-15T00:00:00.000Z',
      status: 'completed',
      prompt: 'prompt',
      output: `${'a'.repeat(half)}${middle}${'a'.repeat(half)}`,
    }] })
    await fs.writeFile(sourcePath, serialize('a'))
    await fs.utimes(sourcePath, exactFileTime, exactFileTime)
    const original = await fs.stat(sourcePath)
    await readScheduledRunPage(sourcePath, { summaryOnly: true })

    await fs.writeFile(sourcePath, serialize('b'))
    await fs.utimes(sourcePath, exactFileTime, exactFileTime)
    const restored = await fs.stat(sourcePath)
    expect(restored.size).toBe(original.size)
    expect(restored.mtimeMs).toBe(original.mtimeMs)
    expect(restored.ctimeMs).not.toBe(original.ctimeMs)

    await readScheduledRunPage(sourcePath, { summaryOnly: true })
    expect(getScheduledRunReadModelDiagnosticsForTests().rebuildCount).toBe(2)
  })

  test('rejects a middle rewrite that races after the warm verifier initial ctime stat', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-run-read-model-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    const sourcePath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const half = 128 * 1024
    const serialize = (middle: string) => JSON.stringify({ runs: [{
      id: 'racing-run',
      taskId: 'task-1',
      taskName: 'Task',
      startedAt: '2026-07-15T00:00:00.000Z',
      status: 'completed',
      prompt: 'prompt',
      output: `${'a'.repeat(half)}${middle}${'a'.repeat(half)}`,
    }] })
    await fs.writeFile(sourcePath, serialize('a'))
    await fs.utimes(sourcePath, exactFileTime, exactFileTime)
    const original = await fs.stat(sourcePath)
    await readScheduledRunPage(sourcePath, { summaryOnly: true })

    setScheduledRunFingerprintAfterInitialStatHookForTests(async () => {
      setScheduledRunFingerprintAfterInitialStatHookForTests(null)
      await fs.writeFile(sourcePath, serialize('b'))
      await fs.utimes(sourcePath, exactFileTime, exactFileTime)
    })

    await readScheduledRunPage(sourcePath, { summaryOnly: true })
    expect(getScheduledRunReadModelDiagnosticsForTests().rebuildCount).toBe(2)
  })

  test('drops an older queued projection when a newer canonical write supersedes it', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-run-read-model-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CC_HAHA_LOCAL_INDEX = 'on'
    const sourcePath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const run = (id: string) => ({
      id,
      taskId: 'task-1',
      taskName: 'Task',
      startedAt: '2026-07-15T00:00:00.000Z',
      status: 'completed',
      prompt: 'prompt',
    })
    const firstRuns = [run('run-a')]
    const secondRuns = [run('run-b')]
    const firstSerialized = JSON.stringify({ runs: firstRuns })
    const secondSerialized = JSON.stringify({ runs: secondRuns })
    await fs.writeFile(sourcePath, firstSerialized)

    let releaseFirstProjection: () => void = () => {}
    const firstProjectionBlocked = new Promise<void>((resolve) => {
      releaseFirstProjection = resolve
    })
    let signalFirstProjection: () => void = () => {}
    const firstProjectionReachedCommit = new Promise<void>((resolve) => {
      signalFirstProjection = resolve
    })
    let hookCalls = 0
    setScheduledRunProjectionBeforeCommitHookForTests(async () => {
      hookCalls += 1
      if (hookCalls !== 1) return
      signalFirstProjection()
      await firstProjectionBlocked
    })

    const firstProjection = projectScheduledRunsAfterCanonicalWrite(
      sourcePath,
      firstSerialized,
      firstRuns,
    )
    await firstProjectionReachedCommit
    await fs.writeFile(sourcePath, secondSerialized)
    const secondProjection = projectScheduledRunsAfterCanonicalWrite(
      sourcePath,
      secondSerialized,
      secondRuns,
    )
    releaseFirstProjection()
    await Promise.all([firstProjection, secondProjection])

    expect((await readScheduledRunPage(sourcePath, { summaryOnly: true }))?.runs[0]?.id).toBe('run-b')
    expect(getScheduledRunReadModelDiagnosticsForTests().rebuildCount).toBe(1)
  })

  test('keeps full list and detail reads canonical while SQLite contains metadata only', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-run-read-model-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CC_HAHA_LOCAL_INDEX = 'on'
    const sourcePath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const canonical = { runs: [{
      id: 'canonical-body-run',
      taskId: 'task-1',
      taskName: 'prompt-derived-private-name',
      startedAt: '2026-07-15T00:00:00.000Z',
      status: 'completed' as const,
      prompt: 'canonical-private-prompt',
      output: 'canonical-private-output',
      error: 'canonical-private-error',
      futureField: { preserved: true },
    }] }
    await fs.writeFile(sourcePath, JSON.stringify(canonical))
    const scheduler = new CronScheduler()
    const summary = await scheduler.getRunsPage({ summaryOnly: true })
    expect(summary.runs[0]).not.toHaveProperty('prompt')
    expect(await scheduler.getRecentRuns()).toEqual(canonical.runs)
    expect(await scheduler.getRunDetail(canonical.runs[0].id)).toEqual(canonical.runs[0])

    const database = new Database(getScheduledRunIndexDatabasePath(), { readonly: true })
    const columns = database.query<{ name: string }, []>(
      'PRAGMA table_info(scheduled_runs)',
    ).all().map(column => column.name)
    expect(columns).not.toContain('task_name')
    expect(columns).not.toContain('prompt_preview')
    expect(columns).not.toContain('output_preview')
    expect(columns).not.toContain('error_preview')
    expect(columns).not.toContain('run_json')
    database.close(true)
  })
})
