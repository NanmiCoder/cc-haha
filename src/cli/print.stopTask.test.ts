import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getIsInteractive, setIsInteractive } from '../bootstrap/state.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { AppState } from '../state/AppState.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { Stream } from '../utils/stream.js'
import { __runHeadlessStreamingForTests } from './print.js'
import { StructuredIO } from './structuredIO.js'

function startHeadless(input: Stream<string>, tasks: AppState['tasks']) {
  const io = new StructuredIO(input)
  let appState = { ...getDefaultAppState(), tasks }
  const output = __runHeadlessStreamingForTests(
    io,
    [],
    [],
    [],
    [],
    (() => undefined) as unknown as CanUseToolFn,
    {},
    () => appState,
    update => {
      appState = update(appState)
    },
    [],
    { outputFormat: 'stream-json' },
  )
  return { io, output, getState: () => appState }
}

async function nextControlResponse(output: AsyncIterable<unknown>) {
  for await (const message of output) {
    if ((message as { type?: string }).type === 'control_response') return message
  }
  throw new Error('Missing control response')
}

describe('stop_task control request', () => {
  let wasInteractive = true

  beforeEach(() => {
    wasInteractive = getIsInteractive()
    setIsInteractive(false)
  })

  afterEach(() => {
    setIsInteractive(wasInteractive)
  })

  test('answers an unknown task id with an idempotent not_found success', async () => {
    const input = new Stream<string>()
    const { output } = startHeadless(input, {})
    input.enqueue(
      `${JSON.stringify({
        type: 'control_request',
        request_id: 'stop-unknown',
        request: { subtype: 'stop_task', task_id: 'b3e0jw079' },
      })}\n`,
    )

    // UI Stop buttons lag the task registry: shell tasks are evicted the turn
    // after they terminate. not_found means the stop's goal state already
    // holds, so the wire answer is success — never "No task found with ID".
    await expect(nextControlResponse(output)).resolves.toMatchObject({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'stop-unknown',
        response: { stopped: false, reason: 'not_found' },
      },
    })
    input.done()
  })

  test('keeps erroring when the task exists but is not running', async () => {
    const input = new Stream<string>()
    const { output } = startHeadless(input, {
      'finished-task': {
        id: 'finished-task',
        type: 'local_bash',
        status: 'completed',
        description: 'Watch the release build',
        toolUseId: 'bash-tool-1',
        startTime: 1,
        outputFile: '/tmp/finished-task.output',
        outputOffset: 0,
        notified: true,
        completionStatusSentInAttachment: true,
        lastReportedTotalLines: 0,
        isBackgrounded: true,
      } as unknown as AppState['tasks'][string],
    })
    input.enqueue(
      `${JSON.stringify({
        type: 'control_request',
        request_id: 'stop-finished',
        request: { subtype: 'stop_task', task_id: 'finished-task' },
      })}\n`,
    )

    await expect(nextControlResponse(output)).resolves.toMatchObject({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: 'stop-finished',
        error: 'Task finished-task is not running (status: completed)',
      },
    })
    input.done()
  })
})
