import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  buildSocketOptions,
  connectionHeaders,
  normalizeHostUrl,
  parseConnectionInput,
} from './connection'
import type { Host } from './types'

const lan: Host = {
  id: 'a',
  name: 'A',
  url: 'http://192.168.1.12:3456',
  auth: 'lan',
}
const remote: Host = {
  id: 'b',
  name: 'B',
  url: 'https://fixture.invalid',
  auth: 'remote',
}

describe('desktop connection contracts', () => {
  test('parses the desktop LAN QR and keeps token out of host URL', () => {
    expect(
      parseConnectionInput(
        'http://192.168.1.12:3456/?serverUrl=http%3A%2F%2F192.168.1.12%3A3456&h5Token=fake-token'
      )
    ).toEqual({ url: lan.url, auth: 'lan', credential: 'fake-token' })
    expect(
      parseConnectionInput(
        JSON.stringify({ serverUrl: lan.url, h5Token: 'fake-token' })
      )
    ).toEqual({ url: lan.url, auth: 'lan', credential: 'fake-token' })
  })

  test('remote pairing secret stays separate from origin', () => {
    expect(
      parseConnectionInput('https://fixture.invalid/remote#pair=pair-secret')
    ).toEqual({ url: remote.url, auth: 'remote', pairSecret: 'pair-secret' })
    expect(
      parseConnectionInput('https://fixture.invalid/#pair=pair-secret')
    ).toEqual({ url: remote.url, auth: 'remote', pairSecret: 'pair-secret' })
    expect(parseConnectionInput(remote.url)).toEqual({
      url: remote.url,
      auth: 'remote',
    })
  })

  test.each(['https://workstation-fixture.trycloudflare.com', 'https://phone.fixture.example:8443'])('accepts a Cloudflare pairing origin without a VPN address: %s', origin => {
    const parsed = parseConnectionInput(`${origin}/remote#pair=fixture-pair`)
    expect(parsed).toEqual({ url: origin, auth: 'remote', pairSecret: 'fixture-pair' })
    expect(buildSocketOptions({ ...remote, url: parsed.url }, 'native_fixture', 'session', 'native'))
      .toEqual({ url: `${origin.replace('https:', 'wss:')}/ws/session`, headers: { Authorization: 'Bearer native_fixture', Origin: origin } })
  })

  test.each([
    'http://10.0.0.4:3456',
    'http://172.16.0.4',
    'http://172.31.255.1',
    'http://192.168.1.2',
    'http://127.0.0.1',
    'http://169.254.1.1',
    'http://workstation.local',
    'http://[::1]',
    'http://[fd12::1]',
  ])('allows LAN address %s', (url: string) => {
    expect(parseConnectionInput(url).auth).toBe('lan')
  })

  test.each([
    'http://public.invalid',
    'http://172.15.1.1',
    'http://172.32.0.1',
    'http://192.168.0.1.public.invalid',
    'https://user:password@fixture.invalid',
    'file:///tmp/example',
    'javascript:alert(1)',
    'https://fixture.invalid/path',
    'https://fixture.invalid/?token=secret',
    'http://192.168.1.12/#pair=secret',
    'https://fixture.invalid/#pair=one&pair=two',
    'https://fixture.invalid/#pair=',
    'https://fixture.invalid/#pair=one&other=two',
    'http://192.168.1.12/?h5Token=one&h5Token=two',
    'http://192.168.1.12/?h5Token=bad%0Avalue',
    'http://192.168.1.12/?serverUrl=http%3A%2F%2Fpublic.invalid&h5Token=token',
  ])('rejects unsafe or ambiguous input %s', (input: string) => {
    expect(() => parseConnectionInput(input)).toThrow()
  })

  test('remote cannot opt into cleartext even for a LAN destination', () => {
    expect(() => normalizeHostUrl(lan.url, 'remote')).toThrow('HTTPS')
  })

  test('native uses bearer headers and remote origin; credentials never enter WS URL', () => {
    expect(connectionHeaders(lan, 'fake-token')).toEqual({
      Authorization: 'Bearer fake-token',
    })
    expect(
      buildSocketOptions(remote, 'native-token', 'session-id', 'native')
    ).toEqual({
      url: 'wss://fixture.invalid/ws/session-id',
      headers: { Authorization: 'Bearer native-token', Origin: remote.url },
    })
    expect(
      buildSocketOptions(lan, 'fake-token', 'session-id', 'native')
    ).toEqual({
      url: 'ws://192.168.1.12:3456/ws/session-id',
      headers: { Authorization: 'Bearer fake-token', Origin: '' },
    })
  })

  test('native LAN suppresses the current Android SDK default Origin without changing HTTP or remote headers', () => {
    const source = readFileSync(
      new URL(
        '../../node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/websocket/WebSocketModule.kt',
        import.meta.url
      ),
      'utf8'
    )
    // RN treats any string Origin value, including empty, as caller-supplied.
    // Keep this contract tied to the installed SDK when React Native is upgraded.
    expect(source).toMatch(
      /if \(key\.equals\("origin", ignoreCase = true\)\) \{\s*hasOriginHeader = true/
    )
    expect(source).toMatch(
      /if \(!hasOriginHeader\) \{\s*builder\.addHeader\("origin", getDefaultOrigin\(url\)\)/
    )
    const alias = { ...lan, url: 'http://10.0.2.2:3567' }
    expect(
      buildSocketOptions(alias, 'fake-token', 'session-id', 'native').headers
    ).toEqual({ Authorization: 'Bearer fake-token', Origin: '' })
    expect(connectionHeaders(alias, 'fake-token')).toEqual({
      Authorization: 'Bearer fake-token',
    })
    expect(
      buildSocketOptions(remote, 'native-token', 'session-id', 'native').headers
        ?.Origin
    ).toBe(remote.url)
  })

  test('only the LAN browser preview uses the existing token query contract', () => {
    expect(buildSocketOptions(lan, 'fake-token', 'session-id', 'web')).toEqual({
      url: 'ws://192.168.1.12:3456/ws/session-id?token=fake-token',
    })
    expect(() =>
      buildSocketOptions(remote, 'native-token', 'session-id', 'web')
    ).toThrow('原生 App')
    expect(() => buildSocketOptions(lan, '', 'session-id', 'native')).toThrow(
      '凭据'
    )
    expect(() =>
      buildSocketOptions(lan, 'fake-token', '../other', 'native')
    ).toThrow('标识')
  })
})
