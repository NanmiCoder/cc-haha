import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  resetStateForTests,
  setIsInteractive,
  switchSession,
} from '../bootstrap/state.js'
import type { AppState } from '../state/AppState.js'
import type { SessionId } from '../types/ids.js'
import { drainSdkEvents } from '../utils/sdkEventQueue.js'
import { stopTask, stopTaskFromControlRequest } from './stopTask.js'

function makeShellTaskHarness(agentId?: string) {
  let killed = false
  let state = {
    tasks: {
      btask123: {
        id: 'btask123',
        type: 'local_bash',
        status: 'running',
        description: 'Sleep for 300 seconds',
        command: 'sleep 300',
        toolUseId: 'bash-tool-1',
        startTime: 1,
        outputFile: '/tmp/btask123.output',
        outputOffset: 0,
        notified: false,
        completionStatusSentInAttachment: false,
        shellCommand: {
          kill: () => {
            killed = true
          },
          cleanup: () => {},
        },
        lastReportedTotalLines: 0,
        isBackgrounded: true,
        agentId,
      },
    },
  } as unknown as AppState

  return {
    get state() {
      return state
    },
    get killed() {
      return killed
    },
    setAppState(updater: (prev: AppState) => AppState) {
      state = updater(state)
    },
  }
}

beforeEach(() => {
  resetStateForTests()
  setIsInteractive(false)
  switchSession('stop-task-sdk-events' as SessionId)
  drainSdkEvents()
})

afterEach(() => {
  drainSdkEvents()
  resetStateForTests()
})

describe('stopTask SDK events', () => {
  test('emits a stopped bookend after LocalShellTask marks itself notified', async () => {
    const harness = makeShellTaskHarness()

    await stopTask('btask123', {
      getAppState: () => harness.state,
      setAppState: harness.setAppState,
    })

    expect(harness.killed).toBe(true)
    expect(harness.state.tasks.btask123?.status).toBe('killed')
    expect(drainSdkEvents()).toContainEqual(expect.objectContaining({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'btask123',
      tool_use_id: 'bash-tool-1',
      status: 'stopped',
      summary: 'Sleep for 300 seconds',
      session_id: 'stop-task-sdk-events',
    }))
  })

  test('does not emit a session bookend for a subagent-owned shell task', async () => {
    const harness = makeShellTaskHarness('subagent-1')

    await stopTask('btask123', {
      getAppState: () => harness.state,
      setAppState: harness.setAppState,
    })

    expect(harness.killed).toBe(true)
    expect(harness.state.tasks.btask123?.status).toBe('killed')
    expect(drainSdkEvents()).toEqual([])
  })
})

describe('stopTaskFromControlRequest', () => {
  test('reports a successful stop for a running task', async () => {
    const harness = makeShellTaskHarness()

    const result = await stopTaskFromControlRequest('btask123', {
      getAppState: () => harness.state,
      setAppState: harness.setAppState,
    })

    expect(result).toEqual({ ok: true, alreadyGone: false })
    expect(harness.killed).toBe(true)
  })

  test('treats an unknown task id as an already-achieved stop, not an error', async () => {
    const harness = makeShellTaskHarness()

    const result = await stopTaskFromControlRequest('evicted-task', {
      getAppState: () => harness.state,
      setAppState: harness.setAppState,
    })

    expect(result).toEqual({ ok: true, alreadyGone: true })
    expect(harness.killed).toBe(false)
  })

  test('keeps surfacing genuine stop failures', async () => {
    const harness = makeShellTaskHarness()
    harness.state.tasks.btask123.status = 'completed'

    const result = await stopTaskFromControlRequest('btask123', {
      getAppState: () => harness.state,
      setAppState: harness.setAppState,
    })

    expect(result).toEqual({
      ok: false,
      message: 'Task btask123 is not running (status: completed)',
    })
    expect(harness.killed).toBe(false)
  })
})
