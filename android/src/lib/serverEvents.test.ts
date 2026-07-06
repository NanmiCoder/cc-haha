import { describe, expect, it } from 'bun:test'
import {
  buildPermissionResponsePayload,
  buildUserMessagePayload,
  groupSessionsByProject,
  reduceServerEvent,
  type RemoteMessageState,
} from './serverEvents'

describe('mobile server event adapter', () => {
  it('sends user text with the desktop websocket protocol', () => {
    expect(buildUserMessagePayload(' hello ')).toEqual({
      type: 'user_message',
      content: 'hello',
    })
  })

  it('accumulates streamed content_delta events into one assistant message', () => {
    const initial: RemoteMessageState = { messages: [], streamingAssistantId: null, sending: true, pendingPermission: null }

    const first = reduceServerEvent(initial, { type: 'content_delta', text: 'Hello' }, () => 'assistant-1')
    const second = reduceServerEvent(first, { type: 'content_delta', text: ' world' }, () => 'assistant-2')
    const done = reduceServerEvent(second, { type: 'message_complete', usage: { input_tokens: 1, output_tokens: 2 } }, () => 'unused')

    expect(done.messages).toEqual([
      {
        id: 'assistant-1',
        type: 'assistant',
        content: 'Hello world',
        timestamp: expect.any(String),
      },
    ])
    expect(done.streamingAssistantId).toBeNull()
    expect(done.sending).toBe(false)
  })

  it('stores permission requests and builds permission responses', () => {
    const initial: RemoteMessageState = { messages: [], streamingAssistantId: null, sending: true, pendingPermission: null }
    const next = reduceServerEvent(initial, {
      type: 'permission_request',
      requestId: 'perm-1',
      toolName: 'Edit',
      input: { file_path: 'src/app.ts' },
      description: 'Allow Edit to modify src/app.ts?',
    })

    expect(next.pendingPermission).toEqual({
      requestId: 'perm-1',
      toolName: 'Edit',
      input: { file_path: 'src/app.ts' },
      description: 'Allow Edit to modify src/app.ts?',
    })
    expect(next.sending).toBe(false)
    expect(buildPermissionResponsePayload('perm-1', true)).toEqual({
      type: 'permission_response',
      requestId: 'perm-1',
      allowed: true,
    })
  })

  it('groups sessions by visible project', () => {
    const groups = groupSessionsByProject([
      { id: '1', title: 'One', createdAt: '', modifiedAt: '', messageCount: 1, projectPath: '-tmp-a', workDir: 'D:/Code/A', workDirExists: true },
      { id: '2', title: 'Two', createdAt: '', modifiedAt: '', messageCount: 1, projectPath: '-tmp-b', workDir: 'D:/Code/B', workDirExists: true },
      { id: '3', title: 'Three', createdAt: '', modifiedAt: '', messageCount: 1, projectPath: '-tmp-a', workDir: 'D:/Code/A', workDirExists: true },
    ])

    expect(groups.map((group) => group.name)).toEqual(['A', 'B'])
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(['1', '3'])
  })
})
