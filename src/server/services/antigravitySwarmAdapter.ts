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
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  TeamRuntimeControlAction,
  TeamRuntimeControlIdentity,
  TeamRuntimeControlView,
} from '../../shared/teamRuntimeControl.js'
import { TeamPlanError } from '../../utils/swarm/teamPlanStore.js'
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
  reason?: 'busy' | 'unavailable'
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
  const previous = registeredSteerHandler
  registeredSteerHandler = handler
  return () => {
    if (registeredSteerHandler === handler) {
      registeredSteerHandler = previous
    }
  }
}

export function getAntigravitySwarmSteerHandler(): AntigravitySwarmSteerHandler | null {
  return registeredSteerHandler
}

// ─── Runtime Probe, Resume Hook & Control State ────────────────────────────

export type AntigravitySwarmRuntimeProbe = (nativeSessionId: string) => boolean

export type AntigravitySwarmResumePayload = {
  teamName: string
  nativeSessionId: string
  sessionId: string
  prompt: string
}

export type AntigravitySwarmResumeHandler = (
  payload: AntigravitySwarmResumePayload,
) => Promise<{ routed: boolean; error?: string }>

export type AntigravitySwarmChangeListener = () => void

let registeredRuntimeProbe: AntigravitySwarmRuntimeProbe | null = null
let registeredResumeHandler: AntigravitySwarmResumeHandler | null = null
const swarmChangeListeners = new Set<AntigravitySwarmChangeListener>()

export function registerAntigravitySwarmRuntimeProbe(
  probe: AntigravitySwarmRuntimeProbe | null,
): () => void {
  const previous = registeredRuntimeProbe
  registeredRuntimeProbe = probe
  return () => {
    if (registeredRuntimeProbe === probe) {
      registeredRuntimeProbe = previous
    }
  }
}

export function registerAntigravitySwarmResumeHandler(
  handler: AntigravitySwarmResumeHandler | null,
): () => void {
  const previous = registeredResumeHandler
  registeredResumeHandler = handler
  return () => {
    if (registeredResumeHandler === handler) {
      registeredResumeHandler = previous
    }
  }
}

export function addAntigravitySwarmChangeListener(
  listener: AntigravitySwarmChangeListener,
): () => void {
  swarmChangeListeners.add(listener)
  return () => {
    swarmChangeListeners.delete(listener)
  }
}

function notifyAntigravitySwarmChanged(): void {
  for (const listener of swarmChangeListeners) {
    try {
      listener()
    } catch {
      // Best-effort notification; watcher polling remains as fallback.
    }
  }
}

type AntigravitySwarmControlRecord = {
  status: TeamRuntimeControlView['status']
  revision: number
  epoch: number
  controlSequence: number
  updatedAt: number
  pausedAt?: number
  pausedAtBoardSeq?: number
  error?: string
  resume?: {
    requestId: string
    epoch: number
    createdAt: number
  }
}

const swarmControlRecords = new Map<string, AntigravitySwarmControlRecord>()
const swarmResumeOperations = new Map<string, Promise<TeamRuntimeControlView>>()

export type AntigravitySwarmPauseToken = {
  sequence: number
  epoch: number
}

export function beginAntigravitySwarmPause(nativeSessionId: string): AntigravitySwarmPauseToken {
  const now = Date.now()
  const prev = swarmControlRecords.get(nativeSessionId)
  const next: AntigravitySwarmControlRecord = {
    status: 'pausing',
    revision: (prev?.revision ?? 0) + 1,
    epoch: (prev?.epoch ?? 0) + 1,
    controlSequence: (prev?.controlSequence ?? 0) + 1,
    updatedAt: now,
    pausedAt: now,
  }
  swarmControlRecords.set(nativeSessionId, next)
  notifyAntigravitySwarmChanged()
  return { sequence: next.controlSequence, epoch: next.epoch }
}

export function completeAntigravitySwarmPause(
  nativeSessionId: string,
  token: AntigravitySwarmPauseToken,
  options: { error?: string; boardMaxSeq?: number } = {},
): boolean {
  const current = swarmControlRecords.get(nativeSessionId)
  if (!current || current.controlSequence !== token.sequence || current.epoch !== token.epoch) {
    return false
  }
  const now = Date.now()
  swarmControlRecords.set(nativeSessionId, {
    ...current,
    status: options.error ? 'partial' : 'paused',
    revision: current.revision + 1,
    updatedAt: now,
    ...(options.boardMaxSeq !== undefined ? { pausedAtBoardSeq: options.boardMaxSeq } : {}),
    ...(options.error ? { error: options.error } : { error: undefined }),
  })
  notifyAntigravitySwarmChanged()
  return true
}

export function clearAntigravitySwarmPause(nativeSessionId: string): void {
  const current = swarmControlRecords.get(nativeSessionId)
  if (!current || current.status === 'running') return
  swarmControlRecords.set(nativeSessionId, {
    ...current,
    status: 'running',
    revision: current.revision + 1,
    updatedAt: Date.now(),
    pausedAt: undefined,
    pausedAtBoardSeq: undefined,
    error: undefined,
  })
  notifyAntigravitySwarmChanged()
}

export function resetAntigravitySwarmControlStateForTests(): void {
  swarmControlRecords.clear()
  swarmResumeOperations.clear()
}

export function hasAntigravitySwarmOnDiskSync(
  nativeSessionId: string,
  options: AntigravityAdapterOptions = {},
): boolean {
  const brainDir = antigravityBrainDir(nativeSessionId, options.appDataDir)
  if (!brainDir) return false
  const swarmDir = path.join(brainDir, '.system_generated', 'swarm')
  return existsSync(path.join(swarmDir, 'swarm.json')) || existsSync(path.join(swarmDir, 'members.json'))
}

export async function hasAntigravitySwarmOnDisk(
  nativeSessionId: string,
  options: AntigravityAdapterOptions = {},
): Promise<boolean> {
  const brainDir = antigravityBrainDir(nativeSessionId, options.appDataDir)
  if (!brainDir) return false
  const swarmDir = path.join(brainDir, '.system_generated', 'swarm')
  const [rawSwarm, rawMembers] = await Promise.all([
    readJsonFile(path.join(swarmDir, 'swarm.json')),
    readJsonFile(path.join(swarmDir, 'members.json')),
  ])
  return isRecord(rawSwarm) || isRecord(rawMembers)
}

export async function readAntigravitySwarmBoardMaxSeq(
  nativeSessionId: string,
  options: AntigravityAdapterOptions = {},
): Promise<number> {
  const brainDir = antigravityBrainDir(nativeSessionId, options.appDataDir)
  if (!brainDir) return 0
  const boardPath = path.join(brainDir, '.system_generated', 'swarm', 'board.jsonl')
  let rawText: string
  try {
    rawText = await fs.readFile(boardPath, 'utf8')
  } catch {
    return 0
  }
  let maxSeq = 0
  let lineCount = 0
  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    lineCount += 1
    try {
      const parsed = JSON.parse(line) as RawBoardMessage
      if (nonEmptyString(parsed?.agent) === 'system') continue
      const seq = typeof parsed?.seq === 'number' && Number.isFinite(parsed.seq) ? parsed.seq : lineCount
      if (seq > maxSeq) maxSeq = seq
    } catch {
      // ignore malformed line
    }
  }
  return maxSeq
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

export function listRememberedAntigravitySwarmSessions(): Array<{
  nativeSessionId: string
  sessionId: string
}> {
  return [...nativeToSessionId.entries()].map(([nativeSessionId, sessionId]) => ({
    nativeSessionId,
    sessionId,
  }))
}

export function forgetAntigravitySwarmSessionMapping(nativeSessionId: string): void {
  nativeToSessionId.delete(nativeSessionId)
}

export function forgetAntigravitySwarmSessionMappingsForSession(sessionId: string): void {
  for (const [nativeId, mappedSessionId] of nativeToSessionId.entries()) {
    if (mappedSessionId === sessionId) {
      nativeToSessionId.delete(nativeId)
    }
  }
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
  nativeSessionId: string,
  createdAt: number,
  swarmId?: string,
): string {
  return hash(JSON.stringify([
    antigravitySwarmTeamName(nativeSessionId),
    swarmId ?? nativeSessionId,
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
    || phase === 'WAITING_ON_PEER'
    || phase === 'WAITING_ON_A_PEER'
    || phase === 'WAITING_PEER'
    || phase === 'BLOCKED'
  ) {
    return { status: 'idle', activity: 'idle' }
  }
  if (phase === 'RUNNING' && (wakeMode === 'mentions' || wakeMode === 'all' || wakeMode === 'anything')) {
    return { status: 'idle', activity: 'idle' }
  }
  if (
    phase === 'RUNNING'
    || phase === 'WORKING'
    || phase === 'STARTING'
    || phase === 'IN_REVIEW'
    || phase === 'REVIEW'
    || phase === 'REVIEWING'
    || wakeMode === 'working'
  ) {
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

type BoardEntryDetail = {
  seq: number
  from: string
  kind?: string
  text: string
  recipients: string[]
}

async function readSwarmBoardMessages(
  boardPath: string,
  knownMemberNames: ReadonlySet<string>,
): Promise<{
  messages: TeamWorkbenchMessage[]
  entries: BoardEntryDetail[]
  firstMentionTimeByMember: Map<string, number>
  latestTimestamp?: string
}> {
  let rawText: string
  try {
    rawText = await fs.readFile(boardPath, 'utf8')
  } catch {
    return { messages: [], entries: [], firstMentionTimeByMember: new Map() }
  }

  const messages: TeamWorkbenchMessage[] = []
  const entries: BoardEntryDetail[] = []
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
    const rawKind = nonEmptyString(entry.kind)
    const timestamp = normalizeAntigravityTimestamp(entry.time)
      ?? latestTimestamp
      ?? new Date(0).toISOString()
    if (!latestTimestamp || Date.parse(timestamp) >= Date.parse(latestTimestamp)) {
      latestTimestamp = timestamp
    }

    const { to, recipients, kind } = extractBoardMentions(text, knownMemberNames, from)
    const entryMs = Date.parse(timestamp)
    if (from !== 'system' && Number.isFinite(entryMs)) {
      if (!firstMentionTimeByMember.has(from)) {
        firstMentionTimeByMember.set(from, entryMs)
      }
      for (const recipient of recipients) {
        if (recipient !== 'system' && !firstMentionTimeByMember.has(recipient)) {
          firstMentionTimeByMember.set(recipient, entryMs)
        }
      }
    }

    const requestId = nonEmptyString(entry.request_id)
    const id = requestId ? `swarm:${seq}:${requestId}` : `swarm:${seq}`
    const summary = rawKind === 'brief' ? summarizeBoardText(text) : undefined

    entries.push({ seq, from, ...(rawKind ? { kind: rawKind } : {}), text, recipients })
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

  return { messages, entries, firstMentionTimeByMember, latestTimestamp }
}

const DONE_TAG_RE = /(?:^|\s)\[done\]/i

type BoardSignals = {
  briefsByMember: Map<string, { seq: number; text: string }>
  doneByMember: Map<string, { seq: number; text: string }>
  progressByMember: Map<string, { seq: number; text: string }>
  coordinatorDoneSeq: number
  coordinatorDoneText?: string
  maxWorkerBriefSeq: number
}

function collectBoardSignals(entries: BoardEntryDetail[]): BoardSignals {
  const briefsByMember = new Map<string, { seq: number; text: string }>()
  const doneByMember = new Map<string, { seq: number; text: string }>()
  const progressByMember = new Map<string, { seq: number; text: string }>()
  let coordinatorDoneSeq = 0
  let coordinatorDoneText: string | undefined
  let maxWorkerBriefSeq = 0

  for (const entry of entries) {
    // 1.5.18 attributes swarm board wakeup notifications to "system"; ignore them when tracking member progress.
    if (entry.from === 'system') continue
    const isDone = DONE_TAG_RE.test(entry.text)
    if (entry.from === 'coordinator') {
      if (isDone && entry.seq >= coordinatorDoneSeq) {
        coordinatorDoneSeq = entry.seq
        coordinatorDoneText = entry.text
      }
      if (entry.kind === 'brief' || entry.recipients.length > 0) {
        for (const target of entry.recipients) {
          if (target === 'coordinator' || target === 'all') continue
          const prev = briefsByMember.get(target)
          if (!prev || entry.seq >= prev.seq) {
            briefsByMember.set(target, { seq: entry.seq, text: entry.text })
          }
          if (target !== 'monitor' && entry.seq > maxWorkerBriefSeq) {
            maxWorkerBriefSeq = entry.seq
          }
        }
      }
      continue
    }

    if (isDone) {
      const prev = doneByMember.get(entry.from)
      if (!prev || entry.seq >= prev.seq) {
        doneByMember.set(entry.from, { seq: entry.seq, text: entry.text })
      }
    } else {
      const prev = progressByMember.get(entry.from)
      if (!prev || entry.seq >= prev.seq) {
        progressByMember.set(entry.from, { seq: entry.seq, text: entry.text })
      }
    }
  }

  return {
    briefsByMember,
    doneByMember,
    progressByMember,
    coordinatorDoneSeq,
    coordinatorDoneText,
    maxWorkerBriefSeq,
  }
}

function extractBriefSubject(workerName: string, text: string): string {
  const stripped = text
    .replace(new RegExp(`^@${workerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '')
    .trim()
  const firstLine = stripped.split(/\r?\n/).find(line => line.trim().length > 0)?.trim() ?? stripped
  if (!firstLine) return `Task for ${workerName}`
  return firstLine.length <= 96 ? firstLine : `${firstLine.slice(0, 93)}...`
}

function deriveWorkerTaskStatus(
  workerName: string,
  signals: BoardSignals,
  rawMembersMap: Record<string, unknown>,
): TaskStatus {
  const rawMember = isRecord(rawMembersMap[workerName])
    ? rawMembersMap[workerName] as RawSwarmMember
    : undefined
  const memberState = rawMember ? deriveSwarmMemberState(rawMember) : undefined
  const briefSeq = signals.briefsByMember.get(workerName)?.seq ?? 0
  const doneSeq = signals.doneByMember.get(workerName)?.seq ?? 0
  const progressSeq = signals.progressByMember.get(workerName)?.seq ?? 0

  if (
    (doneSeq > 0 && doneSeq >= briefSeq)
    || rawMember?.killed === true
    || (signals.coordinatorDoneSeq > 0 && signals.coordinatorDoneSeq >= briefSeq && memberState?.status !== 'running')
  ) {
    return 'completed'
  }
  if (
    memberState?.status === 'running'
    || (progressSeq > 0 && progressSeq >= briefSeq)
    || (briefSeq > 0 && rawMember !== undefined && memberState?.activity !== 'stopped')
  ) {
    return 'in_progress'
  }
  return 'pending'
}

function buildWorkerTaskDescription(
  workerName: string,
  signals: BoardSignals,
  threadContext?: { title?: string; goal?: string },
): string {
  const parts: string[] = []
  if (threadContext?.title || threadContext?.goal) {
    const header = [threadContext.title, threadContext.goal].filter(Boolean).join(' — ')
    if (header) parts.push(header)
  }
  const brief = signals.briefsByMember.get(workerName)?.text?.trim()
  if (brief) {
    parts.push(brief.length <= 500 ? brief : `${brief.slice(0, 497)}...`)
  }
  const done = signals.doneByMember.get(workerName)?.text?.trim()
  if (done) {
    const excerpt = done.length <= 300 ? done : `${done.slice(0, 297)}...`
    parts.push(`Result: ${excerpt}`)
  }
  return parts.join('\n\n')
}

async function readSwarmPlanAndTasks(
  brainDir: string,
  swarmDir: string,
  taskListId: string,
  signals: BoardSignals,
  rawMembersMap: Record<string, unknown>,
  fallbackTitle?: string,
): Promise<{ goalTitle?: string; goalLine?: string; tasks: TaskInfo[] }> {
  const candidates = [
    path.join(swarmDir, 'plan.json'),
    path.join(brainDir, 'plan.json'),
  ]
  for (const candidate of candidates) {
    const raw = await readJsonFile(candidate)
    if (!raw) continue

    // 1. Structured TaskInfo[] array format (legacy / explicit DAG plan.json)
    const rawTaskArray = Array.isArray(raw)
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
    if (rawTaskArray) {
      const tasks: TaskInfo[] = []
      rawTaskArray.forEach((item, index) => {
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
      return { tasks }
    }

    // 2. Native Antigravity `swarm_pane` plan.json format:
    //    { goal: { title, line }, tasks: { [worker]: "summary" }, threads: [{ id, title, goal, tasks: [...] }] }
    if (isRecord(raw) && isRecord(raw.tasks)) {
      const goalObj = isRecord(raw.goal) ? raw.goal : undefined
      const goalTitle = nonEmptyString(goalObj?.title)
      const goalLine = nonEmptyString(goalObj?.line)
      const tasksMap = raw.tasks

      type ParsedThread = {
        id: string
        title?: string
        goal?: string
        taskKeys: string[]
        dependsOn: string[]
      }
      const threads: ParsedThread[] = Array.isArray(raw.threads)
        ? raw.threads.flatMap((entry, idx): ParsedThread[] => {
            if (!isRecord(entry)) return []
            return [{
              id: nonEmptyString(entry.id) ?? `thread-${idx + 1}`,
              title: nonEmptyString(entry.title),
              goal: nonEmptyString(entry.goal),
              taskKeys: stringArray(entry.tasks),
              dependsOn: stringArray(entry.dependsOn ?? entry.depends_on ?? entry.blockedBy ?? entry.blocked_by ?? entry.after),
            }]
          })
        : []

      const orderedKeys: string[] = []
      const threadByTaskKey = new Map<string, ParsedThread>()
      for (const thread of threads) {
        for (const key of thread.taskKeys) {
          if (key in tasksMap && !orderedKeys.includes(key)) {
            orderedKeys.push(key)
            threadByTaskKey.set(key, thread)
          }
        }
      }
      for (const key of Object.keys(tasksMap)) {
        if (!orderedKeys.includes(key)) orderedKeys.push(key)
      }

      const taskIdByKey = new Map<string, string>()
      const tasks: TaskInfo[] = []
      orderedKeys.forEach((workerKey, idx) => {
        const value = tasksMap[workerKey]
        const subject = typeof value === 'string' && value.trim()
          ? value.trim()
          : isRecord(value)
            ? (nonEmptyString(value.subject) ?? nonEmptyString(value.title) ?? workerKey)
            : workerKey
        const id = String(idx + 1)
        taskIdByKey.set(workerKey, id)
        const thread = threadByTaskKey.get(workerKey)
        const status = isRecord(value) && typeof value.status === 'string'
          ? normalizeTaskStatus(value.status)
          : deriveWorkerTaskStatus(workerKey, signals, rawMembersMap)
        const explicitDesc = isRecord(value) && typeof value.description === 'string' ? value.description : ''
        const description = explicitDesc || buildWorkerTaskDescription(workerKey, signals, thread)
        tasks.push({
          id,
          subject,
          description,
          status,
          blocks: [],
          blockedBy: [],
          taskListId,
          owner: workerKey,
        })
      })

      // Wire explicit thread-to-thread dependencies if declared
      const threadById = new Map(threads.map(thread => [thread.id, thread]))
      for (const thread of threads) {
        if (thread.dependsOn.length === 0) continue
        const depTaskIds = thread.dependsOn.flatMap(depId =>
          (threadById.get(depId)?.taskKeys ?? []).map(k => taskIdByKey.get(k)).filter((id): id is string => Boolean(id)),
        )
        if (depTaskIds.length === 0) continue
        for (const key of thread.taskKeys) {
          const taskId = taskIdByKey.get(key)
          const task = tasks.find(item => item.id === taskId)
          if (!task) continue
          for (const depId of depTaskIds) {
            if (depId === task.id || task.blockedBy.includes(depId)) continue
            task.blockedBy.push(depId)
            const depTask = tasks.find(item => item.id === depId)
            if (depTask && !depTask.blocks.includes(task.id)) depTask.blocks.push(task.id)
          }
        }
      }

      appendCoordinatorSynthesisTask(tasks, taskListId, signals, rawMembersMap, goalTitle ?? fallbackTitle, goalLine)
      return { goalTitle, goalLine, tasks }
    }
  }

  // 3. Fallback when plan.json has not been written yet: project tasks directly from board.jsonl briefs.
  const briefedWorkers = [...signals.briefsByMember.entries()]
    .filter(([name]) => name !== 'monitor')
    .sort((a, b) => a[1].seq - b[1].seq)
  if (briefedWorkers.length === 0) {
    return { tasks: [] }
  }
  const tasks: TaskInfo[] = briefedWorkers.map(([workerName, brief], idx) => ({
    id: String(idx + 1),
    subject: extractBriefSubject(workerName, brief.text),
    description: buildWorkerTaskDescription(workerName, signals),
    status: deriveWorkerTaskStatus(workerName, signals, rawMembersMap),
    blocks: [],
    blockedBy: [],
    taskListId,
    owner: workerName,
  }))
  appendCoordinatorSynthesisTask(tasks, taskListId, signals, rawMembersMap, fallbackTitle)
  return { tasks }
}

function appendCoordinatorSynthesisTask(
  tasks: TaskInfo[],
  taskListId: string,
  signals: BoardSignals,
  rawMembersMap: Record<string, unknown>,
  title?: string,
  goalLine?: string,
): void {
  if (tasks.length === 0) return
  if (tasks.some(task => task.owner === 'coordinator')) return
  const synthesisSubject = title?.trim()
  if (!synthesisSubject && signals.coordinatorDoneSeq === 0) return

  const leafWorkerTasks = tasks.filter(task => task.blocks.length === 0)
  const blockedBy = (leafWorkerTasks.length > 0 ? leafWorkerTasks : tasks).map(task => task.id)
  const synthesisId = String(tasks.length + 1)
  for (const task of tasks) {
    if (blockedBy.includes(task.id) && !task.blocks.includes(synthesisId)) {
      task.blocks.push(synthesisId)
    }
  }

  const allWorkersCompleted = tasks.every(task => task.status === 'completed')
  const rawCoordinator = isRecord(rawMembersMap.coordinator)
    ? rawMembersMap.coordinator as RawSwarmMember
    : undefined
  const coordState = rawCoordinator ? deriveSwarmMemberState(rawCoordinator) : undefined
  const status: TaskStatus =
    (signals.coordinatorDoneSeq > 0 && signals.coordinatorDoneSeq >= signals.maxWorkerBriefSeq)
    || (allWorkersCompleted && coordState?.activity === 'exited')
      ? 'completed'
      : allWorkersCompleted && coordState?.status === 'running'
        ? 'in_progress'
        : 'pending'

  const descriptionParts = [
    goalLine?.trim(),
    signals.coordinatorDoneText?.trim(),
  ].filter((part): part is string => Boolean(part))

  tasks.push({
    id: synthesisId,
    subject: synthesisSubject || 'Synthesize swarm results',
    description: descriptionParts.join('\n\n'),
    status,
    blocks: [],
    blockedBy,
    taskListId,
    owner: 'coordinator',
  })
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

  const [board, subagentRecords] = await Promise.all([
    readSwarmBoardMessages(path.join(swarmDir, 'board.jsonl'), knownMemberNames),
    readAntigravitySubagentRegistry(nativeSessionId, options),
  ])
  const signals = collectBoardSignals(board.entries)
  const membersFileTitle = nonEmptyString(membersFile.title)
  const planResult = await readSwarmPlanAndTasks(
    brainDir,
    swarmDir,
    teamName,
    signals,
    rawMembersMap,
    membersFileTitle,
  )
  const tasks = planResult.tasks

  const workspaceByConvId = new Map<string, string>()
  for (const record of subagentRecords) {
    const firstUri = record.workspaceUris[0]
    if (firstUri) {
      workspaceByConvId.set(record.conversationId, uriToPath(firstUri))
    }
  }

  const boardMaxSeq = board.entries.reduce(
    (max, entry) => (entry.from === 'system' ? max : Math.max(max, entry.seq)),
    0,
  )
  const runtimeActive = registeredRuntimeProbe ? registeredRuntimeProbe(nativeSessionId) : undefined
  let controlRecord = swarmControlRecords.get(nativeSessionId)
  if (
    controlRecord?.status === 'paused'
    && runtimeActive === true
    && controlRecord.pausedAtBoardSeq !== undefined
    && boardMaxSeq > controlRecord.pausedAtBoardSeq
  ) {
    controlRecord = {
      ...controlRecord,
      status: 'running',
      revision: controlRecord.revision + 1,
      updatedAt: Date.now(),
      pausedAt: undefined,
      pausedAtBoardSeq: undefined,
      error: undefined,
    }
    swarmControlRecords.set(nativeSessionId, controlRecord)
  }
  const swarmPausedOverlay =
    controlRecord?.status === 'paused'
    || controlRecord?.status === 'pausing'
    || (!controlRecord && runtimeActive === false)

  const members: TeamMember[] = rosterNames.map((rosterName) => {
    const raw = isRecord(rawMembersMap[rosterName])
      ? rawMembersMap[rosterName] as RawSwarmMember
      : {}
    const conversationId = nonEmptyString(raw.conversation_id)
    const model = nonEmptyString(raw.applied_model)
      ?? nonEmptyString(raw.model)
      ?? nonEmptyString(raw.desired_model)
    const effortLevel = parseAntigravityModelEffort(model)
    const derivedState = deriveSwarmMemberState(raw)
    const ownedTasks = tasks.filter(task => task.owner === rosterName)
    const allOwnedTasksCompleted = ownedTasks.length > 0 && ownedTasks.every(task => task.status === 'completed')
    const coordinatorFinishedSwarm = rosterName === 'coordinator'
      && signals.coordinatorDoneSeq > 0
      && signals.coordinatorDoneSeq >= signals.maxWorkerBriefSeq
      && allOwnedTasksCompleted
    let status: TeamMember['status'] =
      (derivedState.status === 'idle' && allOwnedTasksCompleted) || coordinatorFinishedSwarm
        ? 'completed'
        : derivedState.status
    let activity: TeamMemberActivity = derivedState.activity
    // Antigravity does not rewrite `members.json` when a swarm is force-stopped
    // or its ACP process exits, leaving unfinished workers stuck at
    // `phase: RUNNING / wake_mode: working`. Project them as `stopped` while
    // paused or when no ACP runtime is active for this swarm.
    if (swarmPausedOverlay && activity !== 'exited' && status !== 'completed' && status !== 'failed') {
      if (rosterName === 'coordinator') {
        status = 'idle'
        activity = 'idle'
      } else {
        status = 'idle'
        activity = 'stopped'
      }
    }
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
  const description = planResult.goalTitle ?? membersFileTitle

  const activeMemberCount = members.filter(member => member.status === 'running').length
  const allExited = members.length > 0 && members.every(member => member.activity === 'exited')

  const team: TeamDetail = {
    name: teamName,
    ...(description ? { description } : {}),
    createdAt,
    incarnationId: swarmIncarnationId(nativeSessionId, createdAt, nonEmptyString(swarmMeta.swarm_id)),
    memberCount: members.length,
    activeMemberCount,
    leadAgentId,
    ...(leadSessionId ? { leadSessionId } : {}),
    members,
  }

  let latestMtimeMs = createdAt
  for (const filename of ['members.json', 'board.jsonl', 'swarm.json', 'plan.json']) {
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
    startLeader?: (sessionId: string) => Promise<void>
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

  const payload: AntigravitySwarmSteerPayload = {
    teamName,
    nativeSessionId,
    ...(sessionId ? { sessionId } : {}),
    memberName: member.name,
    agentId: member.agentId,
    content: text,
    formattedPrompt,
  }
  let result = await handler(payload)

  if (result && result.routed === false && result.reason === 'unavailable' && sessionId && options.startLeader) {
    try {
      await options.startLeader(sessionId)
      result = await handler(payload)
    } catch {
      // Keep original unavailable error handling below if restarting the lead fails.
    }
  }

  if (result && result.routed === false) {
    if (result.reason === 'busy') {
      throw new ApiError(
        409,
        `Antigravity is busy processing another turn. Wait for it to finish before messaging ${member.name}.`,
        'ANTIGRAVITY_SWARM_SESSION_BUSY',
      )
    }
    throw new ApiError(
      503,
      `Could not deliver message to swarm member ${member.name}. Try again.`,
      'ANTIGRAVITY_SWARM_STEERING_UNAVAILABLE',
    )
  }

  clearAntigravitySwarmPause(nativeSessionId)

  return {
    ok: true,
    routed: true,
    delivery: result?.delivery ?? 'steering',
    target: member.name,
    formattedPrompt: result?.formattedPrompt ?? formattedPrompt,
  }
}

// ─── Runtime Control (Pause / Resume) ──────────────────────────────────────

const MONITOR_MEMBER_NAME_RE = /^monitor(?:-\d+)?$/i

function isMonitorMemberName(name: string): boolean {
  return MONITOR_MEMBER_NAME_RE.test(name.trim())
}

function isCoordinatorMember(member: TeamMember, leadAgentId: string): boolean {
  return member.agentId === leadAgentId || member.name === 'coordinator' || member.agentType === 'coordinator'
}

function ensureSwarmControlRecord(
  nativeSessionId: string,
  runtimeActive: boolean | undefined,
  boardMaxSeq: number,
): AntigravitySwarmControlRecord {
  const existing = swarmControlRecords.get(nativeSessionId)
  if (existing) return existing
  const now = Date.now()
  const initiallyPaused = runtimeActive === false
  const created: AntigravitySwarmControlRecord = {
    status: initiallyPaused ? 'paused' : 'running',
    revision: 1,
    epoch: initiallyPaused ? 1 : 0,
    controlSequence: 0,
    updatedAt: now,
    ...(initiallyPaused ? { pausedAt: now, pausedAtBoardSeq: boardMaxSeq } : {}),
  }
  swarmControlRecords.set(nativeSessionId, created)
  return created
}

function buildAntigravitySwarmControlViewFromSnapshot(
  snapshot: TeamWorkbenchSnapshot,
  nativeSessionId: string,
  identity: TeamRuntimeControlIdentity,
  record: AntigravitySwarmControlRecord,
): TeamRuntimeControlView {
  const workers = snapshot.team.members.filter(
    (member) => !isCoordinatorMember(member, snapshot.team.leadAgentId),
  )
  let resumeEligibleCount = 0
  const members: TeamRuntimeControlView['members'] = workers.map((member) => {
    const isCompleted = member.status === 'completed' || member.activity === 'exited'
    const isFailed = member.status === 'failed'
    const isRunning = !isCompleted && !isFailed && record.status === 'running' && member.status === 'running'
    const isPaused = !isCompleted && !isFailed && (
      record.status === 'paused'
      || record.status === 'pausing'
      || record.status === 'partial'
      || member.activity === 'stopped'
    )
    if (!isCompleted && !isRunning && !isMonitorMemberName(member.name)) {
      resumeEligibleCount += 1
    }
    return {
      agentId: member.agentId,
      sessionId: member.sessionId ?? member.agentId,
      planId: 'antigravity-swarm',
      memberId: member.name,
      name: member.name,
      status: isFailed
        ? 'failed'
        : isCompleted
          ? 'completed'
          : isRunning
            ? 'running'
            : isPaused
              ? 'paused'
              : 'waiting',
      ...(member.lastError ? { error: member.lastError } : {}),
    }
  })

  return {
    schemaVersion: 1,
    teamName: snapshot.team.name,
    leadSessionId: identity.leadSessionId,
    incarnationId: snapshot.team.incarnationId,
    revision: record.revision,
    epoch: record.epoch,
    status: record.status,
    updatedAt: record.updatedAt,
    ...(record.error ? { error: record.error } : {}),
    members,
    resumeEligibleCount,
  }
}

export function buildAntigravitySwarmResumePrompt(
  unfinishedWorkers: string[],
  monitorNames: string[],
): string {
  const workerMentions = unfinishedWorkers.map((name) => `@${name}`)
  const monitorClause = monitorNames.length > 0
    ? ` Post ${monitorNames.map((name) => `"@${name} resume"`).join(' and ')} on the board to restart the stall monitor.`
    : ''
  if (workerMentions.length > 0) {
    return `Resume the paused swarm. Call swarm{action:"status"} and read_board to inspect current progress, then wake and continue the unfinished workers on the board (${workerMentions.join(', ')}) so each resumes its assigned work from its existing conversation.${monitorClause}`
  }
  return `Resume the paused swarm. Call swarm{action:"status"} and read_board to review completed work and continue coordinating until the task is finished.${monitorClause}`
}

export async function getAntigravitySwarmRuntimeControlView(
  teamName: string,
  identity: TeamRuntimeControlIdentity,
  options: AntigravityAdapterOptions = {},
): Promise<TeamRuntimeControlView | null> {
  const nativeSessionId = nativeSessionIdFromSwarmTeamName(teamName)
  if (!nativeSessionId) return null
  const snapshot = await readAntigravitySwarmSnapshot(nativeSessionId, {
    ...options,
    leadSessionId: identity.leadSessionId,
  })
  if (!snapshot) return null
  if (snapshot.team.incarnationId !== identity.incarnationId) {
    throw new TeamPlanError('Team identity changed; refresh before continuing')
  }
  if (snapshot.deletedAt) return null

  const workers = snapshot.team.members.filter(
    (member) => !isCoordinatorMember(member, snapshot.team.leadAgentId),
  )
  if (workers.length === 0) return null

  const existing = swarmControlRecords.get(nativeSessionId)
  const allWorkersFinished = workers.every(
    (member) => member.status === 'completed' || member.activity === 'exited' || isMonitorMemberName(member.name),
  )
  const allTasksCompleted = snapshot.tasks.length > 0
    && snapshot.tasks.every((task) => task.status === 'completed')
  if (
    (allTasksCompleted || (allWorkersFinished && snapshot.team.activeMemberCount === 0))
    && (!existing || existing.status === 'running')
  ) {
    return null
  }

  const runtimeActive = registeredRuntimeProbe ? registeredRuntimeProbe(nativeSessionId) : undefined
  const boardMaxSeq = await readAntigravitySwarmBoardMaxSeq(nativeSessionId, options)
  const record = ensureSwarmControlRecord(nativeSessionId, runtimeActive, boardMaxSeq)
  return buildAntigravitySwarmControlViewFromSnapshot(snapshot, nativeSessionId, identity, record)
}

export function resumeAntigravitySwarm(
  teamName: string,
  action: TeamRuntimeControlAction,
  startLeader: (sessionId: string) => Promise<void>,
  options: AntigravityAdapterOptions & {
    resumeHandler?: AntigravitySwarmResumeHandler | null
  } = {},
): Promise<TeamRuntimeControlView> {
  const key = JSON.stringify([teamName, action.leadSessionId, action.incarnationId, action.requestId])
  const existing = swarmResumeOperations.get(key)
  if (existing) return existing
  const operation = resumeAntigravitySwarmOnce(teamName, action, startLeader, options)
  swarmResumeOperations.set(key, operation)
  void operation.finally(() => {
    if (swarmResumeOperations.get(key) === operation) {
      swarmResumeOperations.delete(key)
    }
  }).catch(() => {})
  return operation
}

async function resumeAntigravitySwarmOnce(
  teamName: string,
  action: TeamRuntimeControlAction,
  startLeader: (sessionId: string) => Promise<void>,
  options: AntigravityAdapterOptions & {
    resumeHandler?: AntigravitySwarmResumeHandler | null
  },
): Promise<TeamRuntimeControlView> {
  const nativeSessionId = nativeSessionIdFromSwarmTeamName(teamName)
  if (!nativeSessionId) {
    throw new TeamPlanError('No Antigravity swarm can resume here', 404)
  }
  const snapshot = await readAntigravitySwarmSnapshot(nativeSessionId, {
    ...options,
    leadSessionId: action.leadSessionId,
  })
  if (!snapshot) {
    throw new TeamPlanError('No Antigravity swarm can resume here', 404)
  }
  if (snapshot.team.incarnationId !== action.incarnationId) {
    throw new TeamPlanError('Team identity changed; refresh before continuing')
  }
  if (snapshot.deletedAt) {
    throw new TeamPlanError('This swarm has already ended')
  }

  const runtimeActive = registeredRuntimeProbe ? registeredRuntimeProbe(nativeSessionId) : undefined
  const boardMaxSeq = await readAntigravitySwarmBoardMaxSeq(nativeSessionId, options)
  const previous = ensureSwarmControlRecord(nativeSessionId, runtimeActive, boardMaxSeq)
  const replay = previous.resume?.requestId === action.requestId
  if (replay && previous.resume?.epoch !== previous.epoch) {
    throw new TeamPlanError('That resume intent was superseded by a pause')
  }
  if (replay && previous.status === 'running') {
    return buildAntigravitySwarmControlViewFromSnapshot(snapshot, nativeSessionId, action, previous)
  }
  if (!replay && previous.revision !== action.expectedRevision) {
    throw new TeamPlanError('Team control changed; refresh before resuming')
  }
  if (previous.status !== 'paused' && previous.status !== 'partial') {
    throw new TeamPlanError('Wait for the team to finish stopping before resuming')
  }

  const continuation = replay || (previous.status === 'partial' && previous.resume?.epoch === previous.epoch)
  const nextEpoch = continuation ? previous.epoch : previous.epoch + 1
  const nextSequence = previous.controlSequence + 1
  const now = Date.now()
  const resumingRecord: AntigravitySwarmControlRecord = {
    ...previous,
    status: 'resuming',
    revision: previous.revision + 1,
    epoch: nextEpoch,
    controlSequence: nextSequence,
    updatedAt: now,
    error: undefined,
    resume: {
      requestId: action.requestId,
      epoch: nextEpoch,
      createdAt: continuation && previous.resume ? previous.resume.createdAt : now,
    },
  }
  swarmControlRecords.set(nativeSessionId, resumingRecord)
  notifyAntigravitySwarmChanged()

  const fresh = () => swarmControlRecords.get(nativeSessionId)?.controlSequence === nextSequence

  const handler = options.resumeHandler !== undefined ? options.resumeHandler : registeredResumeHandler
  const workers = snapshot.team.members.filter(
    (member) => !isCoordinatorMember(member, snapshot.team.leadAgentId) && member.activity !== 'exited',
  )
  const monitorNames = workers
    .filter((member) => isMonitorMemberName(member.name))
    .map((member) => member.name)
  const unfinishedWorkers = workers
    .filter((member) => !isMonitorMemberName(member.name) && member.status !== 'completed')
    .map((member) => member.name)
  const prompt = buildAntigravitySwarmResumePrompt(unfinishedWorkers, monitorNames)

  try {
    if (!handler) {
      throw new Error('Antigravity swarm resume handler is unavailable')
    }
    await startLeader(action.leadSessionId)
    if (!fresh()) {
      throw new TeamPlanError('Team control changed; the newer pause takes precedence')
    }
    const outcome = await handler({
      teamName,
      nativeSessionId,
      sessionId: action.leadSessionId,
      prompt,
    })
    if (!fresh()) {
      throw new TeamPlanError('Team control changed; the newer pause takes precedence')
    }
    if (!outcome.routed) {
      throw new Error(outcome.error || 'Could not deliver swarm resume prompt to Antigravity')
    }
    const current = swarmControlRecords.get(nativeSessionId) ?? resumingRecord
    const runningRecord: AntigravitySwarmControlRecord = {
      ...current,
      status: 'running',
      revision: current.revision + 1,
      updatedAt: Date.now(),
      pausedAt: undefined,
      pausedAtBoardSeq: undefined,
      error: undefined,
    }
    swarmControlRecords.set(nativeSessionId, runningRecord)
    notifyAntigravitySwarmChanged()
    const refreshed = await readAntigravitySwarmSnapshot(nativeSessionId, {
      ...options,
      leadSessionId: action.leadSessionId,
    })
    return buildAntigravitySwarmControlViewFromSnapshot(refreshed ?? snapshot, nativeSessionId, action, runningRecord)
  } catch (error) {
    if (error instanceof TeamPlanError || !fresh()) {
      throw error instanceof TeamPlanError
        ? error
        : new TeamPlanError('Team control changed; the newer pause takes precedence')
    }
    const message = error instanceof Error ? error.message : String(error)
    const current = swarmControlRecords.get(nativeSessionId) ?? resumingRecord
    const partialRecord: AntigravitySwarmControlRecord = {
      ...current,
      status: 'partial',
      revision: current.revision + 1,
      updatedAt: Date.now(),
      error: message,
    }
    swarmControlRecords.set(nativeSessionId, partialRecord)
    notifyAntigravitySwarmChanged()
    return buildAntigravitySwarmControlViewFromSnapshot(snapshot, nativeSessionId, action, partialRecord)
  }
}
