import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  notifyMcpConnectionClosed,
  setMcpConnectionClosedHandler,
} from './client.js'

const client = {} as Client

afterEach(() => {
  setMcpConnectionClosedHandler(undefined)
})

describe('MCP connection close handler', () => {
  test('notifies the registered session handler', () => {
    const handler = mock(() => {})
    setMcpConnectionClosedHandler(handler)

    notifyMcpConnectionClosed('test-server', client)

    expect(handler).toHaveBeenCalledWith('test-server', client)
  })

  test('uses the latest handler and stops notifying after unregister', () => {
    const staleHandler = mock(() => {})
    const activeHandler = mock(() => {})
    setMcpConnectionClosedHandler(staleHandler)
    setMcpConnectionClosedHandler(activeHandler)

    notifyMcpConnectionClosed('test-server', client)
    setMcpConnectionClosedHandler(undefined)
    notifyMcpConnectionClosed('test-server', client)

    expect(staleHandler).not.toHaveBeenCalled()
    expect(activeHandler).toHaveBeenCalledTimes(1)
  })
})
