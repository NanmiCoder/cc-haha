import { createHash, randomUUID } from 'node:crypto'
import { migrationMaintenance } from '../migrationMaintenance.js'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isValidTeamMemberName, teamPlanRecordSchema, type TeamPlanRecord, type TeamPlanMember } from '../../shared/teamPlan.js'
import { conversationService } from './conversationService.js'
import { ProviderService } from './providerService.js'
import { CLAUDE_OFFICIAL_PROVIDER_ID } from '../types/provider.js'
import { normalizeExplicitClaudeOfficialModelId } from './claudeOfficialRuntime.js'
import { getModelReasoningCapabilityOverride, isModelReasoningEffort, normalizeModelReasoningEffort } from '../../shared/modelReasoning.js'
import { getPresetDefaultEnv, getPresetReasoningProviderKind } from './providerRuntimeEnv.js'
import { validateTeamPlanPresetSource } from '../../utils/swarm/teamPlanPresetSource.js'
import { readTeamPlan, findTeamPlanForSession, mutateTeamPlan } from '../../utils/swarm/teamPlanStore.js'
import { cleanupTeamDirectories, getTeamDir, mutateTeamFileAsync, readTeamFile, writeTeamFileAsync, type TeamFile } from '../../utils/swarm/teamHelpers.js'
import { getTeamsDir as getTeamsDirectory } from '../../utils/envUtils.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { createTask, listTasks, updateTask, withTaskListLifecycleLock, getCanonicalTeamTaskListId, type Task } from '../../utils/tasks.js'
import { readUnreadMessages, markMessagesAsReadByPredicate, writeToMailbox, createIdleNotification, formatTeammateMessages, type TeammateMessage } from '../../utils/teammateMailbox.js'
import { formatTeammateAutoContinuePrompt, isTransientTurnFailure, summarizeTurnFailure, TEAMMATE_AUTO_CONTINUE_DELAYS_MS } from '../../utils/swarm/turnFailure.js'

const providerService = new ProviderService()
const essentialTools = ['SendMessage', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate']

const SUPERVISOR_INTERVAL_MS = 250
const WORKER_AUTO_CONTINUE_DELAYS_MS = TEAMMATE_AUTO_CONTINUE_DELAYS_MS
const WORKER_RESTART_WINDOW_MS = 10 * 60_000
const WORKER_MAX_RESTARTS_IN_WINDOW = 3
/** Let a member finish its own bookkeeping before a newly ready task wakes it. */
const UNBLOCKED_TASK_WAKE_DELAY_MS = 3_000
const timing = {
  autoContinueDelaysMs: WORKER_AUTO_CONTINUE_DELAYS_MS,
  unblockedTaskWakeDelayMs: UNBLOCKED_TASK_WAKE_DELAY_MS,
}

/** Tests shorten the supervisor's real-time backoffs; `null` restores them. */
export function setTeamRuntimeTimingForTests(overrides: Partial<typeof timing> | null): void {
  timing.autoContinueDelaysMs = overrides?.autoContinueDelaysMs ?? WORKER_AUTO_CONTINUE_DELAYS_MS
  timing.unblockedTaskWakeDelayMs = overrides?.unblockedTaskWakeDelayMs ?? UNBLOCKED_TASK_WAKE_DELAY_MS
}
const RESULT_TEXT_LIMIT = 4_000
const FAILURE_REASON_LIMIT = 200

type WorkerRuntime = {
  member: TeamPlanMember
  sessionId: string
  released: boolean
  starting?: Promise<boolean>
  autoContinueAttempts: number
  autoContinueTimer?: ReturnType<typeof setTimeout>
  restartHistory: number[]
  /** Automatic restarts stopped after a crash loop; only an explicit message retries. */
  restartsExhausted: boolean
  /** The user's Stop ended this process; resuming it is not a crash restart. */
  stoppedByUser?: boolean
  wokenForTaskIds: Set<string>
  lastResultAt?: number
}

type TeamLaunch = {
  parentId: string
  plan: TeamPlanRecord
  createdAt: number
  released: boolean
  /** True once every member has been released and the supervisor owns the team. */
  running: boolean
  children: string[]
  workers: Map<string, WorkerRuntime>
  timer?: ReturnType<typeof setInterval>
  supervising: boolean
  stopped: boolean
  /** Set by the user's Stop: hold automatic work until the lead or the user acts again. */
  pausedAt?: number
  /** The lead has not yet been told what the user's last Stop did to this team. */
  pauseNoticePending?: boolean
  permissionMode: string
}

const launches = new Map<string, TeamLaunch>()

function incarnationOf(team: Pick<TeamFile, 'name' | 'leadSessionId' | 'createdAt'>): string {
  return createHash('sha256').update(JSON.stringify([team.name, team.leadSessionId || '', team.createdAt])).digest('hex')
}

/** Validation is local: checking a proposal never invokes a model or discovers credentials. */
export async function validateTeamPlanRuntime(plan: TeamPlanRecord): Promise<TeamPlanRecord> {
  if (!(await stat(plan.workDir)).isDirectory()) throw new Error('Team working directory is unavailable')
  const team = plan.teamName ? readTeamFile(plan.teamName) : null
  if (plan.teamName && (!team || team.leadSessionId !== plan.sessionId || incarnationOf(team) !== plan.incarnationId)) throw new Error('Team generation no longer exists')
  const members: TeamPlanMember[] = []
  for (const member of plan.members) {
    if (!isValidTeamMemberName(member.name)) throw new Error(`Invalid teammate name: ${member.name}`)
    if (team?.members.some(existing => existing.name === member.name)) throw new Error(`Member already exists: ${member.name}. Message the existing member to give it more work; a stopped member restarts from its saved conversation.`)
    const snapshot = plan.agentCatalog?.[member.agentType]
    if (!snapshot || !snapshot.systemPrompt.trim()) throw new Error(`Agent preset is unavailable: ${member.agentType}`)
    validateTeamPlanPresetSource(snapshot)
    if (snapshot.configurationError) throw new Error(`Agent preset ${member.agentType}: ${snapshot.configurationError}`)
    if (snapshot.permissionMode && snapshot.permissionMode !== 'default' && snapshot.permissionMode !== conversationService.getSessionPermissionMode(plan.sessionId)) throw new Error(`Agent preset ${member.agentType} requires permission mode ${snapshot.permissionMode}; adjust the preset or leader permission mode and submit a new plan`)
    const unsupported = [
      ...(snapshot.isolation ? ['isolation'] : []),
    ]
    if (unsupported.length) throw new Error(`Agent preset ${member.agentType} uses unsupported team worker settings: ${unsupported.join(', ')}`)
    if (snapshot.maxTurns !== undefined && (!Number.isInteger(snapshot.maxTurns) || snapshot.maxTurns < 1)) throw new Error(`Agent preset ${member.agentType} has invalid maxTurns`)
    const provider = member.runtime.providerId === CLAUDE_OFFICIAL_PROVIDER_ID ? null : await providerService.getProvider(member.runtime.providerId)
    const requestedModel = member.runtime.modelId.trim()
    const aliases = provider?.models as Record<string, string> | undefined
    if (provider && ['default', 'main', 'fable', 'sonnet', 'opus', 'haiku'].includes(requestedModel) && !aliases?.[requestedModel === 'default' ? 'main' : requestedModel]) throw new Error(`Provider has no mapping for ${requestedModel}`)
    const modelId = provider
      ? (aliases?.[requestedModel === 'default' ? 'main' : requestedModel] || requestedModel)
      : normalizeExplicitClaudeOfficialModelId(requestedModel)
    if (!modelId || !/^[^\s\x00-\x1f]+$/.test(modelId) || modelId === 'inherit') throw new Error(`Choose a concrete model for ${member.name}`)
    const requestedEffort = member.runtime.effortLevel
    if (requestedEffort !== undefined && (!isModelReasoningEffort(requestedEffort) || !normalizeModelReasoningEffort(modelId, requestedEffort, provider?.apiFormat ?? 'anthropic', provider ? getModelReasoningCapabilityOverride(modelId, provider.models, getPresetDefaultEnv(provider.presetId)) : undefined, provider ? getPresetReasoningProviderKind(provider.presetId) : undefined))) throw new Error(`Unsupported reasoning effort for ${member.name}`)
    const runtime = { ...member.runtime, modelId }

    // These restrictions would break the team's mailbox protocol even if the
    // preset were allowed to execute its task successfully.
    if (snapshot.disallowedTools?.some(tool => essentialTools.includes(tool.split('(')[0]!))) throw new Error(`Agent preset ${member.agentType} disables team communication tools`)
    members.push({ ...member, providerName: provider?.name ?? 'Claude', runtime, agentSnapshot: structuredClone(snapshot) })
  }
  if (new Set(members.map(member => member.name)).size !== members.length) throw new Error('Teammate names must be unique')
  return { ...plan, members }
}

/** All children must acknowledge the model control before any task is released. */
export async function startTeamWorkersBarrier<T>(
  members: readonly T[],
  prepare: (member: T) => Promise<string>,
  release: (member: T, id: string) => Promise<void>,
  stop: (id: string) => Promise<void>,
): Promise<string[]> {
  const ids: string[] = []
  try {
    for (const member of members) ids.push(await prepare(member))
  } catch (error) {
    await Promise.allSettled(ids.map(stop))
    throw error
  }
  // A release failure is not retried: another worker may already have acted.
  try {
    for (let i = 0; i < members.length; i++) await release(members[i]!, ids[i]!)
  } catch (error) {
    await Promise.allSettled(ids.map(stop))
    throw error
  }
  return ids
}

async function materializeTasks(plan: TeamPlanRecord): Promise<Record<string, string>> {
  const existing = await listTasks(getCanonicalTeamTaskListId(plan.teamName))
  const mapping: Record<string, string> = {}
  for (const task of plan.approvedSnapshot!.tasks) {
    const old = existing.find(entry => entry.metadata?.teamPlanId === plan.planId && entry.metadata?.teamPlanTaskId === task.id)
      ?? existing.find(entry => entry.id === task.id && entry.subject === task.subject && !entry.metadata?.teamPlanId)
    mapping[task.id] = old?.id ?? await createTask(getCanonicalTeamTaskListId(plan.teamName), {
      subject: task.subject, description: task.description ?? '', status: 'pending', blocks: [], blockedBy: [],
      metadata: { teamPlanId: plan.planId, teamPlanTaskId: task.id },
    })
  }
  for (const task of plan.approvedSnapshot!.tasks) {
    const owner = plan.approvedSnapshot!.members.find(member => member.id === task.ownerId)
    await updateTask(getCanonicalTeamTaskListId(plan.teamName), mapping[task.id]!, {
      subject: task.subject, description: task.description ?? '',
      owner: owner?.name,
      blockedBy: task.dependencies.map(id => mapping[id]!),
      blocks: plan.approvedSnapshot!.tasks.filter(other => other.dependencies.includes(task.id)).map(other => mapping[other.id]!),
      metadata: { ...existing.find(entry => entry.id === mapping[task.id])?.metadata, teamPlanId: plan.planId, teamPlanTaskId: task.id },
    })
  }
  return mapping
}

// ── Worker failure classification ───────────────────────────────────────────

/** A worker's CLI `result` text after a failed turn (see utils/swarm/turnFailure). */
export const isTransientWorkerFailure = isTransientTurnFailure

function capText(text: string, limit: number): string {
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean
}

function firstLine(text: string): string {
  return summarizeTurnFailure(text, FAILURE_REASON_LIMIT)
}

// ── Team file updates ───────────────────────────────────────────────────────

type MemberEntry = TeamFile['members'][number]

async function updateWorkerEntry(launch: TeamLaunch, worker: WorkerRuntime, update: (entry: MemberEntry) => MemberEntry): Promise<void> {
  try {
    await mutateTeamFileAsync(launch.plan.teamName, team => {
      if (team.createdAt !== launch.createdAt) return
      const index = team.members.findIndex(entry => entry.sessionId === worker.sessionId)
      if (index === -1) return
      const members = [...team.members]
      members[index] = update(members[index]!)
      return { ...team, members }
    })
  } catch (error) {
    // The team may have been deleted between ticks; the supervisor notices on its next pass.
    console.warn(`[TeamPlanRuntime] cannot update member ${worker.member.name}:`, error instanceof Error ? error.message : error)
  }
}

function withoutFailure(entry: MemberEntry): MemberEntry {
  const { lastError: _lastError, autoRetry: _autoRetry, ...rest } = entry as MemberEntry & { lastError?: string; autoRetry?: unknown }
  return rest
}

async function notifyLead(launch: TeamLaunch, worker: WorkerRuntime, options: { idleReason: 'available' | 'failed'; result?: string; failureReason?: string }): Promise<void> {
  const notification = createIdleNotification(worker.member.name, {
    idleReason: options.idleReason,
    ...(options.result ? { result: capText(options.result, RESULT_TEXT_LIMIT) } : {}),
    ...(options.failureReason ? { failureReason: options.failureReason } : {}),
  })
  const write = () => writeToMailbox(TEAM_LEAD_NAME, { from: worker.member.name, timestamp: new Date().toISOString(), text: JSON.stringify(notification) }, launch.plan.teamName)
  // A lost failure notice is exactly how a member silently drops out of a long
  // run, so a contended mailbox gets one more attempt.
  if ((await write()) === false) {
    await new Promise(resolve => setTimeout(resolve, 1_000))
    if ((await write()) === false) console.error(`[TeamPlanRuntime] could not notify the lead about ${worker.member.name}`)
  }
}

// ── Worker processes ────────────────────────────────────────────────────────

function workerSdkUrl(sessionId: string): string {
  const url = new URL(`ws://127.0.0.1:${ProviderService.getServerPort()}/sdk/${sessionId}`)
  url.searchParams.set('token', randomUUID())
  return url.toString()
}

async function startWorkerProcess(launch: TeamLaunch, worker: WorkerRuntime, resume: boolean): Promise<void> {
  const { member } = worker
  const snapshot = member.agentSnapshot
  if (!snapshot) throw new Error(`Missing approved preset for ${member.name}`)
  const tools = snapshot.tools ? [...new Set([...snapshot.tools, ...essentialTools])] : undefined
  // A restarted member follows the lead's current permission mode, like a
  // freshly approved one would.
  if (resume && conversationService.hasSession(launch.parentId)) {
    launch.permissionMode = conversationService.getSessionPermissionMode(launch.parentId)
  }
  try {
    await conversationService.startSession(worker.sessionId, launch.plan.workDir, workerSdkUrl(worker.sessionId), {
      providerId: member.runtime.providerId === CLAUDE_OFFICIAL_PROVIDER_ID ? null : member.runtime.providerId,
      model: member.runtime.modelId,
      effort: member.runtime.effortLevel,
      permissionMode: launch.permissionMode,
      teamWorker: {
        parentSessionId: launch.parentId, teamName: launch.plan.teamName, memberId: member.id, name: member.name,
        systemPrompt: snapshot.systemPrompt, tools,
        agentDefinition: { ...snapshot, initialPrompt: undefined, effort: member.runtime.effortLevel },
        ...(resume ? { resume: true } : {}),
      },
    })
    await conversationService.requestControl(worker.sessionId, { subtype: 'set_model', model: member.runtime.modelId }, 30_000)
  } catch (error) {
    await conversationService.stopSessionAndWait(worker.sessionId)
    throw error
  }
  conversationService.onOutput(worker.sessionId, message => {
    if (message?.type !== 'result') return
    void migrationMaintenance.track(handleWorkerResult(launch, worker, message)).catch(error => console.error(`[TeamPlanRuntime] cannot record ${member.name}'s turn`, error))
  })
}

/**
 * Restart a member whose process is gone by resuming its own transcript, so a
 * crash, a lead restart or the user's Stop never costs the member its work.
 */
async function restartWorker(launch: TeamLaunch, worker: WorkerRuntime, reason: 'message' | 'user'): Promise<boolean> {
  if (worker.starting) return worker.starting
  const now = Date.now()
  worker.restartHistory = worker.restartHistory.filter(at => now - at < WORKER_RESTART_WINDOW_MS)
  // Stopping the team is the user's choice, not a crash: however often the
  // user stops and resumes, bringing a member back never trips the guard.
  const resumingFromStop = worker.stoppedByUser === true
  worker.stoppedByUser = false
  if (reason === 'message' && !resumingFromStop && (worker.restartsExhausted || worker.restartHistory.length >= WORKER_MAX_RESTARTS_IN_WINDOW)) {
    if (!worker.restartsExhausted) {
      worker.restartsExhausted = true
      await updateWorkerEntry(launch, worker, entry => ({ ...entry, isActive: false, terminated: true, lastError: 'Stopped restarting after repeated exits. A message from the user restarts it.' }))
      await notifyLead(launch, worker, { idleReason: 'failed', failureReason: `${worker.member.name} exited ${worker.restartHistory.length} times in ${WORKER_RESTART_WINDOW_MS / 60_000} minutes; automatic restarts are paused` })
    }
    return false
  }
  if (!resumingFromStop) worker.restartHistory.push(now)
  if (reason === 'user') worker.restartsExhausted = false
  const start = (async () => {
    try {
      await startWorkerProcess(launch, worker, true)
      if (launch.stopped) {
        await conversationService.stopSessionAndWait(worker.sessionId)
        return false
      }
      await updateWorkerEntry(launch, worker, entry => withoutFailure({ ...entry, terminated: false }))
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[TeamPlanRuntime] cannot restart ${worker.member.name}:`, message)
      await updateWorkerEntry(launch, worker, entry => ({ ...entry, isActive: false, terminated: true, lastError: firstLine(`Restart failed: ${message}`) }))
      return false
    } finally {
      worker.starting = undefined
    }
  })()
  worker.starting = start
  return start
}

function cancelAutoContinue(worker: WorkerRuntime): void {
  if (worker.autoContinueTimer) clearTimeout(worker.autoContinueTimer)
  worker.autoContinueTimer = undefined
}

function autoContinuePrompt(reason: string, attempt: number): string {
  return formatTeammateAutoContinuePrompt(reason, attempt, timing.autoContinueDelaysMs.length)
}

async function autoContinueWorker(launch: TeamLaunch, worker: WorkerRuntime, reason: string, attempt: number): Promise<void> {
  if (migrationMaintenance.isActive) return
  worker.autoContinueTimer = undefined
  if (launch.stopped || launch.pausedAt || !conversationService.hasSession(worker.sessionId)) return
  // Queued mail resumes the member anyway, with the newer context.
  if ((await readUnreadMessages(worker.member.name, launch.plan.teamName)).length > 0) return
  const entry = readTeamFile(launch.plan.teamName)?.members.find(member => member.sessionId === worker.sessionId)
  if (entry?.isActive) return
  await updateWorkerEntry(launch, worker, current => ({ ...current, isActive: true }))
  const sent = await conversationService.sendMessage(worker.sessionId, autoContinuePrompt(reason, attempt))
  if (sent) return
  // No retry is scheduled any more: report the failure instead of leaving a
  // stale countdown that also keeps a /goal lead waiting on this member.
  await updateWorkerEntry(launch, worker, current => {
    const { autoRetry: _autoRetry, ...rest } = current as MemberEntry & { autoRetry?: unknown }
    return { ...rest, isActive: false, lastError: reason }
  })
  await notifyLead(launch, worker, { idleReason: 'failed', failureReason: `${reason} (could not continue automatically; message ${worker.member.name} to retry)` })
}

async function handleWorkerResult(launch: TeamLaunch, worker: WorkerRuntime, message: { is_error?: boolean; result?: unknown }): Promise<void> {
  if (launch.stopped) return
  worker.lastResultAt = Date.now()
  const alive = conversationService.hasSession(worker.sessionId)
  const text = typeof message.result === 'string' ? message.result : ''
  const failed = !alive || message.is_error === true
  if (launch.pausedAt) {
    // The user's Stop already accounted for this turn; a burst of failure
    // notices would only make the lead restart members the user just halted.
    await updateWorkerEntry(launch, worker, entry => ({ ...entry, isActive: false, ...(alive ? {} : { terminated: true }) }))
    return
  }
  if (!failed) {
    worker.autoContinueAttempts = 0
    cancelAutoContinue(worker)
    await updateWorkerEntry(launch, worker, entry => withoutFailure({ ...entry, isActive: false }))
    await notifyLead(launch, worker, { idleReason: 'available', ...(text ? { result: text } : {}) })
    return
  }
  const reason = firstLine(text || 'The member process exited')
  if (alive && isTransientWorkerFailure(text) && worker.autoContinueAttempts < timing.autoContinueDelaysMs.length) {
    const attempt = ++worker.autoContinueAttempts
    const delay = timing.autoContinueDelaysMs[attempt - 1]!
    cancelAutoContinue(worker)
    worker.autoContinueTimer = setTimeout(() => {
      void migrationMaintenance.track(autoContinueWorker(launch, worker, reason, attempt)).catch(error => console.error(`[TeamPlanRuntime] cannot continue ${worker.member.name}`, error))
    }, delay)
    worker.autoContinueTimer.unref?.()
    await updateWorkerEntry(launch, worker, entry => ({ ...entry, isActive: false, lastError: reason, autoRetry: { attempt, max: timing.autoContinueDelaysMs.length, nextAt: Date.now() + delay } }))
    return
  }
  const exhausted = alive && isTransientWorkerFailure(text)
  await updateWorkerEntry(launch, worker, entry => {
    const { autoRetry: _autoRetry, ...rest } = entry as MemberEntry & { autoRetry?: unknown }
    return { ...rest, isActive: false, lastError: reason, ...(alive ? {} : { terminated: true }) }
  })
  await notifyLead(launch, worker, {
    idleReason: 'failed',
    failureReason: alive
      ? exhausted ? `${reason} (automatic retries exhausted; message ${worker.member.name} to continue)` : reason
      : `${worker.member.name}'s process exited (${reason}). Messaging it restarts it from its saved conversation.`,
  })
}

// ── Supervisor ──────────────────────────────────────────────────────────────

async function deliverToWorker(launch: TeamLaunch, worker: WorkerRuntime, messages: TeammateMessage[]): Promise<void> {
  cancelAutoContinue(worker)
  // A new instruction starts a fresh retry budget: the lead or the user has
  // looked at the failure and decided the member should go on.
  worker.autoContinueAttempts = 0
  // The message replaces any scheduled retry and answers the last failure;
  // the turn it starts records its own outcome.
  await updateWorkerEntry(launch, worker, entry => withoutFailure({ ...entry, isActive: true, terminated: false }))
  const accepted = await conversationService.sendMessage(worker.sessionId, formatTeammateMessages(messages))
  if (!accepted) {
    await updateWorkerEntry(launch, worker, entry => ({ ...entry, isActive: false }))
    return
  }
  const ids = new Set(messages.map(message => message.id).filter(Boolean))
  const legacy = new Set(messages.filter(message => !message.id).map(message => JSON.stringify([message.from, message.timestamp, message.text])))
  await markMessagesAsReadByPredicate(worker.member.name, message => message.id ? ids.has(message.id) : legacy.has(JSON.stringify([message.from, message.timestamp, message.text])), launch.plan.teamName)
}

/**
 * Wake an idle member when a task it owns becomes ready (its dependencies just
 * completed). Process members have no poll loop of their own, so without this
 * a dependency chain stalls until the lead happens to notice.
 */
async function wakeForReadyTask(launch: TeamLaunch, worker: WorkerRuntime, entry: MemberEntry | undefined, tasks: Task[]): Promise<void> {
  if (!entry || entry.isActive || worker.autoContinueTimer || !conversationService.hasSession(worker.sessionId)) return
  if (worker.lastResultAt === undefined || Date.now() - worker.lastResultAt < timing.unblockedTaskWakeDelayMs) return
  const unresolved = new Set(tasks.filter(task => task.status !== 'completed').map(task => task.id))
  const ready = tasks.find(task => task.owner === worker.member.name && task.status === 'pending' && !worker.wokenForTaskIds.has(task.id)
    && task.blockedBy.length > 0 && task.blockedBy.every(id => !unresolved.has(id)))
  if (!ready) return
  worker.wokenForTaskIds.add(ready.id)
  await deliverToWorker(launch, worker, [{
    from: 'task-list',
    text: `Task #${ready.id} assigned to you is now ready because its dependencies are complete: ${ready.subject}\nStart it now with TaskUpdate (status in_progress), and mark it completed when done.`,
    timestamp: new Date().toISOString(),
    read: false,
  }])
}

async function superviseLaunch(launch: TeamLaunch): Promise<void> {
  if (migrationMaintenance.isActive) return
  const team = readTeamFile(launch.plan.teamName)
  if (!team || team.createdAt !== launch.createdAt) {
    await stopTeamPlanRuntime(launch.plan.planId)
    return
  }
  const leadAlive = conversationService.hasSession(launch.parentId)
  let tasks: Task[] | undefined
  for (const worker of launch.workers.values()) {
    // A restart in flight delivers on a later pass, once its process is ready;
    // it never holds up the rest of the team.
    if (!worker.released || launch.stopped || worker.starting) continue
    // A worker can be stopped without a result (its lead's session was closed
    // or reaped); keep the roster honest so the UI shows it as stopped.
    const entry = team.members.find(member => member.sessionId === worker.sessionId)
    if (entry && entry.terminated !== true && !conversationService.hasSession(worker.sessionId)) {
      await updateWorkerEntry(launch, worker, current => ({ ...current, isActive: false, terminated: true }))
    }
    const messages = await readUnreadMessages(worker.member.name, launch.plan.teamName)
    if (messages.length === 0) {
      if (!leadAlive || launch.pausedAt) continue
      tasks ??= await listTasks(getCanonicalTeamTaskListId(launch.plan.teamName)).catch(() => [])
      await wakeForReadyTask(launch, worker, entry, tasks)
      continue
    }
    if (launch.pausedAt) {
      // Only a new instruction from the lead or the user resumes a paused team.
      const resume = messages.some(message => (message.from === TEAM_LEAD_NAME || message.from === 'user') && Date.parse(message.timestamp) >= launch.pausedAt!)
      if (!resume) continue
      launch.pausedAt = undefined
    }
    if (!conversationService.hasSession(worker.sessionId)) {
      const fromUser = messages.some(message => message.from === 'user')
      // Without a lead nobody coordinates the restarted member; a direct user
      // message is the exception.
      if (!leadAlive && !fromUser) continue
      void migrationMaintenance.track(restartWorker(launch, worker, fromUser ? 'user' : 'message'))
      continue
    }
    await deliverToWorker(launch, worker, messages)
  }
}

function startSupervisor(launch: TeamLaunch): void {
  if (launch.timer || migrationMaintenance.isActive) return
  launch.timer = setInterval(() => {
    if (launch.supervising || launch.stopped || migrationMaintenance.isActive) return
    launch.supervising = true
    void migrationMaintenance.track(superviseLaunch(launch))
      .catch(error => { console.error('[TeamPlanRuntime] team supervision failed', error) })
      .finally(() => { launch.supervising = false })
  }, SUPERVISOR_INTERVAL_MS)
  launch.timer.unref?.()
}

// ── Lifecycle hooks ─────────────────────────────────────────────────────────

async function sendTeamSnapshot(parentId: string, teamName: string, createdAt: number): Promise<void> {
  await conversationService.requestControl(parentId, { subtype: 'team_runtime_snapshot', team_name: teamName, created_at: createdAt })
}

/** The user's Stop: every member stops now, nothing is lost, the next instruction resumes. */
function pauseLaunchesForLead(parentSessionId: string): void {
  for (const launch of launches.values()) {
    if (launch.parentId !== parentSessionId || launch.stopped || !launch.running) continue
    launch.pausedAt = Date.now()
    launch.pauseNoticePending = true
    for (const worker of launch.workers.values()) {
      cancelAutoContinue(worker)
      worker.stoppedByUser = true
    }
    // No notice goes to the lead's mailbox: delivering it would start a lead
    // turn right after the user stopped everything. Messaging a stopped member
    // restarts it, so the lead needs no special knowledge to continue later.
    void migrationMaintenance.track(mutateTeamFileAsync(launch.plan.teamName, team => {
      if (team.createdAt !== launch.createdAt) return
      const sessions = new Set([...launch.workers.values()].map(worker => worker.sessionId))
      return { ...team, members: team.members.map(entry => entry.sessionId && sessions.has(entry.sessionId) ? { ...entry, isActive: false, terminated: true } : entry) }
    })).catch(error => console.error('[TeamPlanRuntime] cannot record the paused team', error))
  }
}

/**
 * The lead's first message from the user after a Stop: tell it what the Stop
 * did to its team. Nothing is said at the Stop itself, which would start a lead
 * turn the user just stopped, but without this a lead told to "continue" waits
 * for members that are no longer running. The lead decides from the user's
 * words whether the members go on.
 */
export async function deliverTeamPauseNotice(parentSessionId: string): Promise<void> {
  for (const launch of launches.values()) {
    if (launch.parentId !== parentSessionId || launch.stopped || !launch.pauseNoticePending) continue
    launch.pauseNoticePending = false
    const stopped = [...launch.workers.values()].filter(worker => worker.released && worker.stoppedByUser)
    if (stopped.length === 0) continue
    const tasks = await listTasks(getCanonicalTeamTaskListId(launch.plan.teamName)).catch(() => [] as Task[])
    const lines = stopped.map(worker => {
      const open = tasks.filter(task => task.owner === worker.member.name && task.status !== 'completed')
      return open.length > 0
        ? `- ${worker.member.name}: ${open.map(task => `#${task.id} ${task.subject} (${task.status})`).join('; ')}`
        : `- ${worker.member.name}: no unfinished task`
    })
    await conversationService.sendMessage(parentSessionId, [
      `[Team runtime notice] The user's Stop also stopped your team ${launch.plan.teamName}. These members are stopped and keep their work so far:`,
      ...lines,
      'A stopped member does nothing until it is messaged: if the work should go on, SendMessage each member that still has work, and it resumes from its saved conversation where it left off. Do not spawn replacements or redo their tasks. If the user wants the team to stay stopped, leave them.',
    ].join('\n'))
  }
}

let hooksInstalled = false
function ensureRuntimeHooks(): void {
  if (hooksInstalled) return
  hooksInstalled = true
  conversationService.addTeamRuntimeListener({
    leadInterrupted: pauseLaunchesForLead,
    sessionStarted: (sessionId, { isTeamWorker }) => {
      // A lead that restarted (provider/permission change, crash, reopen, app
      // restart) lost its in-memory roster; give it back so it can keep
      // coordinating, re-owning the team first if the server restarted.
      const ownedLaunch = () => [...launches.values()].find(item => item.parentId === sessionId && item.running && !item.stopped)
      // Workers never lead a team; skip the disk scan a re-own needs.
      if (!ownedLaunch() && isTeamWorker) return
      void migrationMaintenance.track((async () => {
        if (!ownedLaunch()) await rehydrateTeamPlanRuntimesForSession(sessionId)
        const launch = ownedLaunch()
        if (launch) await sendTeamSnapshot(sessionId, launch.plan.teamName, launch.createdAt)
      })()).catch(error => console.error('[TeamPlanRuntime] cannot restore the team after a lead start', error))
    },
  })
}

// ── Public lifecycle ────────────────────────────────────────────────────────

export async function stopTeamPlanRuntime(planId: string): Promise<void> {
  const launch = launches.get(planId)
  if (!launch) return
  launch.stopped = true
  if (launch.timer) clearInterval(launch.timer)
  for (const worker of launch.workers.values()) cancelAutoContinue(worker)
  launches.delete(planId)
  await Promise.allSettled(launch.children.map(id => conversationService.stopSessionAndWait(id)))
  const plan = launch.plan
  await withTaskListLifecycleLock(getCanonicalTeamTaskListId(plan.teamName), async () => {
    const team = readTeamFile(plan.teamName)
    if (!team || incarnationOf(team) !== plan.incarnationId) return
    team.members = team.members.flatMap(member => {
      if (!member.sessionId || !launch.children.includes(member.sessionId)) return [member]
      return launch.released ? [{ ...member, isActive: false, terminated: true }] : []
    })
    await writeTeamFileAsync(plan.teamName, team)
  })
  if (launch.released) {
    const tasks = await listTasks(getCanonicalTeamTaskListId(plan.teamName))
    for (const task of tasks.filter(task => task.metadata?.teamPlanId === plan.planId && task.status === 'in_progress')) {
      await updateTask(getCanonicalTeamTaskListId(plan.teamName), task.id, { metadata: { ...task.metadata, teamRuntimeInterrupted: true } })
    }
  }
}

export async function launchTeamPlanRuntime(plan: TeamPlanRecord): Promise<{ memberIds: Record<string, string> }> {
  migrationMaintenance.assertAvailable()
  const approved = plan.approvedSnapshot
  if (!approved || approved.revision !== plan.revision - 1 || plan.state !== 'launching') throw new Error('Team plan is not approved for launch')
  ensureRuntimeHooks()
  await conversationService.waitForTeamWorkersStopped(plan.sessionId)
  const durable = await readTeamPlan(plan.teamName)
  if (!durable || durable.planId !== plan.planId || durable.incarnationId !== plan.incarnationId || durable.state !== 'launching' || durable.revision !== plan.revision || durable.approvedSnapshot?.requestId !== approved.requestId) throw new Error('Team launch authorization has been revoked')
  if (launches.has(plan.planId)) throw new Error('Team plan already has a launch in progress')
  if (!conversationService.hasSession(plan.sessionId)) throw new Error('Team leader must be connected before launching')
  const members = approved.members
  const launch: TeamLaunch = {
    parentId: plan.sessionId, plan, createdAt: 0, released: false, running: false, children: [], workers: new Map(),
    supervising: false, stopped: false, permissionMode: conversationService.getSessionPermissionMode(plan.sessionId),
  }
  launches.set(plan.planId, launch)
  const memberIds: Record<string, string> = {}
  let taskMapping: Record<string, string> = {}
  let executionStarted = false
  try {
    await withTaskListLifecycleLock(getCanonicalTeamTaskListId(plan.teamName), async () => {
      const team = readTeamFile(plan.teamName)
      if (!team || team.leadSessionId !== plan.sessionId || incarnationOf(team) !== plan.incarnationId) throw new Error('Team generation no longer exists')
      team.reviewRequired = true
      launch.createdAt = team.createdAt
      await writeTeamFileAsync(plan.teamName, team)
    })
    taskMapping = await materializeTasks(plan)
    await startTeamWorkersBarrier(members, async member => {
      if (launch.stopped || !conversationService.hasSession(plan.sessionId)) throw new Error('Team launch cancelled')
      const id = randomUUID()
      launch.children.push(id)
      memberIds[member.id] = id
      const worker: WorkerRuntime = { member, sessionId: id, released: false, autoContinueAttempts: 0, restartHistory: [], restartsExhausted: false, wokenForTaskIds: new Set() }
      launch.workers.set(member.id, worker)
      await startWorkerProcess(launch, worker, false)
      return id
    }, async (member, id) => {
      if (launch.stopped || !conversationService.hasSession(plan.sessionId)) throw new Error('Team launch cancelled')
      // All processes are ready by the time the first release is reached.
      if (member === members[0]) {
        await withTaskListLifecycleLock(getCanonicalTeamTaskListId(plan.teamName), async () => {
          const team = readTeamFile(plan.teamName)
          if (!team || team.createdAt !== launch.createdAt) throw new Error('Team generation changed during launch')
          for (const entry of members) {
            if (team.members.some(old => old.name === entry.name)) throw new Error(`Member already exists: ${entry.name}`)
            team.members.push({ agentId: `${entry.name}@${plan.teamName}`, name: entry.name, agentType: entry.agentType,
              model: entry.runtime.modelId, providerId: entry.runtime.providerId, providerName: typeof entry.providerName === 'string' ? entry.providerName : undefined, effortLevel: entry.runtime.effortLevel,
              planMemberId: entry.id, joinedAt: Date.now(), tmuxPaneId: '', cwd: plan.workDir, subscriptions: [],
              sessionId: memberIds[entry.id], backendType: 'process', isActive: true })
          }
          await writeTeamFileAsync(plan.teamName, team)
        })
        await sendTeamSnapshot(plan.sessionId, plan.teamName, launch.createdAt)
      }
      const assigned = approved.tasks.filter(task => task.ownerId === member.id).map(task => ({ ...task, id: taskMapping[task.id], dependencies: task.dependencies.map(dep => taskMapping[dep]) }))
      await withTaskListLifecycleLock(getCanonicalTeamTaskListId(plan.teamName), async () => {
        const latest = await readTeamPlan(plan.teamName)
        if (launch.stopped || !latest || latest.planId !== plan.planId || latest.incarnationId !== plan.incarnationId || latest.state !== 'launching' || latest.revision !== plan.revision || latest.approvedSnapshot?.requestId !== approved.requestId) throw new Error('Team launch authorization has been revoked')
        executionStarted = true
        launch.released = true
        const sent = await conversationService.sendMessage(id, `${member.agentSnapshot?.initialPrompt ? member.agentSnapshot.initialPrompt + "\n" : ""}${member.prompt}\n\nApproved shared tasks (use TaskGet/TaskUpdate; respect dependencies):\n${JSON.stringify(assigned)}`, undefined, { canSend: () => !launch.stopped })
        if (!sent) throw new Error(`Failed to release ${member.name}`)
        const worker = launch.workers.get(member.id)
        if (worker) worker.released = true
      })
    }, id => conversationService.stopSessionAndWait(id))

    // One supervisor owns each worker inbox. SDK serializes user turns; a worker
    // remains connected while idle and wakes when another teammate writes.
    launch.running = true
    startSupervisor(launch)
    await conversationService.sendMessage(plan.sessionId, `Approved team ${plan.teamName} is running. Members and their shared tasks are ready. Continue coordinating the approved team; do not spawn these members again. Members report back automatically when they finish or fail; you do not need to poll or wait in a loop.`)
    return { memberIds }
  } catch (error) {
    await stopTeamPlanRuntime(plan.planId)
    if (executionStarted) throw new TeamPlanExecutionInterruptedError(error instanceof Error ? error.message : String(error))
    throw error
  }
}

/** Keep released teams resumable while preventing every supervisor wake. */
export async function quiesceTeamPlanRuntimesForMigration(): Promise<void> {
  const parents = new Set([...launches.values()].map(launch => launch.parentId))
  for (const parent of parents) pauseLaunchesForLead(parent)
  for (const launch of launches.values()) {
    if (launch.timer) clearInterval(launch.timer)
    launch.timer = undefined
    for (const worker of launch.workers.values()) cancelAutoContinue(worker)
    if (launch.running) continue
    launch.stopped = true
    const current = await readTeamPlan(launch.plan.teamName)
    if (current?.planId === launch.plan.planId && current.state === 'launching') {
      await mutateTeamPlan(current.teamName, { ...current, expectedRevision: current.revision }, plan => ({
        ...plan, state: launch.released ? 'interrupted' : 'cancelled',
        launch: { ...plan.launch, status: 'failed', executionStarted: launch.released, error: 'Team startup stopped for data migration.' },
      }))
    }
  }
}

/**
 * Rebuild the supervisor for an approved team whose server-side owner was lost
 * (server or app restart). Members start dormant and restart from their own
 * transcripts as soon as the lead or the user messages them.
 */
export async function rehydrateTeamPlanRuntime(plan: TeamPlanRecord): Promise<boolean> {
  if (migrationMaintenance.isActive) return false
  if (plan.state !== 'running' || !plan.approvedSnapshot || launches.has(plan.planId)) return launches.has(plan.planId)
  const team = readTeamFile(plan.teamName)
  if (!team || team.leadSessionId !== plan.sessionId || incarnationOf(team) !== plan.incarnationId) return false
  const memberIds = plan.launch?.memberIds ?? {}
  const workers = new Map<string, WorkerRuntime>()
  for (const member of plan.approvedSnapshot.members) {
    const sessionId = memberIds[member.id] ?? team.members.find(entry => entry.planMemberId === member.id && entry.backendType === 'process')?.sessionId
    if (!sessionId) continue
    const entry = team.members.find(candidate => candidate.sessionId === sessionId)
    if (!entry) continue
    workers.set(member.id, { member, sessionId, released: true, autoContinueAttempts: 0, restartHistory: [], restartsExhausted: false, wokenForTaskIds: new Set() })
  }
  if (workers.size === 0) return false
  ensureRuntimeHooks()
  const launch: TeamLaunch = {
    parentId: plan.sessionId, plan, createdAt: team.createdAt, released: true, running: true,
    children: [...workers.values()].map(worker => worker.sessionId), workers, supervising: false, stopped: false,
    permissionMode: conversationService.getSessionPermissionMode(plan.sessionId),
  }
  launches.set(plan.planId, launch)
  await mutateTeamFileAsync(plan.teamName, current => {
    if (current.createdAt !== team.createdAt) return
    const sessions = new Set(launch.children)
    return { ...current, members: current.members.map(entry => entry.sessionId && sessions.has(entry.sessionId) && !conversationService.hasSession(entry.sessionId) ? { ...entry, isActive: false, terminated: true } : entry) }
  }).catch(() => undefined)
  startSupervisor(launch)
  return true
}

/** Restore every approved launch (current and archived parent plans) of a lead's team. */
export async function rehydrateTeamPlanRuntimesForSession(sessionId: string): Promise<boolean> {
  const current = await findTeamPlanForSession(sessionId)
  if (!current) return false
  const plans: TeamPlanRecord[] = [current]
  try {
    for (const file of await readdir(getTeamDir(current.teamName))) {
      if (!/^plan-[a-f0-9-]{36}\.json$/i.test(file)) continue
      try {
        const archived = teamPlanRecordSchema.parse(JSON.parse(await readFile(join(getTeamDir(current.teamName), file), 'utf8')))
        if (archived.incarnationId === current.incarnationId && archived.sessionId === sessionId) plans.push(archived)
      } catch {
        // An unreadable archive cannot be restored; the live plan still can.
      }
    }
  } catch {
    // No team directory: nothing to restore.
  }
  let restored = false
  for (const plan of plans) {
    if (plan.state === 'running' && await rehydrateTeamPlanRuntime(plan)) restored = true
  }
  return restored
}

export async function notifyTeamPlanLeader(plan: TeamPlanRecord, kind: 'approved' | 'returned' | 'cancelled'): Promise<void> {
  // Approval wakes the leader only after launch's readiness barrier and snapshot.
  if (kind === 'approved' || !conversationService.hasSession(plan.sessionId)) return
  await conversationService.sendMessage(plan.sessionId, kind === 'returned'
    ? `The user returned team plan ${plan.teamName} for revision. No members were launched. Feedback: ${plan.feedback ?? 'Revise the team proposal.'}`
    : `The user cancelled team plan ${plan.teamName}. Do not launch its members. Wait for new user instructions.`)
}

export class TeamPlanExecutionInterruptedError extends Error {
  readonly executionStarted = true
}

/** Tests simulate a server restart: owners vanish, processes and files stay. */
export function forgetTeamPlanRuntimesForTests(): void {
  for (const launch of launches.values()) {
    if (launch.timer) clearInterval(launch.timer)
    for (const worker of launch.workers.values()) cancelAutoContinue(worker)
  }
  launches.clear()
}

export function isTeamPlanRuntimeActive(planId: string): boolean {
  const launch = launches.get(planId)
  // A paused or lead-less team is still owned here: its members restart on
  // demand. Only an explicit stop or a deleted team ends ownership.
  return !!launch && !launch.stopped
}

/** Whether a lead's approved team has a member mid-turn (keeps an unattended lead alive). */
export function hasActiveTeamWorkForParent(parentSessionId: string): boolean {
  for (const launch of launches.values()) {
    if (launch.parentId !== parentSessionId || launch.stopped || launch.pausedAt) continue
    if (!launch.running) return true
    const team = readTeamFile(launch.plan.teamName)
    for (const worker of launch.workers.values()) {
      if (worker.autoContinueTimer) return true
      if (!conversationService.hasSession(worker.sessionId)) continue
      if (team?.members.find(entry => entry.sessionId === worker.sessionId)?.isActive) return true
    }
  }
  return false
}

/**
 * Stop the teams a lead owns. With `pauseReleased`, a team that is already
 * running is paused (the user's Stop) rather than ended; a launch that has not
 * finished starting is still revoked.
 */
export async function stopTeamPlanRuntimesForParent(parentSessionId: string, options: { pauseReleased?: boolean } = {}): Promise<void> {
  const owned = () => [...launches.entries()].filter(([, launch]) => launch.parentId === parentSessionId && !(options.pauseReleased && launch.running))
  const stopOwned = () => Promise.all(owned().map(([planId]) => stopTeamPlanRuntime(planId)))
  const hadReleasedWork = owned().some(([, launch]) => launch.released)
  const endedRunning = owned().filter(([, launch]) => launch.running).map(([, launch]) => launch.plan)
  await stopOwned()
  const plan = await findTeamPlanForSession(parentSessionId)
  if (plan?.state === 'launching') {
    await mutateTeamPlan(plan.teamName, { ...plan, expectedRevision: plan.revision }, current => ({
      ...current, state: hadReleasedWork ? 'interrupted' : 'cancelled',
      launch: { ...current.launch, status: 'failed', executionStarted: hadReleasedWork, error: 'The user stopped team startup.' },
    })).catch(error => {
      // A concurrent approval/cancellation changes the revision; the second
      // ownership pass still revokes any process launch admitted in that window.
      console.error('[TeamPlanRuntime] stopped plan changed concurrently', error)
    })
  }
  // An ended (not paused) running team must not be rehydrated later.
  for (const ended of endedRunning) {
    const latest = await readTeamPlan(ended.teamName).catch(() => null)
    if (latest?.planId !== ended.planId || latest.state !== 'running') continue
    await mutateTeamPlan(latest.teamName, { ...latest, expectedRevision: latest.revision }, current => ({
      ...current, state: 'interrupted', launch: { ...current.launch, status: 'failed', error: 'The team was stopped.' },
    })).catch(error => console.error('[TeamPlanRuntime] cannot record the stopped team', error))
  }
  await stopOwned()
}

/**
 * End a lead's reviewed teams for good (/clear or deleting the session): stop
 * every launch and remove the team and task directories. The lead's CLI no
 * longer deletes them on exit because a desktop lead process restarts often.
 */
export async function endTeamsForParent(parentSessionId: string): Promise<void> {
  await stopTeamPlanRuntimesForParent(parentSessionId)
  let names: string[] = []
  try {
    names = await readdir(getTeamsDirectory())
  } catch {
    return
  }
  for (const name of names) {
    const team = readTeamFile(name)
    if (!team || team.leadSessionId !== parentSessionId || !team.reviewRequired) continue
    await cleanupTeamDirectories(name).catch(error => console.error(`[TeamPlanRuntime] cannot remove ended team ${name}`, error))
  }
}

// Restarts of a lead (and of the server itself) must find the hooks in place
// before any launch happens in this process.
ensureRuntimeHooks()
