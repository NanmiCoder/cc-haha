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
  test.each(['https://workstation-fixture.trycloudflare.com', 'https://phone.fixture.example:8443'])('a Cloudflare QR switches mode without asking for a LAN token: %s', origin => {
    const link = `${origin}/remote#pair=fake-secret`
    expect(receivedConnection(link)).toEqual({ address: link, name: new URL(origin).hostname, mode: 'remote' })
    expect(modeForAddress(link, 'lan')).toBe('remote')
    expect(needsToken('remote', link)).toBe(false)
    expect(shouldMaskAddress(link)).toBe(true)
    expect(connectionBlocker('remote', link)).toBe('')
    expect(formFootnote('remote', link)).toContain('quick connect or fixed domain')
    expect(formFootnote('remote', link)).toContain('then approve on the computer')
    expect(formFootnote('remote', link)).toContain('quick connect is rebuilt, scan again')
    expect(formFootnote('remote', link)).not.toContain('Tailscale')
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
    expect(() => receivedConnection('not a link')).toThrow('full connection address')
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
      'The phone and computer must be on the same network. The token is in Settings → Mobile connection on the computer.'
    )
    expect(formFootnote('lan', lanQr)).toContain('The QR code already contains LAN credentials')
    expect(formFootnote('remote', pairLink)).toContain('then approve on the computer')
    expect(addressPlaceholder('lan')).toBe('http://192.168.1.10:3456')
    expect(addressPlaceholder('remote')).toBe('https://xxxx.trycloudflare.com/remote#pair=…')
    expect(primaryTitle('lan')).toBe('Connection')
    expect(primaryTitle('remote')).toBe('Request computer authorization')
  })

  test('an explicit HTTP hostname uses the token form and a non-blocking connection notice', () => {
    const address = 'http://workstation.fixture.ts.net/'
    expect(receivedConnection(address).mode).toBe('lan')
    expect(connectionBlocker('lan', address)).toBe('')
    expect(needsToken('lan', address)).toBe(true)
    expect(formFootnote('lan', address)).toContain('HTTP connections are not encrypted')
    expect(formFootnote('lan', address)).toContain('The phone needs to reach this address')
    expect(formFootnote('lan', `${address}?h5Token=fixture-only`)).toContain('The QR code already contains')
    expect(formFootnote('remote', pairLink)).not.toContain('HTTP connections are not encrypted')
  })

  test('a mode that contradicts the address is explained before any request', () => {
    expect(connectionBlocker('remote', 'http://192.168.1.10:3456')).toContain(
      'This is a LAN address'
    )
    expect(connectionBlocker('lan', pairLink)).toContain('This is a remote pairing link')
    expect(connectionBlocker('lan', 'http://192.168.1.10:3456')).toBe('')
    expect(connectionBlocker('remote', pairLink)).toBe('')
    // Unparseable input is left to connectHost so its own message is shown once.
    expect(connectionBlocker('remote', 'garbage')).toBe('')
  })

  test('the approval page shows the public domain', () => {
    expect(remoteBadge(pairLink)).toBe('Remote · cc.example.com')
    expect(remoteBadge('')).toBe('Remote connection')
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
