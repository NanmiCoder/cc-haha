import { afterEach, describe, expect, test } from 'bun:test'
import {
  hasConfiguredLocalAccessToken,
  hasConfiguredPetAccessToken,
  isLocalAccessAuthorized,
  isP2PEndpointAuthorized,
  isPetAccessAuthorized,
  LOCAL_ACCESS_TOKEN_ENV,
  P2P_ENDPOINT_TOKEN_ENV,
  PET_ACCESS_TOKEN_ENV,
} from '../localAccessAuth.js'

const originalToken = process.env[LOCAL_ACCESS_TOKEN_ENV]
const originalPetToken = process.env[PET_ACCESS_TOKEN_ENV]

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env[LOCAL_ACCESS_TOKEN_ENV]
  } else {
    process.env[LOCAL_ACCESS_TOKEN_ENV] = originalToken
  }
  if (originalPetToken === undefined) {
    delete process.env[PET_ACCESS_TOKEN_ENV]
  } else {
    process.env[PET_ACCESS_TOKEN_ENV] = originalPetToken
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

  test('the P2P endpoint link takes only its own token, and only from loopback', () => {
    const original = process.env[P2P_ENDPOINT_TOKEN_ENV]
    try {
      process.env[LOCAL_ACCESS_TOKEN_ENV] = 'desktop-secret'
      delete process.env[P2P_ENDPOINT_TOKEN_ENV]
      // Unset: the link stays closed, whatever is presented.
      expect(isP2PEndpointAuthorized('anything', '127.0.0.1')).toBe(false)
      expect(isP2PEndpointAuthorized('', '127.0.0.1')).toBe(false)
      process.env[P2P_ENDPOINT_TOKEN_ENV] = 'endpoint-secret'
      expect(isP2PEndpointAuthorized('endpoint-secret', '127.0.0.1')).toBe(true)
      expect(isP2PEndpointAuthorized('endpoint-secret', '::1')).toBe(true)
      expect(isP2PEndpointAuthorized('endpoint-secret', '::ffff:127.0.0.1')).toBe(true)
      expect(isP2PEndpointAuthorized(null, '127.0.0.1')).toBe(false)
      expect(isP2PEndpointAuthorized('endpoint-secreT', '127.0.0.1')).toBe(false)
      expect(isP2PEndpointAuthorized('endpoint-secret-and-more', '127.0.0.1')).toBe(false)
      // The local access token no longer opens it.
      expect(isP2PEndpointAuthorized('desktop-secret', '127.0.0.1')).toBe(false)
      expect(isP2PEndpointAuthorized('endpoint-secret', '192.168.1.20')).toBe(false)
      expect(isP2PEndpointAuthorized('endpoint-secret', '')).toBe(false)
    } finally {
      if (original === undefined) delete process.env[P2P_ENDPOINT_TOKEN_ENV]
      else process.env[P2P_ENDPOINT_TOKEN_ENV] = original
    }
  })

  test('keeps the pet capability independent from the desktop master token', () => {
    process.env[LOCAL_ACCESS_TOKEN_ENV] = 'desktop-secret'
    process.env[PET_ACCESS_TOKEN_ENV] = 'pet-secret'
    const request = new Request('http://127.0.0.1:3456/api/sessions', {
      headers: { Authorization: 'Bearer pet-secret' },
    })

    expect(hasConfiguredPetAccessToken()).toBe(true)
    expect(isPetAccessAuthorized(request)).toBe(true)
    expect(isLocalAccessAuthorized(request)).toBe(false)
    expect(isPetAccessAuthorized(request, 'desktop-secret')).toBe(false)
  })
})
