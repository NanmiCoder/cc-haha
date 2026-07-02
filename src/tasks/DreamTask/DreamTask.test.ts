import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  resetStateForTests,
  setIsInteractive,
  switchSession,
} from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import type { SessionId } from '../../types/ids.js'
import { drainSdkEvents } from '../../utils/sdkEventQueue.js'
import {
  DreamTask,
  completeDreamTask,
  failDreamTask,
  registerDreamTask,
} from './DreamTask.js'

function makeTaskHarness() {
  let state = {
    tasks: {},
  } as AppState

  return {
    get state() {
      return state
    },
    setAppState(updater: (prev: AppState) => AppState) {
      state = updater(state)
    },
  }
}

beforeEach(() => {
  resetStateForTests()
  setIsInteractive(false)
  switchSession('dream-task-sdk-events' as SessionId)
  drainSdkEvents()
})

afterEach(() => {
  drainSdkEvents()
  resetStateForTests()
})

describe('DreamTask SDK events', () => {
  test('emits a terminal SDK bookend when auto-dream completes', () => {
    const harness = makeTaskHarness()
    const taskId = registerDreamTask(harness.setAppState, {
      sessionsReviewing: 5,
      priorMtime: 0,
      abortController: new AbortController(),
    })
    drainSdkEvents()

    completeDreamTask(taskId, harness.setAppState)

    expect(drainSdkEvents()).toContainEqual(expect.objectContaining({
      type: 'system',
      subtype: 'task_notification',
      task_id: taskId,
      status: 'completed',
      summary: 'Auto-dream completed',
      output_file: '',
      session_id: 'dream-task-sdk-events',
    }))
  })

  test('emits a terminal SDK bookend when auto-dream fails', () => {
    const harness = makeTaskHarness()
    const taskId = registerDreamTask(harness.setAppState, {
      sessionsReviewing: 5,
      priorMtime: 0,
      abortController: new AbortController(),
    })
    drainSdkEvents()

    failDreamTask(taskId, harness.setAppState)

    expect(drainSdkEvents()).toContainEqual(expect.objectContaining({
      type: 'system',
      subtype: 'task_notification',
      task_id: taskId,
      status: 'failed',
      summary: 'Auto-dream failed',
      output_file: '',
      session_id: 'dream-task-sdk-events',
    }))
  })

  test('emits a terminal SDK bookend when auto-dream is stopped', async () => {
    const harness = makeTaskHarness()
    const taskId = registerDreamTask(harness.setAppState, {
      sessionsReviewing: 5,
      priorMtime: 0,
      abortController: new AbortController(),
    })
    drainSdkEvents()

    await DreamTask.kill(taskId, harness.setAppState)

    expect(drainSdkEvents()).toContainEqual(expect.objectContaining({
      type: 'system',
      subtype: 'task_notification',
      task_id: taskId,
      status: 'stopped',
      summary: 'Auto-dream stopped',
      output_file: '',
      session_id: 'dream-task-sdk-events',
    }))
  })
})
