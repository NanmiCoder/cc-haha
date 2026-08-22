import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import { logForDebugging } from '../debug.js'
import { agentWorktreeUnavailableReason } from '../worktree.js'
import { describeThrown, thrownName } from './errors.js'
import {
  WORKFLOW_AGENT_CAP_MESSAGE,
  WORKFLOW_AGENT_STALL_MS,
  WORKFLOW_LABEL_MAX_CHARS,
  WORKFLOW_MAX_AGENTS,
  WORKFLOW_MAX_FANOUT,
  WORKFLOW_PREVIEW_MAX_CHARS,
  getWorkflowConcurrency,
} from './constants.js'
import {
  WorkflowJournal,
  workflowCacheKey,
  type WorkflowJournalSnapshot,
} from './journal.js'
import { createLimiter, type Limiter } from './limiter.js'
import {
  createWorkflowAgentController,
  runWorkflowAgent,
  type WorkflowAgentRunParams,
  type WorkflowAgentRunResult,
} from './runWorkflowAgent.js'
import type {
  WorkflowAgentEvent,
  WorkflowAgentOptions,
  WorkflowProgressEvent,
} from './types.js'

/** Thrown when a script's loop keeps calling `agent()` past the hard cap. */
export class WorkflowAgentCapError extends Error {
  constructor() {
    super(WORKFLOW_AGENT_CAP_MESSAGE)
    this.name = 'WorkflowAgentCapError'
  }
}

/** Thrown when the turn's token target is exhausted mid-run. */
export class WorkflowBudgetExceededError extends Error {
  constructor(spent: number, total: number) {
    super(
      `Workflow token budget exceeded (${spent.toLocaleString()} / ${total.toLocaleString()} output tokens). ` +
        'Stopping further agent() calls. In-flight agents will complete; their results are preserved.',
    )
    this.name = 'WorkflowBudgetExceededError'
  }
}

export type WorkflowHarnessParams = {
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  runId: string
  /** `meta.name`, recorded on each agent's sidecar metadata. */
  workflowName: string
  emit: (event: WorkflowProgressEvent) => void
  /** Titles from `meta.phases`, seeded so the phase list exists before agents run. */
  seedPhaseTitles?: string[]
  tokenBudget?: { total: number | null; getTurnSpent: () => number }
  journal?: WorkflowJournal
  journalSnapshot?: WorkflowJournalSnapshot
  /** Registers/unregisters a running agent so the UI can skip or retry it. */
  onAgentController: (
    agentKey: string,
    controller: AbortController | undefined,
  ) => void
  abortSignal?: AbortSignal
  /** Overridable so tests can drive the harness without a live model. */
  runAgentImpl?: (
    params: WorkflowAgentRunParams,
  ) => Promise<WorkflowAgentRunResult>
  /**
   * Counters a nested `workflow()` child shares with its parent.
   *
   * Without this a child would get its own concurrency slot pool (doubling the
   * agents actually in flight) and its own index sequence (whose progress rows
   * would overwrite the parent's, since rows are keyed by index).
   */
  shared?: WorkflowSharedCounters
}

export type WorkflowSharedCounters = {
  limiter: Limiter
  nextAgentIndex: () => number
  getAgentCount: () => number
}

/** Counters for a top-level run; nested children are handed the same object. */
export function createWorkflowSharedCounters(): WorkflowSharedCounters {
  let agentCount = 0
  return {
    limiter: createLimiter(getWorkflowConcurrency()),
    nextAgentIndex: () => ++agentCount,
    getAgentCount: () => agentCount,
  }
}

export type WorkflowHarness = {
  agent: (prompt: unknown, opts?: unknown) => Promise<unknown>
  parallel: (thunks: unknown) => Promise<unknown[]>
  pipeline: (items: unknown, ...stages: unknown[]) => Promise<unknown[]>
  log: (message: unknown) => void
  phase: (title: unknown) => void
  getAgentCount: () => number
  getFailures: () => string[]
  recordFailure: (message: string) => void
}

/**
 * Build the globals a workflow script sees.
 *
 * Everything here is the host side of the VM boundary: values arriving from
 * the script are untrusted (they can be cross-realm objects, proxies, or
 * getters that throw), so each one is read defensively before use.
 */
export function createWorkflowHarness(
  params: WorkflowHarnessParams,
): WorkflowHarness {
  const {
    toolUseContext,
    canUseTool,
    runId,
    workflowName,
    emit,
    seedPhaseTitles,
    tokenBudget,
    journal,
    journalSnapshot,
    onAgentController,
    abortSignal,
    runAgentImpl = runWorkflowAgent,
    shared = createWorkflowSharedCounters(),
  } = params

  const runAgentLimiter = shared.limiter
  const failures: string[] = []
  const phaseIndexByTitle = new Map<string, number>()

  let phaseCounter = 0
  let currentPhase: string | undefined
  let capReported = false
  let budgetReported = false
  let isolationDegradeReported = false
  /** Journal replay stops permanently at the first cache miss (see resume docs). */
  let cacheExhausted = false
  let previousCacheKey = ''

  function resolvePhase(title: string, kind: 'meta' | 'script'): number {
    const existing = phaseIndexByTitle.get(title)
    if (existing !== undefined) return existing
    const index = ++phaseCounter
    phaseIndexByTitle.set(title, index)
    emit({ type: 'workflow_phase', index, title, kind })
    return index
  }

  for (const title of seedPhaseTitles ?? []) {
    if (typeof title === 'string' && title !== '') resolvePhase(title, 'meta')
  }

  function assertAgentCap(): void {
    if (shared.getAgentCount() < WORKFLOW_MAX_AGENTS) return
    if (!capReported) {
      capReported = true
      logForDebugging(`Workflow ${runId} hit the ${WORKFLOW_MAX_AGENTS}-agent cap`)
    }
    throw new WorkflowAgentCapError()
  }

  function assertBudget(): void {
    const total = tokenBudget?.total
    if (total == null || total <= 0) return
    const spent = tokenBudget.getTurnSpent()
    if (spent < total) return
    if (!budgetReported) {
      budgetReported = true
      logForDebugging(`Workflow ${runId} exhausted its ${total} token budget`)
    }
    throw new WorkflowBudgetExceededError(spent, total)
  }

  function neverResolves<T>(): Promise<T> {
    // An aborted run must not let the script continue past the await: the task
    // is already terminal, so the cleanest stop is a promise that never settles.
    return new Promise<T>(() => {})
  }

  const agent = async (
    rawPrompt: unknown,
    rawOpts?: unknown,
  ): Promise<unknown> => {
    if (abortSignal?.aborted) return neverResolves()
    const prompt = coerceToString(rawPrompt)
    const opts = readAgentOptions(rawOpts)

    assertAgentCap()
    assertBudget()

    const index = shared.nextAgentIndex()
    const label = deriveLabel(prompt, opts.label)
    const phaseTitle = opts.phase ?? currentPhase
    const phaseIndex =
      phaseTitle !== undefined ? resolvePhase(phaseTitle, 'script') : undefined
    const model = opts.model ?? toolUseContext.options.mainLoopModel
    const promptPreview = clip(prompt, WORKFLOW_PREVIEW_MAX_CHARS)

    if (opts.isolation === 'remote') {
      throw new Error(
        "agent({isolation:'remote'}) is not available in this build",
      )
    }

    // A workspace with no git repository and no WorktreeCreate hook cannot
    // provision a worktree. That is not a reason to fail the agent — it runs
    // in the workspace directory instead — but the run must say so once, and
    // the progress row must not claim an isolation the agent never got.
    const isolationUnavailable =
      opts.isolation === 'worktree' ? agentWorktreeUnavailableReason() : null
    if (isolationUnavailable && !isolationDegradeReported) {
      isolationDegradeReported = true
      emit({
        type: 'workflow_log',
        message:
          `worktree isolation unavailable (${isolationUnavailable}) — agents run in the workspace directory. ` +
          'Run `git init` there, or configure WorktreeCreate/WorktreeRemove hooks, for isolated runs.',
      })
    }

    const cacheKey = journal
      ? workflowCacheKey(prompt, opts, previousCacheKey)
      : undefined
    if (cacheKey !== undefined) previousCacheKey = cacheKey

    if (cacheKey !== undefined && !cacheExhausted) {
      const cached = journalSnapshot?.results.get(cacheKey)
      if (cached !== undefined) {
        const now = Date.now()
        emit({
          type: 'workflow_agent',
          index,
          label,
          state: 'done',
          phaseIndex,
          phaseTitle,
          model,
          agentId: cached.agentId,
          startedAt: now,
          lastProgressAt: now,
          cached: true,
          promptPreview,
          resultPreview: clip(
            coerceToString(cached.result),
            WORKFLOW_PREVIEW_MAX_CHARS,
          ),
        })
        return cached.result
      }
      // First miss: every later agent started after this one, so none of their
      // cached results are valid any more.
      cacheExhausted = true
    }

    const queuedAt = Date.now()
    const baseEvent: WorkflowAgentEvent = {
      type: 'workflow_agent',
      index,
      label,
      state: 'start',
      phaseIndex,
      phaseTitle,
      model,
      queuedAt,
      lastProgressAt: queuedAt,
      promptPreview,
      ...(opts.agentType ? { agentType: opts.agentType } : {}),
      ...(opts.isolation === 'worktree' && !isolationUnavailable
        ? { isolation: 'worktree' as const }
        : {}),
    }
    emit(baseEvent)

    const agentKey = `${runId}-${index}`
    return runAgentLimiter(async () => {
      if (abortSignal?.aborted) return neverResolves()
      assertBudget()

      const controller = createWorkflowAgentController(abortSignal)
      onAgentController(agentKey, controller)
      const startedAt = Date.now()
      let tokens = 0
      let toolCalls = 0
      let agentId: string | undefined
      const stallMs = opts.stallMs ?? WORKFLOW_AGENT_STALL_MS
      let lastProgressAt = startedAt
      const stallTimer = setInterval(() => {
        if (Date.now() - lastProgressAt < stallMs) return
        emit({
          ...baseEvent,
          state: 'progress',
          startedAt,
          lastProgressAt,
          tokens,
          toolCalls,
          agentId,
        })
      }, Math.max(5_000, Math.floor(stallMs / 2)))
      stallTimer.unref?.()

      emit({ ...baseEvent, state: 'progress', startedAt, lastProgressAt })

      try {
        const result = await runAgentImpl({
          prompt,
          opts,
          toolUseContext,
          canUseTool,
          runId,
          ownerAgentId: toolUseContext.agentId,
          // Written to the agent's sidecar before it starts, so a finished
          // run can be rebuilt from disk long after the progress stream is
          // gone. Nothing else persists which phase an agent belonged to.
          workflow: {
            runId,
            name: workflowName,
            phaseIndex: phaseIndex ?? 0,
            ...(phaseTitle ? { phaseTitle } : {}),
            agentIndex: index,
          },
          abortController: controller,
          onAgentId: id => {
            agentId = id
            void journal
              ?.append({ type: 'started', key: cacheKey ?? '', agentId: id })
              .catch(error =>
                logForDebugging(`workflow journal started-append failed: ${error}`),
              )
          },
          onProgress: progress => {
            tokens = progress.tokens
            toolCalls = progress.toolCalls
            lastProgressAt = Date.now()
            emit({
              ...baseEvent,
              state: 'progress',
              startedAt,
              lastProgressAt,
              tokens,
              toolCalls,
              agentId,
              ...(progress.lastToolName
                ? { lastToolName: progress.lastToolName }
                : {}),
            })
          },
        })

        emit({
          ...baseEvent,
          state: 'done',
          agentId: result.agentId,
          startedAt,
          lastProgressAt: Date.now(),
          durationMs: Date.now() - startedAt,
          tokens: result.tokens,
          toolCalls: result.toolCalls,
          resultPreview: clip(
            coerceToString(result.value),
            WORKFLOW_PREVIEW_MAX_CHARS,
          ),
        })

        if (cacheKey !== undefined) {
          void journal
            ?.append({
              type: 'result',
              key: cacheKey,
              agentId: result.agentId,
              result: result.value,
            })
            .catch(error =>
              logForDebugging(`workflow journal result-append failed: ${error}`),
            )
        }
        return result.value
      } catch (error) {
        const skipped =
          describeThrown(controller.signal.reason).includes('user-skip')
        const message = skipped ? 'skipped by user' : describeThrown(error)
        emit({
          ...baseEvent,
          state: 'error',
          agentId,
          startedAt,
          lastProgressAt: Date.now(),
          durationMs: Date.now() - startedAt,
          tokens,
          toolCalls,
          error: message,
          ...(skipped ? { skipped: true } : {}),
        })
        if (abortSignal?.aborted) return neverResolves()
        // A skipped agent resolves to null so the surrounding pipeline keeps
        // going; a real failure propagates so the script can react.
        if (skipped) return null
        throw error
      } finally {
        clearInterval(stallTimer)
        onAgentController(agentKey, undefined)
      }
    })
  }

  const parallel = async (rawThunks: unknown): Promise<unknown[]> => {
    if (abortSignal?.aborted) return neverResolves()
    const thunks = readArray(rawThunks, 'parallel() expects an array of functions')
    if (thunks.length === 0) return []
    assertAgentCap()
    assertBudget()
    for (const thunk of thunks) {
      if (typeof thunk !== 'function') {
        throw new TypeError(
          'parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)',
        )
      }
    }
    const settled = await Promise.allSettled(
      thunks.map(thunk => {
        try {
          return Promise.resolve((thunk as () => unknown)())
        } catch (error) {
          return Promise.reject(error)
        }
      }),
    )
    return collectSettled(settled, 'parallel')
  }

  const pipeline = async (
    rawItems: unknown,
    ...rawStages: unknown[]
  ): Promise<unknown[]> => {
    if (abortSignal?.aborted) return neverResolves()
    const items = readArray(
      rawItems,
      'pipeline() expects an array as the first argument',
    )
    if (items.length === 0) return []
    assertAgentCap()
    assertBudget()
    const stages = rawStages.flat()
    for (const stage of stages) {
      if (typeof stage !== 'function') {
        throw new TypeError(
          'pipeline() stages must be functions: pipeline(items, item => ..., result => ...)',
        )
      }
    }
    const settled = await Promise.allSettled(
      items.map(async (item, index) => {
        let value: unknown = item
        for (const stage of stages) {
          if (value === null) break
          value = await (stage as (
            prev: unknown,
            original: unknown,
            index: number,
          ) => unknown)(value, item, index)
        }
        return value
      }),
    )
    return collectSettled(settled, 'pipeline')
  }

  /**
   * Turn a settled batch into the script-visible array.
   *
   * A rejected slot becomes `null` rather than rejecting the whole call — one
   * bad file in a 500-file migration should not discard the other 499. The
   * failure is still recorded so it reaches the final report.
   */
  function collectSettled(
    settled: PromiseSettledResult<unknown>[],
    kind: 'parallel' | 'pipeline',
  ): unknown[] {
    let budgetDrops = 0
    const values = settled.map((entry, index) => {
      if (entry.status === 'fulfilled') return entry.value
      const reason = entry.reason
      if (thrownName(reason) === 'WorkflowBudgetExceededError') {
        budgetDrops++
        return null
      }
      const message = `${kind}[${index}] failed: ${describeThrown(reason)}`
      failures.push(message)
      emit({ type: 'workflow_log', message })
      return null
    })
    if (budgetDrops > 0) {
      failures.push(
        `${kind}: ${budgetDrops} slot${budgetDrops === 1 ? '' : 's'} dropped — token budget exceeded`,
      )
    }
    return values
  }

  const log = (rawMessage: unknown): void => {
    emit({ type: 'workflow_log', message: coerceToString(rawMessage) })
  }

  const phase = (rawTitle: unknown): void => {
    const title = coerceToString(rawTitle)
    if (title === '') return
    currentPhase = title
    resolvePhase(title, 'script')
  }

  return {
    agent,
    parallel,
    pipeline,
    log,
    phase,
    getAgentCount: shared.getAgentCount,
    getFailures: () => failures,
    recordFailure: message => failures.push(message),
  }
}

/**
 * Copy the options object out of the VM before use.
 *
 * The script owns that object and could keep mutating it (or define getters
 * that throw) while the agent runs; a flat snapshot of the known keys is the
 * only version the runtime trusts. `schema` is passed through by reference
 * because `createSyntheticOutputTool` caches compiled validators on identity.
 */
function readAgentOptions(raw: unknown): WorkflowAgentOptions {
  if (raw === null || typeof raw !== 'object') return {}
  const opts: WorkflowAgentOptions = {}
  const label = readProp(raw, 'label')
  if (label != null) opts.label = String(label)
  const phase = readProp(raw, 'phase')
  if (phase != null) opts.phase = String(phase)
  const model = readProp(raw, 'model')
  if (model != null) opts.model = String(model)
  const effort = readProp(raw, 'effort')
  if (effort != null) opts.effort = String(effort)
  const agentType = readProp(raw, 'agentType')
  if (agentType != null) opts.agentType = String(agentType)
  const isolation = readProp(raw, 'isolation')
  if (isolation === 'worktree' || isolation === 'remote') {
    opts.isolation = isolation
  }
  const stallMs = readProp(raw, 'stallMs')
  if (typeof stallMs === 'number' && Number.isFinite(stallMs)) {
    opts.stallMs = stallMs
  }
  const schema = readProp(raw, 'schema')
  if (schema != null && typeof schema === 'object') opts.schema = schema
  return opts
}

function readProp(target: unknown, key: string): unknown {
  try {
    return (target as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

function readArray(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(message)
  if (value.length > WORKFLOW_MAX_FANOUT) {
    throw new RangeError(
      `A single parallel()/pipeline() call accepts at most ${WORKFLOW_MAX_FANOUT} items (got ${value.length})`,
    )
  }
  return [...value]
}

function deriveLabel(prompt: string, explicit: string | undefined): string {
  const source = explicit ?? prompt.slice(0, WORKFLOW_LABEL_MAX_CHARS)
  return source.replace(/\s+/g, ' ').trim() || 'agent'
}

function clip(value: string, max: number): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

/** Render any script value as a string without invoking its toString trap. */
function coerceToString(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'function') return '[function]'
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? '[object]'
    } catch {
      return '[object]'
    }
  }
  return String(value)
}
