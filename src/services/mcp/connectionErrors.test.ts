import { describe, expect, test } from 'bun:test'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { ErrorCode, ListToolsResultSchema, McpError } from '@modelcontextprotocol/sdk/types.js'
import { classifyMcpConnectionError, getMcpConnectionError, McpConnectionError, McpConnectionErrorContext, setMcpConnectionError, type McpConnectionErrorKind } from './connectionErrors.js'

const secret = 'https://fixture.invalid/mcp?key=fake-private-key Authorization: Bearer fake-header-secret'

describe('safe transient MCP connection errors', () => {
  test.each([
    [Object.assign(new Error(secret), { code: 'ECONNREFUSED' }), 'network'],
    [new Error(secret, { cause: { code: 'ENOTFOUND' } }), 'network'],
    [Object.assign(new Error(secret), { code: 'ETIMEDOUT' }), 'timeout'],
    [new DOMException(secret, 'TimeoutError'), 'timeout'],
    [new McpError(ErrorCode.RequestTimeout, secret), 'timeout'],
    [new McpError(ErrorCode.ConnectionClosed, secret), 'network'],
    [new UnauthorizedError(secret), 'authentication'],
    [{ status: 401, message: secret }, 'authentication'],
    [{ statusCode: 403, message: secret }, 'permission'],
    [{ code: 407, message: secret }, 'proxy'],
    [{ code: 504, message: secret }, 'timeout'],
    [{ code: 503, message: secret }, 'network'],
    [new Error(`401 authentication proxy timed out: ${secret}`), 'discovery'],
  ] satisfies Array<[unknown, McpConnectionErrorKind]>)('classifies structured failure %# without retaining upstream data', (upstream, kind) => {
    const error = classifyMcpConnectionError(upstream)
    expect(error).toBeInstanceOf(McpConnectionError)
    expect(error.kind).toBe(kind)
    expect(error.message).toBe(new McpConnectionError(kind).message)
    expect(`${error}${JSON.stringify(error)}`).not.toContain('fake-private-key')
    expect(`${error}${JSON.stringify(error)}`).not.toContain('fake-header-secret')
    expect(error).not.toHaveProperty('cause')
  })

  test('unknown and cyclic errors use only the supplied safe fallback', () => {
    const cyclic = { cause: undefined as unknown, message: secret }
    cyclic.cause = cyclic
    expect(classifyMcpConnectionError(cyclic).kind).toBe('discovery')
    expect(classifyMcpConnectionError(secret, 'proxy').kind).toBe('proxy')
    const changed = new McpConnectionError('permission')
    changed.message = secret
    expect(classifyMcpConnectionError(changed).message).toBe(new McpConnectionError('permission').message)
  })

  test('observes 401 before SDK OAuth discovery replaces the error, without reading or changing the response', async () => {
    const context = new McpConnectionErrorContext()
    const response = new Response(secret, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } })
    const fetch = context.wrapFetch(async () => response)
    expect(await fetch('https://fixture.invalid/mcp')).toBe(response)
    expect(response.bodyUsed).toBe(false)
    expect(context.classify(new Error(`OAuth discovery failed ${secret}`)).kind).toBe('authentication')
    context.reset()
    expect(context.classify(new Error(secret)).kind).toBe('discovery')
  })

  test('successful MCP retry clears stale authentication before tool-schema validation, but auxiliary successes do not', async () => {
    const context = new McpConnectionErrorContext()
    const endpoint = 'https://fixture.invalid/mcp'
    const request = { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }) }
    const auxiliaryRequests = [
      ['https://fixture.invalid/.well-known/oauth-authorization-server', { method: 'GET' }],
      ['https://fixture.invalid/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'fake-refresh-token' }) }],
      ['https://fixture.invalid/register', { method: 'POST', body: JSON.stringify({ client_name: 'fixture' }) }],
      [endpoint, { method: 'GET' }],
      [endpoint, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }],
      [endpoint, { method: 'POST', body: '{invalid JSON' }],
    ] satisfies Array<[string, RequestInit]>
    const recovered = Response.json({ jsonrpc: '2.0', id: 4, result: { tools: secret } })
    const responses = [new Response(null, { status: 401 }), ...auxiliaryRequests.map(() => Response.json({})), recovered]
    const fetch = context.wrapFetch(async () => responses.shift()!)
    await fetch(endpoint, request)
    for (const [url, init] of auxiliaryRequests) {
      await fetch(url, init)
      expect(context.classify(new Error(secret)).kind).toBe('authentication')
    }
    const response = await fetch(endpoint, request)
    expect(response).toBe(recovered)
    expect(response.bodyUsed).toBe(false)
    const parsed = ListToolsResultSchema.safeParse((await response.json()).result)
    expect(parsed.success).toBe(false)
    if (parsed.success) throw new Error('Fixture must fail tool-schema validation')
    const error = context.classify(parsed.error)
    expect(error.kind).toBe('discovery')
    expect(error.message).toBe(new McpConnectionError('discovery').message)
    expect(`${error}${JSON.stringify(error)}`).not.toContain('fake-private-key')
    expect(error).not.toHaveProperty('cause')
  })

  test.each([403, 407, 408, 500, 504])('retains safe HTTP %i classification even when the SDK drops its status', async status => {
    const context = new McpConnectionErrorContext()
    await context.wrapFetch(async () => new Response(secret, { status }))('https://fixture.invalid/mcp')
    expect(context.classify(new Error(secret)).kind).toBe(classifyMcpConnectionError({ status }).kind)
  })

  test('a selected proxy identifies transport failures while preserving timeout and abort handling', async () => {
    const context = new McpConnectionErrorContext()
    const networkError = Object.assign(new Error(secret), { code: 'ECONNREFUSED' })
    await expect(context.wrapFetch(async () => { throw networkError }, 'proxy')('https://fixture.invalid/mcp')).rejects.toBe(networkError)
    expect(context.classify(networkError).kind).toBe('proxy')
    const timeout = new DOMException(secret, 'TimeoutError')
    await expect(context.wrapFetch(async () => { throw timeout }, 'proxy')('https://fixture.invalid/mcp')).rejects.toBe(timeout)
    expect(context.classify(timeout).kind).toBe('timeout')
    const cancelled = new DOMException('Fixture cancellation', 'AbortError')
    await expect(context.wrapFetch(async () => { throw cancelled })('https://fixture.invalid/mcp')).rejects.toBe(cancelled)
  })

  test('request timeout signal survives runtimes replacing its reason with a generic abort', async () => {
    const context = new McpConnectionErrorContext()
    const controller = new AbortController()
    controller.abort(new DOMException('Fixture request deadline', 'TimeoutError'))
    const abort = new DOMException('Fixture fetch aborted', 'AbortError')
    await expect(context.wrapFetch(async () => { throw abort })('https://fixture.invalid/mcp', { signal: controller.signal })).rejects.toBe(abort)
    expect(context.classify(abort).kind).toBe('timeout')
  })

  test('connection classification adds no serializable fields', () => {
    const connection = { type: 'failed', error: 'existing error boundary' }
    const serialized = JSON.stringify(connection)
    setMcpConnectionError(connection, new McpConnectionError('network'))
    expect(getMcpConnectionError(connection)?.kind).toBe('network')
    expect(JSON.stringify(connection)).toBe(serialized)
    expect(getMcpConnectionError({ ...connection })).toBeUndefined()
  })
})
