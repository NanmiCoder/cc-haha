import { describe, expect, test } from 'bun:test'
import {
  appendPendingUserMessage,
  chatReducer,
  createChatState,
  mergeHistoryPages,
  normalizeHistory,
  parseServerEvent,
} from './chat'
import type { HistoryEntry, HistoryPage, ServerEvent } from './types'

const run = (events: ServerEvent[], state = createChatState('session')) =>
  events.reduce(chatReducer, state)

test('desktop upload replay confirms the existing mobile bubble and retains image bytes', () => {
  const attachment = { type: 'image' as const, name: 'photo.png', data: 'aGk=', mimeType: 'image/png' }
  const pending = appendPendingUserMessage(createChatState('session'), 'Read this.', [attachment])
  const event = { type: 'user_message_replay' as const, content: '@"/tmp/.claude/uploads/session/photo.png" Read this.' }
  const confirmed = chatReducer(pending, event)
  expect(confirmed.items.filter(item => item.type === 'user')).toHaveLength(1)
  expect(confirmed.items[0]).toMatchObject({ text: 'Read this.', pending: false, delivery: 'confirmed', attachments: [attachment] })
  const otherClient = chatReducer(createChatState('session'), event)
  expect(otherClient.items[0]).toMatchObject({ text: 'Read this.', attachments: [{ type: 'image', name: 'photo.png', path: '/tmp/.claude/uploads/session/photo.png' }] })
  const materialOnly = chatReducer(appendPendingUserMessage(createChatState('session'), '', [attachment]), { type: 'user_message_replay', content: 'Please analyze the attached image.' })
  expect(materialOnly.items).toHaveLength(1)
  expect(materialOnly.items[0]).toMatchObject({ text: '', pending: false, attachments: [attachment] })
  const reloaded = normalizeHistory([{ id: 'image-only', type: 'user', timestamp: '2026-10-24T00:00:00Z', content: [
    { type: 'image', source: { type: 'base64', data: 'aGk=', media_type: 'image/png' } },
    { type: 'text', text: 'Please analyze the attached image.' },
  ] }])
  expect(reloaded).toHaveLength(1)
  expect(reloaded[0].attachments?.[0].data).toBe('aGk=')
})
const entry = (
  id: string,
  type: HistoryEntry['type'],
  content: unknown
): HistoryEntry => ({ id, type, content, timestamp: '2026-01-01T00:00:00Z' })
const page = (
  messages: HistoryEntry[],
  nextCursor: string | null,
  sourceVersion = 'version-a'
): HistoryPage => ({
  messages,
  page: {
    nextCursor,
    hasMore: !!nextCursor,
    historyComplete: !nextCursor,
    sourceVersion,
    scannedBytes: 100,
    omittedOversizedEntries: 0,
  },
})

describe('real WebSocket event state transitions', () => {
  test('an updated real question deadline replaces the pending request without fabricating duration', () => {
    const question = {
      type: 'permission_request' as const,
      requestId: 'question',
      toolName: 'AskUserQuestion',
      input: { questions: [] },
    }
    const waiting = chatReducer(createChatState('session'), question)
    expect(waiting.permissions[0].autoAnswerDeadline).toBeUndefined()
    const scheduled = chatReducer(waiting, {
      ...question,
      autoAnswerDeadline: 90_000,
    })
    expect(scheduled.permissions).toHaveLength(1)
    expect(scheduled.permissions[0].autoAnswerDeadline).toBe(90_000)
    const cancelled = chatReducer(scheduled, {
      ...question,
      autoAnswerDeadline: null,
    })
    expect(cancelled.permissions[0].autoAnswerDeadline).toBeNull()
    expect(cancelled.turnActive).toBe(true)
    expect(
      parseServerEvent({ ...question, autoAnswerDeadline: 'soon' })
    ).toBeNull()
  })
  test('streams thinking, text and tools through the real completion event', () => {
    const events: ServerEvent[] = [
      { type: 'connected', sessionId: 'session' },
      { type: 'status', state: 'thinking', attemptStart: true },
      { type: 'thinking', text: 'First ' },
      { type: 'thinking', text: 'thought.' },
      { type: 'content_start', blockType: 'text' },
      { type: 'content_delta', text: 'Hello ' },
      { type: 'content_delta', text: 'world' },
      {
        type: 'content_start',
        blockType: 'tool_use',
        toolUseId: 'tool-1',
        toolName: 'Read',
      },
      { type: 'content_delta', toolInput: '{"path":' },
      { type: 'content_delta', toolInput: '"file"}' },
      {
        type: 'tool_use_complete',
        toolUseId: 'tool-1',
        toolName: 'Read',
        input: { path: 'file' },
      },
      {
        type: 'tool_result',
        toolUseId: 'tool-1',
        content: [{ type: 'text', text: 'file contents' }],
        isError: false,
      },
      {
        type: 'message_complete',
        usage: { input_tokens: 20, output_tokens: 12 },
      },
    ]
    const state = run(events)
    expect(state.items.map((i) => [i.type, i.text])).toEqual([
      ['thinking', 'First thought.'],
      ['assistant', 'Hello world'],
      ['tool', 'file contents'],
    ])
    expect(state.items[2]).toMatchObject({
      input: { path: 'file' },
      pending: false,
      toolUseId: 'tool-1',
    })
    expect(state).toMatchObject({
      connected: true,
      status: 'idle',
      turnActive: false,
      usage: { input_tokens: 20, output_tokens: 12 },
    })
    expect(state.activeTextId).toBeUndefined()
  })

  test('confirms a locally sent message once but preserves a later repeated prompt', () => {
    const sent = appendPendingUserMessage(createChatState('session'), 'Again')
    const confirmed = chatReducer(sent, {
      type: 'user_message_replay',
      content: 'Again',
    })
    expect(confirmed.items).toHaveLength(1)
    expect(confirmed.items[0].pending).toBe(false)
    expect(
      chatReducer(confirmed, { type: 'user_message_replay', content: 'Again' })
        .items
    ).toHaveLength(2)
    expect(sent.items[0].pending).toBe(true)
  })

  test('reconnect snapshots reconcile permissions without fabricating approval payloads', () => {
    const state = run([
      {
        type: 'permission_request',
        requestId: 'one',
        toolName: 'Bash',
        input: { command: 'pwd' },
      },
      {
        type: 'permission_request',
        requestId: 'two',
        toolName: 'Write',
        input: { path: 'file' },
      },
      {
        type: 'permission_request',
        requestId: 'one',
        toolName: 'Bash',
        input: { command: 'ls' },
      },
      {
        type: 'permission_requests_snapshot',
        toolRequestIds: ['one', 'unknown'],
        computerUseRequestIds: [],
        turnActive: true,
      },
    ])
    expect(state.permissions.map((p) => p.requestId)).toEqual(['one'])
    expect(state.permissions[0].input).toEqual({ command: 'ls' })
    expect(state.status).toBe('permission_pending')
    expect(
      chatReducer(state, {
        type: 'permission_resolved',
        requestId: 'one',
        permissionType: 'tool',
        allowed: true,
      })
    ).toMatchObject({ permissions: [], status: 'thinking', turnActive: true })
    expect(
      chatReducer(state, {
        type: 'permission_requests_snapshot',
        toolRequestIds: [],
        computerUseRequestIds: [],
        turnActive: false,
      })
    ).toMatchObject({ permissions: [], status: 'idle', turnActive: false })
  })

  test('root completion preserves still-running background tasks', () => {
    const state = run([
      {
        type: 'session_state',
        turnState: 'running',
        activeBackgroundTaskIds: ['task-a'],
      },
      {
        type: 'message_complete',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ])
    expect(state.backgroundTaskIds).toEqual(['task-a'])
    expect(state.turnActive).toBe(false)
  })

  test('background lifecycle notifications update IDs without reviving the foreground turn', () => {
    const started: ServerEvent = {
      type: 'system_notification',
      subtype: 'task_started',
      message: 'Detached task started',
      data: { task_id: ' task-a ', task_type: 'local_agent' },
    }
    const state = run([
      started,
      started,
      {
        type: 'system_notification',
        subtype: 'task_notification',
        data: { task_id: 'task-b', status: 'running' },
      },
    ])
    expect(state.backgroundTaskIds).toEqual(['task-a', 'task-b'])
    expect(state).toMatchObject({ turnActive: false, status: 'idle' })
    // 任务通知的说明文字不进主对话流，只有任务 id 的增减。
    expect(state.items).toEqual([])
    for (const status of ['completed', 'failed', 'stopped', 'killed']) {
      const settled = chatReducer(state, {
        type: 'system_notification',
        subtype: 'task_notification',
        // Production stop bookends can contain summary without message.
        data: { task_id: 'task-a', status, summary: 'Task settled' },
      })
      expect(settled.backgroundTaskIds).toEqual(['task-b'])
      expect(settled.items).toEqual(state.items)
      expect(settled.turnActive).toBe(false)
    }
    expect(state.backgroundTaskIds).toEqual(['task-a', 'task-b'])
  })

  test('task started, progress and finish messages stay out of the transcript, other notices do not', () => {
    const state = run([
      { type: 'system_notification', subtype: 'task_started', message: 'Summarize src/todo.ts', data: { task_id: 'a' } },
      { type: 'system_notification', subtype: 'task_progress', message: 'Reading src/todo.ts', data: { task_id: 'a', status: 'running' } },
      { type: 'system_notification', subtype: 'task_notification', message: 'Done', data: { task_id: 'a', status: 'completed' } },
      { type: 'system_notification', subtype: 'status', message: 'Compacted context' },
    ])
    expect(state.items.map((item) => item.text)).toEqual(['Compacted context'])
  })

  test('team plan updates for this session signal a re-read; others and malformed ones do not', () => {
    const update = (patch: Record<string, unknown> = {}) =>
      parseServerEvent(JSON.stringify({
        type: 'team_plan_updated', teamName: 'taskboard', sessionId: 'session',
        planId: 'p1', incarnationId: 'i1', revision: 2, state: 'review_pending', ...patch,
      }))
    expect(update({ revision: '2' })).toBeNull()
    expect(update({ sessionId: undefined })).toBeNull()
    const pending = run([update()!])
    expect(pending.teamPlanSignal).toBe('p1:2:review_pending')
    // 同一版本重复推送不产生新状态，避免无谓地重读。
    expect(chatReducer(pending, update()!)).toBe(pending)
    expect(chatReducer(pending, update({ revision: 3, state: 'launching' })!).teamPlanSignal).toBe('p1:3:launching')
    expect(chatReducer(pending, update({ sessionId: 'other', revision: 9 })!)).toBe(pending)
    expect(pending.items).toEqual([])
  })

  test('a deleted team of this session signals a re-read, since its plan is gone too', () => {
    const deleted = (patch: Record<string, unknown> = {}) =>
      parseServerEvent(JSON.stringify({ type: 'team_deleted', teamName: 'taskboard', incarnationId: 'i1', leadSessionId: 'session', ...patch }))
    expect(deleted({ teamName: 7 })).toBeNull()
    const pending = run([parseServerEvent(JSON.stringify({
      type: 'team_plan_updated', teamName: 'taskboard', sessionId: 'session',
      planId: 'p1', incarnationId: 'i1', revision: 2, state: 'review_pending',
    }))!])
    const gone = chatReducer(pending, deleted()!)
    expect(gone.teamPlanSignal).not.toBe(pending.teamPlanSignal)
    expect(chatReducer(gone, deleted()!)).toBe(gone)
    expect(chatReducer(pending, deleted({ leadSessionId: 'other' })!)).toBe(pending)
    expect(gone.items).toEqual([])
  })

  test('unknown or malformed task notifications cannot remove active IDs', () => {
    const state = run([
      {
        type: 'session_state',
        turnState: 'running',
        activeBackgroundTaskIds: ['task-a'],
      },
    ])
    for (const data of [
      undefined,
      [],
      { task_id: '' },
      { task_id: '   ', status: 'stopped' },
      { task_id: 7, status: 'stopped' },
      { task_id: 'task-a' },
      { task_id: 'task-a', status: 'pending' },
    ]) {
      expect(
        chatReducer(state, {
          type: 'system_notification',
          subtype: 'task_notification',
          data,
        }).backgroundTaskIds
      ).toEqual(['task-a'])
    }
    const progress = chatReducer(state, {
      type: 'system_notification',
      subtype: 'task_progress',
      data: { task_id: 'untracked-task', status: 'running' },
    })
    expect(progress.backgroundTaskIds).toEqual(['task-a'])
    expect(progress.turnActive).toBe(true)
  })

  test('idle after stop settles partial output and clears every active stream block', () => {
    const streaming = run([
      { type: 'user_message_replay', content: 'Slow task' },
      { type: 'content_delta', text: 'Partial answer' },
      {
        type: 'content_start',
        blockType: 'tool_use',
        toolUseId: 'tool',
        toolName: 'Read',
      },
      { type: 'content_delta', toolInput: '{"path":' },
      { type: 'thinking', text: 'Still thinking' },
    ])
    const stopped = chatReducer(streaming, { type: 'status', state: 'idle' })
    expect(
      stopped.items.find((item) => item.type === 'assistant')
    ).toMatchObject({ text: 'Partial answer', pending: false })
    expect(stopped.items.find((item) => item.type === 'tool')).toMatchObject({
      partialInput: '{"path":',
      pending: false,
    })
    expect(stopped.items.find((item) => item.type === 'user')?.delivery).toBe(
      'confirmed'
    )
    expect(stopped).toMatchObject({
      status: 'idle',
      turnActive: false,
      activeTextId: undefined,
      activeToolId: undefined,
      activeThinkingId: undefined,
    })
    expect(
      streaming.items.find((item) => item.type === 'assistant')?.pending
    ).toBe(true)
  })

  test('idle cannot confirm a user message whose replay never arrived', () => {
    const pending = appendPendingUserMessage(
      createChatState('session'),
      'Was this received?'
    )
    const stopped = chatReducer(pending, { type: 'status', state: 'idle' })
    expect(stopped.items[0]).toMatchObject({
      text: 'Was this received?',
      pending: false,
      delivery: 'uncertain',
    })
  })

  test('runtime and permission mode only change from server acknowledgements', () => {
    const state = run([
      {
        type: 'runtime_config_applied',
        providerId: 'provider-a',
        modelId: 'model-a',
        effortLevel: 'high',
      },
      { type: 'permission_mode_changed', mode: 'plan' },
    ])
    expect(state.runtime).toEqual({
      providerId: 'provider-a',
      modelId: 'model-a',
      effortLevel: 'high',
      openAIFastMode: undefined,
    })
    expect(state.permissionMode).toBe('plan')
  })

  test('identical thinking blocks in separate turns are not globally deduplicated', () => {
    const state = run([
      { type: 'thinking', text: 'Check this', complete: true },
      {
        type: 'message_complete',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      { type: 'thinking', text: 'Check this', complete: true },
    ])
    expect(state.items.map((item) => item.text)).toEqual([
      'Check this',
      'Check this',
    ])
  })

  test('permission mode rejection does not end a running turn', () => {
    const state = run([
      { type: 'content_delta', text: 'Working' },
      {
        type: 'error',
        code: 'PERMISSION_MODE_CHANGE_FAILED',
        message: 'Unsupported mode',
      },
    ])
    expect(state.turnActive).toBe(true)
    expect(state.status).toBe('streaming')
  })

  test('malformed computer-use app entries cannot reach the UI', () => {
    expect(
      parseServerEvent({
        type: 'computer_use_permission_request',
        requestId: 'request',
        request: {
          requestId: 'request',
          reason: 'Test',
          apps: [null],
          requestedFlags: {},
          screenshotFiltering: 'native',
        },
      })
    ).toBeNull()
  })

  test('terminal errors settle the run; invalid runtime selection preserves it', () => {
    const state = run([
      { type: 'content_delta', text: 'Partial' },
      {
        type: 'permission_request',
        requestId: 'one',
        toolName: 'Read',
        input: {},
      },
    ])
    const rejected = chatReducer(state, {
      type: 'error',
      message: 'Unknown model',
      code: 'RUNTIME_CONFIG_INVALID',
    })
    expect(rejected.turnActive).toBe(true)
    expect(rejected.permissions).toHaveLength(1)
    const failed = chatReducer(state, {
      type: 'error',
      message: 'Connection failed',
      code: 'API_ERROR',
    })
    expect(failed).toMatchObject({
      status: 'idle',
      turnActive: false,
      permissions: [],
    })
    expect(failed.items[0].text).toBe('Partial')
    expect(failed.items[0].pending).toBe(false)
  })

  test('tool result can precede its complete event without losing output', () => {
    const state = run([
      {
        type: 'tool_result',
        toolUseId: 'tool',
        content: 'result',
        isError: false,
      },
      {
        type: 'tool_use_complete',
        toolUseId: 'tool',
        toolName: 'Read',
        input: {},
      },
    ])
    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({
      toolName: 'Read',
      text: 'result',
      pending: false,
    })
  })

  test('subagent streams do not enter the parent transcript', () => {
    const state = createChatState('session')
    expect(
      chatReducer(state, {
        type: 'agent_run_event',
        runAgentId: 'run',
        streamId: 'stream',
        targetAgentId: 'agent',
        event: { type: 'content_delta', text: 'subagent' },
      })
    ).toBe(state)
    expect(
      chatReducer(state, { type: 'connected', sessionId: 'another-session' })
    ).toBe(state)
  })

  test('accepts real events and rejects invented or malformed events', () => {
    expect(parseServerEvent('{"type":"content_delta","text":"hello"}')).toEqual(
      { type: 'content_delta', text: 'hello' }
    )
    for (const raw of [
      '{',
      { type: 'text_delta', text: 'fake' },
      { type: 'done' },
      { type: 'content_delta', text: 2 },
      { type: 'content_start', blockType: 'tool_use' },
      { type: 'status', state: 'complete' },
      {
        type: 'message_complete',
        usage: { input_tokens: '2', output_tokens: 1 },
      },
    ])
      expect(parseServerEvent(raw)).toBeNull()
  })
})

describe('paged transcript normalization', () => {
  test('normalizes real tool entries and preserves text roles, deduplicating record IDs', () => {
    const entries = [
      entry('u', 'user', 'Read file'),
      entry('a', 'tool_use', [
        { type: 'text', text: 'Reading file' },
        { type: 'tool_use', id: 'tool', name: 'Read', input: { path: 'file' } },
      ]),
      entry('r', 'tool_result', [
        {
          type: 'tool_result',
          tool_use_id: 'tool',
          content: [{ type: 'text', text: 'data' }],
          is_error: false,
        },
      ]),
      entry('a', 'tool_use', 'duplicate'),
    ]
    const items = normalizeHistory(entries)
    expect(items.map((i) => [i.type, i.text])).toEqual([
      ['user', 'Read file'],
      ['assistant', 'Reading file'],
      ['tool', 'data'],
    ])
    expect(items[2]).toMatchObject({
      toolUseId: 'tool',
      toolName: 'Read',
      pending: false,
    })
    expect(
      normalizeHistory([entry('r2', 'tool_result', 'user context')])[0].type
    ).toBe('user')
  })

  test('prepends older pages, deduplicates overlap and enforces source version', () => {
    const one = entry('one', 'user', 'First')
    const two = entry('two', 'assistant', 'Second')
    const current = page([two], 'cursor')
    const merged = mergeHistoryPages(current, page([one, two], null))
    expect(merged.messages.map((m) => m.id)).toEqual(['one', 'two'])
    expect(merged.page).toMatchObject({
      nextCursor: null,
      hasMore: false,
      historyComplete: true,
      scannedBytes: 200,
    })
    expect(() =>
      mergeHistoryPages(current, page([one], null, 'changed-version'))
    ).toThrow('HISTORY_PAGE_STALE')
    expect(current.messages).toHaveLength(1)
  })

  test('truncated or omitted history is never marked complete', () => {
    const current = page([], 'cursor')
    const older = page([], null)
    older.page!.contentTruncated = true
    expect(mergeHistoryPages(current, older).page?.historyComplete).toBe(false)
  })
})
