import { describe, expect, it } from 'vitest'
import { buildTailscaleServeCommand, isPublicAccessConfiguration, normalizePublicAccessOrigin, normalizeTailscaleOrigin } from './publicAccessConfiguration'

describe('Tailscale Serve configuration', () => {
  it('accepts private Serve HTTPS roots and preserves an alternate HTTPS port', () => {
    expect(normalizeTailscaleOrigin(' https://Desktop.Example.ts.net/ ')).toBe('https://desktop.example.ts.net')
    expect(normalizeTailscaleOrigin('https://desktop.example.ts.net:8443')).toBe('https://desktop.example.ts.net:8443')
    expect(normalizeTailscaleOrigin('https://desktop.example.ts.net:443/')).toBe('https://desktop.example.ts.net')
  })

  it('rejects public lookalikes, raw CGNAT addresses, paths and credentials', () => {
    for (const value of [undefined, null, '', 'http://desktop.example.ts.net', 'https:desktop.example.ts.net', 'http://100.101.102.103:17463', 'https://100.101.102.103', 'https://relay.example.com', 'https://ts.net', 'https://tailnet.ts.net', 'https://desktop.example.ts.net.evil.test', 'https://bad_label.example.ts.net', 'https://-bad.example.ts.net', 'https://desktop.example.ts.net:0', 'https://desktop.example.ts.net:65536', 'https://desktop.example.ts.net.', 'https://user:pass@desktop.example.ts.net', 'https://@desktop.example.ts.net', 'https://desktop.example.ts.net/remote', 'https://desktop.example.ts.net/?', 'https://desktop.example.ts.net/#', 'https://desktop.example.ts.net?token=secret', 'https://desktop.example.ts.net\\path', 'https://desktop.exa\nmple.ts.net']) {
      expect(normalizeTailscaleOrigin(value)).toBeNull()
    }
  })

  it('keeps legacy HTTPS parsing separate from the active Tailscale allowlist', () => {
    expect(normalizePublicAccessOrigin('https://legacy.example.test:8443')).toBe('https://legacy.example.test:8443')
    expect(normalizePublicAccessOrigin('https://[2001:db8::25]')).toBe('https://[2001:db8::25]')
    expect(normalizePublicAccessOrigin('https://' + 'x'.repeat(2048))).toBeNull()
    expect(normalizeTailscaleOrigin('https://legacy.example.test:8443')).toBeNull()
  })

  it('accepts only a Serve origin and nonprivileged loopback port without shell controls', () => {
    const config = { mode: 'tailscale', customUrl: 'https://desktop.example.ts.net', localPort: 17463 }
    expect(isPublicAccessConfiguration(config)).toBe(true)
    expect(isPublicAccessConfiguration({ ...config, customUrl: '' })).toBe(true)
    for (const patch of [{ mode: 'ngrok' }, { mode: 'custom' }, { customUrl: 'https://relay.example.test' }, { localPort: 1023 }, { localPort: 65536 }, { localPort: NaN }, { localPort: '17463' }, { localPort: 17463.5 }, { localHost: '0.0.0.0' }, { command: 'tunnel start' }, { ngrokDomain: '' }]) {
      expect(isPublicAccessConfiguration({ ...config, ...patch })).toBe(false)
    }
  })

  it('generates only safe loopback Serve commands with the selected HTTPS port', () => {
    expect(buildTailscaleServeCommand(17463)).toBe('tailscale serve --bg http://127.0.0.1:17463')
    expect(buildTailscaleServeCommand(18321, 'https://desktop.example.ts.net:8443')).toBe('tailscale serve --bg --https=8443 http://127.0.0.1:18321')
    expect(buildTailscaleServeCommand(17463, 'https://desktop.example.ts.net:443')).toBe('tailscale serve --bg http://127.0.0.1:17463')
    for (const port of [0, 80, 65536, 17463.5, NaN, '17463;id']) expect(buildTailscaleServeCommand(port as number)).toBeNull()
    for (const origin of ['https://example.com', 'https://desktop.example.ts.net/remote', 'https://desktop.example.ts.net;id']) expect(buildTailscaleServeCommand(17463, origin)).toBeNull()
  })
})
