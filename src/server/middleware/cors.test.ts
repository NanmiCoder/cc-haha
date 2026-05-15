import { describe, expect, it } from 'bun:test'
import { corsHeaders, resolveCors } from './cors'

describe('corsHeaders', () => {
  it('allows localhost browser origins', () => {
    expect(corsHeaders('http://127.0.0.1:1420')['Access-Control-Allow-Origin']).toBe('http://127.0.0.1:1420')
    expect(corsHeaders('http://localhost:3000')['Access-Control-Allow-Origin']).toBe('http://localhost:3000')
  })

  it('allows tauri webview origins used in production builds', () => {
    expect(corsHeaders('http://tauri.localhost')['Access-Control-Allow-Origin']).toBe('http://tauri.localhost')
    expect(corsHeaders('https://tauri.localhost')['Access-Control-Allow-Origin']).toBe('https://tauri.localhost')
    expect(corsHeaders('tauri://localhost')['Access-Control-Allow-Origin']).toBe('tauri://localhost')
  })

  it('allows arbitrary origins while H5 access is open', () => {
    expect(corsHeaders('https://example.com')['Access-Control-Allow-Origin']).toBe('https://example.com')
    expect(corsHeaders(null)['Access-Control-Allow-Origin']).toBe('http://localhost:3000')
  })
})

describe('resolveCors (SaaS permissive)', () => {
  it('allows any origin with no options', async () => {
    const result = await resolveCors('https://example.com', 'http://127.0.0.1:3456')

    expect(result).toEqual({
      allowed: true,
      rejected: false,
      headers: {
        'Access-Control-Allow-Origin': 'https://example.com',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      },
    })
  })

  it('falls back to * when origin is null', async () => {
    const result = await resolveCors(null)

    expect(result.allowed).toBe(true)
    expect(result.rejected).toBe(false)
    expect(result.headers['Access-Control-Allow-Origin']).toBe('*')
  })

  it('allows blocked origins even with H5-style options (permissive)', async () => {
    const result = await resolveCors('https://blocked.example.com', 'http://192.168.0.20:3456', {
      h5Enabled: true,
      isOriginAllowed: async () => false,
    })

    expect(result.allowed).toBe(true)
    expect(result.rejected).toBe(false)
    expect(result.headers['Access-Control-Allow-Origin']).toBe('https://blocked.example.com')
  })

  it('allows configured origins', async () => {
    const result = await resolveCors('https://allowed.example.com', 'http://192.168.0.20:3456', {
      h5Enabled: true,
      isOriginAllowed: async (origin) => origin === 'https://allowed.example.com',
    })

    expect(result.allowed).toBe(true)
    expect(result.rejected).toBe(false)
    expect(result.headers['Access-Control-Allow-Origin']).toBe('https://allowed.example.com')
  })

  it('allows tauri and localhost origins', async () => {
    for (const origin of ['http://tauri.localhost', 'http://127.0.0.1:5179']) {
      const result = await resolveCors(origin, 'http://192.168.0.20:3456', {
        h5Enabled: true,
        isOriginAllowed: async () => false,
      })

      expect(result.allowed).toBe(true)
      expect(result.rejected).toBe(false)
      expect(result.headers['Access-Control-Allow-Origin']).toBe(origin)
    }
  })

  it('allows non-local same-origin requests (permissive)', async () => {
    const result = await resolveCors('http://192.168.0.20:3456', 'http://192.168.0.20:3456', {
      h5Enabled: true,
      isOriginAllowed: async () => false,
    })

    expect(result.allowed).toBe(true)
    expect(result.rejected).toBe(false)
    expect(result.headers['Access-Control-Allow-Origin']).toBe('http://192.168.0.20:3456')
  })

  it('allows same-origin requests through configured origin callback', async () => {
    const result = await resolveCors('http://192.168.0.20:3456', 'http://192.168.0.20:3456', {
      h5Enabled: true,
      isOriginAllowed: async (origin) => origin === 'http://192.168.0.20:3456',
    })

    expect(result.allowed).toBe(true)
    expect(result.rejected).toBe(false)
    expect(result.headers['Access-Control-Allow-Origin']).toBe('http://192.168.0.20:3456')
  })
})
