import { afterEach, expect, spyOn, test } from 'bun:test'
import type { ToolUseContext } from '../../../Tool.js'
import * as mailbox from '../../teammateMailbox.js'
import { InProcessBackend } from './InProcessBackend.js'

let restore: (() => void) | undefined
afterEach(() => {
  restore?.()
  restore = undefined
})

test('a message or shutdown request the inbox did not take is reported instead of assumed sent', async () => {
  const write = spyOn(mailbox, 'writeToMailbox').mockResolvedValue(false)
  restore = () => write.mockRestore()
  const backend = new InProcessBackend()

  await expect(
    backend.sendMessage('worker@review', {
      from: 'team-lead',
      text: 'Please re-check the parser',
      timestamp: new Date().toISOString(),
    }),
  ).rejects.toThrow("Failed to write to worker's inbox")

  const task = {
    id: 'task-1',
    type: 'in_process_teammate',
    status: 'running',
    shutdownRequested: false,
    identity: { agentId: 'worker@review', agentName: 'worker', teamName: 'review' },
  }
  let shutdownMarked = false
  backend.setContext({
    getAppState: () => ({ tasks: { [task.id]: task } }),
    setAppState: () => {
      shutdownMarked = true
    },
  } as unknown as ToolUseContext)

  expect(await backend.terminate('worker@review', 'Review complete')).toBe(false)
  // Nothing was delivered, so the teammate is not marked as shutting down.
  expect(shutdownMarked).toBe(false)
  expect(write).toHaveBeenCalledTimes(2)
})
