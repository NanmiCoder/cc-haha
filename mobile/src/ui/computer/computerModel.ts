import type { Host } from '../../core/types'
import { desktopOnly } from '../settings/settingsModel'
import { effortStopAt, effortStopX } from '../compose/runLogic'
import { hostCheckLine, networkName, type HostCheck, type StatusTone } from '../home/homeModel'

/* ───────────── 头部状态 ───────────── */

/** 标题下的一行状态：在线显示“在线 · 局域网”，其余沿用连通检查的说明。 */
export function computerStatus(
  host: Pick<Host, 'auth'>,
  check: HostCheck,
  now: number
): { text: string; tone: StatusTone } {
  switch (check.state) {
    case 'online':
      return { text: `在线 · ${networkName(host)}`, tone: 'ok' }
    case 'unauthorized':
      return { text: hostCheckLine(host, check, now), tone: 'err' }
    default:
      return { text: hostCheckLine(host, check, now), tone: 'faint' }
  }
}

/* ───────────── 连接 ───────────── */

export const connectionMethod = (host: Pick<Host, 'auth'>) =>
  host.auth === 'lan' ? '局域网直连' : '公网访问'

/** 连接地址的主机和端口；已保存的地址都校验过，解析失败只是展示兜底。 */
export function connectionAddress(host: Pick<Host, 'url'>) {
  try {
    return new URL(host.url).host
  } catch {
    return host.url
  }
}

/** 公网授权剩余天数；局域网或没读到到期时间时为 null。 */
export function remoteAuthLine(
  host: Pick<Host, 'auth'>,
  check: { expiresAt?: number; checkedAt?: number }
) {
  if (host.auth !== 'remote' || check.expiresAt === undefined) return null
  const days = Math.max(
    0,
    Math.ceil((check.expiresAt - (check.checkedAt ?? check.expiresAt)) / 86400000)
  )
  return days < 1 ? '不足 1 天' : `还剩 ${days} 天`
}

/* ───────────── 新任务默认 ───────────── */

/**
 * 服务端不允许公网配对写 /api/permissions/mode（publicAccess.ts 只放行 GET），
 * 局域网可以写。公网连接下这一行只读，并说明原因。
 */
export function permissionAccess(host: Pick<Host, 'auth'>): {
  editable: boolean
  note?: string
} {
  return host.auth === 'remote'
    ? { editable: false, note: '权限：公网连接下只能在电脑上改。' }
    : { editable: true }
}

export const defaultsFootnote = (host: Pick<Host, 'auth'>) =>
  [
    '只影响之后新建的任务。某个任务想临时换，用输入框里的运行胶囊。',
    permissionAccess(host).note,
  ]
    .filter(Boolean)
    .join('\n')

/** 当前模型显示名：优先电脑给的名称，否则用 id。 */
export const modelDisplayName = (model?: { id?: string; name?: string } | null) =>
  model?.name?.trim() || model?.id || ''

/* ───────────── 运行情况 ───────────── */

/**
 * 后台活动一行的值。有会话没读到时不能断言“空闲”：
 * 有在跑的就只报读到的部分，一个都没读到就留空（undefined）。
 */
export function activitySummary(input: { running: number; read: number; total: number }) {
  if (input.running > 0) return `${input.running} 项在跑`
  if (input.read === input.total) return '空闲'
  return undefined
}

/* ───────────── 只能在电脑上改 ───────────── */

export const desktopOnlyText = `${desktopOnly}。在电脑上打开 cc-haha 的设置。`

/* ───────────── 移除 ───────────── */

export function removeConfirmText(hostName: string) {
  return {
    title: `移除「${hostName}」？`,
    message:
      '将注销这台电脑的手机通知并删除手机连接。电脑上的会话会保留。已登记推送时，需要连接电脑完成注销；失败可重试。',
  }
}

/* ───────────── 新任务默认模型页 ───────────── */

export type SourceLike = { id: string | null; name: string }

/** 服务商行：当前服务商名 + “另有 N 个”。当前服务商已不在列表里时名称为空。 */
export function providerSummary(sources: SourceLike[], providerId: string | null) {
  const current = sources.find((source) => source.id === providerId)
  const others = sources.length - (current ? 1 : 0)
  return {
    name: current?.name ?? '',
    others: others > 0 ? `另有 ${others} 个` : undefined,
  }
}

/**
 * 模型行：名称 + 副行。名称和 id 不同才把 id 当等宽副行；
 * 名称就是 id（自定义服务商）时副行改用电脑给的说明，且不等宽。
 */
export function modelRow(model: { id: string; name: string }, description?: string) {
  if (model.name && model.name !== model.id)
    return { title: model.name, detail: model.id, mono: true }
  return {
    title: model.id,
    detail: description?.trim() || undefined,
    mono: false,
  }
}

/** 滑条上选中的档位：当前值不在可选档位里时落到模型默认档；都没有返回 -1（不画滑块，沿用电脑默认）。 */
export function effortIndex(options: string[], current?: string, fallback?: string) {
  const at = current ? options.indexOf(current) : -1
  if (at >= 0) return at
  return fallback ? options.indexOf(fallback) : -1
}

/* ───────────── 思考强度滑条几何（设计稿 P2：40pt 轨道、左右各缩 2pt、44pt 滑块） ───────────── */

export const EFFORT_TRACK = { height: 40, inset: 2, thumb: 44, dotInset: 20 } as const

/** 各档中心在滑条区域（含左右 2pt 外缩）里的横坐标；首尾档距轨道边 20pt。 */
export function effortTrackStops(width: number, count: number) {
  const { inset, dotInset } = EFFORT_TRACK
  return Array.from({ length: count }, (_, index) =>
    inset + effortStopX(index, { width: Math.max(0, width - inset * 2), count, thumb: dotInset * 2 })
  )
}

/** 手指在滑条区域横坐标 x 时最近的档位。 */
export function effortTrackIndex(x: number, width: number, count: number) {
  const { inset, dotInset } = EFFORT_TRACK
  return effortStopAt(x - inset, { width: Math.max(0, width - inset * 2), count, thumb: dotInset * 2 })
}
