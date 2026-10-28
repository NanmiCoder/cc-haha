import type { ChatItem, Session, TokenUsage } from '../../core/types'
import type { ConnectionState } from '../../core/sessionTransport'
import type { Checkpoint } from '../../core/operations'
import { formatDuration } from '../../core/dashboard'

/** 电脑没连上时，导航栏副标题只显示这一处连接状态。 */
export const connectionLabels: Record<ConnectionState, string> = {
  connecting: '正在连接电脑…',
  syncing: '正在同步…',
  ready: '已连接',
  reconnecting: '正在重连…',
  offline: '连接已断开',
  pairing_required: '需要重新配对',
}

const basename = (path: string) =>
  path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean).at(-1) ?? ''

/** 项目名取仓库根目录（工作树会话的 workDir 是工作树路径），取不到再用工作目录。 */
export function projectName(session: Session | null | undefined) {
  if (!session) return ''
  return (
    basename(session.projectRoot ?? '') ||
    basename(session.workDir ?? '') ||
    basename(session.projectPath ?? '')
  )
}

/** “项目名 · 分支”，分支取不到就只显示项目名。 */
export function sessionSubtitle(session: Session | null | undefined, branch?: string | null) {
  const name = projectName(session)
  return [name, branch?.trim()].filter(Boolean).join(' · ')
}

/** 菜单头部的工作目录：macOS / Linux 的用户目录缩写成 ~。 */
export function displayPath(path?: string | null) {
  if (!path) return ''
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
}

/**
 * 上下文窗口只取可靠来源：模型目录给出的大小（如 “200k”“1m”），或模型 id 明确
 * 标了 1M；其他情况不猜。
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
 * 本轮开始时间。看到这一轮从空闲变成运行，就用本地时间；页面打开时已经在跑
 * （或断线重连后才看到），用最后一条用户消息的时间，没有再退回本地时间。
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
 * 一轮结束后的元信息“HH:mm · 用时 m:ss · 模型”。历史记录用消息时间，本页亲眼
 * 看到的一轮用本地记录的起止时间；算不出的部分省略。
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
    // 不到 1 秒的一轮不写“用时 0:00”，那只会让人以为计时坏了。
    endedAt !== undefined && startedAt !== undefined && endedAt - startedAt >= 1000
      ? `用时 ${formatDuration((endedAt - startedAt) / 1000)}`
      : '',
    model ?? '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** 最新一个检查点就是刚结束的这一轮，才算“本轮改动”。 */
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
