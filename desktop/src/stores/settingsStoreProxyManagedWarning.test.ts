import { describe, expect, it } from 'vitest'
import { hasProxyManagedOnlyUserSettings } from './settingsStore'

describe('proxy-managed user settings warning', () => {
  it('recognizes a proxy-only takeover placeholder', () => {
    expect(hasProxyManagedOnlyUserSettings({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
        ANTHROPIC_API_KEY: 'PROXY_MANAGED',
      },
    })).toBe(true)
  })

  it('does not flag a normal local model endpoint', () => {
    expect(hasProxyManagedOnlyUserSettings({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
        ANTHROPIC_API_KEY: 'local-model-key',
      },
    })).toBe(false)
  })

  it('does not flag a proxy placeholder when other user settings remain', () => {
    expect(hasProxyManagedOnlyUserSettings({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
        ANTHROPIC_AUTH_TOKEN: 'PROXY_MANAGED',
      },
      language: 'Chinese',
    })).toBe(false)
  })
})
