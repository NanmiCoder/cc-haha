import { expect, test } from 'bun:test'
import { translateCliMessage, updateSessionSlashCommands } from '../ws/handler.js'

test('keeps native frame provenance through streaming and retracts exact identities', () => {
  const session = 'fixture-sdk-provenance'
  const output = translateCliMessage({ type: 'assistant', uuid: 'wire-id', cc_haha_message_ids: ['wire-id', 'block-id'],
    message: { content: [{ type: 'text', text: 'partial' }] } }, session)
  expect(output).toEqual([
    { type: 'content_start', blockType: 'text', nativeMessageIds: ['wire-id', 'block-id'] },
    { type: 'content_delta', text: 'partial', nativeMessageIds: ['wire-id', 'block-id'] },
  ])
  expect(translateCliMessage({ type: 'system', subtype: 'official_sdk_messages_retracted', ids: ['wire-id', 'block-id'],
    edit: { text: 'original prompt', uuid: 'human' } }, session)).toEqual([
    { type: 'system_notification', subtype: 'official_sdk_messages_retracted',
      data: { ids: ['wire-id', 'block-id'], edit: { text: 'original prompt', uuid: 'human' } } },
  ])
})

test('retains native task patches, reset and empty command-list replacement', () => {
  const session = 'fixture-sdk-events'
  updateSessionSlashCommands(session, [{ name: 'old' }], { notifyClient: false })
  for (const frame of [
    { type: 'system', subtype: 'commands_changed', commands: [] },
    { type: 'conversation_reset', new_conversation_id: 'next', reason: 'plan_mode_exit' },
    { type: 'system', subtype: 'task_updated', task_id: 'agent', run_id: '2', patch: { status: 'paused' } },
    { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
  ]) {
    expect(translateCliMessage({ ...frame, cc_haha_agent_sdk: true }, session)).toEqual([
      expect.objectContaining({ type: 'system_notification', data: expect.objectContaining({ ...frame, official_agent_sdk: true }) }),
    ])
  }
})
