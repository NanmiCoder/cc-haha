import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import {
  __resetDaemonClientForTests,
  __setDaemonSocketForTests,
  callDaemon,
  overlayHide,
} from './cuHelperDaemon.js'
import { __resetHelperBridgeState, callHelper } from './helperBridge.js'

type Request = {
  id: string
  cmd: string
  turnId: string
  payload: Record<string, unknown>
}

/** Models the native contract: snapshots belong to a turn and turn_end clears them. */
class SnapshotSocket extends EventEmitter {
  requests: Request[] = []
  destroyed = false
  private snapshotTurn: string | undefined

  write(data: string): boolean {
    const request = JSON.parse(data) as Request
    this.requests.push(request)
    queueMicrotask(() => {
      let result: unknown = true
      let error: string | undefined
      switch (request.cmd) {
        case 'get_app_state':
          this.snapshotTurn = request.turnId
          result = { axText: 'g1:0 button Search', screenshot: { base64: 'fixture' } }
          break
        case 'overlay_show':
          error = 'target_not_running'
          break
        case 'turn_end':
          this.snapshotTurn = undefined
          break
        case 'click':
          if (this.snapshotTurn !== request.turnId) {
            error = request.payload.index
              ? 'No element snapshot exists in the active turn'
              : 'No screenshot snapshot exists for this target'
          }
          break
        default:
          error = `Unexpected fixture command: ${request.cmd}`
      }
      this.emit('data', Buffer.from(`${JSON.stringify({
        id: request.id,
        ok: !error,
        ...(error ? { error: { message: error } } : { result }),
      })}\n`))
    })
    return true
  }

  destroy(): this {
    this.destroyed = true
    return this
  }
}

afterEach(() => {
  __resetDaemonClientForTests()
  __resetHelperBridgeState()
})

describe('cu-helper snapshot lifetime after visual feedback failure', () => {
  test.each([
    { label: 'coordinates', target: { x: 20, y: 30 } },
    { label: 'element handle', target: { index: 'g1:0' } },
  ])('a failed overlay preserves the snapshot for $label', async ({ target }) => {
    const socket = new SnapshotSocket()
    __setDaemonSocketForTests(socket as never)

    // Use the real bridge: it starts overlay_show without awaiting it, then reads state.
    await callHelper('get_app_state', { app: 'Fixture App' }, {
      platform: 'darwin',
      cuHelperAvailable: () => true,
    })
    // Allow the fire-and-forget overlay reconciliation to finish before the next tool.
    await new Promise<void>(resolve => setImmediate(resolve))

    await expect(callDaemon('click', { app: 'Fixture App', ...target })).resolves.toBe(true)
    expect(socket.requests.map(request => request.cmd)).toEqual([
      'overlay_show', 'get_app_state', 'click',
    ])
    const snapshot = socket.requests.find(request => request.cmd === 'get_app_state')!
    const click = socket.requests.find(request => request.cmd === 'click')!
    expect(click.turnId).toBe(snapshot.turnId)

    // Explicit host cleanup must still release the read snapshot despite the failed overlay.
    await overlayHide()
    expect(socket.requests.at(-1)).toMatchObject({
      cmd: 'turn_end',
      turnId: snapshot.turnId,
    })
  })
})
