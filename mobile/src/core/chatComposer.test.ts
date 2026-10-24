import { describe, expect, test } from 'bun:test'
import {
  attachmentFromBase64,
  buildComposerMessage,
  persistedMessageId,
  restoreFileReferences,
  validateMessageSize,
  visibleMessageText,
  withSkill,
} from './chatComposer'
import { createChatState, normalizeHistory } from './chat'
import { notificationPermissionResponse, runtimeMatches } from './chatActions'

describe('real mobile composition', () => {
  test('reloads desktop upload references as materials without exposing transport paths or offering lossy edits', () => {
    const path = '/tmp/profile/.claude/uploads/session/56e5975d-c6d6-4ab2-a6f2-2ac971e98908-native-output.txt'
    const prompt = `@"${path}" Read the attached file.`
    const [item] = normalizeHistory([{ id: 'persisted-file', type: 'user', content: [{ type: 'text', text: prompt }], timestamp: '2026-10-24T00:00:00Z' }])
    expect(item.text).toBe('Read the attached file.')
    expect(item.attachments).toEqual([{ type: 'file', name: 'native-output.txt', path }])
    expect(item.editableText).toBeUndefined()
    expect(persistedMessageId(item)).toBe('persisted-file')
    expect(restoreFileReferences('Compare @"src/app.ts" inline.')).toEqual({ text: 'Compare @"src/app.ts" inline.', attachments: [] })
    expect(restoreFileReferences('@"unclosed')).toEqual({ text: '@"unclosed', attachments: [] })
    expect(restoreFileReferences('@"C:\\repo\\photo.png" @"notes.txt" Compare').attachments).toEqual([
      { type: 'image', name: 'photo.png', path: 'C:\\repo\\photo.png' },
      { type: 'file', name: 'notes.txt', path: 'notes.txt' },
    ])
  })
  test('sends file bytes, never a phone local path, and permits material-only input', () => {
    const file = attachmentFromBase64({
      name: 'notes.txt',
      base64: 'data:text/plain;base64,aGk=',
      mimeType: 'text/plain',
      uri: 'file:///phone/private/notes.txt',
    })
    expect(file.bytes).toBe(2)
    expect(buildComposerMessage('', [file], false)).toEqual({
      type: 'user_message',
      content: '',
      attachments: [
        {
          type: 'file',
          name: 'notes.txt',
          data: 'aGk=',
          mimeType: 'text/plain',
        },
      ],
    })
    expect(() =>
      attachmentFromBase64({
        name: 'bad',
        base64: 'not valid bytes',
        mimeType: 'text/plain',
      })
    ).toThrow()
    expect(() => buildComposerMessage('', [], false)).toThrow()
  })
  test('uses the same one-message team request as desktop and quotes only real skill names', () => {
    const message = buildComposerMessage('Investigate', [], true)
    expect(message.content).toContain('<agent-team-request>')
    expect(visibleMessageText(message.content)).toBe('Investigate')
    expect(buildComposerMessage('Next', [], false).content).toBe('Next')
    expect(
      withSkill('review this', {
        name: 'review',
        kind: 'skill',
        description: '',
      })
    ).toBe('/review review this')
    expect(() =>
      withSkill('', { name: 'bad\nname', kind: 'skill', description: '' })
    ).toThrow()
  })
  test('enforces the real remote frame limit using UTF-8 bytes before a socket send', () => {
    const message = buildComposerMessage('中'.repeat(360_000), [], false)
    expect(() => validateMessageSize(message, 'remote')).toThrow('1 MB')
    expect(() => validateMessageSize(message, 'lan')).not.toThrow()
  })
  test('retains durable ids and complete editable text, but rejects mixed-material edits and live forks', () => {
    const history = normalizeHistory([
      {
        id: 'durable',
        type: 'user',
        content: [
          { type: 'text', text: 'First' },
          { type: 'text', text: 'Second' },
        ],
        timestamp: '',
      },
    ])
    expect(persistedMessageId(history[0])).toBe('durable')
    expect(history[1].editableText).toBe('First\nSecond')
    const image = normalizeHistory([
      {
        id: 'photo',
        type: 'user',
        content: [
          { type: 'text', text: 'Look' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: 'aGk=' },
          },
        ],
        timestamp: '',
      },
    ])
    expect(image).toHaveLength(1)
    expect(image[0].editableText).toBeUndefined()
    expect(image[0].text).toBe('Look')
    expect(image[0].attachments?.[0].data).toBe('aGk=')
    expect(
      persistedMessageId({ id: 'live:x:1', type: 'assistant', text: 'stream' })
    ).toBeNull()
    expect(persistedMessageId({ ...history[0], pending: true })).toBeNull()
  })
  test('notification action can only respond to the exact outstanding ordinary tool request', () => {
    const state = createChatState('session')
    state.permissions = [
      {
        type: 'permission_request',
        requestId: 'read',
        toolName: 'Read',
        input: {},
      },
      {
        type: 'permission_request',
        requestId: 'ask',
        toolName: 'AskUserQuestion',
        input: {},
      },
      {
        type: 'permission_request',
        requestId: 'plan',
        toolName: 'ExitPlanMode',
        input: {},
      },
    ]
    expect(notificationPermissionResponse(state, 'allow', 'read')).toEqual({
      type: 'permission_response',
      requestId: 'read',
      allowed: true,
    })
    expect(notificationPermissionResponse(state, 'deny', 'read')?.allowed).toBe(
      false
    )
    for (const id of ['ask', 'plan', 'stale'])
      expect(notificationPermissionResponse(state, 'allow', id)).toBeNull()
    expect(notificationPermissionResponse(state, 'other', 'read')).toBeNull()
  })
  test('handoff waits for provider/model/effort and fast-mode acknowledgement', () => {
    const desired = {
      providerId: null,
      modelId: 'test',
      effortLevel: 'high',
      openAIFastMode: false,
    }
    expect(runtimeMatches(undefined, desired)).toBe(false)
    expect(runtimeMatches({ ...desired, effortLevel: 'low' }, desired)).toBe(
      false
    )
    expect(
      runtimeMatches({ ...desired, providerId: 'different' }, desired)
    ).toBe(false)
    expect(runtimeMatches({ ...desired, openAIFastMode: true }, desired)).toBe(
      false
    )
    expect(runtimeMatches({ ...desired }, desired)).toBe(true)
  })
})
