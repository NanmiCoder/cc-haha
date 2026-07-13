import { afterEach, describe, expect, test } from 'bun:test'
import {
  hasConfiguredLocalAccessToken,
  isLocalAccessAuthorized,
  LOCAL_ACCESS_TOKEN_ENV,
} from '../localAccessAuth.js'

const originalToken = process.env[LOCAL_ACCESS_TOKEN_ENV]

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env[LOCAL_ACCESS_TOKEN_ENV]
  } else {
    process.env[LOCAL_ACCESS_TOKEN_ENV] = originalToken
  }
})

describe('localAccessAuth', () => {
  test('accepts only the configured process token', () => {
    process.env[LOCAL_ACCESS_TOKEN_ENV] = 'desktop-secret'

    expect(hasConfiguredLocalAccessToken()).toBe(true)
    expect(isLocalAccessAuthorized(new Request('http://127.0.0.1:3456/api/status', {
      headers: { Authorization: 'Bearer desktop-secret' },
    }))).toBe(true)
    expect(isLocalAccessAuthorized(new Request('http://127.0.0.1:3456/api/status'), 'desktop-secret')).toBe(true)
    expect(isLocalAccessAuthorized(new Request('http://127.0.0.1:3456/api/status'), 'wrong')).toBe(false)
  })

  test('stays disabled when the process token is absent', () => {
    delete process.env[LOCAL_ACCESS_TOKEN_ENV]

    expect(hasConfiguredLocalAccessToken()).toBe(false)
    expect(isLocalAccessAuthorized(new Request('http://127.0.0.1:3456/api/status'), 'anything')).toBe(false)
  })
})
