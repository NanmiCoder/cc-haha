import type { ChatItem, Session, TokenUsage } from '../../core/types'
import type { ConnectionState } from '../../core/sessionTransport'
import type { Checkpoint } from '../../core/operations'
import { formatDuration } from '../../core/dashboard'

/** When the computer is not connected, the nav bar subtitle shows only this connection status. */
export const connectionLabels: Record<ConnectionState, string> = {
  connecting: 'Connecting to computer…',
  syncing: 'Syncing…',
  ready: 'Connected',
  resuming: 'Restoring connection…',
  reconnecting: 'Reconnecting…',
  offline: 'Connection lost',
  pairing_required: 'Needs re-pairing',
}

/** Which path a remote computer uses is only mentioned lightly in the menu. */
export const linkPathLabels: Record<'cf' | 'lan' | 'direct', string> = {
  cf: 'via Cloudflare',
  lan: 'LAN direct',
  direct: 'Direct',
}

const basename = (path: string) =>
  path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean).at(-1) ?? ''

/** Project name comes from the repo root (worktree sessions have workDir as the worktree path), falling back to the working directory. */
export function projectName(session: Session | null | undefined) {
  if (!session) return ''
  return (
    basename(session.projectRoot ?? '') ||
    basename(session.workDir ?? '') ||
    basename(session.projectPath ?? '')
  )
}

/** "Project name · branch", showing only the project name when the branch is unavailable. */
export function sessionSubtitle(session: Session | null | undefined, branch?: string | null) {
  const name = projectName(session)
  return [name, branch?.trim()].filter(Boolean).join(' · ')
}

/** Working directory in the menu header: the macOS / Linux home directory is abbreviated as ~. */
export function displayPath(path?: string | null) {
  if (!path) return ''
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
}

/**
 * Context window only from reliable sources: the size given by the model catalog (e.g. "200k", "1m"), or a model id explicitly
 * marked 1M; no guessing otherwise.
 */
export function contextWindow(modelId?: string | null, catalogContext?: string | null) {
  const match = catalogContext?.trim().match(/^(\d+(?:\.\d+)?)\s*([km])$/i)
  if (match) return Math.round(Number(match[1]) * (match[2].toLowerCase() === 'm' ? 1_000_000 : 1_000))
  return modelId && /(?:\[1m\]|:1m)$/i.test(modelId) ? 1_000_000 : undefined
}

export function contextPercent(usage: TokenUsage | undefined, window: number | undefined) {
  if (!usage || !window) return undefined
  const used =
    usage.input_tokens + (usage.cache_read_tokens ?? 0) + (usage.cache_creation_tokens ?? 0)
  if (!Number.isFinite(used) || used <= 0) return undefined
  return Math.min(100, Math.round((used / window) * 100))
}

/**
 * This turn's start time. If the turn was seen going from idle to running use local time; if already running on page open
 * (or only seen after reconnecting) use the time of the last user message, falling back to local time.
 */
export function nextTurnStart(input: {
  previous?: { active: boolean; startedAt?: number; live: boolean }
  active: boolean
  lastUserTimestamp?: string
  now: number
}): number | undefined {
  if (!input.active) return undefined
  if (input.previous?.active && input.previous.startedAt !== undefined)
    return input.previous.startedAt
  if (input.previous && !input.previous.active && input.previous.live) return input.now
  const parsed = input.lastUserTimestamp ? Date.parse(input.lastUserTimestamp) : NaN
  return Number.isFinite(parsed) && parsed <= input.now ? parsed : input.now
}

const clock = (time: number) => {
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * Metadata after a turn ends "HH:mm · took m:ss · model". History uses message time, and a turn witnessed on this page
 * uses the locally recorded start/end time; parts that cannot be computed are omitted.
 */
export function turnMeta(input: {
  items: readonly ChatItem[]
  checkpoint?: Checkpoint
  local?: { startedAt?: number; endedAt?: number }
  modelId?: string
}) {
  let lastUser = -1
  input.items.forEach((item, index) => {
    if (item.type === 'user') lastUser = index
  })
  const turn = input.items.slice(lastUser + 1)
  if (!turn.length) return ''
  const stamp = (value?: string) => {
    const parsed = value ? Date.parse(value) : NaN
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const lastStamp = [...turn].reverse().map((item) => stamp(item.timestamp)).find((value) => value !== undefined)
  const live = turn.some((item) => item.id.startsWith('live:'))
  const endedAt = live ? (input.local?.endedAt ?? lastStamp) : (lastStamp ?? input.local?.endedAt)
  const checkpointStart =
    input.checkpoint &&
    input.checkpoint.target.userMessageIndex === input.checkpoint.target.userMessageCount - 1
      ? input.checkpoint.startedAt
      : undefined
  const userStart = lastUser >= 0 ? stamp(input.items[lastUser].timestamp) : undefined
  const startedAt = live
    ? (input.local?.startedAt ?? userStart ?? checkpointStart)
    : (userStart ?? checkpointStart ?? input.local?.startedAt)
  const model =
    [...turn].reverse().find((item) => item.type === 'assistant' && item.model)?.model ??
    input.modelId
  return [
    endedAt !== undefined ? clock(endedAt) : '',
    // A turn under 1 second does not show "took 0:00", which would only make people think the timer is broken.
    endedAt !== undefined && startedAt !== undefined && endedAt - startedAt >= 1000
      ? `took ${formatDuration((endedAt - startedAt) / 1000)}`
      : '',
    model ?? '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Only when the latest checkpoint is the turn that just ended does it count as "this turn's changes". */
export function latestTurnCheckpoint(checkpoints: readonly Checkpoint[]) {
  const latest = checkpoints.reduce<Checkpoint | undefined>(
    (previous, current) =>
      !previous || current.target.userMessageIndex > previous.target.userMessageIndex
        ? current
        : previous,
    undefined
  )
  return latest && latest.target.userMessageIndex === latest.target.userMessageCount - 1
    ? latest
    : undefined
}
