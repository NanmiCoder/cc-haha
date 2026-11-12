import type { Host } from '../../core/types'
import { desktopOnly } from '../settings/settingsModel'
import { effortStopAt, effortStopX } from '../compose/runLogic'
import { hostCheckLine, networkName, type HostCheck, type StatusTone } from '../home/homeModel'
import { plural } from '../../core/plural'

/* ───────────── Header status ───────────── */

/** Status line under the title: online shows "Online · LAN", otherwise reuse the connectivity check description. */
export function computerStatus(
  host: Pick<Host, 'auth'>,
  check: HostCheck,
  now: number
): { text: string; tone: StatusTone } {
  switch (check.state) {
    case 'online':
      return { text: `Online · ${networkName(host)}`, tone: 'ok' }
    case 'unauthorized':
      return { text: hostCheckLine(host, check, now), tone: 'err' }
    default:
      return { text: hostCheckLine(host, check, now), tone: 'faint' }
  }
}

/* ───────────── Connection ───────────── */

export const connectionMethod = (host: Pick<Host, 'auth'>) =>
  host.auth === 'lan' ? 'LAN direct' : 'Public access'

/** Host and port of the connection address; saved addresses are all validated, so parse failure is only a display fallback. */
export function connectionAddress(host: Pick<Host, 'url'>) {
  try {
    return new URL(host.url).host
  } catch {
    return host.url
  }
}

/** Remaining days of public authorization; null on LAN or when the expiry was not read. */
export function remoteAuthLine(
  host: Pick<Host, 'auth'>,
  check: { expiresAt?: number; checkedAt?: number }
) {
  if (host.auth !== 'remote' || check.expiresAt === undefined) return null
  const days = Math.max(
    0,
    Math.ceil((check.expiresAt - (check.checkedAt ?? check.expiresAt)) / 86400000)
  )
  return days < 1 ? 'Less than 1 day' : `${plural(days, 'day')} left`
}

/* ───────────── New task defaults ───────────── */

/**
 * The server does not allow public pairing to write /api/permissions/mode (publicAccess.ts only allows GET), 
 * while LAN can write. Over a public connection this row is read-only, with the reason stated.
 */
export function permissionAccess(host: Pick<Host, 'auth'>): {
  editable: boolean
  note?: string
} {
  return host.auth === 'remote'
    ? { editable: false, note: 'Permissions: can only be changed on the computer over a public connection.' }
    : { editable: true }
}

export const defaultsFootnote = (host: Pick<Host, 'auth'>) =>
  [
    'Affects only tasks created afterwards. To change it temporarily for a task, use the run capsule in the input.',
    permissionAccess(host).note,
  ]
    .filter(Boolean)
    .join('\n')

/** Current model display name: prefer the name from the computer, otherwise the id. */
export const modelDisplayName = (model?: { id?: string; name?: string } | null) =>
  model?.name?.trim() || model?.id || ''

/* ───────────── Run status ───────────── */

/**
 * Value of the background activity row. When some sessions were not read we cannot claim "idle": 
 * if some are running report only what was read; if none were read leave it empty (undefined).
 */
export function activitySummary(input: { running: number; read: number; total: number }) {
  if (input.running > 0) return `${input.running} running`
  if (input.read === input.total) return 'Idle'
  return undefined
}

/* ───────────── Can only be changed on the computer ───────────── */

export const desktopOnlyText = `${desktopOnly}. Open cc-haha settings on the computer.`

/* ───────────── Remove ───────────── */

export function removeConfirmText(hostName: string) {
  return {
    title: `Remove “${hostName}”?`,
    message:
      'Only removes the connection on the phone; sessions on the computer are kept. When the computer is online phone notifications are unregistered too; it can be removed even when unreachable, and the notification registration there expires within 30 days.',
  }
}

/* ───────────── New task default model page ───────────── */

export type SourceLike = { id: string | null; name: string }

/** Provider row: current provider name + "N more". The name is empty when the current provider is no longer in the list. */
export function providerSummary(sources: SourceLike[], providerId: string | null) {
  const current = sources.find((source) => source.id === providerId)
  const others = sources.length - (current ? 1 : 0)
  return {
    name: current?.name ?? '',
    others: others > 0 ? `${others} more` : undefined,
  }
}

/**
 * Model row: name + subline. Only when name and id differ is the id a monospace subline; 
 * when the name is the id (custom provider) the subline uses the description from the computer instead, not monospace.
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

/** Selected tier on the slider: when the current value is not a selectable tier fall back to the model default tier; returns -1 if none (no thumb drawn, using the computer default). */
export function effortIndex(options: string[], current?: string, fallback?: string) {
  const at = current ? options.indexOf(current) : -1
  if (at >= 0) return at
  return fallback ? options.indexOf(fallback) : -1
}

/* ───────────── Thinking effort slider geometry (design P2: 40pt track, 2pt inset left and right, 44pt thumb) ───────────── */

export const EFFORT_TRACK = { height: 40, inset: 2, thumb: 44, dotInset: 20 } as const

/** X coordinate of each tier center in the slider area (including the 2pt inset each side); the first and last tiers are 20pt from the track edge. */
export function effortTrackStops(width: number, count: number) {
  const { inset, dotInset } = EFFORT_TRACK
  return Array.from({ length: count }, (_, index) =>
    inset + effortStopX(index, { width: Math.max(0, width - inset * 2), count, thumb: dotInset * 2 })
  )
}

/** Nearest tier for a finger at x in the slider area. */
export function effortTrackIndex(x: number, width: number, count: number) {
  const { inset, dotInset } = EFFORT_TRACK
  return effortStopAt(x - inset, { width: Math.max(0, width - inset * 2), count, thumb: dotInset * 2 })
}
