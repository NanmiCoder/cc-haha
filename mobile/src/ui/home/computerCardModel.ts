import type { Host } from '../../core/types'
import { hostStatusLine, networkName, type HostLink, type StatusTone } from './homeModel'

/** 公网配对剩余天数不超过这个值，才在卡片上提醒（设计稿 B2「公网配对快到期」）。 */
export const pairingWarnDays = 7

const day = 86400000

export type CardSegment = { text: string; tone?: 'attn' }

export type ComputerCardView = {
  /** 左侧方块：普通 / 离线变暗 / 授权失效（红底盾牌）。 */
  tile: 'normal' | 'dim' | 'err'
  /** 状态行最前面的标记：实心点、空心圈、小转圈。 */
  lead: 'dot' | 'ring' | 'spinner'
  leadTone: StatusTone
  /** 状态行文字；个别片段可以单独着色（配对提醒）。 */
  text: CardSegment[]
  /** 状态行整体文字色：平时灰，同步慢是琥珀，授权失效 / 同步失败是红。 */
  textTone: 'ink3' | 'attn' | 'err'
  /** 离线时电脑名也变灰。 */
  dimName: boolean
  /** 离线时展开的一句原因。 */
  detail?: string
  /** 展开后的按钮，从左到右。 */
  buttons: ('switch' | 'reconnect')[]
  /** 右侧：箭头（进电脑设置）或「重新配对」胶囊。 */
  trailing: 'chevron' | 'repair'
}

export const offlineDetail = '电脑可能睡着了，或者 cc-haha 没在运行。手机没法远程唤醒它。'

/**
 * 公网配对的到期提醒。只有公网、读到了到期时间、且剩余不超过 7 天才返回文案；
 * 局域网没有到期，读不到到期时间时不编造。
 */
export function pairingNote(
  host: Pick<Host, 'auth'>,
  expiresAt: number | undefined,
  now: number
) {
  if (host.auth !== 'remote' || expiresAt === undefined || !Number.isFinite(expiresAt))
    return null
  const days = Math.max(0, Math.ceil((expiresAt - now) / day))
  if (days > pairingWarnDays) return null
  return days < 1 ? '配对不足 1 天' : `配对还剩 ${days} 天`
}

/**
 * 首页电脑卡的展示状态（设计稿 B2）：连接状态 + 网络 + 默认模型 + 配对到期 → 文案、色调与可点的操作。
 * `model` 读不到就是 undefined，状态行里直接省掉这一段。
 */
export function computerCardView(input: {
  link: HostLink
  host: Pick<Host, 'auth'>
  lastSyncedAt?: number
  now: number
  model?: string
  expiresAt?: number
}): ComputerCardView {
  const { link, host, lastSyncedAt, now } = input
  const base: Pick<ComputerCardView, 'tile' | 'lead' | 'dimName' | 'buttons' | 'trailing'> = {
    tile: 'normal',
    lead: 'dot',
    dimName: false,
    buttons: [],
    trailing: 'chevron',
  }
  const line = hostStatusLine(link, host, lastSyncedAt, now)
  switch (link) {
    case 'online': {
      const note = pairingNote(host, input.expiresAt, now)
      const head = `在线 · ${networkName(host)}`
      const text: CardSegment[] = note
        ? [{ text: `${head} · ` }, { text: note, tone: 'attn' }]
        : [{ text: input.model ? `${head} · 新任务用 ${input.model}` : head }]
      return { ...base, leadTone: 'ok', text, textTone: 'ink3' }
    }
    case 'slow':
    case 'connecting':
      return {
        ...base,
        lead: 'spinner',
        leadTone: line.tone,
        text: [{ text: line.text }],
        textTone: link === 'slow' ? 'attn' : 'ink3',
      }
    case 'offline':
      return {
        ...base,
        tile: 'dim',
        lead: 'ring',
        leadTone: 'faint',
        text: [{ text: line.text }],
        textTone: 'ink3',
        dimName: true,
        detail: offlineDetail,
        buttons: ['switch', 'reconnect'],
      }
    case 'unauthorized':
      return {
        ...base,
        tile: 'err',
        leadTone: 'err',
        text: [{ text: '授权已失效 · 要重新扫码' }],
        textTone: 'err',
        trailing: 'repair',
      }
    case 'failed':
      return { ...base, leadTone: 'err', text: [{ text: line.text }], textTone: 'err' }
    default:
      return {
        ...base,
        lead: 'ring',
        leadTone: 'faint',
        text: [{ text: line.text }],
        textTone: 'ink3',
      }
  }
}

/** 读屏文案：电脑名 + 状态行 + 去向。 */
export function computerCardLabel(name: string, view: ComputerCardView) {
  const status = view.text.map((part) => part.text).join('')
  return `${name}，${status}，打开电脑设置`
}
