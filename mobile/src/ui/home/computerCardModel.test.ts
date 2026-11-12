import { describe, expect, test } from 'bun:test'
import {
  computerCardLabel,
  computerCardView,
  offlineDetail,
  pairingNote,
} from './computerCardModel'

const lan = { auth: 'lan' } as const
const remote = { auth: 'remote' } as const
const now = Date.parse('2026-10-28T12:00:00Z')
const day = 86400000
const joined = (view: ReturnType<typeof computerCardView>) =>
  view.text.map((part) => part.text).join('')

describe('Online', () => {
  test('LAN: Online · LAN · new tasks use model', () => {
    const view = computerCardView({ link: 'online', host: lan, now, model: 'Sonnet 5.5' })
    expect(joined(view)).toBe('Online · LAN · new tasks use Sonnet 5.5')
    expect(view).toMatchObject({ lead: 'dot', leadTone: 'ok', tile: 'normal', trailing: 'chevron' })
    expect(view.buttons).toEqual([])
    expect(view.detail).toBeUndefined()
  })

  test('Omit this segment when the model cannot be read', () => {
    expect(joined(computerCardView({ link: 'online', host: lan, now }))).toBe('Online · LAN')
    expect(joined(computerCardView({ link: 'online', host: remote, now }))).toBe('Online · Public')
  })

  test('Public expiring within 3 days: amber reminder replaces the model', () => {
    const view = computerCardView({
      link: 'online',
      host: remote,
      now,
      model: 'Sonnet 5.5',
      expiresAt: now + 2.4 * day,
    })
    expect(joined(view)).toBe('Online · Public · pairing expires in 3 days')
    expect(view.text.map((part) => part.tone)).toEqual([undefined, 'attn'])
  })

  test('Public far from expiry: no reminder, show the model as usual', () => {
    const view = computerCardView({
      link: 'online',
      host: remote,
      now,
      model: 'Sonnet 5.5',
      expiresAt: now + 20 * day,
    })
    expect(joined(view)).toBe('Online · Public · new tasks use Sonnet 5.5')
    expect(view.text.every((part) => !part.tone)).toBe(true)
  })

  test('LAN never reminds even with an expiry time', () => {
    const view = computerCardView({ link: 'online', host: lan, now, expiresAt: now + day })
    expect(joined(view)).toBe('Online · LAN')
  })
})

describe('Pairing days until expiry', () => {
  test('Boundary: remind at 7 days, not at 8', () => {
    expect(pairingNote(remote, now + 7 * day, now)).toBe('Pairing expires in 7 days')
    expect(pairingNote(remote, now + 7 * day + 1000, now)).toBeNull()
    expect(pairingNote(remote, now + 8 * day, now)).toBeNull()
  })
  test('Less than a day counts as 1 day (same as the computer settings page); expired or past says less than 1 day', () => {
    expect(pairingNote(remote, now + 0.4 * day, now)).toBe('Pairing expires in 1 day')
    expect(pairingNote(remote, now, now)).toBe('Pairing expires in less than 1 day')
    expect(pairingNote(remote, now - day, now)).toBe('Pairing expires in less than 1 day')
  })
  test('Not public or expiry not read: do not make it up', () => {
    expect(pairingNote(lan, now + day, now)).toBeNull()
    expect(pairingNote(remote, undefined, now)).toBeNull()
    expect(pairingNote(remote, Number.NaN, now)).toBeNull()
  })
})

describe('Slow sync / connecting', () => {
  test('Slow sync: amber text + spinner, computer settings still reachable', () => {
    const view = computerCardView({ link: 'slow', host: lan, now, model: 'Sonnet 5.5' })
    expect(joined(view)).toBe('Sync is slow · retrying')
    expect(view).toMatchObject({ lead: 'spinner', textTone: 'attn', trailing: 'chevron' })
    expect(view.buttons).toEqual([])
  })
  test('Connecting: grey text + spinner', () => {
    const view = computerCardView({ link: 'connecting', host: lan, now })
    expect(joined(view)).toBe('Connecting…')
    expect(view).toMatchObject({ lead: 'spinner', textTone: 'ink3' })
  })
})

describe('Offline', () => {
  test('Expanded: reason + two buttons, name and icon dimmed, hollow ring', () => {
    const view = computerCardView({
      link: 'offline',
      host: lan,
      now,
      lastSyncedAt: now - 12 * 60000,
    })
    expect(joined(view)).toBe('Offline · last synced 12 minutes ago')
    expect(view).toMatchObject({
      tile: 'dim',
      lead: 'ring',
      dimName: true,
      detail: offlineDetail,
      trailing: 'chevron',
    })
    expect(view.buttons).toEqual(['switch', 'reconnect'])
  })
  test('No time written when there is no sync record', () => {
    expect(joined(computerCardView({ link: 'offline', host: lan, now }))).toBe('Offline')
  })
})

describe('Auth expired', () => {
  test('Red shield + Pair again capsule, without chevron or expand button', () => {
    const view = computerCardView({ link: 'unauthorized', host: remote, now })
    expect(joined(view)).toBe('Authorization expired · scan again')
    expect(view).toMatchObject({ tile: 'err', textTone: 'err', trailing: 'repair', leadTone: 'err' })
    expect(view.buttons).toEqual([])
    expect(view.detail).toBeUndefined()
  })
})

describe('Sync failed', () => {
  test('Red text, keeps the chevron', () => {
    const view = computerCardView({ link: 'failed', host: lan, now, lastSyncedAt: now - 3 * 60000 })
    expect(joined(view)).toBe('Sync failed · last synced 3 minutes ago')
    expect(view).toMatchObject({ textTone: 'err', trailing: 'chevron' })
  })
})

test('Screen reader label: computer name + status + destination', () => {
  const view = computerCardView({ link: 'online', host: lan, now, model: 'Sonnet 5.5' })
  expect(computerCardLabel('MacBook Pro', view)).toBe(
    'MacBook Pro, Online · LAN · new tasks use Sonnet 5.5, open computer settings'
  )
})
