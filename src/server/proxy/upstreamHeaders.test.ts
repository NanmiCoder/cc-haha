import { describe, expect, test } from 'bun:test'

import { applyUpstreamHeaders, resolveUpstreamHeaders } from './upstreamHeaders.js'

const OPENCODE_GO_HEADERS = {
  'User-Agent': 'cc-haha/$VERSION',
  'x-opencode-session': '$SESSION_ID',
}

describe('resolveUpstreamHeaders', () => {
  test('substitutes the session id and version placeholders', () => {
    const headers = resolveUpstreamHeaders(OPENCODE_GO_HEADERS, { sessionId: 'session-abc' })
    expect(headers['x-opencode-session']).toBe('session-abc')
    expect(headers['User-Agent']).toMatch(/^cc-haha\//)
  })

  test('omits a session header when the request carries no session id', () => {
    // Sending an empty value would trip the gateway's own validation with a
    // vaguer error than its missing-session one.
    for (const sessionId of [undefined, null, '', '   ']) {
      const headers = resolveUpstreamHeaders(OPENCODE_GO_HEADERS, { sessionId })
      expect(headers['x-opencode-session']).toBeUndefined()
      // A header that does not reference the session still goes out.
      expect(headers['User-Agent']).toMatch(/^cc-haha\//)
    }
  })

  test('defaults to an empty context rather than requiring one', () => {
    const headers = resolveUpstreamHeaders(OPENCODE_GO_HEADERS)
    expect(headers['x-opencode-session']).toBeUndefined()
    expect(headers['User-Agent']).toMatch(/^cc-haha\//)
  })

  test('returns an empty map when no template is declared', () => {
    expect(resolveUpstreamHeaders(undefined, { sessionId: 's' })).toEqual({})
    expect(resolveUpstreamHeaders({}, { sessionId: 's' })).toEqual({})
  })

  test('refuses to let a preset shadow the credential or the request framing', () => {
    const headers = resolveUpstreamHeaders({
      Authorization: 'Bearer attacker',
      'x-api-key': 'attacker',
      Host: 'evil.example',
      'Content-Type': 'text/plain',
      'Content-Length': '0',
      Connection: 'close',
      'x-keep-me': 'yes',
    }, { sessionId: 's' })
    expect(headers).toEqual({ 'x-keep-me': 'yes' })
  })

  test('refuses to let a preset override the credential under any casing', () => {
    const headers = resolveUpstreamHeaders({
      AUTHORIZATION: 'Bearer attacker',
      'X-Api-Key': 'attacker',
      'user-agent': 'ok',
    }, { sessionId: 's' })
    expect(headers).toEqual({ 'user-agent': 'ok' })
  })

  test('drops header values that would inject a new header line', () => {
    const headers = resolveUpstreamHeaders(
      { 'x-opencode-session': '$SESSION_ID', 'x-static': 'a\r\nx-injected: 1' },
      { sessionId: 'bad\r\nx-injected: 1' },
    )
    expect(headers['x-opencode-session']).toBeUndefined()
    expect(headers['x-static']).toBeUndefined()
  })

  test('drops blank names and blank values', () => {
    const headers = resolveUpstreamHeaders({ '  ': 'v', 'x-blank': '   ', 'x-ok': ' v ' }, { sessionId: 's' })
    expect(headers).toEqual({ 'x-ok': 'v' })
  })

  test('leaves a template that declares no placeholder untouched', () => {
    const headers = resolveUpstreamHeaders({ 'x-static': '$VERSION-pinned' }, { sessionId: 's' })
    expect(headers['x-static']).toMatch(/^.+?-pinned$/)
    expect(headers['x-static']).not.toContain('$VERSION')
  })
})

describe('applyUpstreamHeaders', () => {
  test('replaces a header the caller already set under different casing', () => {
    // `Headers` folds casing, so keeping both spellings sends them combined
    // ("caller, preset") instead of letting the preset win.
    const headers: Record<string, string> = {
      'user-agent': 'some-third-party-sdk/1.0',
      'X-SESSION-ID': 'caller-supplied',
      'x-keep': 'kept',
    }

    applyUpstreamHeaders(headers, { 'User-Agent': 'cc-haha/1', 'x-session-id': 'preset' })

    expect(headers).toEqual({ 'x-keep': 'kept', 'User-Agent': 'cc-haha/1', 'x-session-id': 'preset' })
    expect(new Headers(headers).get('user-agent')).toBe('cc-haha/1')
    expect(new Headers(headers).get('x-session-id')).toBe('preset')
  })

  test('adds headers that were not present at all', () => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    applyUpstreamHeaders(headers, { 'x-opencode-session': 's-1' })
    expect(headers).toEqual({ 'Content-Type': 'application/json', 'x-opencode-session': 's-1' })
  })

  test('returns the map it mutated so it can be spread', () => {
    expect(applyUpstreamHeaders({}, { 'x-a': '1' })).toEqual({ 'x-a': '1' })
  })

  test('reports the version the runtime advertises, not a build placeholder', () => {
    // A gateway triaging abuse reads this string; `999.0.0-local` on a real
    // release build would be worse than sending nothing.
    const original = process.env.APP_VERSION
    try {
      process.env.APP_VERSION = '1.2.3'
      const headers = resolveUpstreamHeaders(OPENCODE_GO_HEADERS, { sessionId: 's' })
      expect(headers['User-Agent']).toBe('cc-haha/1.2.3')
    } finally {
      if (original === undefined) delete process.env.APP_VERSION
      else process.env.APP_VERSION = original
    }
  })

})
