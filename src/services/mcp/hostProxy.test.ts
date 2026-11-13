import { afterEach, expect, test } from 'bun:test'
import { resolveMcpHostProxy, setMcpHostProxyResolver } from './hostProxy.js'

const disposers: Array<() => void> = []
const register = (proxy: string) => {
  const dispose = setMcpHostProxyResolver(async () => ({ proxy }))
  disposers.push(dispose)
  return dispose
}

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
})

test('without a host registration MCP retains its CLI environment fallback', async () => {
  expect(await resolveMcpHostProxy('https://fixture.test/mcp')).toBeUndefined()
})

test('stopping the newest host restores the still-active older resolver', async () => {
  const stopFirst = register('http://127.0.0.1:8001')
  const stopSecond = register('http://127.0.0.1:8002')
  expect((await resolveMcpHostProxy('https://fixture.test/mcp'))?.proxy).toBe('http://127.0.0.1:8002')
  stopSecond()
  expect((await resolveMcpHostProxy('https://fixture.test/mcp'))?.proxy).toBe('http://127.0.0.1:8001')
  stopFirst()
  expect(await resolveMcpHostProxy('https://fixture.test/mcp')).toBeUndefined()
})

test('stopping the older host preserves the newest resolver without restoring a stopped one', async () => {
  const stopFirst = register('http://127.0.0.1:8001')
  const stopSecond = register('http://127.0.0.1:8002')
  stopFirst()
  expect((await resolveMcpHostProxy('https://fixture.test/mcp'))?.proxy).toBe('http://127.0.0.1:8002')
  stopSecond()
  expect(await resolveMcpHostProxy('https://fixture.test/mcp')).toBeUndefined()
})

test('registrations own their cleanup even when two hosts supply the same resolver', async () => {
  const resolver = async () => ({ proxy: 'http://127.0.0.1:8001' })
  const first = setMcpHostProxyResolver(resolver)
  const second = setMcpHostProxyResolver(resolver)
  disposers.push(first, second)
  first()
  expect(await resolveMcpHostProxy('https://fixture.test/mcp')).toEqual({ proxy: 'http://127.0.0.1:8001' })
  second()
  expect(await resolveMcpHostProxy('https://fixture.test/mcp')).toBeUndefined()
})

test('unregistering is idempotent and cannot remove a later registration', async () => {
  const resolver = async () => ({ proxy: 'http://127.0.0.1:8001' })
  const first = setMcpHostProxyResolver(resolver)
  disposers.push(first)
  first()
  const second = setMcpHostProxyResolver(resolver)
  disposers.push(second)
  first()
  expect(await resolveMcpHostProxy('https://fixture.test/mcp')).toEqual({ proxy: 'http://127.0.0.1:8001' })
})

test('host resolver errors carry only a safe proxy classification', async () => {
  disposers.push(setMcpHostProxyResolver(async () => { throw new Error('https://user:secret@proxy.test/?token=private') }))
  try {
    await resolveMcpHostProxy('https://fixture.test/mcp')
    throw new Error('Expected the resolver to reject')
  } catch (error) {
    expect(error).toMatchObject({ kind: 'proxy' })
    expect(String(error)).not.toContain('secret')
    expect(String(error)).not.toContain('private')
  }
})
