import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ToolCallGroup } from './ToolCallGroup'
import type { AgentTaskNotification, UIMessage } from '../../types/chat'

type ToolCall = Extract<UIMessage, { type: 'tool_use' }>
type ToolResult = Extract<UIMessage, { type: 'tool_result' }>

function agentCall(id: string, timestamp: number): ToolCall {
  return {
    id: `tool-${id}`,
    type: 'tool_use',
    toolName: 'Agent',
    toolUseId: id,
    input: { description: `Review ${id}` },
    timestamp,
  }
}

function result(id: string, timestamp: number): ToolResult {
  return {
    id: `result-${id}`,
    type: 'tool_result',
    toolUseId: id,
    content: 'done',
    isError: false,
    timestamp,
  }
}

function renderGroup(toolCalls: ToolCall[], results: ToolResult[], notifications: Record<string, AgentTaskNotification> = {}) {
  return render(
    <ToolCallGroup
      sessionId="session-1"
      toolCalls={toolCalls}
      resultMap={new Map(results.map((item) => [item.toolUseId, item]))}
      childToolCallsByParent={new Map()}
      agentTaskNotifications={notifications}
    />,
  )
}

function rowDurations(): (string | null | undefined)[] {
  return Array.from(document.querySelectorAll('[data-agent-call-duration="true"]'))
    .map((node) => node.textContent?.trim())
}

describe('subagent run duration', () => {
  it('sums the members into the header and shows each run beside its own actions', () => {
    // Two synchronous agents, each blocking its own tool call: 120s and 300s.
    const toolCalls = [agentCall('a', 1_000), agentCall('b', 200_000)]
    const results = [result('a', 121_000), result('b', 500_000)]
    renderGroup(toolCalls, results)

    // Header is the group's wall-clock SPAN, not the sum: the runs start 199s
    // apart and the last ends at 500s, so it reads 8m19s — a serial sum would
    // have said 2m0s + 5m0s = 7m0s.
    const header = screen.getByRole('button', { name: /dispatched 2 agents/i })
    const headerDuration = document.querySelector('[data-agent-group-duration="true"]')
    expect(headerDuration?.textContent?.trim()).toBe('8m19s')
    expect(header.textContent).toContain('Duration')
    expect(header.textContent).not.toContain('7m0s')
    // Rows only mount once the group is expanded, and each stays bare.
    expect(rowDurations()).toEqual([])
    fireEvent.click(header)
    expect(rowDurations()).toEqual(['2m0s', '5m0s'])
  })

  it('prefers the runtime report for a background agent, whose call returns at launch', () => {
    // The launch result lands 50ms after the call, but the run itself took
    // three minutes — only the report knows that.
    const toolCalls = [agentCall('bg', 1_000)]
    const results = [result('bg', 1_050)]
    const notifications: Record<string, AgentTaskNotification> = {
      bg: {
        taskId: 'task-bg',
        toolUseId: 'bg',
        status: 'completed',
        usage: { durationMs: 180_000 },
      },
    }
    renderGroup(toolCalls, results, notifications)

    expect(document.querySelector('[data-agent-group-duration="true"]')?.textContent?.trim()).toBe('3m0s')
    fireEvent.click(screen.getByRole('button', { name: /agent/i }))
    expect(rowDurations()).toEqual(['3m0s'])
  })

  it('omits the duration while a synchronous run is still in flight', () => {
    // No result and no incoming report: there is no trustworthy anchor, so
    // neither the row nor the header may guess a number.
    renderGroup([agentCall('a', 1_000)], [])

    const header = screen.getByRole('button', { name: /agent/i })
    expect(document.querySelector('[data-agent-group-duration="true"]')).toBeNull()
    fireEvent.click(header)
    expect(rowDurations()).toEqual([])
  })
})

describe('a parallel dispatch is spanned, never summed', () => {
  it('reports one run\'s length when the agents start together', () => {
    // Both dispatched at the same instant, each taking two minutes. Summing
    // would print 4m of work for 2m of wall clock.
    const toolCalls = [agentCall('a', 1_000), agentCall('b', 1_000)]
    const results = [result('a', 121_000), result('b', 121_000)]
    renderGroup(toolCalls, results)

    const headerDuration = document.querySelector('[data-agent-group-duration="true"]')
    expect(headerDuration?.textContent?.trim()).toBe('2m0s')
  })
})
