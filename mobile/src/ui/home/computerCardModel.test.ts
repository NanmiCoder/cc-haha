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

describe('在线', () => {
  test('局域网：在线 · 局域网 · 新任务用 模型', () => {
    const view = computerCardView({ link: 'online', host: lan, now, model: 'Sonnet 5.5' })
    expect(joined(view)).toBe('在线 · 局域网 · 新任务用 Sonnet 5.5')
    expect(view).toMatchObject({ lead: 'dot', leadTone: 'ok', tile: 'normal', trailing: 'chevron' })
    expect(view.buttons).toEqual([])
    expect(view.detail).toBeUndefined()
  })

  test('读不到模型就省掉这一段', () => {
    expect(joined(computerCardView({ link: 'online', host: lan, now }))).toBe('在线 · 局域网')
    expect(joined(computerCardView({ link: 'online', host: remote, now }))).toBe('在线 · 公网')
  })

  test('公网 3 天内到期：琥珀提醒顶替模型', () => {
    const view = computerCardView({
      link: 'online',
      host: remote,
      now,
      model: 'Sonnet 5.5',
      expiresAt: now + 2.4 * day,
    })
    expect(joined(view)).toBe('在线 · 公网 · 配对还剩 3 天')
    expect(view.text.map((part) => part.tone)).toEqual([undefined, 'attn'])
  })

  test('公网离到期还远：不提醒，正常显示模型', () => {
    const view = computerCardView({
      link: 'online',
      host: remote,
      now,
      model: 'Sonnet 5.5',
      expiresAt: now + 20 * day,
    })
    expect(joined(view)).toBe('在线 · 公网 · 新任务用 Sonnet 5.5')
    expect(view.text.every((part) => !part.tone)).toBe(true)
  })

  test('局域网即使带了到期时间也不提醒', () => {
    const view = computerCardView({ link: 'online', host: lan, now, expiresAt: now + day })
    expect(joined(view)).toBe('在线 · 局域网')
  })
})

describe('配对到期天数', () => {
  test('边界：7 天提醒，8 天不提醒', () => {
    expect(pairingNote(remote, now + 7 * day, now)).toBe('配对还剩 7 天')
    expect(pairingNote(remote, now + 7 * day + 1000, now)).toBeNull()
    expect(pairingNote(remote, now + 8 * day, now)).toBeNull()
  })
  test('不满一天按 1 天算（与电脑设置页一致）；到期或已过期说不足 1 天', () => {
    expect(pairingNote(remote, now + 0.4 * day, now)).toBe('配对还剩 1 天')
    expect(pairingNote(remote, now, now)).toBe('配对不足 1 天')
    expect(pairingNote(remote, now - day, now)).toBe('配对不足 1 天')
  })
  test('不是公网或没读到到期时间：不编造', () => {
    expect(pairingNote(lan, now + day, now)).toBeNull()
    expect(pairingNote(remote, undefined, now)).toBeNull()
    expect(pairingNote(remote, Number.NaN, now)).toBeNull()
  })
})

describe('同步慢 / 连接中', () => {
  test('同步慢：琥珀文字 + 转圈，仍可进电脑设置', () => {
    const view = computerCardView({ link: 'slow', host: lan, now, model: 'Sonnet 5.5' })
    expect(joined(view)).toBe('同步较慢 · 正在重试')
    expect(view).toMatchObject({ lead: 'spinner', textTone: 'attn', trailing: 'chevron' })
    expect(view.buttons).toEqual([])
  })
  test('连接中：灰字 + 转圈', () => {
    const view = computerCardView({ link: 'connecting', host: lan, now })
    expect(joined(view)).toBe('连接中…')
    expect(view).toMatchObject({ lead: 'spinner', textTone: 'ink3' })
  })
})

describe('离线', () => {
  test('展开：原因 + 两个按钮，名字和图标变暗，空心圈', () => {
    const view = computerCardView({
      link: 'offline',
      host: lan,
      now,
      lastSyncedAt: now - 12 * 60000,
    })
    expect(joined(view)).toBe('离线 · 12 分钟前最后同步')
    expect(view).toMatchObject({
      tile: 'dim',
      lead: 'ring',
      dimName: true,
      detail: offlineDetail,
      trailing: 'chevron',
    })
    expect(view.buttons).toEqual(['switch', 'reconnect'])
  })
  test('没有同步记录时不写时间', () => {
    expect(joined(computerCardView({ link: 'offline', host: lan, now }))).toBe('离线')
  })
})

describe('授权失效', () => {
  test('红底盾牌 + 重新配对胶囊，没有箭头和展开按钮', () => {
    const view = computerCardView({ link: 'unauthorized', host: remote, now })
    expect(joined(view)).toBe('授权已失效 · 要重新扫码')
    expect(view).toMatchObject({ tile: 'err', textTone: 'err', trailing: 'repair', leadTone: 'err' })
    expect(view.buttons).toEqual([])
    expect(view.detail).toBeUndefined()
  })
})

describe('同步失败', () => {
  test('红字，保留箭头', () => {
    const view = computerCardView({ link: 'failed', host: lan, now, lastSyncedAt: now - 3 * 60000 })
    expect(joined(view)).toBe('同步失败 · 3 分钟前最后同步')
    expect(view).toMatchObject({ textTone: 'err', trailing: 'chevron' })
  })
})

test('读屏标签：电脑名 + 状态 + 去向', () => {
  const view = computerCardView({ link: 'online', host: lan, now, model: 'Sonnet 5.5' })
  expect(computerCardLabel('MacBook Pro', view)).toBe(
    'MacBook Pro，在线 · 局域网 · 新任务用 Sonnet 5.5，打开电脑设置'
  )
})
