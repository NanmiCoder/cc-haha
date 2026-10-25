import { expect, test } from 'bun:test'
import { buildComposerMessage } from './chatComposer'
import {
  clearPendingTask,
  peekPendingTask,
  pendingTaskDraft,
  putPendingTask,
} from './pendingTask'

test('new-task handoff stays isolated by host and session and survives a failed send', () => {
  putPendingTask('a', 'same', {
    content: 'A',
    attachments: [],
    runtime: { providerId: 'p', modelId: 'm' },
  })
  putPendingTask('b', 'same', { content: 'B', attachments: [] })
  expect(peekPendingTask('a', 'same')?.content).toBe('A')
  expect(peekPendingTask('a', 'other')).toBeUndefined()
  expect(peekPendingTask('a', 'same')?.runtime?.modelId).toBe('m')
  clearPendingTask('a', 'same')
  expect(peekPendingTask('a', 'same')).toBeUndefined()
  expect(peekPendingTask('b', 'same')?.content).toBe('B')
  clearPendingTask('b', 'same')
})

test('handoff snapshots the submitted draft instead of following later form edits', () => {
  const task = {
    content: 'first',
    runtime: { providerId: 'p', modelId: 'one' },
    attachments: [
      {
        id: '1',
        type: 'file' as const,
        name: 'note.txt',
        data: 'YQ==',
        bytes: 1,
      },
    ],
  }
  putPendingTask('host', 'session', task)
  task.runtime.modelId = 'two'
  task.attachments[0].name = 'changed.txt'
  expect(peekPendingTask('host', 'session')?.runtime?.modelId).toBe('one')
  expect(peekPendingTask('host', 'session')?.attachments[0].name).toBe(
    'note.txt'
  )
  clearPendingTask('host', 'session')
})

test('a team task keeps its marker for sending but drafts only the user text', () => {
  const team = buildComposerMessage('拆成三个人做', [], true).content
  putPendingTask('host', 'team', { content: team, attachments: [] })
  const task = peekPendingTask('host', 'team')!
  expect(task.content).toBe(team)
  expect(buildComposerMessage(task.content, [], false).content).toBe(team)
  expect(pendingTaskDraft(task)).toEqual({ text: '拆成三个人做', team: true })
  expect(pendingTaskDraft({ content: '普通任务', attachments: [] })).toEqual({
    text: '普通任务',
    team: false,
  })
  clearPendingTask('host', 'team')
})
