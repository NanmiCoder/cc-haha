import { describe, expect, it } from 'bun:test'
import {
  createCurrentTurnLocalCommandForwarder,
  translateCliMessage,
} from '../ws/handler.js'
import { parseSlashCommand } from '../../utils/slashCommandParsing.js'

describe('WebSocket memory events', () => {
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
