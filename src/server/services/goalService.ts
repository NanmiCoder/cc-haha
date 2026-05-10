import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

export type GoalStatus = 'active' | 'paused' | 'budget_limited' | 'complete'

export type GoalUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
}

export type SessionGoal = {
  sessionId: string
  goalId: string
  objective: string
  status: GoalStatus
  tokenBudget?: number
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: string
  updatedAt: string
}

type GoalStoreFile = {
  sessions: Record<string, SessionGoal>
  [key: string]: unknown
}

type GoalServiceOptions = {
  storagePath?: string
  now?: () => Date
}

const VALID_STATUSES = new Set<GoalStatus>([
  'active',
  'paused',
  'budget_limited',
  'complete',
])

export class GoalService {
  private readonly storagePath?: string
  private readonly now: () => Date
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(options: GoalServiceOptions = {}) {
    this.storagePath = options.storagePath
    this.now = options.now ?? (() => new Date())
  }

  async getGoal(sessionId: string): Promise<SessionGoal | null> {
    const store = await this.readStore()
    return store.sessions[sessionId] ?? null
  }

  async setGoalObjective(
    sessionId: string,
    objective: string,
    options: { tokenBudget?: number } = {},
  ): Promise<SessionGoal> {
    const trimmedObjective = objective.trim()
    if (!trimmedObjective) {
      throw new Error('Goal objective cannot be empty')
    }

    const tokenBudget =
      options.tokenBudget !== undefined
        ? normalizeTokenBudget(options.tokenBudget)
        : undefined
    const now = this.now().toISOString()
    const goal: SessionGoal = {
      sessionId,
      goalId: crypto.randomUUID(),
      objective: trimmedObjective,
      status: 'active',
      ...(tokenBudget !== undefined ? { tokenBudget } : {}),
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: now,
      updatedAt: now,
    }

    await this.updateStore((store) => {
      store.sessions[sessionId] = goal
      return store
    })
    return goal
  }

  async setGoalStatus(
    sessionId: string,
    status: GoalStatus,
  ): Promise<SessionGoal | null> {
    if (!VALID_STATUSES.has(status)) {
      throw new Error(`Invalid goal status: ${status}`)
    }

    let updated: SessionGoal | null = null
    await this.updateStore((store) => {
      const existing = store.sessions[sessionId]
      if (!existing) return store
      updated = {
        ...existing,
        status,
        updatedAt: this.now().toISOString(),
      }
      store.sessions[sessionId] = updated
      return store
    })
    return updated
  }

  async clearGoal(sessionId: string): Promise<boolean> {
    let existed = false
    await this.updateStore((store) => {
      existed = Boolean(store.sessions[sessionId])
      delete store.sessions[sessionId]
      return store
    })
    return existed
  }

  async accountUsage(
    sessionId: string,
    usage: GoalUsage,
    elapsedSeconds = 0,
  ): Promise<SessionGoal | null> {
    let updated: SessionGoal | null = null
    await this.updateStore((store) => {
      const existing = store.sessions[sessionId]
      if (!existing) return store

      const tokensUsed = existing.tokensUsed + getUsageTokens(usage)
      const timeUsedSeconds =
        existing.timeUsedSeconds + Math.max(0, Math.round(elapsedSeconds))
      const nextStatus =
        existing.tokenBudget !== undefined &&
        tokensUsed >= existing.tokenBudget &&
        existing.status === 'active'
          ? 'budget_limited'
          : existing.status

      updated = {
        ...existing,
        tokensUsed,
        timeUsedSeconds,
        status: nextStatus,
        updatedAt: this.now().toISOString(),
      }
      store.sessions[sessionId] = updated
      return store
    })
    return updated
  }

  private async updateStore(
    updater: (store: GoalStoreFile) => GoalStoreFile,
  ): Promise<void> {
    const write = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const store = await this.readStore()
        await this.writeStore(updater(store))
      })
    this.writeQueue = write
    await write
  }

  private async readStore(): Promise<GoalStoreFile> {
    const storagePath = this.getStoragePath()
    let raw = ''
    try {
      raw = await fs.readFile(storagePath, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { sessions: {} }
      }
      throw err
    }

    if (!raw.trim()) {
      return { sessions: {} }
    }

    try {
      const parsed = JSON.parse(raw) as unknown
      return normalizeStore(parsed)
    } catch {
      return { sessions: {} }
    }
  }

  private async writeStore(store: GoalStoreFile): Promise<void> {
    const storagePath = this.getStoragePath()
    await fs.mkdir(path.dirname(storagePath), { recursive: true })
    const tmpPath = `${storagePath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, 'utf-8')
    await fs.rename(tmpPath, storagePath)
  }

  private getStoragePath(): string {
    if (this.storagePath) return this.storagePath
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    return path.join(configDir, 'cc-haha', 'session-goals.json')
  }
}

function normalizeStore(parsed: unknown): GoalStoreFile {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { sessions: {} }
  }

  const record = parsed as Record<string, unknown>
  const hasSessionsObject =
    record.sessions && typeof record.sessions === 'object' && !Array.isArray(record.sessions)
  const sessionsSource =
    hasSessionsObject
      ? record.sessions as Record<string, unknown>
      : record

  const sessions: Record<string, SessionGoal> = {}
  for (const [sessionId, value] of Object.entries(sessionsSource)) {
    const goal = normalizeGoal(sessionId, value)
    if (goal) sessions[sessionId] = goal
  }

  return hasSessionsObject ? { ...record, sessions } : { sessions }
}

function normalizeGoal(sessionId: string, value: unknown): SessionGoal | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.objective !== 'string' || !record.objective.trim()) return null

  const status = typeof record.status === 'string' && VALID_STATUSES.has(record.status as GoalStatus)
    ? record.status as GoalStatus
    : 'paused'
  const now = new Date().toISOString()
  const tokenBudget =
    typeof record.tokenBudget === 'number' && Number.isFinite(record.tokenBudget) && record.tokenBudget > 0
      ? Math.floor(record.tokenBudget)
      : undefined

  return {
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : sessionId,
    goalId: typeof record.goalId === 'string' ? record.goalId : crypto.randomUUID(),
    objective: record.objective.trim(),
    status,
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    tokensUsed: normalizeNonNegativeInteger(record.tokensUsed),
    timeUsedSeconds: normalizeNonNegativeInteger(record.timeUsedSeconds),
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : now,
  }
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}

function normalizeTokenBudget(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Goal token budget must be a positive number')
  }
  return Math.floor(value)
}

function getUsageTokens(usage: GoalUsage): number {
  return (
    normalizeNonNegativeInteger(usage.input_tokens) +
    normalizeNonNegativeInteger(usage.output_tokens) +
    normalizeNonNegativeInteger(usage.cache_read_tokens) +
    normalizeNonNegativeInteger(usage.cache_creation_tokens)
  )
}

export const goalService = new GoalService()
