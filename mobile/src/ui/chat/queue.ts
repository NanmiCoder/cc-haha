import { mergeComposerReferences, type ComposerReference } from '../../core/composerReferences'
import type { ComposerAttachment } from '../../core/chatComposer'
import type { ClientMessage } from '../../core/types'

/**
 * 运行中追加的消息。手机端的传输层不在一轮进行中发送 user_message，
 * 所以和桌面端的默认行为一样先在手机上排队，等这一轮结束再发。
 */
export type QueuedMessage = {
  id: string
  text: string
  attachments: ComposerAttachment[]
  team: boolean
  references?: ComposerReference[]
  message: ClientMessage
}

export type QueueGate = {
  ready: boolean
  turnActive: boolean
  waitingForDecision: boolean
  pendingUser: boolean
  configPending: boolean
  workspaceMissing: boolean
  /** 上一轮以错误结束：排队的追加多半依赖它，先停下让用户决定。 */
  lastTurnFailed: boolean
  /** 上一条消息没确认送达：不能在它前面或后面悄悄接着发。 */
  deliveryUncertain: boolean
}

const settled = (gate: QueueGate) =>
  gate.ready &&
  !gate.turnActive &&
  !gate.waitingForDecision &&
  !gate.pendingUser &&
  !gate.configPending &&
  !gate.workspaceMissing

/** 只有这一轮顺利结束、没有待处理的决定和未确认的发送时才自动发出。 */
export function canFlushQueue(gate: QueueGate, focused = true) {
  return focused && settled(gate) && !gate.lastTurnFailed && !gate.deliveryUncertain
}

/** 这一轮已经停下但不适合自动续发时，给排队区一句原因；能手动发送时才返回。 */
export function queuePauseReason(gate: QueueGate) {
  if (!settled(gate)) return ''
  if (gate.lastTurnFailed) return '上一轮出错了，排队的消息先不发'
  if (gate.deliveryUncertain) return '上一条没确认送达，排队的消息先不发'
  return ''
}

/** 停止任务或离开会话时，排队的文字退回输入框，绝不悄悄发出。 */
export function queueToDraft(draft: string, queued: Pick<QueuedMessage, 'text'>[]) {
  return [...queued.map((item) => item.text), draft]
    .map((text) => text.trim())
    .filter(Boolean)
    .join('\n\n')
}

export function queueAttachments(
  queued: Pick<QueuedMessage, 'attachments'>[],
  current: ComposerAttachment[]
) {
  return [...queued.flatMap((item) => item.attachments), ...current]
}

export type ComposerQueueState = {
  queue: QueuedMessage[]
  draft: string
  attachments: ComposerAttachment[]
  team: boolean
  references?: ComposerReference[]
}

/** 停止、撤回或失焦都使用同一条队列恢复路径。 */
export function withdrawQueuedComposer(
  key: string,
  current: ComposerQueueState,
  drafts: {
    set(key: string, value: string): unknown
    delete(key: string): unknown
  },
  ids?: string[]
): ComposerQueueState {
  const taken = current.queue.filter((item) => !ids || ids.includes(item.id))
  const next = taken.length ? {
    queue: current.queue.filter((item) => !taken.includes(item)),
    draft: queueToDraft(current.draft, taken),
    attachments: queueAttachments(taken, current.attachments),
    team: current.team || taken.some((item) => item.team),
    ...(current.references?.length || taken.some((item) => item.references?.length) ? { references: mergeComposerReferences(...taken.map((item) => item.references), current.references) } : {}),
  } : current
  if (next.draft) drafts.set(key, next.draft)
  else drafts.delete(key)
  parkComposer(key, next)
  return next
}

/**
 * 离开会话页时，排队消息里的材料和团队开关先存在内存里（文字进草稿），
 * 回来时还给输入框。和草稿一样只在这次打开 App 期间有效，不落盘。
 */
type Parked = { attachments: ComposerAttachment[]; team: boolean; references?: ComposerReference[] }
const parked = new Map<string, Parked>()

export function parkComposer(key: string, value: Parked) {
  if (!value.attachments.length && !value.team && !value.references?.length) parked.delete(key)
  else parked.set(key, { attachments: [...value.attachments], team: value.team, ...(value.references?.length ? { references: [...value.references] } : {}) })
}

/** 只读不取走：React 开发模式可能把初始化函数调用两次。挂载后再 clear。 */
export function parkedComposer(key: string): Parked | undefined {
  return parked.get(key)
}

export function clearParkedComposer(key: string) {
  parked.delete(key)
}
