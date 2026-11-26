/**
 * AntigravitySwarmAdapter — Read-only projection from Antigravity's native
 * `/swarm` on-disk state (`<appDataDir>/brain/<nativeSessionId>/.system_generated/swarm/`)
 * into cc-haha's `TeamWorkbenchSnapshot`, `TeamWorkbenchSessionTimeline`,
 * and `TeamTranscriptPage`.
 *
 * Also exposes an optional, injectable steering hook so `POST /api/teams/:name/members/:id/messages`
 * can forward `@<memberName> <content>` to an active ACP session without tight coupling
 * to `conversationService.ts`.
 *
 * Strictly read-only with respect to `~/.gemini/antigravity-cli/` and `~/.gemini/antigravity/`.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ApiError } from '../middleware/errorHandler.js'
import {
  antigravityBrainDir,
  ANTIGRAVITY_PROVIDER_ID,
  isSafeAntigravityId,
  normalizeAntigravityTimestamp,
  parseAntigravityModelEffort,
  parseAntigravityTranscriptContent,
  readAntigravitySubagentRegistry,
  readAntigravityTranscriptRaw,
  type AntigravityAdapterOptions,
} from './antigravityTranscriptAdapter.js'
import type { TaskInfo, TaskStatus } from './taskService.js'
import type {
  TeamDetail,
  TeamMember,
  TeamMemberActivity,
  TeamTranscriptPage,
  TeamTranscriptPageOptions,
  TeamWorkbenchMessage,
  TeamWorkbenchSessionTimeline,
  TeamWorkbenchSnapshot,
  TranscriptMessage,
} from './teamService.js'

export const ANTIGRAVITY_SWARM_TEAM_PREFIX = 'agy-swarm-'

const CURSOR_WINDOW_BYTES = 64 * 1024

// ─── Steering Hook Interface ───────────────────────────────────────────────

export type AntigravitySwarmSteerPayload = {
  teamName: string
  nativeSessionId: string
  sessionId?: string
  memberName: string
  agentId: string
  content: string
  formattedPrompt: string
}

export type AntigravitySwarmSteerResult = {
  routed: boolean
  delivery?: 'steering' | 'queued'
  formattedPrompt?: string
}

export type AntigravitySwarmSteerHandler = (
  payload: AntigravitySwarmSteerPayload,
) => Promise<AntigravitySwarmSteerResult | void>

export type SendAntigravitySwarmMessageResponse = {
  ok: true
  routed: true
  delivery: 'steering' | 'queued'
  target: string
  formattedPrompt: string
}

let registeredSteerHandler: AntigravitySwarmSteerHandler | null = null

/**
 * Register a runtime handler (e.g. from ConversationService / AntigravityConversation)
 * that delivers `@<memberName> <content>` steering prompts to the active ACP session.
 * Returns a disposer function that restores the previous handler only if still active.
 */
export function registerAntigravitySwarmSteerHandler(
  handler: AntigravitySwarmSteerHandler | null,
): () => void {
  registeredSteerHandler = handler
  return () => {
    if (registeredSteerHandler === handler) {
      registeredSteerHandler = null
    }
  }
}

export function getAntigravitySwarmSteerHandler(): AntigravitySwarmSteerHandler | null {
  return registeredSteerHandler
}

// ─── Native <-> cc-haha Session Mapping (in-memory hint) ──────────────────

const nativeToSessionId = new Map<string, string>()

export function rememberAntigravitySwarmSessionMapping(
  nativeSessionId: string,
  sessionId: string,
): void {
  if (isSafeAntigravityId(nativeSessionId) && sessionId.trim()) {
    nativeToSessionId.set(nativeSessionId, sessionId)
  }
}

export function getRememberedSessionIdForAntigravitySwarm(
  nativeSessionId: string,
): string | undefined {
  return nativeToSessionId.get(nativeSessionId)
}

// ─── Naming Helpers ────────────────────────────────────────────────────────

export function antigravitySwarmTeamName(nativeSessionId: string): string {
  return `${ANTIGRAVITY_SWARM_TEAM_PREFIX}${nativeSessionId}`
}

export function isAntigravitySwarmTeamName(teamName: string): boolean {
  return teamName.startsWith(ANTIGRAVITY_SWARM_TEAM_PREFIX)
    && isSafeAntigravityId(teamName.slice(ANTIGRAVITY_SWARM_TEAM_PREFIX.length))
}

export function nativeSessionIdFromSwarmTeamName(teamName: string): string | null {
  if (!isAntigravitySwarmTeamName(teamName)) return null
  return teamName.slice(ANTIGRAVITY_SWARM_TEAM_PREFIX.length)
}

// ─── Raw Disk Schemas (verified by Phase 0 probe on agy 1.5.17) ────────────

type RawSwarmMeta = {
  version?: unknown
  backend?: unknown
  swarm_id?: unknown
  created_at?: unknown
}

type RawSwarmMember = {
  conversation_id?: unknown
  role?: unknown
  desired_state?: unknown
  desired_model?: unknown
  applied_model?: unknown
  workspace_mode?: unknown
  phase?: unknown
  wake_mode?: unknown
  wait_since?: unknown
  last_read_seq?: unknown
  last_nudged_seq?: unknown
  last_park_blocked_seq?: unknown
  killed?: unknown
  model?: unknown
  error?: unknown
  last_error?: unknown
}

type RawMembersFile = {
  title?: unknown
  members?: unknown
}

type RawBoardMessage = {
  seq?: unknown
  agent?: unknown
  text?: unknown
  time?: unknown
  kind?: unknown
  request_id?: unknown
}

type SwarmTranscriptCursor = {
  version: 2
  size: number
  ctimeMs: number
  fileIdentity: string | null
  firstWindowHash: string
  lastWindowHash: string
  afterOrdinal: number
}

// ─── Internal Helpers ──────────────────────────────────────────────────────

function hash(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function swarmIncarnationId(
  name: string,
  createdAt: number,
  leadSessionId?: string,
): string {
  return hash(JSON.stringify([
    name,
    leadSessionId ?? '',
    Number.isFinite(createdAt) ? createdAt : 0,
  ]))
}

function uriToPath(uri: string | undefined): string {
  if (!uri) return ''
  if (uri.startsWith('file://')) {
    try {
      return fileURLToPath(uri)
    } catch {
      return uri.replace(/^file:\/\//, '')
    }
  }
  return uri
}

function normalizeTaskStatus(value: unknown): TaskStatus {
  if (typeof value !== 'string') return 'pending'
  const lower = value.trim().toLowerCase()
  if (lower === 'completed' || lower === 'done' || lower === 'finished') return 'completed'
  if (lower === 'in_progress' || lower === 'in-progress' || lower === 'working' || lower === 'running' || lower === 'active') {
    return 'in_progress'
  }
  return 'pending'
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function deriveSwarmMemberState(member: RawSwarmMember): {
  status: TeamMember['status']
  activity: TeamMemberActivity
} {
  const phase = typeof member.phase === 'string' ? member.phase.toUpperCase() : ''
  const desiredState = typeof member.desired_state === 'string' ? member.desired_state.toUpperCase() : ''
  const wakeMode = typeof member.wake_mode === 'string' ? member.wake_mode.toLowerCase() : ''
  const killed = member.killed === true

  if (killed || phase === 'KILLED' || desiredState === 'KILLED') {
    return { status: 'completed', activity: 'exited' }
  }
  if (phase === 'FAILED' || phase === 'ERROR') {
    return { status: 'failed', activity: 'exited' }
  }
  if (phase === 'STOPPED' || desiredState === 'STOPPED') {
    return { status: 'idle', activity: 'stopped' }
  }
  if (
    phase === 'WAITING'
    || phase === 'IDLE'
    || phase === 'SLEEPING'
    || phase === 'PARKED'
  ) {
    return { status: 'idle', activity: 'idle' }
  }
  if (phase === 'RUNNING' && (wakeMode === 'mentions' || wakeMode === 'all')) {
    return { status: 'idle', activity: 'idle' }
  }
  if (phase === 'RUNNING' || phase === 'WORKING' || phase === 'STARTING' || wakeMode === 'working') {
    return { status: 'running', activity: 'active' }
  }
  return { status: 'idle', activity: 'unknown' }
}

/**
 * Extract `@mention` targets from a swarm board post.
 */
export function extractBoardMentions(
  text: string,
  knownMemberNames: ReadonlySet<string>,
  sender: string,
): {
  to: string | '*'
  recipients: string[]
  kind: TeamWorkbenchMessage['kind']
} {
  const mentions: string[] = []
  let sawAll = false
  const regex = /(?:^|[^A-Za-z0-9_.-])@([a-z0-9][a-z0-9_-]{0,23})\b/gi
  let match: RegExpExecArray | null
  const senderLower = sender.toLowerCase()
  while ((match = regex.exec(text)) !== null) {
    const token = match[1]!.toLowerCase()
    if (token === 'all') {
      sawAll = true
      continue
    }
    if (token === senderLower) continue
    // Match exact roster name (case-insensitive)
    for (const memberName of knownMemberNames) {
      if (memberName.toLowerCase() === token && !mentions.includes(memberName)) {
        mentions.push(memberName)
        break
      }
    }
  }

  if (sawAll) {
    const allTargets = [...knownMemberNames].filter(name => name !== sender).sort()
    return {
      to: '*',
      recipients: allTargets.length > 0 ? allTargets : ['all'],
      kind: 'broadcast',
    }
  }
  if (mentions.length === 1) {
    return {
      to: mentions[0]!,
      recipients: mentions,
      kind: 'direct',
    }
  }
  if (mentions.length > 1) {
    return {
      to: '*',
      recipients: mentions,
      kind: 'broadcast',
    }
  }
  return {
    to: '*',
    recipients: [],
    kind: 'broadcast',
  }
}

function summarizeBoardText(text: string): string | undefined {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return undefined
  return cleaned.length <= 120 ? cleaned : `${cleaned.slice(0, 117)}...`
}

async function readSwarmBoardMessages(
  boardPath: string,
  knownMemberNames: ReadonlySet<string>,
): Promise<{
  messages: TeamWorkbenchMessage[]
  firstMentionTimeByMember: Map<string, number>
  latestTimestamp?: string
}> {
  let rawText: string
  try {
    rawText = await fs.readFile(boardPath, 'utf8')
  } catch {
    return { messages: [], firstMentionTimeByMember: new Map() }
  }

  const messages: TeamWorkbenchMessage[] = []
  const firstMentionTimeByMember = new Map<string, number>()
  let latestTimestamp: string | undefined

  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    const entry = parsed as RawBoardMessage
    const seq = typeof entry.seq === 'number' && Number.isFinite(entry.seq)
      ? entry.seq
      : messages.length + 1
    const from = nonEmptyString(entry.agent) ?? 'coordinator'
    const text = typeof entry.text === 'string' ? entry.text : ''
    const timestamp = normalizeAntigravityTimestamp(entry.time)
      ?? latestTimestamp
      ?? new Date(0).toISOString()
    if (!latestTimestamp || Date.parse(timestamp) >= Date.parse(latestTimestamp)) {
      latestTimestamp = timestamp
    }

    const { to, recipients, kind } = extractBoardMentions(text, knownMemberNames, from)
    const entryMs = Date.parse(timestamp)
    if (Number.isFinite(entryMs)) {
      if (!firstMentionTimeByMember.has(from)) {
        firstMentionTimeByMember.set(from, entryMs)
      }
      for (const recipient of recipients) {
        if (!firstMentionTimeByMember.has(recipient)) {
          firstMentionTimeByMember.set(recipient, entryMs)
        }
      }
    }

    const requestId = nonEmptyString(entry.request_id)
    const id = requestId ? `swarm:${seq}:${requestId}` : `swarm:${seq}`
    const summary = entry.kind === 'brief' ? summarizeBoardText(text) : undefined

    messages.push({
      id,
      from,
      to,
      recipients,
      kind,
      text,
      timestamp,
      ...(summary ? { summary } : {}),
    })
  }

  return { messages, firstMentionTimeByMember, latestTimestamp }
}

async function readSwarmPlanTasks(
  brainDir: string,
  swarmDir: string,
  taskListId: string,
): Promise<TaskInfo[]> {
  const candidates = [
    path.join(swarmDir, 'plan.json'),
    path.join(brainDir, 'plan.json'),
  ]
  for (const candidate of candidates) {
    const raw = await readJsonFile(candidate)
    if (!raw) continue
    const rawTasks = Array.isArray(raw)
      ? raw
      : isRecord(raw)
        ? (Array.isArray(raw.tasks)
            ? raw.tasks
            : Array.isArray(raw.steps)
              ? raw.steps
              : Array.isArray(raw.items)
                ? raw.items
                : null)
        : null
    if (!rawTasks) continue

    const tasks: TaskInfo[] = []
    rawTasks.forEach((item, index) => {
      if (!isRecord(item)) return
      const id = nonEmptyString(item.id)
        ?? (typeof item.id === 'number' && Number.isFinite(item.id) ? String(item.id) : String(index + 1))
      const subject = nonEmptyString(item.subject)
        ?? nonEmptyString(item.title)
        ?? nonEmptyString(item.name)
        ?? `Task #${id}`
      const description = typeof item.description === 'string'
        ? item.description
        : typeof item.detail === 'string'
          ? item.detail
          : ''
      const owner = nonEmptyString(item.owner) ?? nonEmptyString(item.assignee) ?? nonEmptyString(item.agent)
      const activeForm = nonEmptyString(item.activeForm)
      const blocks = stringArray(item.blocks)
      const blockedBy = stringArray(item.blockedBy ?? item.blocked_by ?? item.dependsOn ?? item.depends_on)
      const metadata = isRecord(item.metadata) ? item.metadata : undefined
      tasks.push({
        id,
        subject,
        description,
        status: normalizeTaskStatus(item.status),
        blocks,
        blockedBy,
        taskListId,
        ...(owner ? { owner } : {}),
        ...(activeForm ? { activeForm } : {}),
        ...(metadata ? { metadata } : {}),
      })
    })
    return tasks
  }
  return []
}

// ─── Public Swarm Projections ──────────────────────────────────────────────

export type AntigravitySwarmSnapshotOptions = AntigravityAdapterOptions & {
  leadSessionId?: string
  workDir?: string
}

export async function readAntigravitySwarmSnapshot(
  nativeSessionId: string,
  options: AntigravitySwarmSnapshotOptions = {},
): Promise<TeamWorkbenchSnapshot | null> {
  options.signal?.throwIfAborted()
  const brainDir = antigravityBrainDir(nativeSessionId, options.appDataDir)
  if (!brainDir) return null

  const swarmDir = path.join(brainDir, '.system_generated', 'swarm')
  const [rawSwarm, rawMembersFile] = await Promise.all([
    readJsonFile(path.join(swarmDir, 'swarm.json')),
    readJsonFile(path.join(swarmDir, 'members.json')),
  ])
  if (!isRecord(rawSwarm) && !isRecord(rawMembersFile)) return null

  const swarmMeta = (isRecord(rawSwarm) ? rawSwarm : {}) as RawSwarmMeta
  const membersFile = (isRecord(rawMembersFile) ? rawMembersFile : {}) as RawMembersFile
  const rawMembersMap = isRecord(membersFile.members) ? membersFile.members : {}
  const rosterNames = Object.keys(rawMembersMap)
  if (rosterNames.length === 0 && !isRecord(rawSwarm)) return null

  const teamName = antigravitySwarmTeamName(nativeSessionId)
  const leadSessionId = options.leadSessionId
    ?? getRememberedSessionIdForAntigravitySwarm(nativeSessionId)
  if (leadSessionId) {
    rememberAntigravitySwarmSessionMapping(nativeSessionId, leadSessionId)
  }

  const createdAtIso = normalizeAntigravityTimestamp(swarmMeta.created_at)
  let createdAt = createdAtIso ? Date.parse(createdAtIso) : Number.NaN
  if (!Number.isFinite(createdAt)) {
    try {
      const stat = await fs.stat(swarmDir)
      createdAt = stat.birthtimeMs || stat.mtimeMs
    } catch {
      createdAt = 0
    }
  }

  const knownMemberNames = new Set(rosterNames)
  knownMemberNames.add('coordinator')

  const [board, subagentRecords, tasks] = await Promise.all([
    readSwarmBoardMessages(path.join(swarmDir, 'board.jsonl'), knownMemberNames),
    readAntigravitySubagentRegistry(nativeSessionId, options),
    readSwarmPlanTasks(brainDir, swarmDir, teamName),
  ])

  const workspaceByConvId = new Map<string, string>()
  for (const record of subagentRecords) {
    const firstUri = record.workspaceUris[0]
    if (firstUri) {
      workspaceByConvId.set(record.conversationId, uriToPath(firstUri))
    }
  }

  const members: TeamMember[] = rosterNames.map((rosterName) => {
    const raw = isRecord(rawMembersMap[rosterName])
      ? rawMembersMap[rosterName] as RawSwarmMember
      : {}
    const conversationId = nonEmptyString(raw.conversation_id)
    const model = nonEmptyString(raw.applied_model)
      ?? nonEmptyString(raw.model)
      ?? nonEmptyString(raw.desired_model)
    const effortLevel = parseAntigravityModelEffort(model)
    const { status, activity } = deriveSwarmMemberState(raw)
    const role = nonEmptyString(raw.role)
    const lastError = nonEmptyString(raw.last_error) ?? nonEmptyString(raw.error)
    const cwd = (conversationId ? workspaceByConvId.get(conversationId) : undefined)
      ?? options.workDir
      ?? ''
    const joinedAt = board.firstMentionTimeByMember.get(rosterName) ?? createdAt

    return {
      agentId: `${rosterName}@${teamName}`,
      name: rosterName,
      agentType: role ?? (rosterName === 'coordinator' ? 'coordinator' : 'worker'),
      ...(model ? { model } : {}),
      providerId: ANTIGRAVITY_PROVIDER_ID,
      providerName: 'Antigravity',
      ...(effortLevel ? { effortLevel } : {}),
      backendType: 'antigravity-swarm',
      status,
      activity,
      ...(lastError ? { lastError } : {}),
      joinedAt,
      cwd,
      ...(conversationId ? { sessionId: conversationId } : {}),
    }
  }).sort((left, right) => {
    if (left.name === 'coordinator' && right.name !== 'coordinator') return -1
    if (right.name === 'coordinator' && left.name !== 'coordinator') return 1
    return left.joinedAt - right.joinedAt || left.name.localeCompare(right.name)
  })

  const leadMember = members.find(member => member.agentType === 'coordinator' || member.name === 'coordinator')
    ?? members[0]
  const leadAgentId = leadMember?.agentId ?? `coordinator@${teamName}`
  const description = nonEmptyString(membersFile.title)

  const activeMemberCount = members.filter(member => member.status === 'running').length
  const allExited = members.length > 0 && members.every(member => member.activity === 'exited')

  const team: TeamDetail = {
    name: teamName,
    ...(description ? { description } : {}),
    createdAt,
    incarnationId: swarmIncarnationId(teamName, createdAt, leadSessionId),
    memberCount: members.length,
    activeMemberCount,
    leadAgentId,
    ...(leadSessionId ? { leadSessionId } : {}),
    members,
  }

  let latestMtimeMs = createdAt
  for (const filename of ['members.json', 'board.jsonl', 'swarm.json']) {
    try {
      const stat = await fs.stat(path.join(swarmDir, filename))
      if (stat.mtimeMs > latestMtimeMs) latestMtimeMs = stat.mtimeMs
    } catch {
      // Optional file
    }
  }
  const boardLatestMs = board.latestTimestamp ? Date.parse(board.latestTimestamp) : Number.NaN
  if (Number.isFinite(boardLatestMs) && boardLatestMs > latestMtimeMs) {
    latestMtimeMs = boardLatestMs
  }
  const generatedAt = new Date(latestMtimeMs || Date.now()).toISOString()

  const deletedAt = allExited ? generatedAt : undefined
  const canonical = JSON.stringify({ team, tasks, messages: board.messages, deletedAt })

  return {
    version: hash(canonical),
    generatedAt,
    team,
    tasks,
    messages: board.messages,
    ...(deletedAt ? { deletedAt } : {}),
  }
}

export async function readAntigravitySwarmTimeline(
  sessionId: string,
  nativeSessionId: string,
  options: Omit<AntigravitySwarmSnapshotOptions, 'leadSessionId'> = {},
): Promise<TeamWorkbenchSessionTimeline | null> {
  const snapshot = await readAntigravitySwarmSnapshot(nativeSessionId, {
    ...options,
    leadSessionId: sessionId,
  })
  if (!snapshot) return null
  return {
    sessionId,
    teamName: snapshot.team.name,
    incarnationId: snapshot.team.incarnationId,
    snapshots: [snapshot],
    source: snapshot.deletedAt ? 'archive' : 'live',
  }
}

// ─── Member Transcript Page (Incremental Cursor Compatible) ────────────────

function encodeCursor(cursor: SwarmTranscriptCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeCursor(value: string | undefined): SwarmTranscriptCursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as SwarmTranscriptCursor
    if (
      parsed.version === 2
      && Number.isSafeInteger(parsed.size) && parsed.size >= 0
      && Number.isFinite(parsed.ctimeMs) && parsed.ctimeMs >= 0
      && Number.isSafeInteger(parsed.afterOrdinal) && parsed.afterOrdinal >= -1
      && (parsed.fileIdentity === null || typeof parsed.fileIdentity === 'string')
      && typeof parsed.firstWindowHash === 'string'
      && typeof parsed.lastWindowHash === 'string'
    ) return parsed
  } catch {
    // Malformed client cursor triggers clean reset
  }
  return null
}

function cursorForBuffer(
  bytes: Buffer,
  fileIdentity: string | null,
  ctimeMs: number,
  afterOrdinal: number,
): SwarmTranscriptCursor {
  return {
    version: 2,
    size: bytes.length,
    ctimeMs,
    fileIdentity,
    firstWindowHash: hash(bytes.subarray(0, Math.min(bytes.length, CURSOR_WINDOW_BYTES))),
    lastWindowHash: hash(bytes.subarray(Math.max(0, bytes.length - CURSOR_WINDOW_BYTES))),
    afterOrdinal,
  }
}

function bufferPreservesPrefix(
  bytes: Buffer,
  cursor: SwarmTranscriptCursor,
  fileIdentity: string | null,
): boolean {
  if (bytes.length <= cursor.size) return false
  if (
    cursor.fileIdentity !== null
    && fileIdentity !== null
    && cursor.fileIdentity !== fileIdentity
  ) return false
  const firstEnd = Math.min(cursor.size, CURSOR_WINDOW_BYTES)
  const lastStart = Math.max(0, cursor.size - CURSOR_WINDOW_BYTES)
  return hash(bytes.subarray(0, firstEnd)) === cursor.firstWindowHash
    && hash(bytes.subarray(lastStart, cursor.size)) === cursor.lastWindowHash
}

function resolveMemberFromSnapshot(
  snapshot: TeamWorkbenchSnapshot,
  agentId: string,
): TeamMember | undefined {
  const shortName = agentId.includes('@') ? agentId.split('@')[0]! : agentId
  return snapshot.team.members.find((member) => (
    member.agentId === agentId
    || member.name === agentId
    || member.name === shortName
    || member.sessionId === agentId
  ))
}

export async function readAntigravitySwarmMemberTranscriptPage(
  teamName: string,
  agentId: string,
  options: TeamTranscriptPageOptions & AntigravityAdapterOptions = {},
): Promise<TeamTranscriptPage> {
  const nativeSessionId = nativeSessionIdFromSwarmTeamName(teamName)
  if (!nativeSessionId) {
    throw ApiError.notFound(`Team not found: ${teamName}`)
  }

  const snapshot = await readAntigravitySwarmSnapshot(nativeSessionId, {
    appDataDir: options.appDataDir,
    leadSessionId: options.leadSessionId,
    signal: options.signal,
  })
  if (!snapshot) {
    throw ApiError.notFound(`Team not found: ${teamName}`)
  }

  const member = resolveMemberFromSnapshot(snapshot, agentId)
  if (!member) {
    throw ApiError.notFound(`Team member not found: ${agentId} in team ${teamName}`)
  }

  const conversationId = member.sessionId
  if (!conversationId || !isSafeAntigravityId(conversationId)) {
    return {
      messages: [],
      ownerAgentIds: [],
      taskNotifications: [],
      taskAnchors: [],
      signature: 'missing',
      cursor: encodeCursor(cursorForBuffer(Buffer.alloc(0), null, 0, -1)),
      afterOrdinal: -1,
    }
  }

  const raw = await readAntigravityTranscriptRaw(conversationId, {
    appDataDir: options.appDataDir,
    maxBytes: options.maxBytes,
    signal: options.signal,
  })
  if (!raw) {
    return {
      messages: [],
      ownerAgentIds: [conversationId],
      taskNotifications: [],
      taskAnchors: [],
      signature: 'missing',
      cursor: encodeCursor(cursorForBuffer(Buffer.alloc(0), null, 0, -1)),
      afterOrdinal: -1,
    }
  }

  const parsed = parseAntigravityTranscriptContent(conversationId, raw.text, {
    truncated: raw.truncated,
    historyComplete: !raw.truncated,
  })
  const allMessages: TranscriptMessage[] = parsed.messages.map((message) => ({
    id: message.id,
    type: message.type,
    content: message.content,
    timestamp: message.timestamp,
    ...(message.model ? { model: message.model } : {}),
    ...(message.parentToolUseId ? { parentToolUseId: message.parentToolUseId } : {}),
    ...(message.toolUseResult !== undefined ? { toolUseResult: message.toolUseResult } : {}),
    ...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
  }))

  const fileIdentity = process.platform === 'win32' || raw.ino === 0
    ? null
    : `${raw.dev}:${raw.ino}`
  const signature = hash(raw.bytes)
  const currentAfterOrdinal = allMessages.length - 1
  const previousCursor = decodeCursor(options.cursor)
  let afterOrdinal = options.afterOrdinal ?? -1
  let reset = false

  if (options.cursor !== undefined && !previousCursor) {
    afterOrdinal = -1
    reset = true
  } else if (afterOrdinal >= 0 && !options.signature) {
    afterOrdinal = -1
    reset = true
  } else if (afterOrdinal > currentAfterOrdinal) {
    afterOrdinal = -1
    reset = true
  } else if (previousCursor && previousCursor.afterOrdinal !== afterOrdinal) {
    afterOrdinal = -1
    reset = true
  } else if (options.signature) {
    if (options.signature === signature) {
      const snapshotMismatch = previousCursor && (
        previousCursor.size !== raw.bytes.length
        || previousCursor.ctimeMs !== raw.ctimeMs
        || (
          previousCursor.fileIdentity !== null
          && fileIdentity !== null
          && previousCursor.fileIdentity !== fileIdentity
        )
      )
      if (snapshotMismatch) {
        afterOrdinal = -1
        reset = true
      }
    } else {
      const appendProven = previousCursor
        && raw.bytes.length > previousCursor.size
        && bufferPreservesPrefix(raw.bytes, previousCursor, fileIdentity)
      if (!appendProven) {
        afterOrdinal = -1
        reset = true
      }
    }
  }

  const cursor = encodeCursor(cursorForBuffer(
    raw.bytes,
    fileIdentity,
    raw.ctimeMs,
    currentAfterOrdinal,
  ))

  return {
    messages: allMessages.slice(afterOrdinal + 1),
    ownerAgentIds: [conversationId],
    taskNotifications: [],
    taskAnchors: [],
    signature,
    cursor,
    afterOrdinal: currentAfterOrdinal,
    ...(reset ? { reset: true } : {}),
  }
}

// ─── Member Message Steering ───────────────────────────────────────────────

export function formatAntigravitySwarmSteerPrompt(
  memberName: string,
  content: string,
): string {
  const trimmed = content.trim()
  if (memberName === 'coordinator' || trimmed.startsWith('/')) return trimmed
  const mentionPrefix = new RegExp(`^@${memberName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`, 'i')
  if (mentionPrefix.test(trimmed)) return trimmed
  return `@${memberName} ${trimmed}`
}

export async function sendAntigravitySwarmMemberMessage(
  teamName: string,
  agentId: string,
  content: string,
  options: AntigravityAdapterOptions & {
    leadSessionId?: string
    steerHandler?: AntigravitySwarmSteerHandler | null
  } = {},
): Promise<SendAntigravitySwarmMessageResponse> {
  const text = content.trim()
  if (!text) {
    throw ApiError.badRequest('content (string) is required in request body')
  }

  const nativeSessionId = nativeSessionIdFromSwarmTeamName(teamName)
  if (!nativeSessionId) {
    throw ApiError.notFound(`Team not found: ${teamName}`)
  }

  const snapshot = await readAntigravitySwarmSnapshot(nativeSessionId, {
    appDataDir: options.appDataDir,
    leadSessionId: options.leadSessionId,
    signal: options.signal,
  })
  if (!snapshot) {
    throw ApiError.notFound(`Team not found: ${teamName}`)
  }

  const member = resolveMemberFromSnapshot(snapshot, agentId)
  if (!member) {
    throw ApiError.notFound(`Team member not found: ${agentId} in team ${teamName}`)
  }
  if (member.activity === 'exited') {
    throw ApiError.conflict(`Swarm member ${member.name} has already exited and cannot receive messages.`)
  }

  const formattedPrompt = formatAntigravitySwarmSteerPrompt(member.name, text)
  const sessionId = options.leadSessionId
    ?? snapshot.team.leadSessionId
    ?? getRememberedSessionIdForAntigravitySwarm(nativeSessionId)

  const handler = options.steerHandler !== undefined
    ? options.steerHandler
    : registeredSteerHandler

  if (!handler) {
    throw new ApiError(
      503,
      `Antigravity swarm steering is unavailable for ${member.name}; send "${formattedPrompt}" in the main chat.`,
      'ANTIGRAVITY_SWARM_STEERING_UNAVAILABLE',
    )
  }

  const result = await handler({
    teamName,
    nativeSessionId,
    ...(sessionId ? { sessionId } : {}),
    memberName: member.name,
    agentId: member.agentId,
    content: text,
    formattedPrompt,
  })

  if (result && result.routed === false) {
    throw new ApiError(
      503,
      `Could not deliver message to swarm member ${member.name}. Try again.`,
      'ANTIGRAVITY_SWARM_STEERING_UNAVAILABLE',
    )
  }

  return {
    ok: true,
    routed: true,
    delivery: result?.delivery ?? 'steering',
    target: member.name,
    formattedPrompt: result?.formattedPrompt ?? formattedPrompt,
  }
}
