import { describe, expect, it } from 'bun:test'
import {
  createCurrentTurnLocalCommandForwarder,
  shouldRestartForPermissionMode,
  translateCliMessage,
} from '../ws/handler.js'
import { parseSlashCommand } from '../../utils/slashCommandParsing.js'

describe('WebSocket memory events', () => {
  it('forwards assistant business error codes to the desktop client', () => {
    expect(translateCliMessage({
      type: 'assistant',
      error: 'invalid_request',
      isApiErrorMessage: true,
      businessErrorCode: 'image_unsupported',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'This model does not support images.' }],
      },
    }, 'session-1')).toEqual([
      {
        type: 'error',
        message: 'This model does not support images.',
        code: 'invalid_request',
        businessErrorCode: 'image_unsupported',
      },
    ])
  })

  it('does not replay internal slash-command breadcrumbs as user messages', () => {
    expect(translateCliMessage({
      type: 'user',
      isReplay: true,
      message: {
        role: 'user',
        content: [
          '<command-message>agent</command-message>',
          '<command-name>/agent</command-name>',
          '<command-args>Plan 222</command-args>',
        ].join('\n'),
      },
    }, 'session-1')).toEqual([])

    expect(translateCliMessage({
      type: 'user',
      isReplay: true,
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              '<command-message>agent</command-message>',
              '<command-name>/agent</command-name>',
              '<command-args>Plan 222</command-args>',
            ].join('\n'),
          },
        ],
      },
    }, 'session-1')).toEqual([])
  })

  it('forwards CLI memory_saved system messages to the desktop client', () => {
    const messages = translateCliMessage(
      {
        type: 'system',
        subtype: 'memory_saved',
        writtenPaths: [
          '/Users/test/.claude/projects/example/memory/preferences.md',
          '/Users/test/.claude/projects/example/memory/team/MEMORY.md',
        ],
        teamCount: 1,
        verb: 'Saved',
      },
      'session-1',
    )

    expect(messages).toEqual([
      {
        type: 'system_notification',
        subtype: 'memory_saved',
        message: undefined,
        data: {
          writtenPaths: [
            '/Users/test/.claude/projects/example/memory/preferences.md',
            '/Users/test/.claude/projects/example/memory/team/MEMORY.md',
          ],
          teamCount: 1,
          verb: 'Saved',
        },
      },
    ])
  })
})

describe('WebSocket AskUserQuestion events', () => {
  it('forwards structured AskUserQuestion answers from CLI toolUseResult metadata', () => {
    expect(translateCliMessage({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'ask-1',
            content: 'User has answered your questions: "Pick one?"="A". You can now continue with the user\'s answers in mind.',
          },
        ],
      },
      toolUseResult: {
        questions: [{ question: 'Pick one?', options: [{ label: 'A' }] }],
        answers: { 'Pick one?': 'A' },
      },
    }, 'session-1')).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'ask-1',
        content: {
          questions: [{ question: 'Pick one?', options: [{ label: 'A' }] }],
          answers: { 'Pick one?': 'A' },
        },
        isError: false,
        parentToolUseId: undefined,
      },
    ])
  })
})

describe('WebSocket queued user replay events', () => {
  it('forwards ordinary queued user replays to the desktop client', () => {
    expect(translateCliMessage({
      type: 'user',
      isReplay: true,
      message: {
        role: 'user',
        content: 'please adjust the current direction',
      },
    }, 'session-1')).toEqual([
      {
        type: 'user_message_replay',
        content: 'please adjust the current direction',
      },
    ])
  })

  it('does not turn replayed tool results into user text messages', () => {
    expect(translateCliMessage({
      type: 'user',
      isReplay: true,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
        ],
      },
    }, 'session-1')).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'tool-1',
        content: 'ok',
        isError: false,
        parentToolUseId: undefined,
      },
    ])
  })
})

describe('WebSocket compact events', () => {
  it('forwards CLI compacting status to the desktop client', () => {
    expect(translateCliMessage({
      type: 'system',
      subtype: 'status',
      status: 'compacting',
    }, 'session-1')).toEqual([
      {
        type: 'status',
        state: 'compacting',
        verb: 'Compacting conversation',
      },
    ])

    expect(translateCliMessage({
      type: 'system',
      subtype: 'status',
      status: null,
    }, 'session-1')).toEqual([
      {
        type: 'status',
        state: 'thinking',
        verb: 'Thinking',
      },
    ])

    expect(translateCliMessage({
      type: 'system',
      subtype: 'status',
      status: 'warming',
    }, 'session-1')).toEqual([])
  })

  it('forwards CLI permission-mode broadcasts instead of dropping them as thinking', () => {
    // CLI 在退出 plan 模式后恢复权限时会广播一条 status:null + permissionMode
    // 的事件。它必须被翻译成 permission_mode_changed，而不是被 null→thinking
    // 兜底吞掉 —— 这正是桌面端选择器卡在"计划模式"的根因。
    expect(translateCliMessage({
      type: 'system',
      subtype: 'status',
      status: null,
      permissionMode: 'bypassPermissions',
    }, 'session-1')).toEqual([
      { type: 'permission_mode_changed', mode: 'bypassPermissions' },
    ])

    // 普通 thinking（无 permissionMode）仍走原路径，不受影响。
    expect(translateCliMessage({
      type: 'system',
      subtype: 'status',
      status: null,
    }, 'session-1')).toEqual([
      { type: 'status', state: 'thinking', verb: 'Thinking' },
    ])
  })

  it('forwards compact summaries as system notifications instead of user chat bubbles', () => {
    const summary = [
      'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.',
      '',
      'Built the compact UI and verified the WebSocket event path.',
    ].join('\n')

    expect(translateCliMessage({
      type: 'user',
      message: {
        role: 'user',
        content: summary,
      },
      isSynthetic: true,
    }, 'session-1')).toEqual([
      {
        type: 'system_notification',
        subtype: 'compact_summary',
        message: summary,
        data: { isSynthetic: true },
      },
    ])
  })

  it('suppresses compact local command output after the compact summary', () => {
    expect(translateCliMessage({
      type: 'user',
      message: {
        role: 'user',
        content: '<local-command-stdout>Compacted </local-command-stdout>',
      },
    }, 'session-1')).toEqual([])
  })
})

describe('WebSocket permission mode restart policy', () => {
  it('restarts the CLI only when entering bypassPermissions', () => {
    // 进入 bypass 需要带 --dangerously-skip-permissions 重启子进程。
    expect(shouldRestartForPermissionMode('default', 'bypassPermissions')).toBe(true)
    expect(shouldRestartForPermissionMode('plan', 'bypassPermissions')).toBe(true)
    expect(shouldRestartForPermissionMode('acceptEdits', 'bypassPermissions')).toBe(true)
  })

  it('does NOT restart when leaving bypassPermissions for a stricter mode', () => {
    // 从 bypass 切出不重启——否则会冲掉进程内 prePlanMode，导致 ExitPlanMode 后
    // 恢复成 default 而非进入 plan 前的 bypassPermissions。这正是桌面端退出 plan
    // 权限回不到 bypass 的根因。
    expect(shouldRestartForPermissionMode('bypassPermissions', 'plan')).toBe(false)
    expect(shouldRestartForPermissionMode('bypassPermissions', 'default')).toBe(false)
    expect(shouldRestartForPermissionMode('bypassPermissions', 'acceptEdits')).toBe(false)
  })

  it('does not restart for non-bypass transitions or no-op changes', () => {
    expect(shouldRestartForPermissionMode('default', 'plan')).toBe(false)
    expect(shouldRestartForPermissionMode('plan', 'acceptEdits')).toBe(false)
    // 同模式（含 bypass→bypass）是 no-op，不重启。
    expect(shouldRestartForPermissionMode('bypassPermissions', 'bypassPermissions')).toBe(false)
    expect(shouldRestartForPermissionMode('plan', 'plan')).toBe(false)
  })
})

describe('WebSocket API retry events', () => {
  it('forwards CLI api_retry messages as structured retry status', () => {
    expect(translateCliMessage({
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 10,
      retry_delay_ms: 1500,
      error_status: 503,
      error: 'server_error',
    }, 'session-1')).toEqual([
      {
        type: 'api_retry',
        attempt: 2,
        maxRetries: 10,
        retryDelayMs: 1500,
        errorStatus: 503,
        errorType: 'server_error',
      },
    ])
  })

  it('forwards CLI streaming_fallback messages with a recognized cause', () => {
    // 形状对齐 QueryEngine 的 SDK 输出：{type:'system', subtype:'streaming_fallback', cause, ...}
    expect(translateCliMessage({
      type: 'system',
      subtype: 'streaming_fallback',
      cause: 'watchdog',
      session_id: 'session-1',
      uuid: 'uuid-1',
    }, 'session-1')).toEqual([
      { type: 'streaming_fallback', cause: 'watchdog' },
    ])

    expect(translateCliMessage({
      type: 'system',
      subtype: 'streaming_fallback',
      cause: '404_stream_creation',
    }, 'session-1')).toEqual([
      { type: 'streaming_fallback', cause: '404_stream_creation' },
    ])
  })

  it('normalizes unrecognized streaming_fallback causes to unknown instead of dropping the event', () => {
    // 新 CLI + 旧枚举：提示本身比成因重要，不能丢消息。
    expect(translateCliMessage({
      type: 'system',
      subtype: 'streaming_fallback',
      cause: 'some_future_cause',
    }, 'session-1')).toEqual([
      { type: 'streaming_fallback', cause: 'unknown' },
    ])

    expect(translateCliMessage({
      type: 'system',
      subtype: 'streaming_fallback',
    }, 'session-1')).toEqual([
      { type: 'streaming_fallback', cause: 'unknown' },
    ])
  })
})

describe('WebSocket background task events', () => {
  it('forwards task start and progress as structured desktop notifications', () => {
    const started = {
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-task-1',
      tool_use_id: 'agent-tool-1',
      description: 'Verify the todo app',
      task_type: 'local_agent',
      prompt: 'Run E2E checks',
    }

    expect(translateCliMessage(started, 'session-1')).toEqual([
      {
        type: 'system_notification',
        subtype: 'task_started',
        message: 'Verify the todo app',
        data: started,
      },
      {
        type: 'status',
        state: 'tool_executing',
        verb: 'Verify the todo app',
      },
    ])

    const progress = {
      type: 'system',
      subtype: 'task_progress',
      task_id: 'agent-task-1',
      tool_use_id: 'agent-tool-1',
      description: 'Verify the todo app',
      summary: 'Running Playwright checks',
      last_tool_name: 'Bash',
      usage: {
        total_tokens: 1200,
        tool_uses: 4,
        duration_ms: 45000,
      },
    }

    expect(translateCliMessage(progress, 'session-1')).toEqual([
      {
        type: 'system_notification',
        subtype: 'task_progress',
        message: 'Running Playwright checks',
        data: progress,
      },
      {
        type: 'status',
        state: 'tool_executing',
        verb: 'Running Playwright checks',
      },
    ])
  })
})

describe('WebSocket goal command events', () => {
  const goalStatusOutput = 'Goal set: ship the smoke test'

  const runGoalCommand = (sessionId: string, args: string, output: string, type: 'system' | 'user' = 'system') => {
    expect(translateCliMessage({
      type: 'system',
      subtype: 'local_command',
      content: [
        { text: '<command-name>/goal</command-name>' },
        { text: `<command-args>${args}</command-args>` },
      ],
    }, sessionId)).toEqual([])

    if (type === 'user') {
      return translateCliMessage({
        type: 'user',
        message: {
          content: [{
            type: 'text',
            text: `<local-command-stdout>${output}</local-command-stdout>`,
          }],
        },
      }, sessionId)
    }

    return translateCliMessage({
      type: 'system',
      subtype: 'local_command_output',
      content: `<local-command-stdout>${output}</local-command-stdout>`,
    }, sessionId)
  }

  it('turns confirmed /goal local command output into a desktop goal event', () => {
    const sessionId = `goal-event-${crypto.randomUUID()}`

    expect(translateCliMessage({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/goal</command-name>\n<command-args>ship the smoke test</command-args>',
    }, sessionId)).toEqual([])

    expect(translateCliMessage({
      type: 'system',
      subtype: 'local_command',
      content: [
        '<local-command-stdout>',
        goalStatusOutput,
        '</local-command-stdout>',
      ].join('\n'),
    }, sessionId)).toEqual([
      {
        type: 'system_notification',
        subtype: 'goal_event',
        message: goalStatusOutput,
        data: {
          action: 'created',
          status: 'active',
          objective: 'ship the smoke test',
          message: goalStatusOutput,
        },
      },
    ])
  })

  it('classifies /goal clear and completion output for the desktop client', () => {
    expect(runGoalCommand(`goal-complete-${crypto.randomUUID()}`, 'complete', 'Goal marked complete.')).toEqual([
      expect.objectContaining({
        type: 'system_notification',
        subtype: 'goal_event',
        data: { action: 'completed', message: 'Goal marked complete.' },
      }),
    ])

    expect(runGoalCommand(`goal-clear-${crypto.randomUUID()}`, 'clear', 'Goal cleared: ship docs')).toEqual([
      expect.objectContaining({
        type: 'system_notification',
        subtype: 'goal_event',
        data: { action: 'cleared', message: 'Goal cleared: ship docs' },
      }),
    ])
  })

  it('allows direct /goal local command output through the pre-turn mute gate', () => {
    const shouldForward = createCurrentTurnLocalCommandForwarder(
      parseSlashCommand('/goal ship the smoke test'),
    )

    expect(shouldForward({
      type: 'system',
      subtype: 'local_command_output',
      content: '<local-command-stdout>Goal set: ship the smoke test</local-command-stdout>',
    })).toBe(true)
  })

  it('keeps negative /goal command output visible as a goal message event', () => {
    expect(runGoalCommand(`goal-empty-${crypto.randomUUID()}`, '', 'No active goal.', 'user')).toEqual([
      {
        type: 'system_notification',
        subtype: 'goal_event',
        message: 'No active goal.',
        data: { action: 'message', message: 'No active goal.' },
      },
    ])
  })

  it('does not turn unrelated local command output into a goal event', () => {
    const sessionId = `goal-unrelated-${crypto.randomUUID()}`

    expect(translateCliMessage({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/status</command-name>',
    }, sessionId)).toEqual([])

    expect(translateCliMessage({
      type: 'system',
      subtype: 'local_command_output',
      content: '<local-command-stdout>Goal: active</local-command-stdout>',
    }, sessionId)).toEqual([
      { type: 'content_start', blockType: 'text' },
      { type: 'content_delta', text: 'Goal: active' },
    ])
  })

  it('allows the current slash command lifecycle through the pre-turn mute gate', () => {
    const shouldForward = createCurrentTurnLocalCommandForwarder(
      parseSlashCommand('/goal ship the smoke test'),
    )

    expect(shouldForward({
      type: 'system',
      subtype: 'init',
    })).toBe(false)
    expect(shouldForward({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/cost</command-name>\n<command-args></command-args>',
    })).toBe(false)
    expect(shouldForward({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/goal</command-name>\n<command-args>ship the smoke test</command-args>',
    })).toBe(true)
    expect(shouldForward({
      type: 'system',
      subtype: 'local_command',
      content: '<local-command-stdout>Goal set: ship the smoke test</local-command-stdout>',
    })).toBe(true)
    expect(shouldForward({
      type: 'system',
      subtype: 'local_command_output',
      content: 'late unrelated output',
    })).toBe(false)
  })

})

describe('WebSocket stream event translation', () => {
  it('keeps subagent parent linkage when later stream events omit the parent id', () => {
    const sessionId = `subagent-parent-${crypto.randomUUID()}`

    expect(translateCliMessage({
      type: 'stream_event',
      parent_tool_use_id: 'agent-1',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'read-1', name: 'Read' },
      },
    }, sessionId)).toEqual([
      {
        type: 'content_start',
        blockType: 'tool_use',
        toolName: 'Read',
        toolUseId: 'read-1',
        parentToolUseId: 'agent-1',
      },
    ])

    expect(translateCliMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"src/App.tsx"}' },
      },
    }, sessionId)).toEqual([
      { type: 'content_delta', toolInput: '{"file_path":"src/App.tsx"}' },
    ])

    expect(translateCliMessage({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    }, sessionId)).toEqual([
      {
        type: 'tool_use_complete',
        toolName: 'Read',
        toolUseId: 'read-1',
        input: { file_path: 'src/App.tsx' },
        parentToolUseId: 'agent-1',
      },
    ])

    expect(translateCliMessage({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'read-1', content: 'ok' },
        ],
      },
    }, sessionId)).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'read-1',
        content: 'ok',
        isError: false,
        parentToolUseId: 'agent-1',
      },
    ])
  })

  it('keeps DeepSeek-style thinking blocks in thinking state until text starts', () => {
    const sessionId = `deepseek-thinking-${crypto.randomUUID()}`

    expect(translateCliMessage({
      type: 'stream_event',
      event: { type: 'message_start' },
    }, sessionId)).toEqual([
      { type: 'status', state: 'thinking' },
    ])

    expect(translateCliMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      },
    }, sessionId)).toEqual([
      { type: 'status', state: 'thinking', verb: 'Thinking' },
    ])

    expect(translateCliMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Let me think' },
      },
    }, sessionId)).toEqual([
      { type: 'thinking', text: 'Let me think' },
    ])

    expect(translateCliMessage({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    }, sessionId)).toEqual([])

    expect(translateCliMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      },
    }, sessionId)).toEqual([
      { type: 'content_start', blockType: 'text' },
    ])
  })
})
