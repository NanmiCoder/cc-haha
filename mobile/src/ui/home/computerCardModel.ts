import type { Host } from '../../core/types'
import { hostStatusLine, networkName, type HostLink, type StatusTone } from './homeModel'
import { plural } from '../../core/plural'

/** Only when remaining public pairing days are at most this value is the card reminded (design B2 "public pairing expiring soon"). */
export const pairingWarnDays = 7

const day = 86400000

export type CardSegment = { text: string; tone?: 'attn' }

export type ComputerCardView = {
  /** Left square: normal / dimmed offline / auth expired (red shield). */
  tile: 'normal' | 'dim' | 'err'
  /** Marker at the start of the status line: solid dot, hollow ring, small spinner. */
  lead: 'dot' | 'ring' | 'spinner'
  leadTone: StatusTone
  /** Status line text; individual segments can be colored separately (pairing reminder). */
  text: CardSegment[]
  /** Overall status line color: grey normally, amber when sync is slow, red when auth expired / sync failed. */
  textTone: 'ink3' | 'attn' | 'err'
  /** The computer name also turns grey when offline. */
  dimName: boolean
  /** One-line reason expanded when offline. */
  detail?: string
  /** Buttons when expanded, left to right. */
  buttons: ('switch' | 'reconnect')[]
  /** Right side: chevron (to computer settings) or "Pair again" capsule. */
  trailing: 'chevron' | 'repair'
}

export const offlineDetail = 'The computer may be asleep, or cc-haha is not running. The phone cannot wake it remotely.'

/**
 * Expiry reminder for public pairing. Returns text only when public, the expiry was read, and at most 7 days remain; 
 * LAN has no expiry, and nothing is made up when the expiry cannot be read.
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
  return days < 1 ? 'Pairing expires in less than 1 day' : `Pairing expires in ${plural(days, 'day')}`
}

/**
 * Display state of the home computer card (design B2): connection state + network + default model + pairing expiry → text, tone and tappable actions.
 * `model` undefined when unavailable, and the status line simply omits this segment.
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
      const head = `Online · ${networkName(host)}`
      const text: CardSegment[] = note
        ? [{ text: `${head} · ` }, { text: note.replace(/^Pairing/, 'pairing'), tone: 'attn' }]
        : [{ text: input.model ? `${head} · new tasks use ${input.model}` : head }]
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
        text: [{ text: 'Authorization expired · scan again' }],
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

/** Screen reader text: computer name + status line + destination. */
export function computerCardLabel(name: string, view: ComputerCardView) {
  const status = view.text.map((part) => part.text).join('')
  return `${name}, ${status}, open computer settings`
}
