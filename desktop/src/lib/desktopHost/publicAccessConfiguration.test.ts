import { describe, expect, it } from 'vitest'
import { isNgrokDevOrigin, isPublicAccessConfiguration, normalizeNgrokDomain, normalizePublicAccessOrigin } from './publicAccessConfiguration'

describe('external tunnel configuration', () => {
  it('preserves HTTPS IP and port origins and canonicalizes domain names', () => {
    expect(normalizePublicAccessOrigin(' https://Relay.Example.test/ ')).toBe('https://relay.example.test')
    expect(normalizePublicAccessOrigin('https://203.0.113.25:8443')).toBe('https://203.0.113.25:8443')
    expect(normalizePublicAccessOrigin('https://[2001:db8::25]')).toBe('https://[2001:db8::25]')
  })

  it('rejects URLs that would send credentials to a path, redirect, or insecure origin', () => {
    for (const value of [undefined, null, '', 'http://relay.test', 'https:relay.test', 'https://u:p@relay.test', 'https://@relay.test', 'https://relay.test/path', 'https://relay.test/?', 'https://relay.test/#', 'https://relay.test/?token=secret', 'https://relay.test\\path', 'https://relay.\ntest', 'https://' + 'x'.repeat(2048)]) {
      expect(normalizePublicAccessOrigin(value)).toBeNull()
    }
  })

  it('accepts only the public origin and fixed port, never a different local binding or commands', () => {
    const config = { mode: 'custom', customUrl: 'https://relay.example.test', localPort: 17463, ngrokDomain: '' }
    expect(isPublicAccessConfiguration(config)).toBe(true)
    expect(isPublicAccessConfiguration({ mode: 'ngrok', customUrl: '', localPort: 17463, ngrokDomain: '' })).toBe(true)
    for (const patch of [{ mode: 'cloudflare' }, { customUrl: '' }, { localPort: 1023 }, { localPort: 65536 }, { localPort: NaN }, { localPort: '17463' }, { localPort: 17463.5 }, { localHost: '0.0.0.0' }, { command: 'tunnel start' }]) {
      expect(isPublicAccessConfiguration({ ...config, ...patch })).toBe(false)
    }
  })

  it('requires a complete HTTPS registered domain with no nonstandard port, IP or wildcard', () => {
    expect(normalizeNgrokDomain(' https://Registered.Example.test/ ')).toBe('https://registered.example.test')
    for (const value of [undefined, null, '', 'registered.example.test', 'http://registered.example.test', 'https://registered.example.test:8443', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://*.example.test', 'https://bad_label.example.test', 'https://registered.example.test/path', 'https://registered.example.test?token=x']) {
      expect(normalizeNgrokDomain(value)).toBeNull()
    }
    const config = { mode: 'ngrok', customUrl: '', localPort: 17463, ngrokDomain: '' }
    expect(isPublicAccessConfiguration({ ...config, ngrokDomain: 'https://registered.example.test' })).toBe(true)
    for (const ngrokDomain of [undefined, null, 'registered.example.test', 'http://registered.example.test', 'https://registered.example.test:8443']) {
      expect(isPublicAccessConfiguration({ ...config, ngrokDomain })).toBe(false)
    }
  })

  it('identifies only assigned account dev domains as automatically reusable', () => {
    for (const value of ['https://assigned-name.ngrok-free.app', 'https://assigned-name.ngrok-free.dev/']) {
      expect(isNgrokDevOrigin(value)).toBe(true)
    }
    for (const value of [null, '', 'https://random.ngrok.app', 'https://random.ngrok.io', 'https://ngrok-free.dev', 'https://name.ngrok-free.app.evil.test', 'https://nested.name.ngrok-free.dev', 'https://name.ngrok-free.app:8443', 'http://name.ngrok-free.dev']) {
      expect(isNgrokDevOrigin(value)).toBe(false)
    }
  })
})
