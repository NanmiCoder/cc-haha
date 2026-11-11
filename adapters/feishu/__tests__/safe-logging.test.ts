import { describe, expect, it, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { createFeishuLogger } from '../logger.js'

describe('Feishu safe logger', () => {
  it('keeps only HTTP metadata from Axios errors and SDK-formatted response arrays', () => {
    const logger = createFeishuLogger(['fixture-bare-secret'])
    const capture = spyOn(console, 'error').mockImplementation(() => {})
    const config = {
      method: 'post', url: 'https://user:password@fixture.invalid/token?api_key=fixture-query',
      data: '{"app_secret":"fixture-body"}', headers: { Authorization: 'Bearer fixture-header' },
    }
    const error = Object.assign(new Error('app_secret=fixture-message'), {
      name: 'AxiosError', isAxiosError: true, code: 'ERR_BAD_REQUEST', config,
      response: { status: 400, data: { detail: 'fixture-response' } }, request: { body: 'fixture-request' },
    })
    try {
      logger.error([['request failed', error]])
      logger.error([[{ message: error.message, config, request: error.request, response: error.response }, error.response.data]])
      const output = capture.mock.calls.flat().join('\n')
      expect(output).toContain('AxiosError')
      expect(output).toContain('ERR_BAD_REQUEST')
      expect(output).toContain('POST')
      expect(output).toContain('/token')
      expect(output).toContain('400')
      for (const value of ['fixture-body', 'fixture-header', 'fixture-message', 'fixture-response', 'fixture-request', 'fixture-query', 'password@']) {
        expect(output).not.toContain(value)
      }
      expect(output).not.toContain('"config"')
      expect(output).not.toContain('"data"')
      expect(capture.mock.calls.flat().every(value => typeof value === 'string')).toBe(true)
      expect(error.config.data).toBe('{"app_secret":"fixture-body"}')
      expect(error.response.data.detail).toBe('fixture-response')
    } finally { capture.mockRestore() }
  })

  it('redacts nested fields, JSON strings and known credentials without invoking object hooks', () => {
    const logger = createFeishuLogger(['fixture-bare-secret'])
    const capture = spyOn(console, 'warn').mockImplementation(() => {})
    let getterCalls = 0
    const nested = {
      AppID: 'fixture-app', AppSecret: 'fixture-secret', token: 'fixture-token',
      api_key: 'fixture-key', password: 'fixture-password', Authorization: 'fixture-auth',
      text: 'known value fixture-bare-secret', json: JSON.stringify({ app_secret: 'fixture-json' }),
      safe: 'readable-context', get dangerous() { getterCalls++; return 'fixture-getter' },
      toJSON() { throw new Error('must not execute') },
    }
    const circular: Record<string, unknown> = { nested }
    circular.self = circular
    try {
      logger.warn([circular])
      const output = capture.mock.calls.flat().join('\n')
      expect(output).toContain('readable-context')
      expect(output).toContain('[CIRCULAR]')
      expect(output).toContain('[REDACTED]')
      expect(getterCalls).toBe(0)
      for (const secret of ['fixture-app', 'fixture-secret', 'fixture-token', 'fixture-key', 'fixture-password', 'fixture-auth', 'fixture-bare-secret', 'fixture-json', 'fixture-getter']) {
        expect(output).not.toContain(secret)
      }
    } finally { capture.mockRestore() }
  })

  it('retains readable ordinary error stacks and causes while redacting their secrets', () => {
    const logger = createFeishuLogger(['fixture-bare-secret'])
    const capture = spyOn(console, 'error').mockImplementation(() => {})
    const cause = new Error('token=fixture-cause')
    cause.stack = 'Error: token=fixture-cause\n    at fixtureCause (worker.ts:8:2)'
    const error = new Error('request failed fixture-bare-secret', { cause })
    error.stack = 'Error: request failed fixture-bare-secret\n    at fixtureWork (worker.ts:12:4)'
    try {
      logger.error('operation failed:', error)
      const output = capture.mock.calls.flat().join('\n')
      expect(output).toContain('\n    at fixtureWork (worker.ts:12:4)')
      expect(output).toContain('\n    at fixtureCause (worker.ts:8:2)')
      expect(output).not.toContain('fixture-bare-secret')
      expect(output).not.toContain('fixture-cause')
      expect(capture.mock.calls.flat().every(value => typeof value === 'string')).toBe(true)
    } finally { capture.mockRestore() }
  })
})

describe('Feishu logging at the production startup boundary', () => {
  it('keeps SDK token failures, dispatcher/WS logs and adapter catches free of credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'feishu-safe-logging-'))
    const fixture = fileURLToPath(new URL('./fixtures/safe-logging.ts', import.meta.url))
    const secrets = {
      FEISHU_APP_ID: 'issue1720-fixture-app-id',
      FEISHU_APP_SECRET: 'issue1720-fixture-app-secret',
      FEISHU_ENCRYPT_KEY: 'issue1720-fixture-encrypt-key',
      FEISHU_VERIFICATION_TOKEN: 'issue1720-fixture-verification-token',
    }
    try {
      const child = Bun.spawn([process.execPath, '--no-env-file', fixture], {
        env: createSandboxedTestEnvironment(directory, secrets),
        stdout: 'pipe', stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ])
      expect({ exitCode, stderr: exitCode === 0 ? '' : stderr }).toEqual({ exitCode: 0, stderr: '' })
      const output = stdout + stderr
      for (const secret of Object.values(secrets)) expect(output).not.toContain(secret)
      for (const secret of ['fixture-authorization', 'fixture-response-body', 'fixture-request-body', 'fixture-url-query']) {
        expect(output).not.toContain(secret)
      }
      expect(output).toContain('/open-apis/auth/v3/tenant_access_token/internal')
      expect(output).toContain('400')
      expect(output).toContain('ERR_BAD_REQUEST')
      expect(output).toContain('ws fixture')
      expect(output).toContain('dispatcher fixture')
      expect(output).toContain('Send text error')
      expect(output).toContain('TOKEN_REQUESTS=1')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
