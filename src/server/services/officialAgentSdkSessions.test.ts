import { expect, test } from 'bun:test'
import { officialAgentSdkRewindFilter } from './officialAgentSdkSessions.js'

test('native rewind keeps preceding hidden chain records and settings while removing every later turn record and checkpoint', () => {
  const entries = [
    { type: 'session-meta', runtimeProviderId: 'sdk-fixture' },
    { type: 'user', uuid: 'first' },
    { type: 'attachment', uuid: 'hidden-before', parentUuid: 'first' },
    { type: 'system', subtype: 'compact_boundary', uuid: 'compact-before', parentUuid: null },
    { type: 'assistant', uuid: 'reply' },
    { type: 'file-history-snapshot', messageId: 'first', snapshot: { messageId: 'first' } },
    { type: 'user', uuid: 'removed' },
    { type: 'assistant', uuid: 'tool-carrier', parentUuid: 'removed' },
    { type: 'attachment', uuid: 'hidden-after', parentUuid: 'tool-carrier' },
    { type: 'progress', uuid: 'progress-after', parentUuid: 'hidden-after' },
    { type: 'system', subtype: 'compact_boundary', uuid: 'compact-after', parentUuid: null },
    { type: 'file-history-snapshot', messageId: 'removed', snapshot: { messageId: 'removed' } },
    { type: 'summary', leafUuid: 'compact-after' },
    { type: 'last-prompt', leafUuid: 'tool-carrier', lastPrompt: 'discarded prompt' },
    { type: 'custom-title', customTitle: 'latest title' },
    { type: 'session-meta', effortLevel: 'high', extension: { preserve: true } },
  ]
  const keep = officialAgentSdkRewindFilter(entries, 'removed')
  expect(entries.filter(keep)).toEqual([...entries.slice(0, 6), ...entries.slice(14)])
})

test('native rewind refuses a missing boundary without returning a destructive filter', () => {
  expect(() => officialAgentSdkRewindFilter([{ type: 'user', uuid: 'first' }], 'absent')).toThrow('boundary is missing')
})
