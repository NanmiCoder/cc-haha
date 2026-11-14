import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  REMOTE_WORKSPACE_STORAGE_KEY,
  REMOTE_WORKSPACE_STORAGE_VERSION,
  clearRemoteWorkspace,
  getEnabledRemoteWorkspace,
  parseRemoteWorkspaceProfile,
  readRemoteWorkspace,
  serializeRemoteWorkspaceProfile,
  writeRemoteWorkspace,
  type RemoteWorkspaceProfile,
} from './remoteWorkspace'

const profile: RemoteWorkspaceProfile = {
  url: 'http://127.0.0.1:3456',
  sshHost: 'my-gpu-server',
  enabled: true,
  connectedAt: '2026-11-09T00:00:00.000Z',
}

describe('remote workspace profile', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('round-trips a profile through localStorage', () => {
    writeRemoteWorkspace(profile)
    expect(readRemoteWorkspace()).toEqual(profile)
    expect(getEnabledRemoteWorkspace()).toEqual(profile)
  })

  it('remembers a disabled profile but does not apply it at startup', () => {
    writeRemoteWorkspace({ ...profile, enabled: false })
    expect(readRemoteWorkspace()).toEqual({ ...profile, enabled: false })
    expect(getEnabledRemoteWorkspace()).toBeNull()
  })

  it('reads null when nothing is stored', () => {
    expect(readRemoteWorkspace()).toBeNull()
    expect(getEnabledRemoteWorkspace()).toBeNull()
  })

  it('forgets the profile on disconnect', () => {
    writeRemoteWorkspace(profile)
    clearRemoteWorkspace()
    expect(window.localStorage.getItem(REMOTE_WORKSPACE_STORAGE_KEY)).toBeNull()
    expect(readRemoteWorkspace()).toBeNull()
  })

  it('drops an entry a newer schema wrote instead of half-applying it', () => {
    const future = JSON.stringify({
      version: REMOTE_WORKSPACE_STORAGE_VERSION + 1,
      url: profile.url,
      sshHost: profile.sshHost,
      enabled: true,
      connectedAt: null,
    })
    expect(parseRemoteWorkspaceProfile(future)).toBeNull()
    window.localStorage.setItem(REMOTE_WORKSPACE_STORAGE_KEY, future)
    expect(readRemoteWorkspace()).toBeNull()
  })

  it('round-trips the process credential the deploy helper minted', () => {
    const withToken = { ...profile, token: 'k3y-minted-by-deploy-0123456789abcdef' }
    writeRemoteWorkspace(withToken)
    expect(readRemoteWorkspace()).toEqual(withToken)
    expect(JSON.parse(serializeRemoteWorkspaceProfile(withToken)).token).toBe(withToken.token)
  })

  it.each([
    ['a short token', 'abc'],
    ['a token with shell metacharacters', 'token;rm -rf /'],
    ['a non-string token', 42],
  ])('drops %s instead of sending it as a credential', (_label, token) => {
    const parsed = parseRemoteWorkspaceProfile(JSON.stringify({
      version: REMOTE_WORKSPACE_STORAGE_VERSION,
      url: profile.url,
      sshHost: profile.sshHost,
      token,
      enabled: true,
      connectedAt: null,
    }))
    expect(parsed?.token).toBeUndefined()
  })

  it.each([
    ['not json', 'not-json'],
    ['an array', '[]'],
    ['a string', '"http://127.0.0.1:3456"'],
    ['a missing url', JSON.stringify({ version: 1, sshHost: 'h', enabled: true, connectedAt: null })],
    ['a blank ssh host', JSON.stringify({ version: 1, url: profile.url, sshHost: '  ', enabled: true, connectedAt: null })],
    ['a non-boolean flag', JSON.stringify({ version: 1, url: profile.url, sshHost: 'h', enabled: 'yes', connectedAt: null })],
  ])('rejects %s', (_label, raw) => {
    expect(parseRemoteWorkspaceProfile(raw)).toBeNull()
  })

  it('normalizes a missing connectedAt to null', () => {
    expect(parseRemoteWorkspaceProfile(JSON.stringify({
      version: REMOTE_WORKSPACE_STORAGE_VERSION,
      url: profile.url,
      sshHost: profile.sshHost,
      enabled: true,
    }))).toEqual({ ...profile, connectedAt: null })
  })

  it('serializes with the version this build understands', () => {
    expect(JSON.parse(serializeRemoteWorkspaceProfile(profile))).toEqual({
      version: REMOTE_WORKSPACE_STORAGE_VERSION,
      ...profile,
    })
  })

  it('reads null when localStorage access throws rather than throwing at startup', () => {
    const original = window.localStorage
    // Force every `window.localStorage` access to throw, as a disabled or
    // sandboxed storage would. The reads must degrade to null, not crash boot.
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled')
      },
    })
    try {
      expect(readRemoteWorkspace()).toBeNull()
      expect(getEnabledRemoteWorkspace()).toBeNull()
    } finally {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        writable: true,
        value: original,
      })
    }
  })

  it('survives a storage failure on write and clear', () => {
    const original = window.localStorage
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('quota exceeded')
      },
    })
    try {
      // Neither throws outward: a storage restriction must not break a live session.
      expect(() => writeRemoteWorkspace(profile)).not.toThrow()
      expect(() => clearRemoteWorkspace()).not.toThrow()
    } finally {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        writable: true,
        value: original,
      })
    }
  })
})
