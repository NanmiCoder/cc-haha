import { describe, expect, test } from 'bun:test'
import { StreamAssistantCommitBuffer } from './streamAssistantCommitBuffer.js'

function assistant(uuid: string) {
  return {
    type: 'assistant' as const,
    uuid,
    message: { role: 'assistant' as const, content: [] },
  }
}

describe('StreamAssistantCommitBuffer', () => {
  test('holds side-effect-free blocks until the stream completes', () => {
    const buffer = new StreamAssistantCommitBuffer<ReturnType<typeof assistant>>()
    const thinking = assistant('thinking')
    const text = assistant('text')

    expect(buffer.add(thinking, 'thinking')).toEqual([])
    expect(buffer.add(text, 'text')).toEqual([])
    expect(buffer.flush()).toEqual([thinking, text])
  })

  test('commits buffered blocks with the first local tool boundary', () => {
    const buffer = new StreamAssistantCommitBuffer<ReturnType<typeof assistant>>()
    const thinking = assistant('thinking')
    const tool = assistant('tool')

    expect(buffer.add(thinking, 'thinking')).toEqual([])
    expect(buffer.add(tool, 'tool_use')).toEqual([thinking, tool])
    expect(buffer.add(assistant('after-tool'), 'text')).toEqual([
      expect.objectContaining({ uuid: 'after-tool' }),
    ])
    expect(buffer.flush()).toEqual([])
  })

  test('treats server tools as an irreversible boundary', () => {
    const buffer = new StreamAssistantCommitBuffer<ReturnType<typeof assistant>>()
    const serverTool = assistant('server-tool')

    expect(buffer.add(serverTool, 'server_tool_use')).toEqual([serverTool])
    expect(buffer.hasCrossedSideEffectBoundary()).toBe(true)
  })

  test('can defer tool blocks until the response stop reason is known', () => {
    const buffer = new StreamAssistantCommitBuffer<ReturnType<typeof assistant>>({
      deferToolUseCommit: true,
    })
    const thinking = assistant('thinking')
    const tool = assistant('tool')

    expect(buffer.add(thinking, 'thinking')).toEqual([])
    expect(buffer.add(tool, 'tool_use')).toEqual([])
    expect(buffer.hasCrossedSideEffectBoundary()).toBe(true)
    expect(buffer.flushWithoutToolUse()).toEqual([thinking])
    expect(buffer.flush()).toEqual([])
  })
})
