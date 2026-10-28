import { describe, expect, test } from 'bun:test'
import {
  addressPlaceholder,
  connectionBlocker,
  formFootnote,
  initialStage,
  modeForAddress,
  needsToken,
  primaryTitle,
  receivedConnection,
  remoteBadge,
  shouldMaskAddress,
} from './connectForm'

const pairLink = 'https://cc.example.com/remote#pair=fake-secret'
const lanQr =
  'http://192.168.1.10:3456/?serverUrl=http%3A%2F%2F192.168.1.10%3A3456&h5Token=fake-lan'

describe('manual connect mode', () => {
  test('a Tailscale Serve QR switches mode without asking for a LAN token and keeps its port', () => {
    const link = 'https://workstation.fixture.ts.net:8443/remote#pair=fake-secret'
    expect(receivedConnection(link)).toEqual({ address: link, name: 'workstation.fixture.ts.net', mode: 'remote' })
    expect(modeForAddress(link, 'lan')).toBe('remote')
    expect(needsToken('remote', link)).toBe(false)
    expect(shouldMaskAddress(link)).toBe(true)
    expect(connectionBlocker('remote', link)).toBe('')
    expect(formFootnote('remote', link)).toContain('同一个 Tailscale 账号')
  })
  test('a pasted #pair= link switches to public and a LAN QR switches back', () => {
    expect(modeForAddress(pairLink, 'lan')).toBe('remote')
    expect(modeForAddress(lanQr, 'remote')).toBe('lan')
  })

  test('plain or incomplete addresses keep the mode the user picked', () => {
    expect(modeForAddress('http://192.168.1.10:3456', 'remote')).toBe('remote')
    expect(modeForAddress('https://cc.example.com', 'lan')).toBe('lan')
    expect(modeForAddress('http://192.168', 'remote')).toBe('remote')
    expect(modeForAddress('', 'lan')).toBe('lan')
  })

  test('scanned content fills the hostname and the matching mode', () => {
    expect(receivedConnection(pairLink)).toEqual({
      address: pairLink,
      name: 'cc.example.com',
      mode: 'remote',
    })
    expect(receivedConnection(lanQr)).toEqual({
      address: lanQr,
      name: '192.168.1.10',
      mode: 'lan',
    })
    expect(() => receivedConnection('not a link')).toThrow('完整的连接地址')
  })
})

describe('manual connect fields', () => {
  test('pair codes and LAN tokens inside the address are masked', () => {
    expect(shouldMaskAddress(pairLink)).toBe(true)
    expect(shouldMaskAddress(lanQr)).toBe(true)
    expect(shouldMaskAddress('http://192.168.1.10:3456')).toBe(false)
  })

  test('the token row appears only for LAN without an embedded credential', () => {
    expect(needsToken('lan', 'http://192.168.1.10:3456')).toBe(true)
    expect(needsToken('lan', '')).toBe(true)
    expect(needsToken('lan', lanQr)).toBe(false)
    expect(needsToken('remote', 'http://192.168.1.10:3456')).toBe(false)
  })

  test('footnote, placeholder and primary action follow the scenario', () => {
    expect(formFootnote('lan', '')).toBe(
      '手机和电脑要在同一个网络。令牌在电脑的「设置 → 手机连接」里。'
    )
    expect(formFootnote('lan', lanQr)).toContain('二维码已包含局域网凭据')
    expect(formFootnote('remote', pairLink)).toContain('请求电脑授权')
    expect(addressPlaceholder('lan')).toBe('http://192.168.1.10:3456')
    expect(addressPlaceholder('remote')).toBe('https://电脑.网络.ts.net/remote#pair=…')
    expect(primaryTitle('lan')).toBe('连接')
    expect(primaryTitle('remote')).toBe('请求电脑授权')
  })

  test('a mode that contradicts the address is explained before any request', () => {
    expect(connectionBlocker('remote', 'http://192.168.1.10:3456')).toContain(
      '这是局域网地址'
    )
    expect(connectionBlocker('lan', pairLink)).toContain('这是远程配对链接')
    expect(connectionBlocker('lan', 'http://192.168.1.10:3456')).toBe('')
    expect(connectionBlocker('remote', pairLink)).toBe('')
    // Unparseable input is left to connectHost so its own message is shown once.
    expect(connectionBlocker('remote', 'garbage')).toBe('')
  })

  test('the approval page shows the public domain', () => {
    expect(remoteBadge(pairLink)).toBe('远程 · cc.example.com')
    expect(remoteBadge('')).toBe('远程连接')
  })
})

describe('connect entry stage', () => {
  test('mode=manual opens the manual form directly, anything else starts at the scanner', () => {
    expect(initialStage('manual')).toBe('form')
    expect(initialStage(['manual'])).toBe('form')
    expect(initialStage(undefined)).toBe('scan')
    expect(initialStage('')).toBe('scan')
    expect(initialStage('scan')).toBe('scan')
    expect(initialStage(['scan', 'manual'])).toBe('scan')
  })
})
