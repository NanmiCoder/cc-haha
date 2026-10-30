import { describe, expect, it } from 'vitest'
import { isPublicAccessConfiguration, normalizePublicAccessOrigin, isCloudflareTunnelToken } from './publicAccessConfiguration'

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
