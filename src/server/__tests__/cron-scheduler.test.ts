/**
 * Tests for CronScheduler — cron matching, task execution, log storage, and API endpoints
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import {
  cronMatches,
  extractAssistantText,
  fieldMatches,
  CronScheduler,
  type TaskRun,
} from '../services/cronScheduler.js'
import { CronService } from '../services/cronService.js'
import { resetScheduledRunReadModelForTests } from '../services/localIndex/scheduledRunReadModel.js'

// ─── Test helpers ───────────────────────────────────────────────────────────

let tmpDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalClaudeCliPath = process.env.CLAUDE_CLI_PATH
const originalDisableTerminalShellEnv = process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
const originalLocalIndexMode = process.env.CC_HAHA_LOCAL_INDEX

async function createTmpDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `claude-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function cleanupTmpDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

async function createFakeCronCli(dir: string): Promise<string> {
  const cliPath = path.join(dir, 'fake-cron-cli.ts')
  await fs.writeFile(
    cliPath,
    [
      "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'fake cron output' }] } }))",
      "console.log(JSON.stringify({ type: 'result', result: 'fake cron result' }))",
    ].join('\n') + '\n',
    'utf-8',
  )
  return cliPath
}

async function createBlockingFakeCronCli(dir: string): Promise<{
  cliPath: string
  readyPath: string
  releasePath: string
}> {
  const cliPath = path.join(dir, 'blocking-fake-cron-cli.ts')
  const readyPath = path.join(dir, 'blocking-fake-cron-cli.ready')
  const releasePath = path.join(dir, 'blocking-fake-cron-cli.release')
  await fs.writeFile(
    cliPath,
    [
      "import { existsSync, writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(readyPath)}, 'ready')`,
      `while (!existsSync(${JSON.stringify(releasePath)})) await Bun.sleep(5)`,
      "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'blocking fake cron output' }] } }))",
      "console.log(JSON.stringify({ type: 'result', result: 'blocking fake cron result' }))",
    ].join('\n') + '\n',
    'utf-8',
  )
  return { cliPath, readyPath, releasePath }
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await fs.stat(filePath).then(() => true).catch(() => false)) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}

// ─── fieldMatches tests ────────────────────────────────────────────────────

describe('extractAssistantText', () => {
  it('does not duplicate the final assistant text repeated by the result event', () => {
    const raw = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'X' }] } }),
      JSON.stringify({ type: 'result', result: 'X' }),
    ].join('\n')

    expect(extractAssistantText(raw)).toBe('X')
  })

  it('keeps a distinct result summary after assistant text', () => {
    const raw = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'details' }] } }),
      JSON.stringify({ type: 'result', result: 'summary' }),
    ].join('\n')

    expect(extractAssistantText(raw)).toBe('details\n\nsummary')
  })
})

describe('fieldMatches', () => {
  it('should match wildcard', () => {
    expect(fieldMatches('*', 0)).toBe(true)
    expect(fieldMatches('*', 59)).toBe(true)
    expect(fieldMatches('*', 23)).toBe(true)
  })

  it('should match exact number', () => {
    expect(fieldMatches('5', 5)).toBe(true)
    expect(fieldMatches('5', 6)).toBe(false)
    expect(fieldMatches('0', 0)).toBe(true)
    expect(fieldMatches('30', 30)).toBe(true)
  })

  it('should match comma-separated list', () => {
    expect(fieldMatches('1,3,5', 1)).toBe(true)
    expect(fieldMatches('1,3,5', 3)).toBe(true)
    expect(fieldMatches('1,3,5', 5)).toBe(true)
    expect(fieldMatches('1,3,5', 2)).toBe(false)
    expect(fieldMatches('1,3,5', 4)).toBe(false)
  })

  it('should match range', () => {
    expect(fieldMatches('1-5', 1)).toBe(true)
    expect(fieldMatches('1-5', 3)).toBe(true)
    expect(fieldMatches('1-5', 5)).toBe(true)
    expect(fieldMatches('1-5', 0)).toBe(false)
    expect(fieldMatches('1-5', 6)).toBe(false)
  })

  it('should match step from wildcard', () => {
    expect(fieldMatches('*/2', 0)).toBe(true)
    expect(fieldMatches('*/2', 2)).toBe(true)
    expect(fieldMatches('*/2', 4)).toBe(true)
    expect(fieldMatches('*/2', 1)).toBe(false)
    expect(fieldMatches('*/2', 3)).toBe(false)
    expect(fieldMatches('*/15', 0)).toBe(true)
    expect(fieldMatches('*/15', 15)).toBe(true)
    expect(fieldMatches('*/15', 30)).toBe(true)
    expect(fieldMatches('*/15', 7)).toBe(false)
  })

  it('should match step within range', () => {
    expect(fieldMatches('1-10/3', 1)).toBe(true)
    expect(fieldMatches('1-10/3', 4)).toBe(true)
    expect(fieldMatches('1-10/3', 7)).toBe(true)
    expect(fieldMatches('1-10/3', 10)).toBe(true)
    expect(fieldMatches('1-10/3', 2)).toBe(false)
    expect(fieldMatches('1-10/3', 11)).toBe(false)
    expect(fieldMatches('1-10/3', 0)).toBe(false)
  })

  it('should handle combined comma and range', () => {
    expect(fieldMatches('1-3,7,10-12', 2)).toBe(true)
    expect(fieldMatches('1-3,7,10-12', 7)).toBe(true)
    expect(fieldMatches('1-3,7,10-12', 11)).toBe(true)
    expect(fieldMatches('1-3,7,10-12', 5)).toBe(false)
  })
})

// ─── cronMatches tests ─────────────────────────────────────────────────────

describe('cronMatches', () => {
  it('should match every-minute expression', () => {
    const date = new Date(2026, 3, 5, 14, 30, 0) // April 5, 2026 14:30 (Sunday)
    expect(cronMatches('* * * * *', date)).toBe(true)
  })

  it('should match daily at 9:00', () => {
    const match = new Date(2026, 3, 5, 9, 0, 0)
    const noMatch = new Date(2026, 3, 5, 9, 1, 0)
    expect(cronMatches('0 9 * * *', match)).toBe(true)
    expect(cronMatches('0 9 * * *', noMatch)).toBe(false)
  })

  it('should match every 2 hours at minute 0', () => {
    expect(cronMatches('0 */2 * * *', new Date(2026, 0, 1, 0, 0))).toBe(true)
    expect(cronMatches('0 */2 * * *', new Date(2026, 0, 1, 2, 0))).toBe(true)
    expect(cronMatches('0 */2 * * *', new Date(2026, 0, 1, 4, 0))).toBe(true)
    expect(cronMatches('0 */2 * * *', new Date(2026, 0, 1, 1, 0))).toBe(false)
    expect(cronMatches('0 */2 * * *', new Date(2026, 0, 1, 3, 0))).toBe(false)
  })

  it('should match weekdays at 14:30', () => {
    // April 6, 2026 is a Monday (dow = 1)
    const monday = new Date(2026, 3, 6, 14, 30, 0)
    // April 5, 2026 is a Sunday (dow = 0)
    const sunday = new Date(2026, 3, 5, 14, 30, 0)
    expect(cronMatches('30 14 * * 1-5', monday)).toBe(true)
    expect(cronMatches('30 14 * * 1-5', sunday)).toBe(false)
  })

  it('should match specific month and day', () => {
    // January 15 at midnight
    const jan15 = new Date(2026, 0, 15, 0, 0)
    const feb15 = new Date(2026, 1, 15, 0, 0)
    expect(cronMatches('0 0 15 1 *', jan15)).toBe(true)
    expect(cronMatches('0 0 15 1 *', feb15)).toBe(false)
  })

  it('should reject invalid cron expressions', () => {
    const date = new Date()
    expect(cronMatches('* * *', date)).toBe(false) // only 3 fields
    expect(cronMatches('', date)).toBe(false)
    expect(cronMatches('* * * * * *', date)).toBe(false) // 6 fields
  })

  it('should match day-of-week with Sunday as 0', () => {
    // Sunday = 0
    const sunday = new Date(2026, 3, 5, 10, 0) // April 5, 2026 is Sunday
    expect(cronMatches('0 10 * * 0', sunday)).toBe(true)
    expect(cronMatches('0 10 * * 6', sunday)).toBe(false)
  })
})

// ─── CronScheduler execution tests ────────────────────────────────────────

describe('CronScheduler', () => {
  let cronService: CronService
  let scheduler: CronScheduler

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CLAUDE_CLI_PATH = await createFakeCronCli(tmpDir)
    process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
    process.env.CC_HAHA_LOCAL_INDEX = 'off'
    cronService = new CronService()
    scheduler = new CronScheduler(cronService)
  })

  afterEach(async () => {
    scheduler.stop()
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    if (originalClaudeCliPath) {
      process.env.CLAUDE_CLI_PATH = originalClaudeCliPath
    } else {
      delete process.env.CLAUDE_CLI_PATH
    }
    if (originalDisableTerminalShellEnv) {
      process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = originalDisableTerminalShellEnv
    } else {
      delete process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
    }
    if (originalLocalIndexMode) {
      process.env.CC_HAHA_LOCAL_INDEX = originalLocalIndexMode
    } else {
      delete process.env.CC_HAHA_LOCAL_INDEX
    }
    await cleanupTmpDir(tmpDir)
  })

  it('should start and stop without errors', () => {
    scheduler.start()
    scheduler.stop()
    // Starting again after stop should also work
    scheduler.start()
    scheduler.stop()
  })

  it('should not start twice', () => {
    scheduler.start()
    // Second start should be a no-op (no error)
    scheduler.start()
    scheduler.stop()
  })

  it('should return empty runs when no tasks have executed', async () => {
    const runs = await scheduler.getRecentRuns()
    expect(runs).toEqual([])
  })

  it('should return empty runs for a non-existent task ID', async () => {
    const runs = await scheduler.getTaskRuns('nonexistent')
    expect(runs).toEqual([])
  })

  it('should persist a task run to the log file', async () => {
    // Create a task that runs "echo hello" — we'll invoke executeTask directly
    // with a mock-like approach: create a task then check the log file
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'echo test',
      name: 'Test Task',
      recurring: true,
    })

    // We can't easily mock Bun.spawn in bun:test, so we'll check the log
    // file was created by reading it after execution attempt.
    // The CLI subprocess will likely fail (not a real CLI available in tests),
    // but the run should still be logged with 'failed' status.
    try {
      await scheduler.executeTask(task)
    } catch {
      // Expected — CLI binary may not be available in test environment
    }

    const logPath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const logExists = await fs
      .stat(logPath)
      .then(() => true)
      .catch(() => false)
    expect(logExists).toBe(true)

    const logContent = JSON.parse(await fs.readFile(logPath, 'utf-8')) as {
      runs: TaskRun[]
    }
    expect(logContent.runs.length).toBeGreaterThanOrEqual(1)
    expect(logContent.runs[0].taskId).toBe(task.id)
    expect(logContent.runs[0].taskName).toBe('Test Task')
    expect(logContent.runs[0].prompt).toBe('echo test')
    await expect(fs.stat(path.join(
      tmpDir,
      'cc-haha',
      'db',
      'scheduled-runs-v1.sqlite',
    ))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps one execution lifecycle canonical and projected writes in its original scope', async () => {
    const scopeA = path.join(tmpDir, 'scope-a')
    const scopeB = path.join(tmpDir, 'scope-b')
    await fs.mkdir(scopeA, { recursive: true })
    await fs.mkdir(scopeB, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = scopeA
    process.env.CC_HAHA_LOCAL_INDEX = 'on'

    const blockingCli = await createBlockingFakeCronCli(tmpDir)
    process.env.CLAUDE_CLI_PATH = blockingCli.cliPath
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'scope A prompt',
      name: 'Scope A Task',
      recurring: true,
    })
    const scopeBMarker: TaskRun = {
      id: 'scope-b-marker',
      taskId: 'scope-b-task',
      taskName: 'Scope B Task',
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(1).toISOString(),
      status: 'completed',
      prompt: 'scope B prompt',
    }
    await fs.writeFile(
      path.join(scopeB, 'scheduled_tasks_log.json'),
      JSON.stringify({ runs: [scopeBMarker] }, null, 2) + '\n',
      'utf-8',
    )

    const execution = scheduler.executeTask(task)
    try {
      await waitForFile(blockingCli.readyPath)

      // The running write must already be projected in scope A before the
      // process-level config scope changes while the task is still alive.
      await resetScheduledRunReadModelForTests()
      const scopeADatabasePath = path.join(
        scopeA,
        'cc-haha',
        'db',
        'scheduled-runs-v1.sqlite',
      )
      const runningDatabase = new Database(scopeADatabasePath, { readonly: true })
      try {
        expect(runningDatabase.query<{ status: string }, []>(
          'SELECT status FROM scheduled_runs WHERE task_id = ?',
        ).get(task.id)?.status).toBe('running')
      } finally {
        runningDatabase.close()
      }

      process.env.CLAUDE_CONFIG_DIR = scopeB
      await fs.writeFile(blockingCli.releasePath, 'release', 'utf-8')
      await execution
      await resetScheduledRunReadModelForTests()
    } finally {
      await fs.writeFile(blockingCli.releasePath, 'release', 'utf-8').catch(() => {})
      await execution.catch(() => {})
      await resetScheduledRunReadModelForTests()
    }

    const scopeARuns = JSON.parse(await fs.readFile(
      path.join(scopeA, 'scheduled_tasks_log.json'),
      'utf-8',
    )) as { runs: TaskRun[] }
    const scopeBRuns = JSON.parse(await fs.readFile(
      path.join(scopeB, 'scheduled_tasks_log.json'),
      'utf-8',
    )) as { runs: TaskRun[] }

    expect(scopeARuns.runs).toHaveLength(1)
    expect(scopeARuns.runs[0]).toMatchObject({
      taskId: task.id,
      status: 'completed',
      prompt: 'scope A prompt',
    })
    expect(scopeBRuns.runs).toEqual([scopeBMarker])

    const scopeADatabasePath = path.join(
      scopeA,
      'cc-haha',
      'db',
      'scheduled-runs-v1.sqlite',
    )
    const completedDatabase = new Database(scopeADatabasePath, { readonly: true })
    try {
      expect(completedDatabase.query<{ status: string }, []>(
        'SELECT status FROM scheduled_runs WHERE task_id = ?',
      ).get(task.id)?.status).toBe('completed')
    } finally {
      completedDatabase.close()
    }
    await expect(fs.stat(path.join(
      scopeB,
      'cc-haha',
      'db',
      'scheduled-runs-v1.sqlite',
    ))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('should disable non-recurring task after execution', async () => {
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'one-shot task',
      recurring: false,
    })

    try {
      await scheduler.executeTask(task)
    } catch {
      // CLI may not be available
    }

    // After execution, the task should be disabled
    const tasks = await cronService.listTasks()
    const updated = tasks.find((t) => t.id === task.id)
    expect(updated?.enabled).toBe(false)
  })

  it('should NOT disable recurring task after execution', async () => {
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'recurring task',
      recurring: true,
    })

    try {
      await scheduler.executeTask(task)
    } catch {
      // CLI may not be available
    }

    const tasks = await cronService.listTasks()
    const updated = tasks.find((t) => t.id === task.id)
    // enabled should not have been set to false
    expect(updated?.enabled).not.toBe(false)
  })

  it('should update lastFiredAt after execution', async () => {
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'fire test',
      recurring: true,
    })

    const beforeExec = new Date().toISOString()

    try {
      await scheduler.executeTask(task)
    } catch {
      // CLI may not be available
    }

    const tasks = await cronService.listTasks()
    const updated = tasks.find((t) => t.id === task.id)
    expect(updated?.lastFiredAt).toBeDefined()
    // lastFiredAt should be a valid ISO timestamp at or after beforeExec
    expect(new Date(updated!.lastFiredAt!).getTime()).toBeGreaterThanOrEqual(
      new Date(beforeExec).getTime() - 1000, // allow 1s tolerance
    )
  })

  it('should skip disabled tasks during tick', async () => {
    // Create a task matching every minute but disabled
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'should not run',
      enabled: false,
      recurring: true,
    })

    await scheduler.tick()

    // No runs should be logged
    const runs = await scheduler.getTaskRuns(task.id)
    expect(runs).toHaveLength(0)
  })

  it('getTaskRuns should return runs sorted newest first', async () => {
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'multi run',
      recurring: true,
    })

    // Execute twice
    try {
      await scheduler.executeTask(task)
    } catch {
      /* ignore */
    }
    try {
      await scheduler.executeTask(task)
    } catch {
      /* ignore */
    }

    const runs = await scheduler.getTaskRuns(task.id)
    expect(runs.length).toBeGreaterThanOrEqual(2)
    // Should be sorted newest first
    if (runs.length >= 2) {
      expect(
        new Date(runs[0].startedAt).getTime(),
      ).toBeGreaterThanOrEqual(new Date(runs[1].startedAt).getTime())
    }
  })

  it('getRecentRuns should respect limit parameter', async () => {
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'limit test',
      recurring: true,
    })

    // Execute 3 times
    for (let i = 0; i < 3; i++) {
      try {
        await scheduler.executeTask(task)
      } catch {
        /* ignore */
      }
    }

    const runs = await scheduler.getRecentRuns(2)
    expect(runs.length).toBeLessThanOrEqual(2)
  })
})

// ─── Execution log trimming ────────────────────────────────────────────────

describe('Execution log trimming', () => {
  let cronService: CronService
  let scheduler: CronScheduler

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CLAUDE_CLI_PATH = await createFakeCronCli(tmpDir)
    process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
    cronService = new CronService()
    scheduler = new CronScheduler(cronService)
  })

  afterEach(async () => {
    scheduler.stop()
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    if (originalClaudeCliPath) {
      process.env.CLAUDE_CLI_PATH = originalClaudeCliPath
    } else {
      delete process.env.CLAUDE_CLI_PATH
    }
    if (originalDisableTerminalShellEnv) {
      process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = originalDisableTerminalShellEnv
    } else {
      delete process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
    }
    await cleanupTmpDir(tmpDir)
  })

  it('should keep log entries within the max limit', async () => {
    // Pre-populate the log file with 105 entries for a single task
    const logPath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const runs: TaskRun[] = []
    for (let i = 0; i < 105; i++) {
      runs.push({
        id: `run-${i}`,
        taskId: 'task-1',
        taskName: 'Test',
        startedAt: new Date(Date.now() - (105 - i) * 1000).toISOString(),
        completedAt: new Date(Date.now() - (105 - i) * 1000 + 100).toISOString(),
        status: 'completed',
        prompt: 'test',
        exitCode: 0,
        durationMs: 100,
      })
    }
    await fs.writeFile(logPath, JSON.stringify({ runs }, null, 2), 'utf-8')

    // Now execute one more task run — this triggers a trim
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'trigger trim',
      recurring: true,
    })

    try {
      await scheduler.executeTask(task)
    } catch {
      /* ignore */
    }

    // Read back the log
    const logContent = JSON.parse(await fs.readFile(logPath, 'utf-8')) as {
      runs: TaskRun[]
    }
    const task1Runs = logContent.runs.filter((r) => r.taskId === 'task-1')
    // Should have been trimmed to at most 100
    expect(task1Runs.length).toBeLessThanOrEqual(100)
  })
})

// ─── Scheduled Tasks API with runs endpoints ──────────────────────────────

describe('Scheduled Tasks API — runs endpoints', () => {
  let handleScheduledTasksApi: (
    req: Request,
    url: URL,
    segments: string[],
  ) => Promise<Response>

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir

    const mod = await import('../api/scheduled-tasks.js')
    handleScheduledTasksApi = mod.handleScheduledTasksApi
  })

  afterEach(async () => {
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    await cleanupTmpDir(tmpDir)
  })

  it('GET /api/scheduled-tasks/runs should return empty runs', async () => {
    const req = new Request('http://localhost/api/scheduled-tasks/runs', {
      method: 'GET',
    })
    const url = new URL(req.url)
    const resp = await handleScheduledTasksApi(req, url, [
      'api',
      'scheduled-tasks',
      'runs',
    ])
    const body = (await resp.json()) as { runs: unknown[] }
    expect(resp.status).toBe(200)
    expect(body.runs).toEqual([])
  })

  it('GET /api/scheduled-tasks/:id/runs should return empty runs for a task', async () => {
    const req = new Request(
      'http://localhost/api/scheduled-tasks/abc123/runs',
      { method: 'GET' },
    )
    const url = new URL(req.url)
    const resp = await handleScheduledTasksApi(req, url, [
      'api',
      'scheduled-tasks',
      'abc123',
      'runs',
    ])
    const body = (await resp.json()) as { runs: unknown[] }
    expect(resp.status).toBe(200)
    expect(body.runs).toEqual([])
  })

  it('GET /api/scheduled-tasks/runs should return runs from log', async () => {
    // Write some runs to the log file
    const logPath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const runs: TaskRun[] = [
      {
        id: 'run-1',
        taskId: 'task-a',
        taskName: 'Task A',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: 'completed',
        prompt: 'test prompt',
        exitCode: 0,
        durationMs: 500,
      },
      {
        id: 'run-2',
        taskId: 'task-b',
        taskName: 'Task B',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: 'failed',
        prompt: 'another prompt',
        error: 'some error',
        exitCode: 1,
        durationMs: 200,
      },
    ]
    await fs.writeFile(logPath, JSON.stringify({ runs }, null, 2), 'utf-8')

    const req = new Request('http://localhost/api/scheduled-tasks/runs', {
      method: 'GET',
    })
    const url = new URL(req.url)
    const resp = await handleScheduledTasksApi(req, url, [
      'api',
      'scheduled-tasks',
      'runs',
    ])
    const body = (await resp.json()) as { runs: TaskRun[] }
    expect(resp.status).toBe(200)
    expect(body.runs).toHaveLength(2)
  })

  it('GET /api/scheduled-tasks/:id/runs should filter by task ID', async () => {
    const logPath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const runs: TaskRun[] = [
      {
        id: 'run-1',
        taskId: 'task-a',
        taskName: 'Task A',
        startedAt: new Date().toISOString(),
        status: 'completed',
        prompt: 'prompt a',
        exitCode: 0,
      },
      {
        id: 'run-2',
        taskId: 'task-b',
        taskName: 'Task B',
        startedAt: new Date().toISOString(),
        status: 'completed',
        prompt: 'prompt b',
        exitCode: 0,
      },
    ]
    await fs.writeFile(logPath, JSON.stringify({ runs }, null, 2), 'utf-8')

    const req = new Request(
      'http://localhost/api/scheduled-tasks/task-a/runs',
      { method: 'GET' },
    )
    const url = new URL(req.url)
    const resp = await handleScheduledTasksApi(req, url, [
      'api',
      'scheduled-tasks',
      'task-a',
      'runs',
    ])
    const body = (await resp.json()) as { runs: TaskRun[] }
    expect(resp.status).toBe(200)
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0].taskId).toBe('task-a')
  })
})
