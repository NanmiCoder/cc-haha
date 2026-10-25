import type { Preferences } from '../../state/preferences'

/** 与 PushRegistrationContext 的状态一致；这里只关心界面要说什么。 */
export type PushState =
  | 'loading'
  | 'registered'
  | 'notConfigured'
  | 'permissionRequired'
  | 'unsupported'
  | 'error'

export type QuietHours = Preferences['quietHours']
export type AutoQuestion = { enabled: boolean; timeoutMinutes: number }

const time = /^([01]\d|2[0-3]):[0-5]\d$/

/** 设置页「勿扰时段」行右侧的值。开始等于结束视为全天（与 isQuietTime 一致）。 */
export function quietSummary(quiet: QuietHours) {
  if (!quiet.enabled) return '未开启'
  if (quiet.start === quiet.end) return '全天'
  return `${quiet.start} – ${quiet.end}`
}

/** 勿扰弹层点「完成」时统一校验，通过才写入；开关不再单独立即生效。 */
export function validateQuietHours(
  draft: QuietHours
): { value: QuietHours; error?: undefined } | { value?: undefined; error: string } {
  const start = draft.start.trim()
  const end = draft.end.trim()
  if (!time.test(start) || !time.test(end))
    return { error: '时间请输入 HH:mm 格式' }
  return { value: { ...draft, start, end } }
}

export function quietHint(draft: QuietHours) {
  const start = draft.start.trim()
  return draft.enabled && time.test(start) && start === draft.end.trim()
    ? '开始和结束相同，表示全天勿扰。'
    : ''
}

/** 组下脚注：推送登记的四种异常状态和已登记状态，各说一句。 */
export function pushFootnote(
  push: { status: PushState; error?: string } | undefined,
  hostName: string | undefined
) {
  switch (push?.status) {
    case 'registered':
      return `${hostName ?? '这台电脑'} 已配好推送，App 不在前台也能收到。`
    case 'notConfigured':
      return '电脑还没配 APNs / FCM 推送。App 打开时照常同步；想在离开 App 后收到通知，要先在电脑上配好推送。'
    case 'permissionRequired':
      return '系统还没允许 cc-haha 发通知。去系统设置里打开，或重新打开上面的开关。'
    case 'unsupported':
      return '这台设备暂时登记不了远程通知。'
    case 'error':
      return push.error || '没能登记远程通知，请检查电脑连接。'
    default:
      return ''
  }
}

/** AI 代答档位，与电脑端 AUTO_QUESTION_TIMEOUT_OPTIONS 一致；0 表示不代答。 */
export const autoAnswerMinutes = [0, 1, 5, 10, 30] as const
const timeouts = [1, 5, 10, 30]

export const autoAnswerLabel = (minutes: number) =>
  minutes > 0 ? `${minutes} 分` : '不代答'

/** 「我不在的时候」行右侧的值。 */
export function autoAnswerValue(current: AutoQuestion) {
  return current.enabled ? `等 ${current.timeoutMinutes} 分钟` : '不代答'
}

export const selectedMinutes = (current: AutoQuestion) =>
  current.enabled ? current.timeoutMinutes : 0

/** 写回电脑的 autoQuestion：关闭时保留原来的等待时间。 */
export function nextAutoQuestion(
  current: AutoQuestion,
  minutes: number
): AutoQuestion {
  return {
    enabled: minutes > 0,
    timeoutMinutes: minutes > 0 ? minutes : current.timeoutMinutes,
  }
}

/** 按电脑端 normalizeAutoQuestionSettings 的规则读取：缺失或异常时视为关闭、5 分钟。 */
export function readAutoQuestion(settings: { autoQuestion?: unknown }): AutoQuestion {
  const value = settings.autoQuestion
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { enabled: false, timeoutMinutes: 5 }
  const record = value as Record<string, unknown>
  return {
    enabled: record.enabled === true,
    timeoutMinutes: timeouts.find((minutes) => minutes === record.timeoutMinutes) ?? 5,
  }
}

export const desktopOnly = [
  'MCP、技能与插件',
  '服务商与 API Key',
  '官方账号登录',
  'IM 机器人',
  '局域网和公网访问',
].join(' · ')
