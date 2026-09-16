import { describe, expect, mock, test } from 'bun:test'
import type { ConnectedMCPServer } from './types.js'
import { discardConnectionAttemptIfDisabled } from './useManageMCPConnections.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function connectedServer(cleanup: () => Promise<void>): ConnectedMCPServer {
  return {
    name: 'test-server',
    type: 'connected',
    client: {} as ConnectedMCPServer['client'],
    capabilities: {},
    config: { type: 'sse', url: 'https://example.com/mcp' },
    cleanup,
  }
}

describe('discardConnectionAttemptIfDisabled', () => {
  test('closes a reconnect that resolves after the server is disabled', async () => {
    const reconnect = deferred<ConnectedMCPServer>()
    const cleanup = mock(async () => {})
    const updateServer = mock(() => {})

    const completion = reconnect.promise.then(client =>
      discardConnectionAttemptIfDisabled(client, true, updateServer),
    )

    reconnect.resolve(connectedServer(cleanup))

    await expect(completion).resolves.toBe(true)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(updateServer).toHaveBeenCalledWith({
      name: 'test-server',
      type: 'disabled',
      config: { type: 'sse', url: 'https://example.com/mcp' },
    })
  })

  test('leaves the active reconnect result untouched after re-enable', () => {
    const cleanup = mock(async () => {})
    const updateServer = mock(() => {})

    const discarded = discardConnectionAttemptIfDisabled(
      connectedServer(cleanup),
      false,
      updateServer,
    )

    expect(discarded).toBe(false)
    expect(cleanup).not.toHaveBeenCalled()
    expect(updateServer).not.toHaveBeenCalled()
  })
})
