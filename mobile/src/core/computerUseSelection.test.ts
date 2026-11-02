import { expect, test } from 'bun:test'
import { appendPendingUserMessage, chatReducer, createChatState, normalizeHistory } from './chat'
import { buildComposerMessage } from './chatComposer'
import { serializeComposer } from './composerReferences'
import { computerUseReference, isComputerUseReference, withComputerUseReference } from './computerUse'
import { clearPendingTask, peekPendingTask, putPendingTask } from './pendingTask'
import { clearParkedComposer, withdrawQueuedComposer } from '../ui/chat/queue'

test('computer-use is an ordinary deduplicated skill reference that survives send, replay and reopened history', () => {
  const references = withComputerUseReference([], true)
  expect(withComputerUseReference(references, true)).toHaveLength(1)
  expect(withComputerUseReference(references, false)).toEqual([])
  expect(isComputerUseReference({ kind: 'plugin', id: 'computer-use' })).toBe(false)
  const message = buildComposerMessage(serializeComposer('检查页面', references), [], true)
  expect(message.content).toContain(computerUseReference.modelText)
  const live = appendPendingUserMessage(createChatState('fixture'), message.content)
  const replayed = chatReducer(live, { type: 'user_message_replay', content: message.content })
  expect(replayed.items).toHaveLength(1)
  expect(replayed.items[0].text).toBe(message.content)
  const reopened = normalizeHistory([{ id: 'saved', type: 'user', content: [{ type: 'text', text: message.content }], timestamp: '' }])
  expect(reopened[0].text).toBe(message.content)
})

test('queue withdrawal and new-task handoff keep the per-message computer selection without adding persisted state', () => {
  const references = withComputerUseReference([], true)
  const message = buildComposerMessage(serializeComposer('稍后检查', references), [], false)
  const current = { queue: [{ id: 'queued', text: '稍后检查', attachments: [], team: false, references, message }], draft: '', attachments: [], team: false, references: [] }
  const restored = withdrawQueuedComposer('computer-fixture', current, new Map())
  expect(restored.queue).toEqual([])
  expect(restored.references).toEqual(references)
  expect(restored.draft).toBe('稍后检查')
  clearParkedComposer('computer-fixture')
  putPendingTask('fixture-host', 'fixture-session', { content: message.content, displayText: '稍后检查', references, attachments: [] })
  const handoff = peekPendingTask('fixture-host', 'fixture-session')!
  expect(handoff.references).toEqual(references)
  expect(buildComposerMessage(handoff.content, handoff.attachments, false).content).toBe(message.content)
  clearPendingTask('fixture-host', 'fixture-session')
})
