import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  resetStateForTests,
  setIsInteractive,
  switchSession,
} from '../bootstrap/state.js'
import type { AppState } from '../state/AppState.js'
import type { SessionId } from '../types/ids.js'
import { drainSdkEvents } from '../utils/sdkEventQueue.js'
import { stopTask } from './stopTask.js'

function makeShellTaskHarness() {
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
})
