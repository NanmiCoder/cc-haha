import { expect, test } from 'bun:test'
import { createOfficialAgentSdkMessageIdentity } from './officialAgentSdkMessageIdentity.js'

test('retracts exact normalized blocks, tool results, and duplicate notices without retracting siblings', () => {
  const identity = createOfficialAgentSdkMessageIdentity()
  const stream = (event: object) => identity.observe({ type: 'stream_event', event })
  stream({ type: 'message_start', message: { id: 'api' } })
  const first = stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })!
  stream({ type: 'content_block_delta', index: 0, delta: { text: 'kept' } })
  const second = stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'withdrawn' } })!
  identity.observe({ type: 'assistant', uuid: 'u1', message: { id: 'api', content: [{ type: 'text', text: 'kept' }] } })
  identity.observe({ type: 'assistant', uuid: 'u2', message: { id: 'api', content: [{ type: 'text', text: 'withdrawn' }] } })
  identity.observe({ type: 'user', uuid: 'result', message: { content: [{ type: 'tool_result', tool_use_id: 'tool' }] } })
  expect(identity.expand(['u2', 'result', 'u2'])).toEqual(['u2', ...second, 'result'])
  expect(identity.expand(['u2'])).not.toContain(first[0]!)
  expect(identity.expand(['unknown'])).toEqual(['unknown'])
})

test('scopes simultaneous child streams and associates tools by identity', () => {
  const identity = createOfficialAgentSdkMessageIdentity()
  for (const scope of ['', 'child']) {
    identity.observe({ type: 'stream_event', parent_tool_use_id: scope, event: { type: 'message_start', message: { id: 'api' } } })
    identity.observe({ type: 'stream_event', parent_tool_use_id: scope, event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool', name: 'Read' } } })
  }
  const child = identity.observe({ type: 'assistant', uuid: 'child-uuid', parent_tool_use_id: 'child', message: { id: 'api', content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: {} }] } })
  expect(child).toEqual(['child-uuid', 'sdk-block:["child","api"]:0'])
  expect(identity.observe({ type: 'assistant', uuid: 'child-uuid' })).toEqual(child)
})
