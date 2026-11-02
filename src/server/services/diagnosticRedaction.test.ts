import { describe, expect, test } from 'bun:test'
import { inspect } from 'node:util'
import { isSensitiveDiagnosticKey, redactDiagnosticText } from './diagnosticRedaction'

describe('diagnostic credential redaction', () => {
  test('preserves prose apostrophes before quoted credentials', () => {
    for (const contraction of ["Can't", "Don't", "Couldn't", "users'"]) {
      const result = redactDiagnosticText(`Error: ${contraction} complete request\n{ token: 'fixture-prose-secret', status: 400 }`)
      expect(result).toContain(`Error: ${contraction} complete request`)
      expect(result).not.toContain('fixture-prose-secret')
      expect(result).toContain('status: 400')
    }
  })

  test('redacts complete Node inspect string values, including concatenation and backticks', () => {
    for (const password of ['start\n' + 'fixture-inspect-secret'.repeat(8), `begin'fixture-inspect-secret"end`]) {
      const result = redactDiagnosticText(inspect({ password, status: 400 }))
      expect(result).not.toContain('fixture-inspect-secret')
      expect(result).toContain('status: 400')
    }
  })

  test('redacts complete Cookie and Digest headers while retaining the next diagnostic line', () => {
    const result = redactDiagnosticText('Cookie: first=fixture-cookie-one; session=fixture-cookie-two\nAuthorization: Digest username="fixture-user", response="fixture-response"\nstatus: 400')
    for (const secret of ['fixture-cookie-one', 'fixture-cookie-two', 'fixture-user', 'fixture-response']) expect(result).not.toContain(secret)
    expect(result).toContain('\nstatus: 400')
    expect(redactDiagnosticText(result.replaceAll('\n', ' '))).toBe(result.replaceAll('\n', ' '))
  })

  test.each(['null', 'true', 'false', 'true-user'])('treats %s as a cookie name when followed by a value', name => {
    const result = redactDiagnosticText(`Cookie: ${name}=fixture-first-cookie; session=fixture-session-cookie\nstatus: 400`)
    expect(result).not.toContain('fixture-first-cookie')
    expect(result).not.toContain('fixture-session-cookie')
    expect(result).toContain('status: 400')
  })

  test.each(['Authorization', 'Cookie'])('preserves JSON structure when %s has structured or null values', key => {
    for (const value of [{ credential: 'fixture-structured-secret' }, ['fixture-structured-secret'], null]) {
      const result = redactDiagnosticText(JSON.stringify({ [key]: value, status: 400 }))
      expect(JSON.parse(result)).toEqual({ [key]: '[REDACTED]', status: 400 })
      expect(redactDiagnosticText(result)).toBe(result)
    }
  })

  test.each(['app_id', 'AppID', 'appId', 'APP_SECRET', 'appSecret', 'token', 'tenant_access_token', 'API-Key', 'apiKey', 'Password', 'Authorization', 'Cookie', 'ANTHROPIC_AUTH_TOKEN'])('redacts %s in plain and nested serialized JSON', key => {
    const value = { method: 'post', status: 400, nested: [{ [key]: 'fixture-private-value' }], path: '/open-apis/auth/v3/tenant_access_token/internal' }
    let encoded = JSON.stringify(value)
    for (let depth = 0; depth < 4; depth++) {
      const result = redactDiagnosticText(`AxiosError data: ${encoded}\n at request (adapter.ts:42:7)`)
      expect(result).not.toContain('fixture-private-value')
      for (const safe of ['post', '400', value.path, 'adapter.ts:42:7']) expect(result).toContain(safe)
      expect(redactDiagnosticText(result)).toBe(result)
      encoded = JSON.stringify(encoded)
    }
  })

  test('redacts whole quoted multiline values and sensitive objects without eating adjacent diagnostics', () => {
    const input = `Error: failure\npassword: 'first line\nsecond \\'quote\\' line', status: 400\nAuthorization: Basic fixture-auth\napp_secret: { nested: ['object-secret', { value: 'another-secret' }] }, method: post`
    const result = redactDiagnosticText(input)
    for (const secret of ['first line', 'second', 'fixture-auth', 'object-secret', 'another-secret']) expect(result).not.toContain(secret)
    for (const safe of ['Error: failure', 'status: 400', 'method: post']) expect(result).toContain(safe)
    expect(redactDiagnosticText(result)).toBe(result)
  })

  test('redacts truncated credential values while retaining the preceding failure context', () => {
    for (const tail of [
      "app_secret: 'fixture-truncated-secret",
      '"token": "fixture-truncated-secret',
      'password: { nested: ["fixture-truncated-secret"]',
    ]) {
      const result = redactDiagnosticText(`AxiosError status: 400 method: POST\n${tail}`)
      expect(result).not.toContain('fixture-truncated')
      expect(result).toContain('[REDACTED]')
      expect(result).toContain('AxiosError status: 400 method: POST')
      expect(redactDiagnosticText(result)).toBe(result)
    }
  })

  test('keeps JSON valid when redacting non-string credential values', () => {
    const result = JSON.parse(redactDiagnosticText(JSON.stringify({ app_id: 123456, token: { value: 'hidden' }, password: ['hidden'], status: 400 })))
    expect(result).toEqual({ app_id: '[REDACTED]', token: '[REDACTED]', password: '[REDACTED]', status: 400 })
  })

  test('preserves safe counters, identifiers, crash diagnostics and already redacted auth', () => {
    const input = 'exit code=1 SIGABRT\n at request (adapter.ts:42:7)\n{"token_count":42,"max_tokens":2048,"status":400,"request_id":"req-42"}\nBearer [REDACTED]'
    expect(redactDiagnosticText(input)).toBe(input)
    for (const key of ['token_count', 'max_tokens', 'request_id', 'method', 'path', 'status']) expect(isSensitiveDiagnosticKey(key)).toBe(false)
  })
})
