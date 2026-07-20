import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createElectronDevEnv, DEFAULT_RENDERER_URL, mergeNoProxy, resolveElectronExecutable } from './electron-dev'

describe('desktop dev launcher environment', () => {
  it('uses localhost and bypasses proxies for local renderer startup', () => {
    const env = createElectronDevEnv({
      HTTPS_PROXY: 'http://proxy.example',
      NO_PROXY: 'example.com',
    })

    expect(env.ELECTRON_RENDERER_URL).toBe(DEFAULT_RENDERER_URL)
    expect(env.NO_PROXY).toBe('example.com,localhost,127.0.0.1,::1')
    expect(env.no_proxy).toBe(env.NO_PROXY)
  })

  it('preserves explicit renderer URL while adding missing local no_proxy entries', () => {
    const env = createElectronDevEnv({
      ELECTRON_RENDERER_URL: 'http://localhost:1777',
      no_proxy: 'localhost',
    })

    expect(env.ELECTRON_RENDERER_URL).toBe('http://localhost:1777')
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1')
    expect(env.no_proxy).toBe(env.NO_PROXY)
  })

  it('deduplicates no_proxy entries', () => {
    expect(mergeNoProxy('localhost,127.0.0.1')).toBe('localhost,127.0.0.1,::1')
  })

  it('resolves Electron directly instead of shelling through bunx', () => {
    expect(resolveElectronExecutable(path.resolve(import.meta.dirname, '..'), 'win32')).toMatch(/electron\.exe$/)
  })
})