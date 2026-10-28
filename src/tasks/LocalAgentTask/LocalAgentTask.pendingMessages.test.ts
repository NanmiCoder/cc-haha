import { expect, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { createTaskStateBase } from '../../Task.js'
import { createUserMessage } from '../../utils/messages.js'
import { registerTask } from '../../utils/task/framework.js'
import { drainPendingAgentMessages, drainPendingMessages, queuePendingMessage, type LocalAgentTaskState } from './LocalAgentTask.js'

function harness(...ids: string[]) {
  const tasks = Object.fromEntries(ids.map(id => [id, {
    ...createTaskStateBase(id, 'local_agent', 'Inspect the fixture'),
    type: 'local_agent', status: 'running', agentId: id, agentType: 'general-purpose',
    prompt: 'Inspect the fixture', retrieved: false, lastReportedToolCount: 0,
    lastReportedTokenCount: 0, isBackgrounded: true, pendingMessages: [], retain: false, diskLoaded: false,
  } satisfies LocalAgentTaskState]))
  let state: AppState = { ...getDefaultAppState(), tasks }
  const getAppState = () => state
  const setAppState = (update: (value: typeof state) => typeof state) => { state = update(state) }
  return { getAppState, setAppState, task: (id: string) => state.tasks[id] as LocalAgentTaskState }
}

test('duplicate message text keeps each selection in order, including empty and legacy entries', () => {
  const state = harness('worker')
  const first = [createUserMessage({ content: '$first' })]
  const second = [createUserMessage({ content: '$second' })]
  queuePendingMessage('worker', 'Continue.', state.setAppState)
  queuePendingMessage('worker', 'Continue.', state.setAppState, first)
  queuePendingMessage('worker', 'Continue.', state.setAppState, [])
  queuePendingMessage('worker', 'Continue.', state.setAppState, second)
  first.push(createUserMessage({ content: '$not-part-of-the-queued-request' }))
  const drained = drainPendingAgentMessages('worker', state.getAppState, state.setAppState)
  expect(drained.map(entry => entry.message)).toEqual(Array(4).fill('Continue.'))
  expect(drained.map(entry => entry.skillSelectionMessages?.map(message => message.uuid))).toEqual([
    undefined, [first[0]!.uuid], [], [second[0]!.uuid],
  ])
  expect(state.task('worker').pendingMessages).toEqual([])
  queuePendingMessage('worker', 'Next.', state.setAppState)
  expect(drainPendingAgentMessages('worker', state.getAppState, state.setAppState)).toEqual([
    { message: 'Next.', skillSelectionMessages: undefined },
  ])
})

test('interleaved callers keep authorization attached to the addressed worker', () => {
  const state = harness('alpha', 'beta')
  const alpha = [createUserMessage({ content: '$alpha' })]
  const beta = [createUserMessage({ content: '$beta' })]
  queuePendingMessage('alpha', 'Continue.', state.setAppState, alpha)
  queuePendingMessage('beta', 'Continue.', state.setAppState, beta)
  queuePendingMessage('alpha', 'Then inspect tests.', state.setAppState, [])
  expect(drainPendingAgentMessages('beta', state.getAppState, state.setAppState)).toEqual([
    { message: 'Continue.', skillSelectionMessages: beta },
  ])
  expect(drainPendingAgentMessages('alpha', state.getAppState, state.setAppState)).toEqual([
    { message: 'Continue.', skillSelectionMessages: alpha },
    { message: 'Then inspect tests.', skillSelectionMessages: [] },
  ])
})

test('task replacement keeps the existing queue and its runtime selection metadata', () => {
  const state = harness('worker')
  const selection = [createUserMessage({ content: '$review' })]
  queuePendingMessage('worker', 'Continue.', state.setAppState, selection)
  registerTask({ ...state.task('worker'), pendingMessages: [] }, state.setAppState)
  expect(drainPendingAgentMessages('worker', state.getAppState, state.setAppState)).toEqual([
    { message: 'Continue.', skillSelectionMessages: selection },
  ])
})

test('authorization has no JSON representation and old string-only queues still drain', () => {
  const state = harness('worker')
  queuePendingMessage('worker', 'Continue.', state.setAppState, [createUserMessage({ content: '$private-selection-marker' })])
  const serialized = JSON.stringify(state.task('worker'))
  expect(serialized).not.toContain('private-selection-marker')
  expect(serialized).not.toContain('skillSelection')
  const restored = JSON.parse(serialized)
  expect(restored.pendingMessages).toEqual(['Continue.'])
  state.setAppState(previous => ({ ...previous, tasks: { worker: restored } }))
  expect(drainPendingAgentMessages('worker', state.getAppState, state.setAppState)).toEqual([
    { message: 'Continue.', skillSelectionMessages: undefined },
  ])
})

test('the original string queue API stays unchanged and needs no authorization metadata', () => {
  const state = harness('worker')
  queuePendingMessage('worker', 'Continue.', state.setAppState)
  expect(Object.getOwnPropertySymbols(state.task('worker').pendingMessages)).toEqual([])
  expect(drainPendingMessages('worker', state.getAppState, state.setAppState)).toEqual(['Continue.'])
  expect(drainPendingMessages('worker', state.getAppState, state.setAppState)).toEqual([])
  expect(drainPendingAgentMessages('absent', state.getAppState, state.setAppState)).toEqual([])
})
