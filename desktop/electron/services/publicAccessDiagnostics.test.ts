// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createPublicAccessDiagnosticWriter, recordPublicAccessDiagnostic, sanitizePublicAccessDiagnosticText } from './publicAccessDiagnostics'

describe('private remote connection diagnostics', () => {
  it('keeps controlled metadata and correlation ids intact with single-character proxy credentials', () => {
    const events: unknown[] = []
    const attemptId = 'a91642e1-6050-4e59-92c4-bf74b7e336a9'
    recordPublicAccessDiagnostic(event => events.push(event), {
      attemptId, stage: 'tunnel_registration', outcome: 'failed', reason: 'startup_timeout',
      error: Object.assign(new Error('request a:b failed'), { code: 'ECONNABORTED', syscall: 'connect' }),
    }, ['http://a:b@127.0.0.1:7890'])
    expect(events[0]).toMatchObject({ attemptId, stage: 'tunnel_registration', outcome: 'failed', reason: 'startup_timeout', error: { code: 'ECONNABORTED', syscall: 'connect' } })
    expect(JSON.stringify(events)).not.toContain('request a:b failed')
    recordPublicAccessDiagnostic(event => events.push(event), {
      attemptId, stage: 'proxy_connect', outcome: 'failed',
      error: Object.assign(new Error('certificate expired'), { code: 'CERT_HAS_EXPIRED' }),
    }, ['http://user:CERT@127.0.0.1:7890'])
    expect(events[1]).toMatchObject({ error: { code: 'CERT_HAS_EXPIRED' } })
  })

  it('preserves nested transport causes while redacting unlabeled credentials before truncation', () => {
    const token = 'fixture-tunnel-token-never-export'
    const proxy = 'http://private-user:private-password@127.0.0.1:7890'
    const root = Object.assign(new Error(`connect ECONNREFUSED ${proxy}`), { code: 'ECONNREFUSED', syscall: 'connect' })
    const error = new Error('fetch failed', { cause: new Error(`TLS failure ${token}`, { cause: root }) })
    const events: unknown[] = []
    recordPublicAccessDiagnostic(event => events.push(event), {
      stage: 'tunnel_registration', outcome: 'failed', error,
      details: { logTail: `Authorization: Basic ${Buffer.from('private-user:private-password').toString('base64')}\n${'x'.repeat(2040)}${token}` },
    }, [token, proxy])
    expect(events[0]).toMatchObject({ error: { name: 'Error', message: 'fetch failed', cause: { cause: { code: 'ECONNREFUSED', syscall: 'connect' } } } })
    const recorded = JSON.stringify(events)
    for (const secret of [token, 'private-user', 'private-password', Buffer.from('private-user:private-password').toString('base64')]) expect(recorded).not.toContain(secret)
    expect(sanitizePublicAccessDiagnosticText('https://proxy.test/path?credential=private-query')).not.toContain('private-query')
  })

  it('bounds circular and aggregate errors and ignores a failing diagnostic sink', () => {
    const error = Object.assign(new Error('failed'), { code: 'ECONNRESET' })
    error.cause = error
    const events: unknown[] = []
    recordPublicAccessDiagnostic(event => events.push(event), { stage: 'proxy_connect', outcome: 'failed', error: new AggregateError([error], 'All addresses failed') })
    expect(events[0]).toMatchObject({ error: { errors: [{ code: 'ECONNRESET' }] } })
    expect(() => recordPublicAccessDiagnostic(() => { throw new Error('disk full') }, { stage: 'proxy_connect', outcome: 'failed' })).not.toThrow()
  })

  it('writes timestamped events to the host diagnostic surface used by export', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'public-access-log-'))
    try {
      const file = path.join(directory, 'electron-host.log')
      const report = createPublicAccessDiagnosticWriter(file)
      report({ attemptId: 'a91642e1-6050-4e59-92c4-bf74b7e336a9', stage: 'proxy_connect', outcome: 'failed', reason: 'http_connect_status', details: { status: 407, targetPort: 7844 } })
      const line = readFileSync(file, 'utf8').trim()
      expect(JSON.parse(line.slice('[public-access] '.length))).toMatchObject({ timestamp: expect.any(String), attemptId: expect.any(String), stage: 'proxy_connect', reason: 'http_connect_status', details: { status: 407, targetPort: 7844 } })
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('keeps complete JSON, the attempt id and root error code within the host byte limit', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'public-access-long-log-'))
    try {
      const file = path.join(directory, 'electron-host.log')
      const error = new Error('外层错误'.repeat(500), { cause: Object.assign(new Error('底层证书错误'.repeat(400)), { code: 'CERT_HAS_EXPIRED' }) })
      createPublicAccessDiagnosticWriter(file)({ stage: 'tunnel_registration', outcome: 'failed', error,
        details: { logTail: 'certificate has expired '.repeat(60) + 'FINAL_FATAL_CERTIFICATE_EXPIRED' }, attemptId: 'a91642e1-6050-4e59-92c4-bf74b7e336a9' })
      const line = readFileSync(file, 'utf8').trim()
      expect(Buffer.byteLength(line)).toBeLessThan(4096)
      expect(JSON.parse(line.slice('[public-access] '.length))).toMatchObject({
        attemptId: 'a91642e1-6050-4e59-92c4-bf74b7e336a9', stage: 'tunnel_registration', error: { cause: { code: 'CERT_HAS_EXPIRED' } },
      })
      expect(line).toContain('FINAL_FATAL_CERTIFICATE_EXPIRED')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
