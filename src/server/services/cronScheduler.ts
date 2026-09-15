/**
 * CronScheduler — Execution engine for scheduled tasks
 *
 * Periodically checks all scheduled tasks and executes those whose cron
 * expression matches the current time. Tasks are run by spawning a CLI
 * subprocess with the task's prompt. Execution history is persisted to
 * ~/.claude/scheduled_tasks_log.json.
 */

import * as fs from 'fs/promises'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { CronService, type CronTask } from './cronService.js'
import { parseOneShotCronTarget } from './scheduledReservation.js'
import { SessionService } from './sessionService.js'
import { sendTaskNotification } from './notificationService.js'
import { ProviderService } from './providerService.js'
import { SettingsService } from './settingsService.js'
import { isProviderManagedEnvVar } from '../../utils/managedEnvConstants.js'
import {
  buildClaudeCliArgs,
  resolveClaudeCliLauncher,
} from '../../utils/desktopBundledCli.js'
import { getProcessEnvWithTerminalShellEnvironment } from '../../utils/terminalShellEnvironment.js'
import { attributionHeaderEnvForModel } from './attributionHeaderPolicy.js'
import { diagnosticsService } from './diagnosticsService.js'
import {
  buildNetworkEnvironment,
  loadNetworkSettings,
  resolveEffectiveProxyMode,
  type NetworkProxyMode,
} from './networkSettings.js'
import { resolveLocalIndexMode } from './localIndex/config.js'
import {
  captureScheduledRunReadModelTarget,
  deactivateScheduledRunReadModel,
  projectScheduledRunsAfterCanonicalWrite,
  readScheduledRunPage,
  type ScheduledRunReadModelTarget,
} from './localIndex/scheduledRunReadModel.js'
import {
  paginateScheduledRunRecords,
  type ScheduledRunSummary,
} from './localIndex/scheduledRunIndex.js'

// ─── Types ─────────────────────────────────────────────────────────────────────

export type TaskRun = {
  id: string // random ID
  taskId: string // references CronTask.id
  taskName: string
  startedAt: string // ISO timestamp
  completedAt?: string
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'missed'
  prompt: string
  output?: string // captured stdout summary
  error?: string
  exitCode?: number
  durationMs?: number
  sessionId?: string // links to a session for rich output rendering
}

// ─── One-shot reservation helpers ─────────────────────────────────────────────

/**
 * A one-shot reservation was "missed" when the server was down at its pinned
 * target time and it never fired. Detection is intentionally conservative: we
 * never auto-run a missed reservation (that would deliver a message hours
 * later with no user present). Instead the caller disables it, records a
 * `missed` run, and lets the user run it now or reschedule.
 *
 * Pure so it can be unit-tested without touching the filesystem or clock.
 *
 * @param tasks   all persisted tasks
 * @param now     current time
 * @returns the subset of enabled one-shot tasks whose target has passed
 *          without a recorded fire at/after that target
 */
export function findMissedOneShotTasks(
  tasks: CronTask[],
  now: Date,
): CronTask[] {
  const nowMs = now.getTime()
  const missed: CronTask[] = []
  for (const task of tasks) {
    if (task.enabled === false) continue
    if (task.recurring !== false) continue
    // Anchor on createdAt so the resolved target is the originally-scheduled
    // occurrence, not next year's. parseOneShotCronTarget returns null for
    // non-pinned crons, which are never one-shot reservations.
    const target = parseOneShotCronTarget(task.cron, new Date(task.createdAt))
    if (!target) continue
    const targetMs = target.getTime()
    if (targetMs > nowMs) continue // still in the future — not missed
    if (task.lastFiredAt) {
      const firedMs = new Date(task.lastFiredAt).getTime()
      // Fired at/after the target means it ran on time (or was run manually
      // after) — not missed.
      if (Number.isFinite(firedMs) && firedMs >= targetMs - 60_000) continue
    }
    missed.push(task)
  }
  return missed
}

// ─── Rate-limit / retry helpers ───────────────────────────────────────────────

/** Maximum number of spawn attempts for a single run (1 initial + retries). */
export const MAX_RUN_ATTEMPTS = 3

/**
 * Minimum wall-clock runtime (ms) before a failed attempt is eligible for
 * rate-limit retry. A real 429 requires at least one network round-trip
 * (DNS + TCP + TLS + request + response), which takes >1s even on localhost.
 * Processes that die faster are startup crashes (wrong path, missing deps,
 * permission errors) — retrying them just flashes console windows on Windows.
 */
export const MIN_RETRY_RUNTIME_MS = 3_000

/**
 * True when CLI output/exit signals provider rate limiting (HTTP 429,
 * "rate limit", "overloaded", "too many requests"). Used to decide whether a
 * failed run is worth a bounded backoff retry.
 *
 * The '429' check requires HTTP status context (e.g. "status 429", "429 Too
 * Many Requests", "HTTP 429", "error 429") to avoid false positives from port
 * numbers, timestamps, line numbers, or memory addresses that happen to
 * contain the substring "429".
 */
export function isRateLimitedRunOutput(text: string): boolean {
  if (!text) return false
  const lower = text.toLowerCase()
  return (
    /(?:status|http|error|code)\s*[:\s]?\s*429\b/.test(lower) ||
    /\b429\s+too\s+many\b/.test(lower) ||
    lower.includes('rate limit') ||
    lower.includes('rate_limit') ||
    lower.includes('ratelimit') ||
    lower.includes('overloaded') ||
    lower.includes('too many requests')
  )
}

/**
 * Exponential backoff for run retries: ~2s / 4s / 8s plus a small (<10%)
 * jitter, capped at 8s of base delay. `attempt` is 1-based (the delay before
 * the 2nd spawn is `computeRunRetryDelayMs(1)`).
 */
export function computeRunRetryDelayMs(attempt: number): number {
  const cappedAttempt = Math.max(1, Math.min(attempt, 3))
  const base = 2000 * 2 ** (cappedAttempt - 1)
  const jitter = Math.floor(Math.random() * base * 0.1)
  return base + jitter
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}


export function buildCronTaskSpawnOptions(
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  return {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd,
    env,
    windowsHide: true,
  } as const
}

// ─── Output extraction ────────────────────────────────────────────────────────

/**
 * Extract meaningful assistant text from raw CLI stream-json (NDJSON) output.
 *
 * The raw stdout contains system/init messages, tool_use blocks, tool_result
 * echoes, and thinking blocks — all of which are noise to the end user. The
 * actual AI answer (assistant text blocks + final result) is what matters.
 *
 * By extracting server-side we avoid the 10K naive truncation problem where
 * the useful content sits well past the first 10K characters.
 */
export function extractAssistantText(raw: string): string {
  if (!raw) return ''
  const lines = raw.split('\n')
  const parts: string[] = []

  for (const line of lines) {
    if (!line.trim()) continue
    let parsed: any
    try {
      parsed = JSON.parse(line)
    } catch {
      continue // skip non-JSON lines and truncated lines
    }

    const type = parsed?.type

    if (type === 'assistant') {
      const content = parsed?.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type === 'text' && block.text?.trim()) {
          parts.push(block.text.trim())
        }
        // Skip tool_use, thinking blocks
      }
    }

    if (type === 'result') {
      const result = parsed?.result
      if (typeof result === 'string' && result.trim()) {
        const text = result.trim()
        if (text !== parts.at(-1) && text !== parts.join('\n\n')) {
          parts.push(text)
        }
      } else if (result?.message?.trim()) {
        const text = result.message.trim()
        if (text !== parts.at(-1) && text !== parts.join('\n\n')) {
          parts.push(text)
        }
      }
    }
  }

  return parts.join('\n\n')
}

// ─── Cron expression matching ──────────────────────────────────────────────────

/**
 * Check whether a single cron field matches a given numeric value.
 *
 * Supported syntax per field:
 *   *          — any value
 *   5          — exact match
 *   1,3,5      — list
 *   1-5        — inclusive range
 *   *​/2        — step from 0
 *   1-10/3     — step within a range
 */
export function fieldMatches(field: string, value: number): boolean {
  if (field === '*') return true

  // Comma-separated list — each element can be a range or step
  const parts = field.split(',')
  return parts.some((part) => singleFieldMatches(part.trim(), value))
}

function singleFieldMatches(part: string, value: number): boolean {
  // Step: */n or range/n
  if (part.includes('/')) {
    const [rangePart, stepStr] = part.split('/')
    const step = parseInt(stepStr, 10)
    if (isNaN(step) || step <= 0) return false

    if (rangePart === '*') {
      return value % step === 0
    }
    // range/step  e.g. 1-10/3
    if (rangePart.includes('-')) {
      const [startStr, endStr] = rangePart.split('-')
      const start = parseInt(startStr, 10)
      const end = parseInt(endStr, 10)
      if (value < start || value > end) return false
      return (value - start) % step === 0
    }
    // single/step  e.g. 5/2  — treat as start with step
    const start = parseInt(rangePart, 10)
    if (value < start) return false
    return (value - start) % step === 0
  }

  // Range: a-b
  if (part.includes('-')) {
    const [startStr, endStr] = part.split('-')
    const start = parseInt(startStr, 10)
    const end = parseInt(endStr, 10)
    return value >= start && value <= end
  }

  // Exact number
  return parseInt(part, 10) === value
}

/**
 * Check whether a standard 5-field cron expression matches the given date.
 * Fields: minute hour day-of-month month day-of-week
 */
export function cronMatches(cronExpr: string, date: Date): boolean {
  const fields = cronExpr.trim().split(/\s+/)
  if (fields.length !== 5) return false

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
  return (
    fieldMatches(minute, date.getMinutes()) &&
    fieldMatches(hour, date.getHours()) &&
    fieldMatches(dayOfMonth, date.getDate()) &&
    fieldMatches(month, date.getMonth() + 1) &&
    fieldMatches(dayOfWeek, date.getDay())
  )
}

// ─── Log file I/O ──────────────────────────────────────────────────────────────

type RunsFile = { runs: TaskRun[] }
type RunsFilePageSource = { data: RunsFile; cursorRevision: string }
type RunsFileMutationTarget = {
  sourcePath: string
  projectionTarget: ScheduledRunReadModelTarget
}

function getLogFilePath(): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'scheduled_tasks_log.json')
}

function captureRunsFileMutationTarget(): RunsFileMutationTarget {
  const sourcePath = getLogFilePath()
  return {
    sourcePath,
    projectionTarget: captureScheduledRunReadModelTarget(sourcePath),
  }
}

function parseRunsFile(raw: string): RunsFile {
  const parsed = JSON.parse(raw) as RunsFile
  return Array.isArray(parsed.runs) ? parsed : { runs: [] }
}

async function readRunsFile(filePath = getLogFilePath()): Promise<RunsFile> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    return parseRunsFile(raw)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { runs: [] }
    }
    throw err
  }
}

async function readRunsFilePageSource(
  filePath = getLogFilePath(),
): Promise<RunsFilePageSource> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    return {
      data: parseRunsFile(raw),
      cursorRevision: `file:${crypto.createHash('sha256').update(raw).digest('base64url')}`,
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { data: { runs: [] }, cursorRevision: 'file:missing' }
    }
    throw err
  }
}

async function writeRunsFile(
  data: RunsFile,
  target = captureRunsFileMutationTarget(),
): Promise<void> {
  const filePath = target.sourcePath
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })

  const tmpFile = `${filePath}.tmp.${Date.now()}`
  const serialized = JSON.stringify(data, null, 2) + '\n'
  try {
    await fs.writeFile(tmpFile, serialized, 'utf-8')
    await fs.rename(tmpFile, filePath)
  } catch (err) {
    await fs.unlink(tmpFile).catch(() => {})
    throw err
  }

  // The file is canonical. A derived-index failure must never turn a
  // successful task-history write into a failed business operation.
  if (resolveLocalIndexMode().mode === 'off') {
    deactivateScheduledRunReadModel(filePath)
  } else {
    void projectScheduledRunsAfterCanonicalWrite(
      filePath,
      serialized,
      data.runs,
      target.projectionTarget,
    ).catch(() => {})
  }
}

type ScheduledRunPageOptions = {
  taskId?: string
  limit?: number
  cursor?: string
  summaryOnly?: boolean
  nonterminalOnly?: boolean
  completedAfterMs?: number
}

type ScheduledRunPageResult = {
  runs: Array<TaskRun | ScheduledRunSummary>
  nextCursor?: string
  revision?: number
  revisionToken?: string
  reset?: boolean
}

function scheduledRunShadowDigest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function recordScheduledRunShadowComparison(
  operation: string,
  canonical: unknown[],
  projected: unknown[] | null,
): Promise<void> {
  const matched = projected !== null && JSON.stringify(canonical) === JSON.stringify(projected)
  if (matched) return
  await diagnosticsService.recordEvent({
    type: 'local_index_scheduled_run_shadow_comparison',
    severity: 'warn',
    summary: 'Scheduled-run index shadow comparison differed',
    details: {
      operation,
      fileCount: canonical.length,
      indexedCount: projected?.length ?? 0,
      fileHash: scheduledRunShadowDigest(canonical),
      indexedHash: scheduledRunShadowDigest(projected),
    },
  })
}

async function compareScheduledRunPageInShadow(
  sourcePath: string,
  source: RunsFilePageSource,
  options: ScheduledRunPageOptions,
  operation: string,
): Promise<void> {
  const comparisonOptions: ScheduledRunPageOptions = {
    ...(options.taskId ? { taskId: options.taskId } : {}),
    ...(options.nonterminalOnly ? { nonterminalOnly: true } : {}),
    ...(options.completedAfterMs === undefined
      ? {}
      : { completedAfterMs: options.completedAfterMs }),
    limit: 2_147_483_647,
    summaryOnly: true,
  }
  const canonical = paginateScheduledRunRecords(
    source.data.runs,
    comparisonOptions,
    source.cursorRevision,
  ).runs
  const projected = await readScheduledRunPage(sourcePath, comparisonOptions)
  await recordScheduledRunShadowComparison(
    operation,
    canonical,
    projected?.runs ?? null,
  )
}

/** Append a run to the log and trim to keep at most MAX_RUNS_PER_TASK per task. */
async function appendRun(
  run: TaskRun,
  target = captureRunsFileMutationTarget(),
): Promise<void> {
  const data = await readRunsFile(target.sourcePath)
  data.runs.push(run)
  trimRuns(data)
  await writeRunsFile(data, target)
}

/** Update an existing run in the log (matched by run.id). */
async function updateRun(
  run: TaskRun,
  target = captureRunsFileMutationTarget(),
): Promise<void> {
  const data = await readRunsFile(target.sourcePath)
  const idx = data.runs.findIndex((r) => r.id === run.id)
  if (idx !== -1) {
    data.runs[idx] = run
  } else {
    data.runs.push(run)
  }
  trimRuns(data)
  await writeRunsFile(data, target)
}

const MAX_RUNS_PER_TASK = 100

/** Keep only the latest MAX_RUNS_PER_TASK entries per task. */
function trimRuns(data: RunsFile): void {
  const countByTask = new Map<string, number>()
  // Count from the end (newest first) and mark for removal
  const keep = new Array<boolean>(data.runs.length).fill(false)
  for (let i = data.runs.length - 1; i >= 0; i--) {
    const taskId = data.runs[i].taskId
    const count = countByTask.get(taskId) || 0
    if (count < MAX_RUNS_PER_TASK) {
      keep[i] = true
      countByTask.set(taskId, count + 1)
    }
  }
  data.runs = data.runs.filter((_, i) => keep[i])
}

// ─── Scheduler ─────────────────────────────────────────────────────────────────

const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

export function resolveCronTaskTimeoutMs(
  env: { CC_HAHA_TASK_TIMEOUT_MS?: string } = process.env,
): number {
  const raw = env.CC_HAHA_TASK_TIMEOUT_MS?.trim()
  if (!raw) return DEFAULT_TASK_TIMEOUT_MS

  const timeoutMs = Number(raw)
  return Number.isInteger(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_TASK_TIMEOUT_MS
}

type CronCliResolutionOptions = {
  cliPath?: string | null
  execPath?: string
  appRoot?: string
  cwd?: string
  moduleDir?: string
  env?: NodeJS.ProcessEnv
}

function isSourceProjectRoot(root: string): boolean {
  return (
    existsSync(path.join(root, 'preload.ts')) &&
    existsSync(path.join(root, 'src', 'entrypoints', 'cli.tsx'))
  )
}

function findSourceProjectRoot(startDir: string): string | null {
  let current = path.resolve(startDir)

  while (true) {
    if (isSourceProjectRoot(current)) {
      return current
    }

    const parent = path.dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}

export function resolveCronProjectRoot(
  options: CronCliResolutionOptions = {},
): string {
  const env = options.env ?? process.env
  const explicitRoot = env.CC_HAHA_ROOT?.trim()
  if (explicitRoot && isSourceProjectRoot(path.resolve(explicitRoot))) {
    return path.resolve(explicitRoot)
  }

  const cwdRoot = findSourceProjectRoot(options.cwd ?? process.cwd())
  if (cwdRoot) {
    return cwdRoot
  }

  const moduleRoot = findSourceProjectRoot(options.moduleDir ?? import.meta.dir)
  if (moduleRoot) {
    return moduleRoot
  }

  return path.resolve(options.moduleDir ?? import.meta.dir, '../../..')
}

export function buildCronCliArgs(
  baseArgs: string[],
  options: CronCliResolutionOptions = {},
): string[] {
  const launcher = resolveClaudeCliLauncher({
    cliPath: options.cliPath ?? process.env.CLAUDE_CLI_PATH,
    execPath: options.execPath ?? process.execPath,
  })

  if (launcher) {
    return buildClaudeCliArgs(
      launcher,
      baseArgs,
      options.appRoot ?? process.env.CLAUDE_APP_ROOT,
    )
  }

  const projectRoot = resolveCronProjectRoot(options)
  return [
    'bun',
    '--preload',
    path.join(projectRoot, 'preload.ts'),
    path.join(projectRoot, 'src', 'entrypoints', 'cli.tsx'),
    ...baseArgs,
  ]
}

export class CronScheduler {
  private intervalId: Timer | null = null
  private runningTasks = new Map<
    string,
    { proc: ReturnType<typeof Bun.spawn>; startedAt: number; runId: string }
  >()
  /** Track which minute each task last fired (prevents same-process duplicate within a minute). */
  private lastFiredMinuteKey = new Map<string, string>()
  private cronService: CronService
  private sessionService: SessionService
  private providerService = new ProviderService()

  constructor(cronService?: CronService) {
    this.cronService = cronService || new CronService()
    this.sessionService = new SessionService()
  }

  /** Return a string key representing the calendar minute of `date`. */
  private static minuteKey(date: Date): string {
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`
  }

  /** Start the scheduler (called on server boot). */
  start(): void {
    if (this.intervalId) return // already running
    console.log('[CronScheduler] Starting — checking every 60 s')
    // Clean up stale "running" entries left by previously crashed processes
    this.cleanupStaleRuns().catch((err) =>
      console.error('[CronScheduler] Error cleaning up stale runs:', err),
    )
    // Surface one-shot reservations missed while the server was down (disable
    // + record a `missed` run). Never auto-runs them.
    this.detectMissedOneShotTasks().catch((err) =>
      console.error('[CronScheduler] Error detecting missed one-shot tasks:', err),
    )
    this.intervalId = setInterval(() => this.tick(), 60_000)
    // Immediate first check
    this.tick()
  }

  /** Stop the scheduler and kill any running task processes. */
  stop(): void {
    const wasRunning = this.intervalId !== null || this.runningTasks.size > 0
    if (!wasRunning) return

    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    for (const [taskId, entry] of this.runningTasks) {
      try {
        entry.proc.kill()
      } catch {
        // process may have already exited
      }
      this.runningTasks.delete(taskId)
    }
    console.log('[CronScheduler] Stopped')
  }

  /** One tick of the scheduler — evaluate all tasks against the current time. */
  async tick(): Promise<void> {
    try {
      const tasks = await this.cronService.listTasks()
      const now = new Date()
      const currentKey = CronScheduler.minuteKey(now)

      for (const task of tasks) {
        // Skip disabled tasks
        if (task.enabled === false) continue

        // Skip if already running (in-memory guard — same process)
        if (this.runningTasks.has(task.id)) continue

        // Skip if this process already fired the task in the current minute
        if (this.lastFiredMinuteKey.get(task.id) === currentKey) continue

        // Skip if ANY process already fired the task in the current minute
        // (cross-process guard via file-persisted lastFiredAt)
        if (task.lastFiredAt) {
          const lastFiredKey = CronScheduler.minuteKey(new Date(task.lastFiredAt))
          if (lastFiredKey === currentKey) continue
        }

        if (cronMatches(task.cron, now)) {
          // Record the minute key BEFORE firing to prevent double-fire
          this.lastFiredMinuteKey.set(task.id, currentKey)
          // Fire and forget — don't await; we want all matching tasks to start
          this.executeTask(task).catch((err) => {
            console.error(
              `[CronScheduler] Unhandled error executing task ${task.id}:`,
              err,
            )
          })
        }
      }
    } catch (err) {
      console.error('[CronScheduler] Error during tick:', err)
    }
  }

  /**
   * Execute a single task by spawning a CLI subprocess.
   * @param task The task to execute
   * @param options.createSession When true, creates a Session for rich output viewing (used for manual "Run Now")
   */
  async executeTask(
    task: CronTask,
    options?: {
      createSession?: boolean
      /** Total spawn attempts (1 = no retry). Defaults to {@link MAX_RUN_ATTEMPTS}. */
      maxRunAttempts?: number
      /** Injectable backoff wait so tests never sleep for real seconds. */
      sleep?: (ms: number) => Promise<void>
      /** Override minimum runtime before retry eligibility (tests use 0). */
      minRetryRuntimeMs?: number
    },
  ): Promise<TaskRun> {
    const runLogTarget = captureRunsFileMutationTarget()

    // Prevent concurrent executions of the same task
    const existing = this.runningTasks.get(task.id)
    if (existing) {
      console.log(
        `[CronScheduler] Task ${task.id} is already running (runId=${existing.runId}), skipping`,
      )
      return {
        id: existing.runId,
        taskId: task.id,
        taskName: task.name || task.prompt.slice(0, 60),
        startedAt: new Date(existing.startedAt).toISOString(),
        status: 'running',
        prompt: task.prompt,
      }
    }

    const runId = crypto.randomBytes(6).toString('hex')
    const startedAt = new Date().toISOString()
    let workDir = task.folderPath || os.homedir()
    if (task.folderPath && (!existsSync(task.folderPath) || !statSync(task.folderPath).isDirectory())) {
      console.warn(`[cron] task ${task.id}: folderPath "${task.folderPath}" is not a valid directory, falling back to homedir`)
      workDir = os.homedir()
    }
    workDir = this.resolveCanonicalWorkDir(workDir)

    // Only create a session when explicitly requested (manual "Run Now"),
    // not for automatic cron runs — avoids flooding the sidebar.
    let sessionId: string | undefined
    if (options?.createSession) {
      try {
        const result = await this.sessionService.createSession(
          workDir,
          undefined,
          'bypassPermissions',
        )
        sessionId = result.sessionId
        // Delete the placeholder JSONL file so the CLI can create it fresh
        // with actual content. Same pattern as conversationService.ts.
        await this.sessionService.deleteSessionFile(sessionId)
      } catch {
        // Fall back to no session if creation fails
      }
    }

    const run: TaskRun = {
      id: runId,
      taskId: task.id,
      taskName: task.name || task.prompt.slice(0, 60),
      startedAt,
      status: 'running',
      prompt: task.prompt,
      sessionId,
    }

    // Update lastFiredAt IMMEDIATELY so other scheduler processes see it
    // and skip this task in the current minute (cross-process dedup).
    await this.cronService.updateLastFired(task.id, startedAt)

    // Persist the "running" state
    await appendRun(run, runLogTarget)

    const inputPayload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: task.prompt }],
      },
      parent_tool_use_id: null,
      session_id: sessionId || '',
    }) + '\n'

    const cliArgs = buildCronCliArgs([
      '--print',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      ...(sessionId ? ['--session-id', sessionId] : []),
      ...this.getRuntimeArgs(task),
    ])

    const childEnv = await this.buildTaskChildEnv(workDir, task)
    const taskTimeoutMs = resolveCronTaskTimeoutMs()
    const sleep = options?.sleep ?? defaultSleep
    const maxAttempts = Math.max(1, options?.maxRunAttempts ?? MAX_RUN_ATTEMPTS)
    const minRetryRuntime = options?.minRetryRuntimeMs ?? MIN_RETRY_RUNTIME_MS

    try {
      // Bounded backoff retry when the provider rate-limits the run. The first
      // attempt always runs; each retry only happens while the previous
      // attempt signalled 429/overloaded and we have attempts left.
      let outcome = await this.spawnTaskAttempt({
        task,
        runId,
        inputPayload,
        cliArgs,
        workDir,
        childEnv,
        taskTimeoutMs,
      })
      for (let attempt = 1; attempt < maxAttempts; attempt++) {
        const rateLimited =
          !outcome.wasTimeout &&
          outcome.exitCode !== 0 &&
          outcome.durationMs >= minRetryRuntime &&
          isRateLimitedRunOutput(`${outcome.rawOutput}\n${outcome.stderrText}`)
        if (!rateLimited) break
        const delayMs = computeRunRetryDelayMs(attempt)
        console.warn(
          `[CronScheduler] Task ${task.id} rate limited; retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts})`,
        )
        // Keep the minute-key guard fresh across the backoff sleep so tick()
        // cannot re-fire this task if the sleep crosses a minute boundary
        // (spawnTaskAttempt's finally already cleared runningTasks).
        this.lastFiredMinuteKey.set(task.id, CronScheduler.minuteKey(new Date()))
        await sleep(delayMs)
        outcome = await this.spawnTaskAttempt({
          task,
          runId,
          inputPayload,
          cliArgs,
          workDir,
          childEnv,
          taskTimeoutMs,
        })
      }

      const completedAt = new Date().toISOString()
      const durationMs =
        new Date(completedAt).getTime() - new Date(startedAt).getTime()

      // Extract only meaningful AI text responses from raw NDJSON output.
      // The raw stream contains system/init messages, tool_use blocks, and
      // tool_result echoes that consume thousands of chars before any actual
      // AI answer appears. A naive .slice(0, 10_000) would lose the answer.
      const output = extractAssistantText(outcome.rawOutput)

      const completedRun: TaskRun = {
        ...run,
        completedAt,
        status: outcome.wasTimeout
          ? 'timeout'
          : outcome.exitCode === 0
            ? 'completed'
            : 'failed',
        output: output.slice(0, 50_000), // cap after extraction
        exitCode: outcome.exitCode,
        durationMs,
      }

      // Collect stderr for error field
      if (outcome.exitCode !== 0 && outcome.stderrText) {
        completedRun.error = outcome.stderrText.slice(0, 5_000)
      }

      await this.persistScheduledSessionPermission(sessionId, workDir)
      await updateRun(completedRun, runLogTarget)

      // Send IM notification if configured
      if (task.notification?.enabled && task.notification.channels.length > 0) {
        sendTaskNotification(completedRun, task.notification).catch((err) => {
          console.error(`[CronScheduler] Notification error for task ${task.id}:`, err)
        })
      }

      // If non-recurring, disable after first run
      if (!task.recurring) {
        await this.cronService.updateTask(task.id, { enabled: false }).catch(() => {
          // Task may have been deleted
        })
      }

      return completedRun
    } catch (err) {
      // spawnTaskAttempt's finally already cleared its per-attempt timeout and
      // removed the runningTasks entry when the proc matched. If Bun.spawn
      // threw before the entry was set, delete is a harmless no-op.
      this.runningTasks.delete(task.id)

      const completedAt = new Date().toISOString()
      const failedRun: TaskRun = {
        ...run,
        completedAt,
        status: 'failed',
        error: (err as Error).message,
        durationMs:
          new Date(completedAt).getTime() - new Date(startedAt).getTime(),
      }

      await this.persistScheduledSessionPermission(sessionId, workDir)
      await updateRun(failedRun, runLogTarget)

      return failedRun
    }
  }

  /**
   * Spawn one CLI attempt for a task, collect its stdout/stderr and exit code,
   * and enforce the per-attempt timeout. Manages the `runningTasks` guard for
   * the lifetime of this attempt only, so the retry loop in {@link executeTask}
   * can re-enter cleanly. Extracted for the 429 backoff-retry path.
   */
  private async spawnTaskAttempt(params: {
    task: CronTask
    runId: string
    inputPayload: string
    cliArgs: string[]
    workDir: string
    childEnv: Record<string, string | undefined>
    taskTimeoutMs: number
  }): Promise<{
    exitCode: number
    rawOutput: string
    stderrText: string
    wasTimeout: boolean
    durationMs: number
  }> {
    const { task, runId, inputPayload, cliArgs, workDir, childEnv, taskTimeoutMs } =
      params
    const attemptStartedAt = Date.now()
    const proc = Bun.spawn(
      cliArgs,
      buildCronTaskSpawnOptions(workDir, childEnv),
    )

    this.runningTasks.set(task.id, { proc, startedAt: attemptStartedAt, runId })

    // Write prompt to stdin then close it
    try {
      proc.stdin.write(inputPayload)
      proc.stdin.end()
    } catch {
      // If writing fails, the process may have already exited
    }

    // Set up a timeout for this attempt
    const timeoutId = setTimeout(() => {
      if (this.runningTasks.get(task.id)?.proc === proc) {
        try {
          proc.kill()
        } catch {
          // ignore
        }
      }
    }, taskTimeoutMs)

    try {
      // Collect stdout
      const stdoutChunks: string[] = []
      if (proc.stdout) {
        const reader = proc.stdout.getReader()
        const decoder = new TextDecoder()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            stdoutChunks.push(decoder.decode(value, { stream: true }))
          }
        } catch {
          // stream may be interrupted on kill
        }
      }

      // Wait for exit
      const exitCode = await proc.exited
      const wasTimeout = Date.now() - attemptStartedAt >= taskTimeoutMs
      const rawOutput = stdoutChunks.join('')

      let stderrText = ''
      if (exitCode !== 0 && proc.stderr) {
        try {
          stderrText = await new Response(proc.stderr).text()
        } catch {
          // ignore
        }
      }

      return { exitCode, rawOutput, stderrText, wasTimeout, durationMs: Date.now() - attemptStartedAt }
    } finally {
      clearTimeout(timeoutId)
      if (this.runningTasks.get(task.id)?.proc === proc) {
        this.runningTasks.delete(task.id)
      }
    }
  }

  /**
   * Detect one-shot reservations whose target time passed while the server was
   * down and never fired. For each, disable the task (so its pinned cron cannot
   * re-trigger next year) and record a `missed` run so the existing desktop
   * notification path can tell the user to run it now or reschedule. We never
   * auto-run a missed reservation.
   */
  async detectMissedOneShotTasks(): Promise<void> {
    const now = new Date()
    let tasks: CronTask[]
    try {
      tasks = await this.cronService.listTasks()
    } catch (err) {
      console.error('[CronScheduler] Error listing tasks for missed detection:', err)
      return
    }

    const missed = findMissedOneShotTasks(tasks, now)
    if (missed.length === 0) return

    const runLogTarget = captureRunsFileMutationTarget()
    for (const task of missed) {
      // Disable first so the pinned cron cannot fire again, then record the
      // missed run. Both are best-effort: a deleted task must not abort the
      // sweep of the remaining ones.
      await this.cronService
        .updateTask(task.id, { enabled: false })
        .catch(() => {})

      const missedAt = now.toISOString()
      const missedRun: TaskRun = {
        id: crypto.randomBytes(6).toString('hex'),
        taskId: task.id,
        taskName: task.name || task.prompt.slice(0, 60),
        startedAt: missedAt,
        completedAt: missedAt,
        status: 'missed',
        prompt: task.prompt,
        durationMs: 0,
      }
      await appendRun(missedRun, runLogTarget).catch((err) => {
        console.error(
          `[CronScheduler] Failed to record missed run for task ${task.id}:`,
          err,
        )
      })
      console.warn(
        `[CronScheduler] One-shot reservation ${task.id} was missed while the server was down; disabled it`,
      )
    }
  }

  private async persistScheduledSessionPermission(
    sessionId: string | undefined,
    workDir: string,
  ): Promise<void> {
    if (!sessionId) return
    await this.sessionService.appendSessionMetadata(sessionId, {
      workDir,
      permissionMode: 'bypassPermissions',
    }).catch(() => {
      // The task result is still valid even if session metadata refresh fails.
    })
  }

  private resolveCanonicalWorkDir(workDir: string): string {
    try {
      return realpathSync(workDir)
    } catch {
      return workDir
    }
  }

  private getRuntimeArgs(task: CronTask): string[] {
    const model = task.model?.trim()
    return [
      ...(model ? ['--model', model] : []),
      '--dangerously-skip-permissions',
      '--permission-mode',
      'bypassPermissions',
    ]
  }

  private async buildTaskChildEnv(
    workDir: string,
    task: CronTask,
  ): Promise<Record<string, string | undefined>> {
    const cleanEnv = await getProcessEnvWithTerminalShellEnvironment()
    delete cleanEnv.CLAUDE_CODE_OAUTH_TOKEN
    delete cleanEnv.CC_HAHA_AGENT_TEAMS_ENABLED

    if (this.shouldStripInheritedProviderEnv(task.providerId)) {
      for (const key of Object.keys(cleanEnv)) {
        if (isProviderManagedEnvVar(key)) {
          delete cleanEnv[key]
        }
      }
    }

    const explicitProviderEnv =
      typeof task.providerId === 'string'
        ? await this.providerService.getProviderRuntimeEnv(task.providerId)
        : null
    if (explicitProviderEnv && task.model?.trim()) {
      explicitProviderEnv.ANTHROPIC_MODEL = task.model.trim()
    }
    const attributionHeaderEnv = attributionHeaderEnvForModel(
      task.model?.trim() ||
        explicitProviderEnv?.ANTHROPIC_MODEL ||
        cleanEnv.ANTHROPIC_MODEL,
    )
    const networkSettings = await loadNetworkSettings()
    // Per-provider NETWORK egress override for the scheduled task's target
    // provider (or the active provider when the task pins none), matching the
    // interactive CLI launch path.
    const effectiveProxyMode: NetworkProxyMode = resolveEffectiveProxyMode(
      networkSettings,
      await this.providerService.getProviderUseProxyForRouting(task.providerId),
    )
    const networkEnv = buildNetworkEnvironment(
      networkSettings,
      cleanEnv,
      effectiveProxyMode,
    )
    const agentTeamsEnabled = await new SettingsService().getAgentTeamsEnabled()

    return {
      ...cleanEnv,
      CLAUDE_CODE_ENABLE_TASKS: '1',
      CC_HAHA_AGENT_TEAMS_ENABLED: agentTeamsEnabled ? '1' : '0',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-cli',
      CALLER_DIR: workDir,
      PWD: workDir,
      CC_HAHA_SKIP_DOTENV: '1',
      ...(explicitProviderEnv
        ? {
            CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
            CLAUDE_CODE_ENTRYPOINT: 'sdk-cli',
          }
        : {}),
      ...(explicitProviderEnv ?? {}),
      ...(this.shouldMarkManagedOAuth(task.providerId)
        ? await this.buildOfficialOAuthEnv()
        : {}),
      ...networkEnv,
      ...attributionHeaderEnv,
    }
  }

  private getConfigDir(): string {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  }

  private shouldStripInheritedProviderEnv(providerId?: string | null): boolean {
    if (providerId !== undefined) {
      return true
    }

    const ccHahaDir = path.join(this.getConfigDir(), 'cc-haha')
    if (existsSync(path.join(ccHahaDir, 'providers.json'))) {
      return true
    }

    try {
      const raw = readFileSync(path.join(ccHahaDir, 'settings.json'), 'utf-8')
      const parsed = JSON.parse(raw) as { env?: Record<string, string> }
      const env = parsed.env ?? {}
      return Object.entries(env).some(
        ([key, value]) =>
          isProviderManagedEnvVar(key) &&
          typeof value === 'string' &&
          value.trim().length > 0,
      )
    } catch {
      return false
    }
  }

  private shouldMarkManagedOAuth(providerId?: string | null): boolean {
    if (providerId === null) {
      return true
    }
    if (typeof providerId === 'string') {
      return false
    }

    try {
      const raw = readFileSync(
        path.join(this.getConfigDir(), 'cc-haha', 'settings.json'),
        'utf-8',
      )
      const parsed = JSON.parse(raw) as { env?: Record<string, string> }
      const env = parsed.env ?? {}
      const hasProviderEnv = [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
      ].some(
        (key) =>
          typeof env[key] === 'string' && env[key]!.trim().length > 0,
      )
      return !hasProviderEnv
    } catch {
      return true
    }
  }

  private async buildOfficialOAuthEnv(): Promise<Record<string, string>> {
    const env: Record<string, string> = {
      CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
    }
    try {
      const { hahaOAuthService } = await import('./hahaOAuthService.js')
      const token = await hahaOAuthService.ensureFreshAccessToken()
      if (token) {
        env.CLAUDE_CODE_OAUTH_TOKEN = token
      }
    } catch (err) {
      console.error(
        '[cronScheduler] ensureFreshAccessToken failed:',
        err instanceof Error ? err.message : err,
      )
    }
    return env
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  /**
   * Mark stale "running" entries as "failed" on startup.
   * These are leftover from previous process instances that crashed or were
   * killed before they could update the run log.
   */
  private async cleanupStaleRuns(): Promise<void> {
    const target = captureRunsFileMutationTarget()
    const data = await readRunsFile(target.sourcePath)
    let changed = false
    const now = Date.now()
    const taskTimeoutMs = resolveCronTaskTimeoutMs()

    for (const run of data.runs) {
      if (run.status !== 'running') continue
      const startedAt = new Date(run.startedAt).getTime()
      // If "running" for longer than the task timeout + 1-minute buffer,
      // the owning process is certainly dead.
      if (now - startedAt > taskTimeoutMs + 60_000) {
        run.status = 'failed'
        run.error = 'Process terminated before task could complete'
        run.completedAt = new Date().toISOString()
        run.durationMs = now - startedAt
        changed = true
        console.log(
          `[CronScheduler] Cleaned up stale run ${run.id} for task ${run.taskId}`,
        )
      }
    }

    if (changed) {
      await writeRunsFile(data, target)
    }
  }

  // ─── Query helpers ─────────────────────────────────────────────────────────

  /** Get execution history for a specific task. */
  async getTaskRuns(taskId: string): Promise<TaskRun[]> {
    const sourcePath = getLogFilePath()
    const mode = resolveLocalIndexMode().mode
    if (mode === 'off' || mode === 'shadow') {
      if (mode === 'off') deactivateScheduledRunReadModel(sourcePath)
      const source = await readRunsFilePageSource(sourcePath)
      const canonical = paginateScheduledRunRecords(
        source.data.runs,
        { taskId, limit: 2_147_483_647 },
        source.cursorRevision,
      ).runs as TaskRun[]
      if (mode === 'shadow') {
        await compareScheduledRunPageInShadow(
          sourcePath,
          source,
          { taskId },
          'getTaskRuns',
        )
      }
      return canonical
    }
    const projected = await readScheduledRunPage(sourcePath, {
      taskId,
      limit: 2_147_483_647,
    })
    if (projected) return projected.runs as TaskRun[]
    const data = await readRunsFile(sourcePath)
    return data.runs
      .filter((r) => r.taskId === taskId)
      .sort(
        (a, b) =>
          new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      )
  }

  /** Get recent runs across all tasks. */
  async getRecentRuns(limit = 50): Promise<TaskRun[]> {
    const sourcePath = getLogFilePath()
    const mode = resolveLocalIndexMode().mode
    if (mode === 'off' || mode === 'shadow') {
      if (mode === 'off') deactivateScheduledRunReadModel(sourcePath)
      const source = await readRunsFilePageSource(sourcePath)
      const canonical = paginateScheduledRunRecords(
        source.data.runs,
        { limit },
        source.cursorRevision,
      ).runs as TaskRun[]
      if (mode === 'shadow') {
        await compareScheduledRunPageInShadow(
          sourcePath,
          source,
          {},
          'getRecentRuns',
        )
      }
      return canonical
    }
    const projected = await readScheduledRunPage(sourcePath, { limit })
    if (projected) return projected.runs as TaskRun[]
    const data = await readRunsFile(sourcePath)
    return data.runs
      .sort(
        (a, b) =>
          new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      )
      .slice(0, limit)
  }

  async getRunsPage(options: ScheduledRunPageOptions = {}): Promise<ScheduledRunPageResult> {
    const sourcePath = getLogFilePath()
    const mode = resolveLocalIndexMode().mode
    if (mode === 'off' || mode === 'shadow') {
      if (mode === 'off') deactivateScheduledRunReadModel(sourcePath)
      const source = await readRunsFilePageSource(sourcePath)
      const canonical = paginateScheduledRunRecords(
        source.data.runs,
        options,
        source.cursorRevision,
      ) as ScheduledRunPageResult
      if (mode === 'shadow') {
        await compareScheduledRunPageInShadow(
          sourcePath,
          source,
          options,
          'getRunsPage',
        )
      }
      return canonical
    }
    const projected = await readScheduledRunPage(sourcePath, options)
    if (projected) return projected as {
      runs: Array<TaskRun | ScheduledRunSummary>
      nextCursor?: string
      revision: number
      revisionToken: string
      reset?: boolean
    }

    const source = await readRunsFilePageSource(sourcePath)
    return paginateScheduledRunRecords(
      source.data.runs,
      options,
      source.cursorRevision,
    ) as {
      runs: Array<TaskRun | ScheduledRunSummary>
      nextCursor?: string
      revisionToken?: string
      reset?: boolean
    }
  }

  async getRunDetail(runId: string): Promise<TaskRun | null> {
    const sourcePath = getLogFilePath()
    const mode = resolveLocalIndexMode().mode
    if (mode === 'off') deactivateScheduledRunReadModel(sourcePath)
    const data = await readRunsFile(sourcePath)
    return data.runs.find(run => run.id === runId) ?? null
  }
}

// ─── Singleton export ──────────────────────────────────────────────────────────

export const cronScheduler = new CronScheduler()
