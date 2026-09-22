import { describe, expect, it } from 'bun:test'
import { authenticateCollaborationCaller, collaborationToolAction } from './sessionCollaborationAuth.js'

describe('session collaboration credentials', () => {
  const authorize = (id: string, token: string) => id === 'caller' && token === 'session-secret'
  it('binds the authenticated caller and rejects a mismatched or stale token', () => {
    const request = (id: string, token: string) => new Request('http://localhost/api/session-collaboration/send', {
      method: 'POST', headers: { 'x-session-id': id, authorization: `Bearer ${token}` },
    })
    expect(authenticateCollaborationCaller(request('caller', 'session-secret'), authorize)).toBe('caller')
    expect(authenticateCollaborationCaller(request('other', 'session-secret'), authorize)).toBeNull()
    expect(authenticateCollaborationCaller(request('caller', 'global-token'), authorize)).toBeNull()
  })
  it('does not expose the SDK credential to browser requests or unrelated routes', () => {
    expect(authenticateCollaborationCaller(new Request('http://localhost', { method: 'POST',
      headers: { origin: 'https://example.com', 'x-session-id': 'caller', authorization: 'Bearer session-secret' },
    }), authorize)).toBeNull()
    expect(collaborationToolAction('/api/session-collaboration/send')).toBe('send')
    expect(collaborationToolAction('/api/session-collaboration/id/stop')).toBeNull()
    expect(collaborationToolAction('/api/settings')).toBeNull()
  })
})
