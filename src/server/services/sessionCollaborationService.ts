import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ApiError } from '../middleware/errorHandler.js'
import type { SessionRuntimeSelection, SessionModelOption, SessionUserInstruction, SessionDelegationInput, SessionDelegationBatch, SessionModelChangeInput, SessionModelChange } from '../../shared/sessionDelegation.js'

export type CollaborationState = 'queued' | 'running' | 'idle' | 'blocked' | 'completed' | 'failed' | 'stopped'
export type CollaborationMessage = {
  id: string
  sourceSessionId: string
  targetSessionId: string
  content: string
  kind: 'message' | 'assignment' | 'completed' | 'blocked' | 'failed'
  status: 'queued' | 'accepted' | 'consumed' | 'cancelled'
  createdAt: string
  revision?: number
  error?: string
  errorCode?: string
}
export type CollaborationMember = {
  sessionId: string
  rootSessionId: string
  parentSessionId: string | null
  state: CollaborationState
  stopped: boolean
  result?: string
  /** Display title, attached at snapshot time so tool results render names immediately. */
  title?: string
  runtime?: SessionRuntimeSelection
  continuationId?: string
  continuationSourceSessionId?: string
}
export type CollaborationCreateInput = {
  requestId?: string
  prompt: string
  title?: string
  workDir?: string
  model?: string
  providerId?: string | null
  runtime?: SessionRuntimeSelection
}
export type CollaborationCreateResult = { sessionId: string; workDir?: string; messageId: string; title?: string; state: CollaborationState; delivery: CollaborationMessage['status']; error?: string; errorCode?: string }
export type SessionCollaborationDependencies = {
  statePath: string
  sessions: {
    list(options: { query?: string; limit: number; offset: number; signal?: AbortSignal }): Promise<unknown>
    read(sessionId: string, options: { cursor?: string; limit: number; signal?: AbortSignal }): Promise<unknown>
    exists(sessionId: string): Promise<boolean>
    /** Must use the caller's effective runtime and an isolated Git worktree. */
    create(callerSessionId: string, input: CollaborationCreateInput): Promise<{ sessionId: string; workDir?: string }>
    /** Optional display titles for snapshot members; keyed by session id. */
    titles?(sessionIds: string[]): Promise<Record<string, string>> | Record<string, string>
    /** Names and worker session ids of the Agent Team members this session leads. */
    teamMemberIdentities?(sessionId: string): Promise<string[]> | string[]
    verifyUserInstruction?(sessionId: string, evidence: SessionUserInstruction): Promise<boolean>
  }
  models?: {
    list(): Promise<SessionModelOption[]>
    resolve(callerSessionId: string, input: { runtime?: SessionRuntimeSelection; model?: string; providerId?: string | null }): Promise<SessionRuntimeSelection>
    validate(runtime: SessionRuntimeSelection): Promise<SessionRuntimeSelection>
    parentRuntime(callerSessionId: string): Promise<SessionRuntimeSelection>
  }
  runtime: {
    apply?(sessionId: string, runtime: SessionRuntimeSelection): Promise<void>
    stopAndWait?(sessionId: string): Promise<void>
    getState?(sessionId: string): 'running' | 'blocked' | 'idle'
    /** Admit a foreground turn and return promptly; completion arrives through onSessionState. */
    start(sessionId: string, message: CollaborationMessage): Promise<void>
    /** Enqueue at the current query's post-tool boundary without replacing its turn token. */
    enqueue(sessionId: string, message: CollaborationMessage): Promise<void>
    stop(sessionId: string): Promise<void>
  }
  now?: () => Date
}
type StoredBatch = SessionDelegationBatch & { input: string; stopEpoch: number }
type Store = { batches?: Record<string, StoredBatch>; modelChanges?: Record<string, SessionModelChange & { input: string; continuations?: string[]; stopEpoch?: number }>; version: 1; revision: number; members: Record<string, CollaborationMember>; messages: CollaborationMessage[]; stopEpochs?: Record<string, number>; creations?: Record<string, { input: string; rootSessionId?: string; stopEpoch?: number; result?: { sessionId: string; workDir?: string; messageId: string; title?: string }; failure?: { message: string; code: string; status: number } }> }
/** Pages one ReadSession cursor chain may serve before it stops instead of walking the whole transcript. */
export const COLLABORATION_READ_MAX_PAGES = 8
export const COLLABORATION_WAIT_MIN_MS = 10_000
export const COLLABORATION_WAIT_DEFAULT_MS = 30_000
export const COLLABORATION_WAIT_MAX_MS = 300_000
export const UNKNOWN_WAIT_TARGET_GUIDANCE = 'These are your Agent Team members, not collaboration sessions, so WaitSessions will never report on them. Their results, failures and questions arrive automatically as teammate messages. If you are waiting for teammates, end your turn instead of polling or sleeping.'
export type CollaborationSnapshot = { revision: number; members: CollaborationMember[]; messages: CollaborationMessage[]; waitReason?: 'capacity_blocked'; guidance?: string; truncated?: boolean; omittedMessages?: number; omittedMembers?: number; requestedTimeoutMs?: number; timeoutMs?: number }

/** Mirrors the host's customTitle rule so the tool result carries the same name the session list shows. */
function collaborationSessionTitle(input: CollaborationCreateInput): string {
  return input.title?.trim() || input.prompt.slice(0, 80)
}

/** A bounded evidence projection, never a generated semantic summary. */
export function projectCollaborationHistory(value: unknown, options: { limit?: number; includeOutputs?: boolean; maxOutputCharsPerItem?: number; budgetChars?: number } = {}): unknown {
  const page = value as { messages?: Array<Record<string, unknown>>; page?: Record<string, unknown> }
  const messages = page.messages ?? []
  const turns: Array<Array<Record<string, unknown>>> = []
  for (const message of messages) {
    if (message.type === 'user' || turns.length === 0) turns.push([])
    turns[turns.length - 1]!.push(message)
  }
  const selected = turns.slice(-Math.min(10, Math.max(1, options.limit ?? 1)))
  const itemLimit = Math.min(8000, Math.max(100, options.maxOutputCharsPerItem ?? 2000))
  let remaining = options.budgetChars ?? 24_000
  let truncated = selected.length < turns.length
  const projected = selected.flatMap(turn => turn.map(message => {
    if (!options.includeOutputs && message.type === 'tool_result') return null
    const copy = { ...message }
    if (!options.includeOutputs) delete copy.toolUseResult
    if (message.type === 'tool_result') {
      const output = typeof copy.content === 'string' ? copy.content : JSON.stringify(copy.content)
      if (output.length > itemLimit) { copy.content = output.slice(0, itemLimit); copy.bodyTruncated = true; truncated = true }
      delete copy.toolUseResult
    }
    if (Array.isArray(copy.content)) {
      copy.content = copy.content.filter(block => options.includeOutputs || block?.type !== 'tool_result').map(block => {
        if (block?.type !== 'tool_result') return block
        const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
        if (text.length > itemLimit) truncated = true
        return { ...block, content: text.slice(0, itemLimit), ...(text.length > itemLimit ? { truncated: true } : {}) }
      })
    }
    const serialized = JSON.stringify(copy)
    if (serialized.length <= remaining) { remaining -= serialized.length; return copy }
    truncated = true
    if (remaining < 100) return null
    const result = { id: copy.id, type: copy.type, content: serialized.slice(0, Math.max(0, remaining - 100)), truncated: true }
    remaining = 0
    return result
  })).filter(Boolean)
  return { messages: projected, page: page.page, turnsIncluded: selected.length, truncated,
    historyComplete: page.page?.historyComplete === true && !truncated }
}

/** Versionless fixtures are the forward-compatible pre-release v0 shape. Unknown fields survive writes. */
export function migrateCollaborationStore(value: unknown): Store {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid collaboration state')
  const source = value as Record<string, unknown>
  if (source.version !== undefined && source.version !== 1) throw new Error('Unsupported collaboration state version')
  if (!source.members || typeof source.members !== 'object' || Array.isArray(source.members) || !Array.isArray(source.messages)) {
    throw new Error('Invalid collaboration state records')
  }
  for (const [id, member] of Object.entries(source.members)) {
    if (!member || typeof member !== 'object' || member.sessionId !== id || typeof member.rootSessionId !== 'string' ||
      !['queued', 'running', 'idle', 'blocked', 'completed', 'failed', 'stopped'].includes(member.state) ||
      (member.title !== undefined && typeof member.title !== 'string')) throw new Error('Invalid collaboration member')
  }
  for (const message of source.messages) {
    if (!message || typeof message.id !== 'string' || typeof message.sourceSessionId !== 'string' ||
      typeof message.targetSessionId !== 'string' || typeof message.content !== 'string' ||
      !['queued', 'accepted', 'consumed', 'cancelled'].includes(message.status)) throw new Error('Invalid collaboration message')
  }
  for (const field of ['batches', 'modelChanges'] as const) {
    if (source[field] !== undefined && (!source[field] || typeof source[field] !== 'object' || Array.isArray(source[field]))) throw new Error(`Invalid collaboration ${field}`)
  }
  const revision = Math.max(typeof source.revision === 'number' ? source.revision : 0, source.messages.length ? 1 : 0)
  return { ...source, version: 1, revision, batches: (source.batches ?? {}) as Store['batches'], modelChanges: (source.modelChanges ?? {}) as Store['modelChanges'],
    members: source.members as Store['members'], messages: source.messages.map(message => ({ ...message, revision: message.revision ?? revision })) as CollaborationMessage[] }
}

export class SessionCollaborationService {
  private store: Store = { version: 1, revision: 0, members: {}, messages: [] }
  private ready: Promise<void>
  private tail: Promise<unknown> = Promise.resolve()
  private pumping: Promise<void> | null = null
  private listeners = new Set<() => void>()
  private userInputs = new Map<string, number>()
  private heldCreations = new Set<string>()
  private changeOperations = new Map<string, Promise<void>>()
  private userAdmissions = new Map<string, { token: symbol; previous: { state: CollaborationState; stopped: boolean } }>()

  constructor(private readonly deps: SessionCollaborationDependencies) {
    this.ready = readFile(deps.statePath, 'utf8').then(text => { this.store = migrateCollaborationStore(JSON.parse(text)) })
      .catch(error => { if (error?.code !== 'ENOENT') throw error })
  }

  private async mutate<T>(fn: () => T): Promise<T> {
    const operation = this.tail.then(async () => {
      await this.ready
      const previous = structuredClone(this.store)
      const previousAdmissions = new Map(this.userAdmissions)
      try {
        const result = fn()
        if (JSON.stringify(previous) === JSON.stringify(this.store)) return structuredClone(result)
        this.store.revision++
        const previousMessages = new Map(previous.messages.map(message => [message.id, JSON.stringify(message)]))
        for (const message of this.store.messages) {
          if (previousMessages.get(message.id) !== JSON.stringify(message)) message.revision = this.store.revision
        }
        await mkdir(dirname(this.deps.statePath), { recursive: true })
        const temporary = `${this.deps.statePath}.${randomUUID()}.tmp`
        await writeFile(temporary, JSON.stringify(this.store), { mode: 0o600 })
        await rename(temporary, this.deps.statePath)
        for (const listener of this.listeners) listener()
        return structuredClone(result)
      } catch (error) { this.store = previous; this.userAdmissions = previousAdmissions; throw error }
    })
    this.tail = operation.catch(() => {})
    return operation
  }

  private ensureMember(sessionId: string, rootSessionId = sessionId, parentSessionId: string | null = null): CollaborationMember {
    return this.store.members[sessionId] ??= { sessionId, rootSessionId, parentSessionId, state: 'idle', stopped: false }
  }

  private append(sourceSessionId: string, targetSessionId: string, content: string, kind: CollaborationMessage['kind'], id = randomUUID()): CollaborationMessage {
    const existing = this.store.messages.find(message => message.id === id)
    if (existing) {
      if (existing.sourceSessionId !== sourceSessionId || existing.targetSessionId !== targetSessionId || existing.content !== content || existing.kind !== kind) {
        throw ApiError.conflict('Message id was already used for different content')
      }
      return existing
    }
    const message: CollaborationMessage = { id, sourceSessionId, targetSessionId, content, kind, status: 'queued',
      createdAt: (this.deps.now?.() ?? new Date()).toISOString() }
    this.store.messages.push(message)
    return message
  }

  async getModels(): Promise<SessionModelOption[]> { return this.deps.models?.list() ?? [] }

  async getMemberRuntimes(callerSessionId: string): Promise<Array<{ sessionId: string; runtime?: SessionRuntimeSelection; state: CollaborationState; paused: boolean; error?: string }>> {
    const snapshot = await this.groupStatus(callerSessionId)
    return Promise.all(snapshot.members.filter(member => member.parentSessionId !== null).map(async member => {
      try {
        const runtime = this.deps.models ? await this.deps.models.parentRuntime(member.sessionId) : member.runtime
        return { sessionId: member.sessionId, runtime, state: member.state, paused: member.stopped }
      } catch (cause) {
        return { sessionId: member.sessionId, runtime: member.runtime, state: member.state, paused: member.stopped, error: cause instanceof Error ? cause.message : String(cause) }
      }
    }))
  }


  async listBatches(callerSessionId: string): Promise<SessionDelegationBatch[]> {
    await this.ready; await this.tail
    return structuredClone(Object.values(this.store.batches ?? {}).filter(batch => batch.callerSessionId === callerSessionId).map(({ input, stopEpoch, ...batch }) => batch))
  }

  async listModelChanges(callerSessionId: string): Promise<SessionModelChange[]> {
    await this.ready; await this.tail
    return structuredClone(Object.values(this.store.modelChanges ?? {}).filter(change => change.callerSessionId === callerSessionId).map(({ input, continuations, stopEpoch, ...change }) => change))
  }

  private batch(callerSessionId: string, id: string, revision?: number) {
    const batch = this.store.batches?.[id]
    if (!batch || batch.callerSessionId !== callerSessionId) throw ApiError.notFound('Delegation batch not found')
    if (revision !== undefined && batch.revision !== revision) throw ApiError.conflict('Delegation batch changed; refresh before continuing')
    return batch
  }

  async propose(callerSessionId: string, input: SessionDelegationInput): Promise<SessionDelegationBatch> {
    if (!input.requestId?.trim() || !Array.isArray(input.sessions) || input.sessions.length < 1 || input.sessions.length > 8 || input.sessions.some(item => !item.prompt?.trim())) throw ApiError.badRequest('A requestId and between one and eight tasks are required')
    if (!await this.deps.sessions.exists(callerSessionId)) throw ApiError.notFound('Caller session not found')
    const id = `${callerSessionId}:${input.requestId}`
    await this.ready; await this.tail
    const previous = this.store.batches?.[id]
    if (previous) {
      if (previous.input !== JSON.stringify(input)) throw ApiError.conflict('requestId was reused for different input')
      return (await this.listBatches(callerSessionId)).find(batch => batch.id === id)!
    }
    const proposalFence = await this.mutate(() => {
      const caller = this.ensureMember(callerSessionId)
      if (caller.stopped) throw ApiError.conflict('Caller session was stopped')
      return { root: caller.rootSessionId, epoch: this.store.stopEpochs?.[caller.rootSessionId] ?? 0 }
    })
    let explicit = true
    const explicitIds = new Set<string>()
    const sessions = await Promise.all(input.sessions.map(async (item, index) => {
      let runtime: SessionRuntimeSelection | undefined
      let error: string | undefined
      try {
        if (!this.deps.models) throw new Error('Model selection is unavailable')
        runtime = await this.deps.models.resolve(callerSessionId, item)
      } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
      const verified = item.userInstruction && this.deps.sessions.verifyUserInstruction
        ? await this.deps.sessions.verifyUserInstruction(callerSessionId, item.userInstruction).catch(() => false) : false
      if (!verified || !runtime || (!item.runtime && !item.model)) explicit = false
      else explicitIds.add(item.id ?? String(index + 1))
      return { id: item.id ?? String(index + 1), title: item.title, prompt: item.prompt, workDir: item.workDir, runtime, ...(error ? { error } : {}) }
    }))
    if (new Set(sessions.map(item => item.id)).size !== sessions.length) throw ApiError.badRequest('Task ids must be unique')
    const batch = await this.mutate(() => {
      const caller = this.ensureMember(callerSessionId)
      if (caller.stopped || caller.rootSessionId !== proposalFence.root || (this.store.stopEpochs?.[caller.rootSessionId] ?? 0) !== proposalFence.epoch) throw ApiError.conflict('Delegation was stopped while resolving models')
      const existing = this.store.batches?.[id]
      if (existing) {
        if (existing.input !== JSON.stringify(input)) throw ApiError.conflict('requestId was reused for different input')
        return existing
      }
      this.store.batches ??= {}
      return this.store.batches[id] = { id, callerSessionId, requestId: input.requestId, revision: 1, state: 'review', sessions, input: JSON.stringify(input), stopEpoch: this.store.stopEpochs?.[caller.rootSessionId] ?? 0 }
    })
    if (explicit) return this.confirmBatch(callerSessionId, id, batch.revision)
    for (const entry of batch.sessions) {
      if (!explicitIds.has(entry.id) || entry.sessionId || !entry.runtime) continue
      try {
        const runtime = await this.deps.models!.validate(entry.runtime)
        const created = await this.create(callerSessionId, { requestId: `batch:${input.requestId}:${entry.id}`, title: entry.title, prompt: entry.prompt, workDir: entry.workDir, runtime, model: runtime.modelId, providerId: runtime.providerId }, { id, stopEpoch: batch.stopEpoch })
        await this.mutate(() => {
          const current = this.batch(callerSessionId, id)
          const target = current.sessions.find(item => item.id === entry.id)!
          target.sessionId = created.sessionId; target.messageId = created.messageId; target.launched = true; current.revision++
        })
      } catch (cause) {
        await this.mutate(() => { const current = this.batch(callerSessionId, id); current.sessions.find(item => item.id === entry.id)!.error = cause instanceof Error ? cause.message : String(cause); current.revision++ })
      }
    }
    return (await this.listBatches(callerSessionId)).find(item => item.id === id)!
  }

  async updateBatch(callerSessionId: string, id: string, revision: number, selections: Array<{ id: string; runtime: SessionRuntimeSelection }>): Promise<SessionDelegationBatch> {
    if (!this.deps.models) throw ApiError.conflict('Model selection is unavailable')
    const resolved = await Promise.all(selections.map(async item => ({ ...item, runtime: await this.deps.models!.validate(item.runtime) })))
    await this.mutate(() => {
      const batch = this.batch(callerSessionId, id, revision)
      if (batch.state !== 'review' && batch.state !== 'failed') throw ApiError.conflict('This batch cannot be edited')
      for (const item of resolved) {
        const entry = batch.sessions.find(entry => entry.id === item.id)
        if (!entry || entry.launched) throw ApiError.conflict('Task is unavailable or already launched')
        entry.runtime = item.runtime; delete entry.error
      }
      batch.state = 'review'; batch.revision++; delete batch.error
    })
    return (await this.listBatches(callerSessionId)).find(item => item.id === id)!
  }

  async cancelBatch(callerSessionId: string, id: string, revision: number): Promise<SessionDelegationBatch> {
    await this.mutate(() => {
      const batch = this.batch(callerSessionId, id, revision)
      if (batch.state === 'launched' || batch.state === 'launching') throw ApiError.conflict('Batch has already started')
      batch.state = 'cancelled'; batch.revision++
      for (const entry of batch.sessions) if (entry.messageId && !entry.launched) {
        const message = this.store.messages.find(message => message.id === entry.messageId)
        if (message && message.status !== 'consumed') message.status = 'cancelled'
      }
    })
    return (await this.listBatches(callerSessionId)).find(item => item.id === id)!
  }

  /**
   * The model's tool call waits for the launch: it needs the new session ids.
   * The UI passes `wait: false` and returns once the batch is launching.
   * Creating each workspace and starting its CLI can take far longer than a
   * dialog should stay open, and the batch's state already reports the outcome.
   */
  async confirmBatch(callerSessionId: string, id: string, revision: number, options: { wait?: boolean } = {}): Promise<SessionDelegationBatch> {
    if (!this.deps.models) throw ApiError.conflict('Model selection is unavailable')
    await this.ready; await this.tail
    const snapshot = structuredClone(this.batch(callerSessionId, id))
    if (snapshot.state === 'launched') return (await this.listBatches(callerSessionId)).find(item => item.id === id)!
    if (snapshot.state !== 'review' && snapshot.state !== 'failed') throw ApiError.conflict('Batch cannot be started')
    const runtimes = await Promise.all(snapshot.sessions.map(item => {
      if (!item.runtime) throw ApiError.badRequest('Choose a model for every task')
      return item.launched ? Promise.resolve(item.runtime) : this.deps.models!.validate(item.runtime)
    }))
    await this.mutate(() => {
      const batch = this.batch(callerSessionId, id, revision)
      const caller = this.ensureMember(callerSessionId)
      if (caller.stopped || (this.store.stopEpochs?.[caller.rootSessionId] ?? 0) !== batch.stopEpoch) throw ApiError.conflict('Delegation was stopped; submit a new batch')
      if (batch.state !== 'review' && batch.state !== 'failed') throw ApiError.conflict('Batch cannot be started')
      batch.state = 'launching'; batch.revision++; delete batch.error
      batch.sessions.forEach((item, index) => { item.runtime = runtimes[index]! })
    })
    const launch = this.launchBatch(callerSessionId, id, snapshot, runtimes)
    if (options.wait === false) launch.catch(error => console.error('[SessionCollaboration] Batch launch failed', error))
    else await launch
    return (await this.listBatches(callerSessionId)).find(item => item.id === id)!
  }

  private async launchBatch(callerSessionId: string, id: string, snapshot: StoredBatch, runtimes: SessionRuntimeSelection[]): Promise<void> {
    try {
      for (const entry of snapshot.sessions) {
        const runtime = runtimes[snapshot.sessions.indexOf(entry)]!
        if (entry.sessionId) {
          if (!entry.launched) {
            if (!this.deps.runtime.apply) throw ApiError.conflict('Runtime changes are unavailable')
            await this.deps.runtime.apply(entry.sessionId, runtime)
            await this.mutate(() => { this.store.members[entry.sessionId!]!.runtime = runtime })
          }
          continue
        }
        const requestId = `batch:${snapshot.requestId}:${entry.id}`
        await this.mutate(() => {
          const prior = this.store.creations?.[`${callerSessionId}:${requestId}`]
          // A recorded failure is definite; uncertain pending creations are never retried.
          if (prior?.failure) delete this.store.creations![`${callerSessionId}:${requestId}`]
        })
        this.heldCreations.add(`${callerSessionId}:${requestId}`)
        try {
          const created = await this.create(callerSessionId, { requestId, title: entry.title, prompt: entry.prompt, workDir: entry.workDir, model: runtime.modelId, providerId: runtime.providerId, runtime }, { id, stopEpoch: snapshot.stopEpoch })
          await this.mutate(() => { const target = this.batch(callerSessionId, id).sessions.find(item => item.id === entry.id)!; target.sessionId = created.sessionId; target.messageId = created.messageId })
        } finally { this.heldCreations.delete(`${callerSessionId}:${requestId}`) }
      }
      // Revalidate after workspace creation; a deleted provider must never fall back.
      await Promise.all(runtimes.filter((_, index) => !snapshot.sessions[index]!.launched).map(runtime => this.deps.models!.validate(runtime)))
      await this.mutate(() => {
        const batch = this.batch(callerSessionId, id)
        const caller = this.ensureMember(callerSessionId)
        if (caller.stopped || (this.store.stopEpochs?.[caller.rootSessionId] ?? 0) !== batch.stopEpoch) throw ApiError.conflict('Delegation was stopped')
        for (const entry of batch.sessions) { if (entry.launched) continue; const member = this.store.members[entry.sessionId!]!; member.stopped = false; member.state = 'queued'; entry.launched = true }
        batch.state = 'launched'; batch.revision++
      })
      await this.pump()
    } catch (cause) {
      await this.mutate(() => { const batch = this.batch(callerSessionId, id); batch.state = 'failed'; batch.revision++; batch.error = cause instanceof Error ? cause.message : String(cause) })
    }
  }

  /** As with confirmBatch, the UI passes `wait: false`: stopping and restarting sessions reports through the change's state. */
  async changeModels(callerSessionId: string, input: SessionModelChangeInput, options: { wait?: boolean } = {}): Promise<SessionModelChange> {
    if (!input.requestId?.trim() || !Array.isArray(input.selections) || !input.selections.length || input.selections.length > 8 || new Set(input.selections.map(item => item.sessionId)).size !== input.selections.length) throw ApiError.badRequest('Choose between one and eight distinct sessions')
    if (!this.deps.models || !this.deps.runtime.apply || !this.deps.runtime.stopAndWait) throw ApiError.conflict('Runtime changes are unavailable')
    if (input.mode !== undefined && input.mode !== 'after_turn' && input.mode !== 'immediate') throw ApiError.badRequest('Invalid change mode')
    const id = `${callerSessionId}:${input.requestId}`
    await this.ready; await this.tail
    const existing = this.store.modelChanges?.[id]
    if (existing) {
      if (existing.input !== JSON.stringify(input)) throw ApiError.conflict('requestId was reused for different input')
      return (await this.listModelChanges(callerSessionId)).find(item => item.id === id)!
    }
    const changeFence = await this.mutate(() => {
      const caller = this.store.members[callerSessionId]
      if (!caller) throw ApiError.notFound('Collaboration not found')
      return {
        root: caller.rootSessionId, epoch: this.store.stopEpochs?.[caller.rootSessionId] ?? 0,
        userInputVersions: input.selections.map(item => ({ sessionId: item.sessionId, version: this.userInputs.get(item.sessionId) ?? 0 })),
      }
    })
    const selections = await Promise.all(input.selections.map(async item => ({ ...item, runtime: await this.deps.models!.validate(item.runtime) })))
    await this.mutate(() => {
      // Validation yields to other requests. Preserve the winner's identity and
      // state even when it already finished applying before this request resumes.
      const existing = this.store.modelChanges?.[id]
      if (existing) {
        if (existing.input !== JSON.stringify(input)) throw ApiError.conflict('requestId was reused for different input')
        return
      }
      const caller = this.store.members[callerSessionId]
      if (!caller) throw ApiError.notFound('Collaboration not found')
      if (caller.rootSessionId !== changeFence.root || (this.store.stopEpochs?.[caller.rootSessionId] ?? 0) !== changeFence.epoch || changeFence.userInputVersions.some(item => (this.userInputs.get(item.sessionId) ?? 0) !== item.version)) throw ApiError.conflict('Model change was stopped or superseded by user input while validating models')
      for (const item of selections) {
        const member = this.store.members[item.sessionId]
        if (!member || member.rootSessionId !== caller.rootSessionId || member.sessionId === caller.rootSessionId) throw ApiError.badRequest('Only this collaboration’s child sessions can be changed')
        if (Object.values(this.store.modelChanges ?? {}).some(change => ['pending', 'applying'].includes(change.state) && change.selections.some(selection => selection.sessionId === item.sessionId))) throw ApiError.conflict('A model change is already pending')
      }
      this.store.modelChanges ??= {}
      this.store.modelChanges[id] = { id, callerSessionId, requestId: input.requestId, revision: 1, mode: input.mode ?? 'after_turn', resume: input.resume !== false, selections, state: 'pending', input: JSON.stringify(input), stopEpoch: this.store.stopEpochs?.[caller.rootSessionId] ?? 0 }
    })
    const processing = this.processPendingModelChanges()
    if (options.wait === false) processing.catch(error => console.error('[SessionCollaboration] Model change failed', error))
    else await processing
    return (await this.listModelChanges(callerSessionId)).find(item => item.id === id)!
  }

  async cancelModelChange(callerSessionId: string, id: string, revision: number): Promise<SessionModelChange> {
    await this.mutate(() => {
      const change = this.store.modelChanges?.[id]
      if (!change || change.callerSessionId !== callerSessionId) throw ApiError.notFound('Model change not found')
      if (change.revision !== revision || change.state !== 'pending') throw ApiError.conflict('Model change is no longer pending')
      change.state = 'cancelled'; change.revision++
    })
    await this.pump()
    return (await this.listModelChanges(callerSessionId)).find(item => item.id === id)!
  }

  async processPendingModelChanges(): Promise<void> {
    await this.ready; await this.tail
    for (const change of Object.values(this.store.modelChanges ?? {})) {
      if (change.state !== 'pending' || this.changeOperations.has(change.id)) continue
      if (change.mode === 'after_turn' && change.selections.some(item => {
        const state = this.store.members[item.sessionId]?.state
        const live = this.deps.runtime.getState?.(item.sessionId)
        return live ? live !== 'idle' : ['running', 'blocked'].includes(state ?? '')
      })) continue
      const operation = this.applyModelChange(change.id)
      this.changeOperations.set(change.id, operation)
      try { await operation } finally { this.changeOperations.delete(change.id) }
    }
  }

  private async applyModelChange(id: string): Promise<void> {
    const change = await this.mutate(() => {
      const item = this.store.modelChanges![id]!
      if (item.state !== 'pending') return null
      item.state = 'applying'; item.revision++
      item.continuations = item.mode === 'immediate' ? item.selections.filter(selection => {
        const member = this.store.members[selection.sessionId]!
        return ['running', 'blocked'].includes(member.state) && this.store.messages.some(message => message.targetSessionId === selection.sessionId && message.status === 'consumed')
      }).map(selection => selection.sessionId) : []
      for (const selection of item.selections) {
        const member = this.store.members[selection.sessionId]!
        if (item.continuations.includes(selection.sessionId)) { member.continuationId ??= randomUUID(); member.continuationSourceSessionId = item.callerSessionId }
        member.stopped = true; member.state = 'stopped'
      }
      return item
    })
    if (!change) return
    try {
      if (change.mode === 'immediate') {
        const outcomes = await Promise.allSettled(change.selections.map(item => this.deps.runtime.stopAndWait!(item.sessionId)))
        const failed = outcomes.find(item => item.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      }
      const stopVersions = new Map(change.selections.map(item => [item.sessionId, this.userInputs.get(item.sessionId) ?? 0]))
      const runtimes = await Promise.all(change.selections.map(item => this.deps.models!.validate(item.runtime)))
      for (let index = 0; index < change.selections.length; index++) {
        const sessionId = change.selections[index]!.sessionId
        await this.deps.runtime.apply!(sessionId, runtimes[index]!)
        await this.mutate(() => { this.store.members[sessionId]!.runtime = runtimes[index]! })
      }
      await this.mutate(() => {
        const current = this.store.modelChanges![id]!
        current.state = 'applied'; current.revision++
        for (const item of current.selections) this.store.members[item.sessionId]!.runtime = item.runtime
        const root = this.store.members[current.callerSessionId]!.rootSessionId
        if (!current.resume || (this.store.stopEpochs?.[root] ?? 0) !== current.stopEpoch || current.selections.some(item => (this.userInputs.get(item.sessionId) ?? 0) !== stopVersions.get(item.sessionId))) return
        for (const item of current.selections) {
          const member = this.store.members[item.sessionId]!
          member.stopped = false; member.state = 'idle'
          for (const message of this.store.messages) if (message.targetSessionId === item.sessionId && message.status === 'queued') {
            delete message.error; delete message.errorCode
          }
          this.appendPendingContinuation(member)
        }
      })
      await this.pump()
    } catch (cause) {
      await this.mutate(() => { const current = this.store.modelChanges![id]!; current.state = 'failed'; current.revision++; current.error = cause instanceof Error ? cause.message : String(cause) })
    }
  }

  async list(options: { query?: string; limit?: number; offset?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    options.signal?.throwIfAborted()
    const result = await this.deps.sessions.list({ ...options, limit: Math.min(100, Math.max(1, options.limit ?? 30)), offset: Math.max(0, options.offset ?? 0) })
    options.signal?.throwIfAborted()
    return result
  }

  async candidates(query?: string, signal?: AbortSignal): Promise<{ sessions: Array<{ sessionId: string; title: string; cwd: string; status: string; updatedAt: string }> }> {
    const result = await this.list({ query, signal }) as { sessions?: Array<Record<string, unknown>> }
    await this.ready
    await this.tail
    signal?.throwIfAborted()
    // Suggestions need only a status lookup for the returned page, not a clone
    // of every collaboration message and member in the application.
    return { sessions: (result.sessions ?? []).map(session => ({
      sessionId: String(session.sessionId ?? session.id), title: String(session.title ?? ''),
      cwd: String(session.cwd ?? session.workDir ?? session.projectPath ?? ''),
      status: this.store.members[String(session.sessionId ?? session.id)]?.state ?? 'idle',
      updatedAt: String(session.updatedAt ?? session.modifiedAt ?? ''),
    })) }
  }

  async groupStatus(sessionId: string): Promise<CollaborationSnapshot> {
    const snapshot = await this.status()
    const root = snapshot.members.find(member => member.sessionId === sessionId)?.rootSessionId ?? sessionId
    return this.status(snapshot.members.filter(member => member.rootSessionId === root).map(member => member.sessionId))
  }

  async read(sessionId: string, options: { cursor?: string; limit?: number; includeOutputs?: boolean; maxOutputCharsPerItem?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    let baseCursor: string | undefined
    let end: number | undefined
    let sourceVersion: unknown
    let fragmentEnd: number | undefined
    // A reference read starts at the newest page. Each returned cursor carries
    // how many pages were already served, so one model cannot walk an entire
    // transcript by following the cursor.
    let depth = 0
    if (options.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'))
        if (cursor.version !== 1 || cursor.sessionId !== sessionId || (cursor.end !== undefined && (!Number.isInteger(cursor.end) || cursor.end < 0))) throw new Error('Invalid cursor')
        if (cursor.fragmentEnd !== undefined && (!Number.isInteger(cursor.fragmentEnd) || cursor.fragmentEnd < 0)) throw new Error('Invalid fragment')
        if (cursor.depth !== undefined && (!Number.isInteger(cursor.depth) || cursor.depth < 0)) throw new Error('Invalid depth')
        baseCursor = cursor.baseCursor; end = cursor.end; sourceVersion = cursor.sourceVersion; fragmentEnd = cursor.fragmentEnd; depth = cursor.depth ?? 0
      } catch { throw ApiError.badRequest('Invalid collaboration history cursor') }
    }
    if (depth >= COLLABORATION_READ_MAX_PAGES) {
      return { messages: [], turnsIncluded: 0, truncated: true, pageLimitReached: true,
        page: { nextCursor: null, hasMore: false }, historyComplete: false }
    }
    const page = await this.deps.sessions.read(sessionId, { cursor: baseCursor, signal: options.signal, limit: 100 }) as { messages: Array<Record<string, unknown>>; page: Record<string, unknown> }
    if (sourceVersion !== undefined && sourceVersion !== page.page.sourceVersion) throw ApiError.conflict('Session history changed during pagination; restart the read')
    const stop = Math.min(end ?? page.messages.length, page.messages.length)
    let start = stop
    let turns = 0
    const limit = Math.min(10, Math.max(1, options.limit ?? 1))
    while (start > 0) {
      start--
      if (page.messages[start]?.type === 'user' && ++turns >= limit) break
    }
    // Keep the page cursor at the unreturned boundary instead of dropping older
    // turns that happen to share the same bounded storage page.
    const projectedMessages: Record<string, unknown>[] = []
    let remaining = 24_000
    let nextEnd = stop
    let nextFragmentEnd: number | undefined
    let truncated = false
    for (let index = stop - 1; index >= start; index--) {
      const projection = projectCollaborationHistory({ messages: [page.messages[index]] }, { ...options, budgetChars: Number.MAX_SAFE_INTEGER }) as { messages: Record<string, unknown>[]; truncated: boolean }
      const message = projection.messages[0]
      if (!message) { nextEnd = index; continue }
      truncated ||= projection.truncated
      const serialized = JSON.stringify(message)
      const available = index === stop - 1 && fragmentEnd !== undefined ? Math.min(fragmentEnd, serialized.length) : serialized.length
      if (available > remaining && projectedMessages.length) break
      if (available > remaining || fragmentEnd !== undefined && index === stop - 1) {
        const from = Math.max(0, available - Math.max(100, remaining - 300))
        projectedMessages.unshift({ id: message.id, type: message.type, content: serialized.slice(from, available),
          contentEncoding: 'json-fragment', contentPart: { from, to: available, total: serialized.length }, truncated: true })
        truncated = true
        nextEnd = from > 0 ? index + 1 : index
        nextFragmentEnd = from > 0 ? from : undefined
        break
      }
      projectedMessages.unshift(message)
      remaining -= available
      nextEnd = index
    }
    const nextDepth = depth + 1
    const hasOlder = nextEnd > 0 || Boolean(page.page.nextCursor)
    const pageLimitReached = nextDepth >= COLLABORATION_READ_MAX_PAGES && hasOlder
    const next = pageLimitReached ? null : nextEnd > 0
      ? { version: 1, sessionId, baseCursor, end: nextEnd, sourceVersion: page.page.sourceVersion, fragmentEnd: nextFragmentEnd, depth: nextDepth }
      : page.page.nextCursor ? { version: 1, sessionId, baseCursor: page.page.nextCursor, depth: nextDepth } : null
    return { messages: projectedMessages, turnsIncluded: turns, truncated,
      page: { ...page.page, nextCursor: next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null, hasMore: next !== null },
      ...(pageLimitReached ? { pageLimitReached: true } : {}),
      historyComplete: next === null && page.page.historyComplete === true && !truncated }
  }

  private async describeCreation(result: { sessionId: string; workDir?: string; messageId: string; title?: string }): Promise<CollaborationCreateResult> {
    const snapshot = await this.status([result.sessionId])
    const member = snapshot.members.find(item => item.sessionId === result.sessionId)
    const message = snapshot.messages.find(item => item.id === result.messageId)
    return { ...result, state: member?.state ?? 'idle', delivery: message?.status ?? 'queued',
      ...(message?.error ? { error: message.error } : {}), ...(message?.errorCode ? { errorCode: message.errorCode } : {}) }
  }

  async create(callerSessionId: string, input: CollaborationCreateInput, batchFence?: { id: string; stopEpoch: number }): Promise<CollaborationCreateResult> {
    if (!input.prompt?.trim()) throw ApiError.badRequest('prompt is required')
    if (!await this.deps.sessions.exists(callerSessionId)) throw ApiError.notFound('Caller session not found')
    const creationFence = await this.mutate(() => {
      const caller = this.ensureMember(callerSessionId)
      if (caller.stopped) throw ApiError.conflict('Caller session was stopped; new user input is required')
      if (batchFence && ((this.store.stopEpochs?.[caller.rootSessionId] ?? 0) !== batchFence.stopEpoch || this.store.batches?.[batchFence.id]?.state === 'cancelled')) throw ApiError.conflict('Delegation was stopped or cancelled')
      return { root: caller.rootSessionId, epoch: this.store.stopEpochs?.[caller.rootSessionId] ?? 0 }
    })
    const creationKey = input.requestId ? `${callerSessionId}:${input.requestId}` : undefined
    if (creationKey) {
      const previous = await this.mutate(() => {
        const existing = this.store.creations?.[creationKey]
        if (existing) {
          if (existing.input !== JSON.stringify(input)) throw ApiError.conflict('requestId was reused for different input')
          if (existing.failure) throw new ApiError(existing.failure.status, existing.failure.message, existing.failure.code)
          if (!existing.result) throw ApiError.conflict('Session creation is pending or requires recovery; do not create another session')
          return existing.result
        }
        this.store.creations ??= {}
        this.store.creations[creationKey] = { input: JSON.stringify(input), rootSessionId: creationFence.root, stopEpoch: creationFence.epoch }
        return null
      })
      if (previous) return this.describeCreation(previous)
    }
    let created: { sessionId: string; workDir?: string }
    try { created = await this.deps.sessions.create(callerSessionId, input) }
    catch (cause) {
      const error = cause instanceof ApiError ? cause : new ApiError(500, cause instanceof Error ? cause.message : 'Unable to create the session workspace', 'SESSION_CREATE_FAILED')
      if (creationKey) await this.mutate(() => {
        this.store.creations![creationKey]!.failure = { message: error.message, code: error.code ?? 'SESSION_CREATE_FAILED', status: error.statusCode }
      })
      throw error
    }
    const message = await this.mutate(() => {
      const parent = this.ensureMember(callerSessionId)
      const member = this.ensureMember(created.sessionId, parent.rootSessionId, callerSessionId)
      member.title = collaborationSessionTitle(input)
      if (input.runtime) member.runtime = input.runtime
      // Stop may arrive while workspace/session creation awaits. Keep the
      // independently created session visible, but do not launch stale work.
      member.stopped = parent.stopped || Boolean(input.requestId && this.heldCreations.has(`${callerSessionId}:${input.requestId}`))
      member.state = member.stopped ? 'stopped' : 'queued'
      const message = this.append(callerSessionId, created.sessionId, input.prompt, 'assignment')
      if ((this.store.stopEpochs?.[creationFence.root] ?? 0) !== creationFence.epoch) {
        message.status = 'cancelled'
        member.stopped = true
        member.state = 'stopped'
      }
      if (creationKey) this.store.creations![creationKey]!.result = { ...created, messageId: message.id, title: collaborationSessionTitle(input) }
      return message
    })
    await this.pump()
    return this.describeCreation({ ...created, messageId: message.id, title: collaborationSessionTitle(input) })
  }

  async send(callerSessionId: string, targetSessionId: string, content: string, messageId?: string): Promise<CollaborationMessage> {
    if (!content?.trim()) throw ApiError.badRequest('content is required')
    if (!await this.deps.sessions.exists(targetSessionId)) throw ApiError.notFound('Target session not found')
    const message = await this.mutate(() => {
      if (this.ensureMember(callerSessionId).stopped) throw ApiError.conflict('Caller session was stopped; new user input is required')
      this.ensureMember(targetSessionId)
      const message = this.append(callerSessionId, targetSessionId, content, 'message', messageId)
      if (message.status === 'queued') { delete message.error; delete message.errorCode }
      return message
    })
    await this.pump()
    return (await this.status()).messages.find(item => item.id === message.id)!
  }

  async status(sessionIds?: string[]): Promise<CollaborationSnapshot> {
    await this.ready
    await this.tail
    const ids = sessionIds && new Set(sessionIds)
    const members = Object.values(this.store.members).filter(member => !ids || ids.has(member.sessionId))
    const titles = this.deps.sessions.titles
      ? await Promise.resolve(this.deps.sessions.titles(members.map(member => member.sessionId))).catch(() => undefined)
      : undefined
    return structuredClone({ revision: this.store.revision,
      members: members.map(member => {
        const indexedTitle = titles?.[member.sessionId]?.trim()
        return indexedTitle && indexedTitle !== 'Untitled Session'
          ? { ...member, title: indexedTitle }
          : member
      }),
      messages: this.store.messages.filter(message => !ids || ids.has(message.targetSessionId) || ids.has(message.sourceSessionId)) })
  }

  async wait(afterRevision: number, sessionIds?: string[], timeoutMs = COLLABORATION_WAIT_DEFAULT_MS, signal?: AbortSignal, callerSessionId?: string): Promise<CollaborationSnapshot> {
    if (signal?.aborted) throw signal.reason
    const requestedTimeoutMs = timeoutMs
    const clampedTimeoutMs = Math.min(COLLABORATION_WAIT_MAX_MS, Math.max(COLLABORATION_WAIT_MIN_MS, requestedTimeoutMs))
    const noteTimeout = (snapshot: CollaborationSnapshot): CollaborationSnapshot => requestedTimeoutMs === clampedTimeoutMs ? snapshot : { ...snapshot, requestedTimeoutMs, timeoutMs: clampedTimeoutMs, guidance: [`Requested timeout of ${requestedTimeoutMs}ms was clamped to ${clampedTimeoutMs}ms.`, snapshot.guidance].filter(Boolean).join('\n\n') }
    const inputVersion = callerSessionId ? this.userInputs.get(callerSessionId) ?? 0 : 0
    const current = await this.status(sessionIds)
    if (sessionIds?.length && callerSessionId && this.deps.sessions.teamMemberIdentities) {
      // A team lead that waits on its own members' names or worker session ids
      // would block for the full timeout: nothing here ever updates them,
      // because members report through teammate messages instead.
      const team = new Set(await Promise.resolve(this.deps.sessions.teamMemberIdentities(callerSessionId)).catch(() => []))
      if (sessionIds.every(id => team.has(id) && !this.store.members[id])) {
        return noteTimeout({ ...this.projectWait(current, afterRevision), guidance: UNKNOWN_WAIT_TARGET_GUIDANCE })
      }
    }
    const caller = callerSessionId ? this.store.members[callerSessionId] : undefined
    if (caller && caller.sessionId !== caller.rootSessionId) {
      const workers = Object.values(this.store.members).filter(member => member.rootSessionId === caller.rootSessionId && member.sessionId !== member.rootSessionId)
      const capacityUsed = workers.filter(member => member.state === 'running' || member.state === 'blocked').length
      const awaitedIds = sessionIds && new Set(sessionIds)
      const queuedTarget = workers.some(member => member.state === 'queued' && (!awaitedIds || awaitedIds.has(member.sessionId)))
      if (capacityUsed >= 3 && queuedTarget) return noteTimeout({ ...this.projectWait(current, afterRevision), waitReason: 'capacity_blocked',
        guidance: 'The three worker slots are occupied, including this turn. End the current turn to release its slot. Queued sessions will then start and automatically report completion or blockage; calling WaitSessions again does not release capacity.' })
    }
    if (current.revision > afterRevision) return noteTimeout(this.projectWait(current, afterRevision))
    await new Promise<void>((resolve, reject) => {
      const finish = () => { cleanup(); resolve() }
      const abort = () => { cleanup(); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')) }
      const timer = setTimeout(finish, clampedTimeoutMs)
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(finish); signal?.removeEventListener('abort', abort) }
      this.listeners.add(finish)
      signal?.addEventListener('abort', abort, { once: true })
      if (this.store.revision > afterRevision) finish()
      else if (callerSessionId && (this.userInputs.get(callerSessionId) ?? 0) !== inputVersion) finish()
      else if (signal?.aborted) abort()
    })
    if (callerSessionId && (this.userInputs.get(callerSessionId) ?? 0) !== inputVersion) {
      throw new ApiError(409, 'Waiting ended because the user supplied new input', 'WAIT_INTERRUPTED')
    }
    return noteTimeout(this.projectWait(await this.status(sessionIds), afterRevision))
  }

  private projectWait(snapshot: CollaborationSnapshot, afterRevision: number): CollaborationSnapshot {
    const changed = snapshot.messages.filter(message => (message.revision ?? snapshot.revision) > afterRevision)
    const messages: CollaborationMessage[] = []
    let remaining = 24_000
    let clipped = false
    for (const message of changed.slice(-50).reverse()) {
      const projected = { ...message, content: message.content.slice(0, 2000), ...(message.error ? { error: message.error.slice(0, 1000) } : {}) }
      const length = JSON.stringify(projected).length
      if (length > remaining) break
      remaining -= length
      clipped ||= projected.content.length < message.content.length || projected.error !== message.error
      messages.unshift(projected)
    }
    const members: CollaborationMember[] = []
    let memberBudget = 24_000
    for (const member of snapshot.members) {
      const projected = { ...member, ...(member.result ? { result: member.result.slice(0, 1000) } : {}) }
      const length = JSON.stringify(projected).length
      if (length > memberBudget || members.length >= 100) break
      memberBudget -= length
      clipped ||= projected.result !== member.result
      members.push(projected)
    }
    return { ...snapshot, members, messages, truncated: clipped || messages.length < changed.length || members.length < snapshot.members.length,
      omittedMessages: changed.length - messages.length, omittedMembers: snapshot.members.length - members.length }
  }

  /** A user Stop fences both queued messages and completion-triggered wakeups until an explicit resume. */
  async stop(sessionId: string): Promise<void> {
    await this.onStopped(sessionId)
    await this.deps.runtime.stop(sessionId)
    await this.pump()
  }

  async onStopped(sessionId: string): Promise<void> {
    this.userInputs.set(sessionId, (this.userInputs.get(sessionId) ?? 0) + 1)
    await this.mutate(() => {
      this.userAdmissions.delete(sessionId)
      const member = this.ensureMember(sessionId); member.stopped = true; member.state = 'stopped'
      // Applying changes issue their own runtime Stop. Only pending changes are
      // cancelled here, so an internal stop cannot cancel the active transition.
      for (const change of Object.values(this.store.modelChanges ?? {})) if (change.state === 'pending' && change.selections.some(item => item.sessionId === sessionId)) {
        change.state = 'cancelled'; change.revision++
      }
      for (const message of this.store.messages) if (message.targetSessionId === sessionId && message.status === 'accepted') {
        message.status = 'queued'
        delete message.error
        delete message.errorCode
      }
    })
    for (const listener of this.listeners) listener()
  }

  async stopGroup(sessionId: string): Promise<void> {
    const ids = await this.mutate(() => {
      const root = this.ensureMember(sessionId).rootSessionId
      this.store.stopEpochs ??= {}
      this.store.stopEpochs[root] = (this.store.stopEpochs[root] ?? 0) + 1
      const ids = Object.values(this.store.members).filter(member => member.rootSessionId === root).map(member => member.sessionId)
      const targets = new Set(ids)
      for (const change of Object.values(this.store.modelChanges ?? {})) if (change.state === 'pending' && change.selections.some(item => targets.has(item.sessionId))) { change.state = 'cancelled'; change.revision++ }
      for (const id of ids) { this.userAdmissions.delete(id); const member = this.ensureMember(id); member.stopped = true; member.state = 'stopped'; delete member.continuationId; delete member.continuationSourceSessionId }
      for (const message of this.store.messages) {
        if (targets.has(message.targetSessionId) && (message.status === 'queued' || message.status === 'accepted')) message.status = 'cancelled'
      }
      return ids
    })
    for (const id of ids) {
      this.userInputs.set(id, (this.userInputs.get(id) ?? 0) + 1)
    }
    for (const listener of this.listeners) listener()
    const outcomes = await Promise.allSettled(ids.map(id => this.deps.runtime.stop(id)))
    const failures = outcomes.filter(outcome => outcome.status === 'rejected')
    if (failures.length) throw ApiError.conflict(`Stopped collaboration wakeups, but ${failures.length} runtime stop request(s) failed`)
  }

  private appendPendingContinuation(member: CollaborationMember): void {
    if (!member.continuationId) return
    this.append(member.continuationSourceSessionId ?? member.parentSessionId ?? member.sessionId, member.sessionId, 'Continue the interrupted task from the saved conversation. Check the latest tool results and current state before acting; do not repeat completed actions or assume an interrupted operation failed.', 'message', member.continuationId)
    delete member.continuationId; delete member.continuationSourceSessionId
  }

  async resume(sessionId: string): Promise<void> {
    await this.mutate(() => {
      const member = this.ensureMember(sessionId); member.stopped = false; member.state = 'idle'
      this.appendPendingContinuation(member)
      for (const message of this.store.messages) if (message.targetSessionId === sessionId) { delete message.error; delete message.errorCode }
    })
    await this.pump()
  }

  /** Reserve manual worker capacity using the same serialized state as background dispatch. */
  async admitUserTurn(sessionId: string, canAdmit: () => boolean = () => true): Promise<{ release(): Promise<void> }> {
    await this.ready; await this.tail
    const token = Symbol(sessionId)
    const previous = await this.mutate(() => {
      if (Object.values(this.store.modelChanges ?? {}).some(change => (change.state === 'pending' || change.state === 'applying') && change.selections.some(item => item.sessionId === sessionId))) throw ApiError.conflict('Model change in progress; wait before sending a new message')
      if (!canAdmit()) throw ApiError.conflict('Session turn was cancelled before admission')
      const member = this.ensureMember(sessionId)
      const previous = this.userAdmissions.get(sessionId)?.previous ?? { state: member.state, stopped: member.stopped }
      const workers = Object.values(this.store.members).filter(other => other.rootSessionId === member.rootSessionId && other.sessionId !== other.rootSessionId && other.sessionId !== sessionId && (other.state === 'running' || other.state === 'blocked')).length
      if (member.sessionId !== member.rootSessionId && workers >= 3) throw new ApiError(409, 'All three worker slots are occupied. Wait for a worker to finish before sending this turn.', 'SESSION_WORKER_CAPACITY')
      member.state = 'running'
      member.stopped = false
      this.userAdmissions.set(sessionId, { token, previous })
      return previous
    })
    return { release: async () => {
      await this.mutate(() => {
        if (this.userAdmissions.get(sessionId)?.token !== token) return
        this.userAdmissions.delete(sessionId)
        const member = this.store.members[sessionId]
        if (member?.state === 'running') Object.assign(member, previous)
      })
      await this.pump()
    } }
  }

  /** Invoke after admitting real user input, before delivering queued collaboration messages. */
  async onUserInput(sessionId: string, options: { dispatch?: boolean } = {}): Promise<void> {
    this.userInputs.set(sessionId, (this.userInputs.get(sessionId) ?? 0) + 1)
    await this.mutate(() => {
      if (Object.values(this.store.modelChanges ?? {}).some(change => change.state === 'applying' && change.selections.some(item => item.sessionId === sessionId))) return
      const member = this.ensureMember(sessionId); member.stopped = false; member.state = 'running'
      delete member.continuationId; delete member.continuationSourceSessionId
      for (const message of this.store.messages) if (message.targetSessionId === sessionId && message.status === 'queued') { delete message.error; delete message.errorCode }
    })
    for (const listener of this.listeners) listener()
    if (options.dispatch !== false) await this.pump()
  }

  async onMessageConsumed(messageId: string, targetSessionId?: string): Promise<void> {
    await this.mutate(() => {
      const message = this.store.messages.find(item => item.id === messageId)
      if (message && message.status !== 'cancelled' && (!targetSessionId || message.targetSessionId === targetSessionId)) message.status = 'consumed'
    })
  }

  /** The host must recheck this at the final SDK socket write after startup awaits. */
  canDeliver(messageId: string): boolean {
    const message = this.store.messages.find(item => item.id === messageId)
    return Boolean(message && message.status === 'accepted' && !this.store.members[message.targetSessionId]?.stopped)
  }

  async onSessionState(sessionId: string, state: CollaborationState, result?: string, eventId?: string): Promise<void> {
    await this.mutate(() => {
      this.userAdmissions.delete(sessionId)
      const member = this.ensureMember(sessionId)
      const changed = member.state !== state || member.result !== result
      if (!member.stopped) member.state = state
      if (result !== undefined) member.result = result
      if (changed && !member.stopped && member.rootSessionId !== sessionId && ['completed', 'blocked', 'failed'].includes(state)) {
        this.append(sessionId, member.rootSessionId, result || `Session ${sessionId} is ${state}.`, state as 'completed' | 'blocked' | 'failed', eventId)
      }
    })
    await this.processPendingModelChanges()
    await this.pump()
  }

  /** Call once during host startup, before accepting new work. Never clears persisted Stop fences. */
  async recover(): Promise<void> {
    await this.mutate(() => {
      for (const member of Object.values(this.store.members)) {
        if (member.state === 'running' || member.state === 'queued' || member.state === 'blocked' || this.store.messages.some(message => message.targetSessionId === member.sessionId && (message.status === 'queued' || message.status === 'accepted'))) {
          member.state = 'stopped'
          member.stopped = true
        }
      }
      for (const message of this.store.messages) if (message.status === 'accepted') message.status = 'queued'
      for (const batch of Object.values(this.store.batches ?? {})) if (batch.state === 'launching') { batch.state = 'failed'; batch.revision++; batch.error = 'Startup was interrupted; review before retrying' }
      for (const change of Object.values(this.store.modelChanges ?? {})) if (change.state === 'applying' || change.state === 'pending') { change.state = 'failed'; change.revision++; change.error = 'Runtime change was interrupted; sessions remain paused' }
    })
  }

  private pump(): Promise<void> {
    // Runtime callbacks can await hooks while admission is in progress. The
    // current drain will observe their mutations; never await it recursively.
    if (this.pumping) return Promise.resolve()
    this.pumping = this.dispatch().finally(() => { this.pumping = null })
    return this.pumping
  }

  private async dispatch(): Promise<void> {
    while (true) {
      const admission = await this.mutate(() => {
        for (const message of this.store.messages) {
          if (message.status !== 'queued' || message.error) continue
          const member = this.store.members[message.targetSessionId]
          if (!member || member.stopped || member.state === 'blocked' || this.userAdmissions.has(member.sessionId)) continue
          if (Object.values(this.store.modelChanges ?? {}).some(change => (change.state === 'pending' || change.state === 'applying') && change.selections.some(item => item.sessionId === member.sessionId))) continue
          const liveState = this.deps.runtime.getState?.(member.sessionId)
          if (liveState === 'blocked') continue
          const running = liveState ? liveState === 'running' : member.state === 'running'
          const activeWorkers = Object.values(this.store.members).filter(other => other.rootSessionId === member.rootSessionId && other.sessionId !== other.rootSessionId && (other.state === 'running' || other.state === 'blocked')).length
          if (!running && member.sessionId !== member.rootSessionId && activeWorkers >= 3) continue
          message.status = 'accepted'
          member.state = 'running'
          return { message, running }
        }
        return null
      })
      if (!admission) return
      try {
        const selectedRuntime = this.store.members[admission.message.targetSessionId]?.runtime
        if (selectedRuntime && this.deps.models) await this.deps.models.validate(selectedRuntime)
        if (admission.running) await this.deps.runtime.enqueue(admission.message.targetSessionId, admission.message)
        else await this.deps.runtime.start(admission.message.targetSessionId, admission.message)
      } catch (error) {
        await this.mutate(() => {
          const message = this.store.messages.find(item => item.id === admission.message.id)!
          if (message.status === 'cancelled' || message.status === 'consumed') return
          message.status = 'queued'
          const member = this.store.members[message.targetSessionId]!
          if (member.stopped) return
          message.error = error instanceof Error ? error.message : String(error)
          if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') message.errorCode = error.code
          if (!member.stopped && !admission.running) {
            member.state = 'failed'
            if (member.rootSessionId !== member.sessionId) {
              this.append(member.sessionId, member.rootSessionId, `Unable to start session ${member.sessionId}: ${message.error}`, 'failed')
            }
          }
        })
      }
    }
  }
}
