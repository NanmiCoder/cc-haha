import { expect, test } from 'bun:test'
import { prepareLegacyAgentSdkImport } from './officialAgentSdkImport.js'

function entry(type: 'user' | 'assistant', uuid: string, parentUuid: string | null, content: unknown) {
  return { type, uuid, parentUuid, sessionId: 'child', cwd: '/fixture', timestamp: '2026-01-01T00:00:00Z',
    forkedFrom: { sessionId: 'original', messageUuid: `old-${uuid}` }, message: { role: type, content } }
}

test('legacy import keeps portable conversation and complete historical tool evidence, stripping signatures and runtime attachments', () => {
  const source = [
    entry('user', 'u', null, [{ type: 'text', text: 'Investigate' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fixture' } }]),
    { type: 'attachment', uuid: 'a', parentUuid: 'u', attachment: { type: 'queued_command', prompt: 'DO_NOT_REPLAY' } },
    entry('assistant', 't', 'a', [{ type: 'thinking', thinking: 'private', signature: 'provider-only' }, { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/fixture/a.txt' } }]),
    entry('user', 'r', 't', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'historical file contents' }]),
    entry('assistant', 'done', 'r', [{ type: 'text', text: 'Done' }]),
    { type: 'custom-title', customTitle: 'Original (Agent SDK)' },
    { type: 'mode', mode: 'bypassPermissions' },
  ]
  const before = JSON.stringify(source)
  const result = prepareLegacyAgentSdkImport(source)
  expect(JSON.stringify(source)).toBe(before)
  expect(result.map(item => item.type)).toEqual(['user', 'assistant', 'user', 'assistant', 'custom-title'])
  expect(result[1].parentUuid).toBe('u')
  expect(JSON.stringify(result)).not.toMatch(/DO_NOT_REPLAY|provider-only|bypassPermissions/)
  expect(JSON.stringify(result)).toContain('historical file contents')
  expect(result[0].forkedFrom).toEqual({ sessionId: 'original', messageUuid: 'old-u' })
})

test('legacy import rejects partial tools, orphan results, unsupported content and broken chains before publication', () => {
  const invalid = [
    [entry('assistant', 'a', null, [{ type: 'tool_use', id: 't', name: 'Write', input: {} }])],
    [entry('user', 'a', null, [{ type: 'tool_result', tool_use_id: 'missing', content: 'x' }])],
    [entry('user', 'a', null, [{ type: 'runtime_private', payload: 'x' }])],
    [entry('user', 'a', 'absent', 'hello')],
    [entry('user', 'a', 'a', 'hello')],
  ]
  for (const source of invalid) expect(() => prepareLegacyAgentSdkImport(source)).toThrow('Cannot copy this history')
})

test('legacy import follows the selected compacted conversation chain and does not revive obsolete leaves', () => {
  const result = prepareLegacyAgentSdkImport([
    entry('user', 'obsolete', null, 'obsolete branch'),
    { type: 'system', subtype: 'compact_boundary', uuid: 'compact', parentUuid: null },
    entry('user', 'summary', 'compact', 'compacted context'),
    entry('assistant', 'current', 'summary', 'current reply'),
  ])
  expect(result.map(item => item.uuid)).toEqual(['summary', 'current'])
  expect(result[0].parentUuid).toBeNull()
})
