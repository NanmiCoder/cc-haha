import { describe, expect, it } from 'vitest'
import { buildTraceWindowUrl, getTraceLaunchRequest } from './traceLaunch'

describe('trace launch URLs', () => {
  it('parses dedicated trace window requests by session id', () => {
    expect(getTraceLaunchRequest('?traceWindow=1&traceSessionId=session-123')).toEqual({
      sessionId: 'session-123',
      windowMode: true,
    })
  })

  it('accepts sessionId as a shorter deep-link alias', () => {
    expect(getTraceLaunchRequest('?sessionId=session-456')).toEqual({
      sessionId: 'session-456',
      windowMode: false,
    })
  })

  it('builds a same-app trace window URL without dropping existing connection params', () => {
    expect(buildTraceWindowUrl(
      'session-789',
      'http://127.0.0.1:5173/?serverUrl=http%3A%2F%2F127.0.0.1%3A3456',
    )).toBe(
      'http://127.0.0.1:5173/?serverUrl=http%3A%2F%2F127.0.0.1%3A3456&traceWindow=1&traceSessionId=session-789',
    )
  })
})
