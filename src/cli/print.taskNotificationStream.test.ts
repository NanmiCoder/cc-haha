import { afterEach, beforeEach, expect, test } from 'bun:test'
import { asAgentId } from '../types/ids.js'
import { getIsInteractive, setIsInteractive } from '../bootstrap/state.js'
import { clearCommandQueue, dequeue, enqueuePendingNotification, getCommandQueue, recheckCommandQueue } from '../utils/messageQueueManager.js'
import { drainSdkEvents, enqueueSdkEvent } from '../utils/sdkEventQueue.js'
import { bindBackgroundTaskNotifications } from './print.js'
import { StructuredIO } from './structuredIO.js'

async function* emptyInput(): AsyncGenerator<string> {}
let wasInteractive = true
beforeEach(() => {
  wasInteractive = getIsInteractive()
  setIsInteractive(false)
  clearCommandQueue()
  drainSdkEvents()
})
afterEach(() => {
  clearCommandQueue()
  drainSdkEvents()
  setIsInteractive(wasInteractive)
})
const terminal = (id: string) => `<task-notification><task-id>${id}</task-id><status>completed</status><summary>Check passed</summary></task-notification>`

test('streams already queued and new terminals in lifecycle order while preserving model commands exactly once', async () => {
  const io = new StructuredIO(emptyInput())
  enqueueSdkEvent({ type: 'system', subtype: 'task_started', task_id: 'existing', description: 'Check' })
  enqueuePendingNotification({ mode: 'task-notification', value: terminal('existing') })
  const binding = bindBackgroundTaskNotifications(io)
  try {
    enqueueSdkEvent({ type: 'system', subtype: 'task_started', task_id: 'new', description: 'Check' })
    enqueuePendingNotification({ mode: 'task-notification', value: terminal('new') })
    recheckCommandQueue()
    expect(getCommandQueue()).toHaveLength(2)
    for (const id of ['existing', 'new']) {
      const command = dequeue()!
      expect(command.value).toBe(terminal(id))
      binding.publish(command)
    }
    binding.unsubscribe()
    io.outbound.done()
    const events = []
    for await (const event of io.outbound) events.push(event)
    expect(events.map(event => [event.type === 'system' ? event.subtype : event.type, 'task_id' in event ? event.task_id : undefined])).toEqual([
      ['task_started', 'existing'], ['task_notification', 'existing'],
      ['task_started', 'new'], ['task_notification', 'new'],
    ])
  } finally { binding.unsubscribe() }
})

test('ignores progress and child-owned commands, and stops observing after disposal', async () => {
  const io = new StructuredIO(emptyInput())
  const binding = bindBackgroundTaskNotifications(io)
  try {
    enqueuePendingNotification({ mode: 'task-notification', value: terminal('child'), agentId: asAgentId('child-agent') })
    enqueuePendingNotification({ mode: 'task-notification', value: '<task-notification><task-id>progress</task-id><summary>Still working</summary></task-notification>' })
    enqueuePendingNotification({ mode: 'prompt', value: terminal('user-text') })
    binding.unsubscribe()
    enqueuePendingNotification({ mode: 'task-notification', value: terminal('after-disposal') })
    io.outbound.done()
    const events = []
    for await (const event of io.outbound) events.push(event)
    expect(events).toEqual([])
    expect(getCommandQueue()).toHaveLength(4)
  } finally { binding.unsubscribe() }
})
