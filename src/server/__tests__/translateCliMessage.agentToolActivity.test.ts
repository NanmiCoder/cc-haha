import { describe, expect, it } from 'bun:test'
import { translateCliMessage } from '../ws/handler.js'

// A background (async) agent's tool activity arrives on the parent stdout
// stream as a system/agent_tool_activity SDK event. translateCliMessage must
// re-emit it as a normal tool_use_complete / tool_result carrying the parent
// Agent tool_use_id, so the desktop groups it under the agent card exactly
// like a synchronous subagent (childToolCallsByParent). Regression guard for
// the "background subagents stuck on 'no tool activity'" bug.
describe('translateCliMessage: agent_tool_activity', () => {
  it('re-emits a background tool_use as tool_use_complete with the parent id', () => {
    const out = translateCliMessage(
      {
        type: 'system',
        subtype: 'agent_tool_activity',
        task_id: 'agent-1',
        tool_use_id: 'toolu_parent',
        activity: {
          kind: 'tool_use',
          tool_name: 'Bash',
          tool_use_id: 'toolu_child',
          input: { command: 'ls' },
        },
      },
      'session-1',
    )
    expect(out).toEqual([
      {
        type: 'tool_use_complete',
        toolName: 'Bash',
        toolUseId: 'toolu_child',
        input: { command: 'ls' },
        parentToolUseId: 'toolu_parent',
      },
    ])
  })

  it('re-emits a background tool_result with the parent id', () => {
    const out = translateCliMessage(
      {
        type: 'system',
        subtype: 'agent_tool_activity',
        task_id: 'agent-1',
        tool_use_id: 'toolu_parent',
        activity: {
          kind: 'tool_result',
          tool_use_id: 'toolu_child',
          content: 'done',
          is_error: true,
        },
      },
      'session-1',
    )
    expect(out).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'toolu_child',
        content: 'done',
        isError: true,
        parentToolUseId: 'toolu_parent',
      },
    ])
  })

  it('returns nothing for an unknown activity kind', () => {
    const out = translateCliMessage(
      {
        type: 'system',
        subtype: 'agent_tool_activity',
        task_id: 'agent-1',
        tool_use_id: 'toolu_parent',
        activity: { kind: 'mystery' },
      },
      'session-1',
    )
    expect(out).toEqual([])
  })
})
