import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionService } from './sessionService.js'
import * as handler from '../ws/handler.js'
import * as catalog from './sessionModelCatalog.js'
import { emitSessionTurnEvent } from './sessionTurnEvents.js'
import { executeScheduledSessionTask } from './scheduledTaskHost.js'
import { reportScheduledTaskNotificationDecision } from './scheduledTaskNotificationDecision.js'
import type { ScheduledSessionTaskInput } from './scheduledTaskExecution.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scheduled-host-'))
  spyOn(sessionService, 'getSessionSummary').mockResolvedValue({ id: 'target' } as any)
  spyOn(sessionService, 'getSessionWorkDir').mockResolvedValue(dir)
  spyOn(handler, 'getCollaborationRuntime').mockResolvedValue({ providerId: 'fixture', modelId: 'fixture-model' })
  spyOn(handler, 'getSessionTurnState').mockReturnValue('idle')
  spyOn(catalog, 'validateSessionRuntime').mockImplementation(async runtime => runtime)
})
afterEach(async () => { mock.restore(); await rm(dir, { recursive: true, force: true }) })

function input(): ScheduledSessionTaskInput {
  return {
    task: { id: 'task', name: 'Check', cron: '0 9 * * *', prompt: 'Check status', createdAt: 1, enabled: true, execution: { kind: 'session', targetSessionId: 'target' }, notificationPolicy: 'important' },
    runId: 'run', occurrenceId: 'occurrence', scheduledFor: '2026-10-26T01:00:00Z', signal: new AbortController().signal, canSend: async () => true,
  }
}
const endpoint = { serverHost: '127.0.0.1', serverPort: 1234 }
function consumed() {
  emitSessionTurnEvent({ type: 'output', sessionId: 'target', message: { type: 'system', subtype: 'session_message_receipt', message_id: 'occurrence', status: 'consumed' } })
}

test('scheduled host accepts only its receipt and root result and retains the notification decision', async () => {
  const resolved = mock(async () => {})
  const deliver = spyOn(handler, 'submitScheduledTaskTurn').mockImplementation(async (id, _content, options) => {
    expect(options.scheduledTask).toMatchObject({ taskId: 'task', runId: 'run' })
    expect(options.messageId).toBe('occurrence')
    emitSessionTurnEvent({ type: 'output', sessionId: id, message: { type: 'result', is_error: false, result: 'stale result' } })
    consumed()
    emitSessionTurnEvent({ type: 'output', sessionId: id, message: { type: 'result', parent_tool_use_id: 'child', is_error: false, result: 'nested result' } })
    reportScheduledTaskNotificationDecision('run', id, 'silent')
    emitSessionTurnEvent({ type: 'output', sessionId: id, message: { type: 'result', is_error: false, result: 'No change' } })
    return { status: 'queued' }
  })
  expect(await executeScheduledSessionTask({ ...input(), onSessionResolved: resolved }, endpoint)).toEqual({ status: 'completed', sessionId: 'target', output: 'No change', notificationDecision: 'silent' })
  expect(resolved).toHaveBeenCalledWith('target')
  expect(deliver).toHaveBeenCalledTimes(1)
  expect(() => reportScheduledTaskNotificationDecision('run', 'target', 'notify')).toThrow()
})

test('removed targets and invalid runtime never silently fall back to a new conversation', async () => {
  const send = spyOn(handler, 'submitScheduledTaskTurn')
  spyOn(sessionService, 'getSessionSummary').mockResolvedValue(null)
  expect(await executeScheduledSessionTask(input(), endpoint)).toMatchObject({ status: 'failed', error: 'Scheduled task target session no longer exists' })
  expect(send).not.toHaveBeenCalled()
})

test('a revoked task is not delivered and an already-consumed task is not replayed', async () => {
  const send = spyOn(handler, 'submitScheduledTaskTurn').mockResolvedValue({ status: 'consumed' })
  expect(await executeScheduledSessionTask({ ...input(), canSend: async () => false }, endpoint)).toMatchObject({ status: 'failed' })
  expect(send).not.toHaveBeenCalled()
  expect(await executeScheduledSessionTask(input(), endpoint)).toMatchObject({ status: 'failed', sessionId: 'target', error: expect.stringContaining('already delivered') })
  expect(send).toHaveBeenCalledTimes(1)
})

test('a stop terminates this run without interpreting the next user result', async () => {
  spyOn(handler, 'submitScheduledTaskTurn').mockImplementation(async () => {
    consumed()
    emitSessionTurnEvent({ type: 'stopped', sessionId: 'target' })
    emitSessionTurnEvent({ type: 'output', sessionId: 'target', message: { type: 'result', is_error: false, result: 'next user result' } })
    return { status: 'queued' }
  })
  expect(await executeScheduledSessionTask(input(), endpoint)).toMatchObject({ status: 'failed', error: expect.stringContaining('stopped') })
})

test('aborting after queue acceptance cancels this delivery before a consumed receipt', async () => {
  const controller = new AbortController()
  const stop = spyOn(handler, 'stopScheduledTaskTurn').mockImplementation(() => {
    emitSessionTurnEvent({ type: 'stopped', sessionId: 'target' })
  })
  spyOn(handler, 'submitScheduledTaskTurn').mockImplementation(async () => {
    queueMicrotask(() => controller.abort())
    return { status: 'queued' }
  })
  expect(await executeScheduledSessionTask({ ...input(), signal: controller.signal }, endpoint)).toMatchObject({ status: 'timeout' })
  expect(stop).toHaveBeenCalledWith('target', 'occurrence')
})

test('a new scheduled conversation inherits source permissions and records its runtime before delivery', async () => {
  spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue({ workDir: dir, permissionMode: 'default' } as any)
  const runtime = { providerId: 'fixture', modelId: 'fixture-model' }
  spyOn(catalog, 'resolveSessionRuntime').mockResolvedValue(runtime)
  const create = spyOn(sessionService, 'createSession').mockResolvedValue({ sessionId: 'target', workDir: dir } as any)
  const metadata = spyOn(sessionService, 'appendSessionMetadata').mockResolvedValue(undefined)
  spyOn(handler, 'submitScheduledTaskTurn').mockImplementation(async () => {
    expect(metadata).toHaveBeenCalledWith('target', expect.objectContaining({ permissionMode: 'default', runtimeProviderId: 'fixture', runtimeModelId: 'fixture-model' }))
    consumed()
    emitSessionTurnEvent({ type: 'output', sessionId: 'target', message: { type: 'result', is_error: false, result: 'Finished' } })
    return { status: 'queued' }
  })
  const request = input()
  request.task = { ...request.task, sourceSessionId: 'source', execution: { kind: 'new-session' }, permissionMode: 'bypassPermissions' }
  expect(await executeScheduledSessionTask(request, endpoint)).toMatchObject({ status: 'completed', sessionId: 'target' })
  expect(create).toHaveBeenCalledWith(dir, undefined, 'default')
})

test('a human turn starting during target validation delays delivery without consuming its result', async () => {
  let busy = true
  spyOn(handler, 'getSessionTurnState').mockImplementation(() => busy ? 'running' : 'idle')
  const send = spyOn(handler, 'submitScheduledTaskTurn').mockImplementation(async () => {
    expect(busy).toBe(false)
    consumed()
    emitSessionTurnEvent({ type: 'output', sessionId: 'target', message: { type: 'result', is_error: false, result: 'Scheduled result' } })
    return { status: 'queued' }
  })
  const execution = executeScheduledSessionTask(input(), endpoint)
  await Bun.sleep(20)
  expect(send).not.toHaveBeenCalled()
  emitSessionTurnEvent({ type: 'stopped', sessionId: 'target' })
  emitSessionTurnEvent({ type: 'output', sessionId: 'target', message: { type: 'result', is_error: false, result: 'Human result' } })
  busy = false
  expect(await execution).toMatchObject({ status: 'completed', output: 'Scheduled result' })
})

test('cancelling while waiting for a human turn never interrupts that turn', async () => {
  spyOn(handler, 'getSessionTurnState').mockReturnValue('running')
  const send = spyOn(handler, 'submitScheduledTaskTurn')
  const stop = spyOn(handler, 'stopScheduledTaskTurn')
  const controller = new AbortController()
  const execution = executeScheduledSessionTask({ ...input(), signal: controller.signal }, endpoint)
  await Bun.sleep(20)
  controller.abort(new Error('Task timed out'))
  expect(await execution).toMatchObject({ status: 'timeout', error: 'Task timed out' })
  expect(send).not.toHaveBeenCalled()
  expect(stop).not.toHaveBeenCalled()
})
