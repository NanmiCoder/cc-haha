import { describe, expect, it } from 'vitest'
import { findCloudflareTunnelToken, isPublicAccessConfiguration, normalizePublicAccessOrigin, isCloudflareTunnelToken, readCloudflareTunnelToken } from './publicAccessConfiguration'

// Same shape cloudflared decodes; every value is fabricated.
const tunnelId = '0d9c6c2e-4f5a-4b7e-9c1d-2e3f4a5b6c7d'
const fakeToken = (id = tunnelId) => btoa(JSON.stringify({ a: '0123456789abcdef0123456789abcdef', t: id, s: btoa('fake-tunnel-secret-for-tests') }))

describe('Cloudflare public access configuration', () => {
  it('accepts zero-configuration quick mode and a named HTTPS origin', () => {
    expect(isPublicAccessConfiguration({ mode: 'quick', customUrl: '', localPort: 17463 })).toBe(true)
    expect(isPublicAccessConfiguration({ mode: 'named', customUrl: 'https://phone.example.com/', localPort: 17463, tunnelToken: 'fake_token_for_a_local_only_regression_fixture' })).toBe(true)
    expect(isPublicAccessConfiguration({ mode: 'named', customUrl: '', localPort: 17463 })).toBe(true)
    expect(normalizePublicAccessOrigin('https://PHONE.example.com:443/')).toBe('https://phone.example.com')
  })

  it('rejects retired modes, malformed origins, shell options and URL credentials', () => {
    const config = { mode: 'named', customUrl: 'https://phone.example.com', localPort: 17463 }
    for (const patch of [
      { mode: 'tailscale' }, { mode: 'ngrok' }, { mode: 'custom' },
      { customUrl: 'http://phone.example.com' }, { customUrl: 'https://phone.example.com/remote' },
      { customUrl: 'https://phone.example.com?token=fake' }, { customUrl: 'https://user:fake@phone.example.com' },
      { localPort: 80 }, { localPort: 65536 }, { localPort: '17463' }, { localPort: NaN },
      { localHost: '0.0.0.0' }, { command: 'cloudflared tunnel run' }, { tunnelToken: 'fake\nsecret' },
    ]) expect(isPublicAccessConfiguration({ ...config, ...patch })).toBe(false)
    expect(isPublicAccessConfiguration({ ...config, mode: 'quick' })).toBe(false)
  })

  it('bounds opaque tokens and permits retaining a saved token', () => {
    expect(isCloudflareTunnelToken('')).toBe(true)
    expect(isCloudflareTunnelToken(undefined)).toBe(true)
    expect(isCloudflareTunnelToken('eyJhIjoiZmFrZS1maXh0dXJlLXRva2VuIiwicyI6ImZha2UifQ==')).toBe(true)
    for (const value of [null, 7, ' short ', 'x'.repeat(8193), 'fake token', 'fake\0token']) expect(isCloudflareTunnelToken(value)).toBe(false)
  })
})

describe('Tunnel Token pasted from Cloudflare', () => {
  const token = fakeToken()

  it.each([
    ['bare token', `  ${token}\n`],
    ['macOS install', `brew install cloudflared && \n\nsudo cloudflared service install ${token}`],
    ['service install', `sudo cloudflared service install ${token}`],
    ['manual run', `cloudflared tunnel run --token ${token}`],
    ['Windows', `cloudflared.exe service install ${token}`],
    ['Docker', `docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token ${token}`],
    ['Debian', `curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && \n\nsudo dpkg -i cloudflared.deb && \n\nsudo cloudflared service install ${token}`],
    ['flag assignment', `cloudflared tunnel run --token=${token}`],
    ['quoted environment', `TUNNEL_TOKEN="${token}" cloudflared tunnel run`],
    ['two commands for the same tunnel', `sudo cloudflared service install ${token}\ncloudflared tunnel run --token ${token}`],
  ])('keeps only the credential from %s', (_name, pasted) => {
    expect(findCloudflareTunnelToken(pasted)).toEqual({ status: 'found', token, tunnelId })
  })

  it('refuses commands for two different tunnels instead of guessing', () => {
    const other = fakeToken('7f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f')
    expect(findCloudflareTunnelToken(`cloudflared tunnel run --token ${token}\ncloudflared tunnel run --token ${other}`)).toEqual({ status: 'ambiguous' })
  })

  it.each([
    ['a command without a token', 'cloudflared service install private-token'],
    ['an opaque string', 'x'.repeat(64)],
    ['a token cut short by one character', token.slice(0, -1)],
    ['a credential without a tunnel', 'eyJhIjoiZmFrZS1maXh0dXJlLXRva2VuIiwicyI6ImZha2UifQ=='],
    ['a credential with a malformed tunnel ID', btoa(JSON.stringify({ a: 'account', t: 'not-a-uuid', s: btoa('secret') }))],
    ['a credential whose secret is not base64', btoa(JSON.stringify({ a: 'account', t: tunnelId, s: 'not base64!' }))],
  ])('reports no token for %s', (_name, pasted) => {
    expect(findCloudflareTunnelToken(pasted)).toEqual({ status: 'missing' })
  })

  it('names the tunnel of a saved credential without exposing its secret', () => {
    expect(readCloudflareTunnelToken(fakeToken(tunnelId.toUpperCase()))).toEqual({ tunnelId })
    expect(readCloudflareTunnelToken('')).toBeNull()
  })
})
