import { expect, test } from 'bun:test'
import { desktopOnly } from '../settings/settingsModel'
import {
  activitySummary,
  computerStatus,
  connectionAddress,
  connectionMethod,
  defaultsFootnote,
  desktopOnlyText,
  effortIndex,
  effortTrackIndex,
  effortTrackStops,
  modelDisplayName,
  modelRow,
  permissionAccess,
  providerSummary,
  remoteAuthLine,
  removeConfirmText,
} from './computerModel'

const lan = { auth: 'lan' as const, url: 'http://192.168.1.8:3600' }
const remote = { auth: 'remote' as const, url: 'https://haha.example.com' }

test('permission default is editable on LAN and read-only over public access', () => {
  expect(permissionAccess(lan)).toEqual({ editable: true })
  const blocked = permissionAccess(remote)
  expect(blocked.editable).toBe(false)
  expect(blocked.note).toContain('公网连接下只能在电脑上改')
})

test('defaults footnote only mentions the permission limit on public connections', () => {
  expect(defaultsFootnote(lan)).not.toContain('公网')
  expect(defaultsFootnote(lan)).toContain('只影响之后新建的任务')
  const text = defaultsFootnote(remote)
  expect(text).toContain('只影响之后新建的任务')
  expect(text).toContain('公网连接下只能在电脑上改')
})

test('connection rows name the method and show host:port', () => {
  expect(connectionMethod(lan)).toBe('局域网直连')
  expect(connectionMethod(remote)).toBe('公网访问')
  expect(connectionAddress(lan)).toBe('192.168.1.8:3600')
  expect(connectionAddress(remote)).toBe('haha.example.com')
  expect(connectionAddress({ url: 'not a url' })).toBe('not a url')
})

test('public authorization countdown rounds up and is hidden on LAN', () => {
  const day = 86400000
  expect(remoteAuthLine(lan, { expiresAt: 5 * day, checkedAt: 0 })).toBeNull()
  expect(remoteAuthLine(remote, {})).toBeNull()
  expect(remoteAuthLine(remote, { expiresAt: 2.2 * day, checkedAt: 0 })).toBe('还剩 3 天')
  expect(remoteAuthLine(remote, { expiresAt: 0.4 * day, checkedAt: 0 })).toBe('还剩 1 天')
  expect(remoteAuthLine(remote, { expiresAt: 0, checkedAt: 0 })).toBe('不足 1 天')
  expect(remoteAuthLine(remote, { expiresAt: -day, checkedAt: 0 })).toBe('不足 1 天')
})

test('model display prefers the computer-provided name', () => {
  expect(modelDisplayName({ id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' })).toBe('Sonnet 5.5')
  expect(modelDisplayName({ id: 'claude-sonnet-5-5', name: '  ' })).toBe('claude-sonnet-5-5')
  expect(modelDisplayName({ id: 'x' })).toBe('x')
  expect(modelDisplayName(null)).toBe('')
})

test('background activity never claims idle when some sessions were unreadable', () => {
  expect(activitySummary({ running: 4, read: 2, total: 5 })).toBe('4 项在跑')
  expect(activitySummary({ running: 0, read: 5, total: 5 })).toBe('空闲')
  expect(activitySummary({ running: 0, read: 0, total: 0 })).toBe('空闲')
  expect(activitySummary({ running: 0, read: 2, total: 5 })).toBeUndefined()
})

test('desktop-only footnote keeps the shared list and points to the desktop', () => {
  expect(desktopOnlyText).toContain(desktopOnly)
  expect(desktopOnlyText).toContain('在电脑上打开 cc-haha')
})

test('removing a computer quotes its name in the confirmation', () => {
  const text = removeConfirmText('MacBook Pro')
  expect(text.title).toBe('移除「MacBook Pro」？')
  expect(text.message).toContain('电脑上的会话会保留')
})

test('provider row names the active source and counts the others', () => {
  const sources = [
    { id: null, name: 'Claude 官方' },
    { id: 'openai-official', name: 'ChatGPT 官方' },
    { id: 'p1', name: '自建' },
  ]
  expect(providerSummary(sources, null)).toEqual({ name: 'Claude 官方', others: '另有 2 个' })
  expect(providerSummary(sources, 'p1')).toEqual({ name: '自建', others: '另有 2 个' })
  expect(providerSummary(sources.slice(0, 1), null)).toEqual({ name: 'Claude 官方', others: undefined })
  // 当前来源已被删除：不能把它算进“其他”。
  expect(providerSummary(sources, 'gone')).toEqual({ name: '', others: '另有 3 个' })
})

test('model rows show the id in mono only when the name differs', () => {
  expect(modelRow({ id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' })).toEqual({
    title: 'Sonnet 5.5',
    detail: 'claude-sonnet-5-5',
    mono: true,
  })
  expect(modelRow({ id: 'glm-5', name: 'glm-5' }, ' main · sonnet ')).toEqual({
    title: 'glm-5',
    detail: 'main · sonnet',
    mono: false,
  })
  expect(modelRow({ id: 'glm-5', name: 'glm-5' })).toEqual({
    title: 'glm-5',
    detail: undefined,
    mono: false,
  })
})

test('effort slider falls back from the current level to the model default, else draws no thumb', () => {
  const options = ['low', 'medium', 'high']
  expect(effortIndex(options, 'medium', 'high')).toBe(1)
  expect(effortIndex(options, 'max', 'high')).toBe(2)
  expect(effortIndex(options, undefined, 'low')).toBe(0)
  expect(effortIndex(options, undefined, undefined)).toBe(-1)
  expect(effortIndex(options, 'max', 'nope')).toBe(-1)
})

test('header status reads online with the network, and keeps offline and revoked states apart', () => {
  const now = Date.now()
  expect(computerStatus(lan, { state: 'online' }, now)).toEqual({ text: '在线 · 局域网', tone: 'ok' })
  expect(computerStatus(remote, { state: 'online' }, now)).toEqual({ text: '在线 · 公网', tone: 'ok' })
  expect(computerStatus(lan, { state: 'unauthorized' }, now).tone).toBe('err')
  const offline = computerStatus(lan, { state: 'offline' }, now)
  expect(offline.tone).toBe('faint')
  expect(offline.text).toContain('离线')
  expect(computerStatus(lan, { state: 'checking' }, now).text).toContain('检查')
})

test('effort track puts the first and last stops 20pt inside the 2pt-inset track', () => {
  expect(effortTrackStops(358, 3)).toEqual([22, 179, 336])
  expect(effortTrackStops(358, 1)).toEqual([179])
  expect(effortTrackStops(358, 4).length).toBe(4)
})

test('effort track maps a finger position to the nearest stop and clamps at the ends', () => {
  expect(effortTrackIndex(0, 358, 3)).toBe(0)
  expect(effortTrackIndex(100, 358, 3)).toBe(0)
  expect(effortTrackIndex(101, 358, 3)).toBe(1)
  expect(effortTrackIndex(179, 358, 3)).toBe(1)
  expect(effortTrackIndex(260, 358, 3)).toBe(2)
  expect(effortTrackIndex(999, 358, 3)).toBe(2)
  effortTrackStops(358, 5).forEach((x, index) => expect(effortTrackIndex(x, 358, 5)).toBe(index))
})
