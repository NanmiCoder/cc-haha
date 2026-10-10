import { memo, type ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { ActivityStep } from './activityGroupModel'
import { useSettingsStore } from '../../stores/settingsStore'
import type { UIMessage } from '../../types/chat'

// Counts renders of the real row block. The wrapper is memoized like the real
// one, so it re-renders exactly when the real block would.
const rendered = vi.hoisted(() => [] as string[])
vi.mock('./ToolCallBlock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ToolCallBlock')>()
  const CountedToolCallBlock = memo((props: ComponentProps<typeof actual.ToolCallBlock>) => {
    rendered.push(props.toolUseId ?? `child:${props.toolName}`)
    return <actual.ToolCallBlock {...props} />
  })
  return { ...actual, ToolCallBlock: CountedToolCallBlock }
})

// Counts renders of the row component itself: `ActivityToolRow` asks for its
// call's duration on every render, and nothing else in the group does. Without
// this a row that re-renders but feeds `ToolCallBlock` equal props goes unseen.
const rowRenders = vi.hoisted(() => [] as string[])
vi.mock('./activityGroupModel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./activityGroupModel')>()
  return {
    ...actual,
    toolCallDurationMs: (...args: Parameters<typeof actual.toolCallDurationMs>) => {
      rowRenders.push((args[0] as { id?: string }).id ?? '?')
      return actual.toolCallDurationMs(...args)
    },
  }
})

const { ActivityGroup } = await import('./ActivityGroup')

type ToolCall = Extract<UIMessage, { type: 'tool_use' }>
type ToolResult = Extract<UIMessage, { type: 'tool_result' }>

function bash(index: number, overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: `use-${index}`,
    type: 'tool_use',
    toolName: 'Bash',
    toolUseId: `bash-${index}`,
    input: { command: `bun test tests/vehicle-${index}.test.ts` },
    timestamp: index * 1_000,
    ...overrides,
  }
}

function resultFor(toolCall: ToolCall, content = `${toolCall.toolUseId} passed`): ToolResult {
  return {
    id: `result-${toolCall.toolUseId}`,
    type: 'tool_result',
    toolUseId: toolCall.toolUseId,
    content,
    isError: false,
    timestamp: toolCall.timestamp + 500,
  }
}

// What MessageList hands the group on each streamed token: the same message
// objects, inside steps and maps rebuilt from the whole transcript.
function snapshot(calls: ToolCall[], results: ToolResult[], children: Array<[string, ToolCall[]]> = []) {
  return {
    steps: calls.map((toolCall): ActivityStep => ({ kind: 'tool', toolCall })),
    resultMap: new Map(results.map((result) => [result.toolUseId, result])),
    childToolCallsByParent: new Map(children.map(([parent, calls]) => [parent, [...calls]])),
  }
}

describe('ActivityGroup re-rendering while a run streams (#1480)', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    rendered.length = 0
    rowRenders.length = 0
  })

  it('re-renders only the rows whose own call or result changed', () => {
    // A /goal run keeps every tool call in one open group. Rebuilding each row
    // for every token made a 1,400-row run stall the window for seconds.
    const calls = Array.from({ length: 40 }, (_, index) => bash(index))
    const results = calls.map((toolCall) => resultFor(toolCall))
    const { rerender } = render(<ActivityGroup {...snapshot(calls, results)} isLive isStreaming={false} />)
    expect(rendered).toHaveLength(40)

    rendered.length = 0
    rowRenders.length = 0
    rerender(<ActivityGroup {...snapshot(calls, results)} isLive isStreaming={false} />)
    expect(rendered).toEqual([])
    expect(rowRenders).toEqual([])

    const next = bash(40)
    rerender(<ActivityGroup {...snapshot([...calls, next], results)} isLive isStreaming />)
    expect(rendered).toEqual(['bash-40'])

    // While the run stays live, a further step touches only its own row.
    rendered.length = 0
    rowRenders.length = 0
    const after = bash(41)
    rerender(<ActivityGroup {...snapshot([...calls, next, after], results)} isLive isStreaming />)
    expect(rendered).toEqual(['bash-41'])
    expect(rowRenders).toEqual(['use-41'])

    rendered.length = 0
    const nextResult = resultFor(next, 'vehicle 40 passed')
    const afterResult = resultFor(after, 'vehicle 41 passed')
    rerender(
      <ActivityGroup {...snapshot([...calls, next, after], [...results, nextResult, afterResult])} isLive isStreaming={false} />,
    )
    expect(rendered).toEqual(['bash-40', 'bash-41'])
    expect(screen.getAllByTestId('activity-group')[0]).toHaveTextContent(/ran 42 commands/i)
  })

  it('stops showing a resultless row as running once a pinned-open run ends', () => {
    const calls = [bash(0), bash(1)]
    const results = [resultFor(calls[0]!)]
    const { rerender } = render(<ActivityGroup {...snapshot(calls, results)} isLive />)
    const group = screen.getByTestId('activity-group')
    const row = () => group.querySelector(`[data-chat-anchor-id="use-1"] [data-tool-status]`)
    expect(row()).toHaveAttribute('data-tool-status', 'running')

    // The reader folds and reopens it, which pins it open past the end of the run.
    const header = group.querySelector('[data-chat-disclosure="true"]')!
    fireEvent.click(header)
    fireEvent.click(header)
    rerender(<ActivityGroup {...snapshot(calls, results)} isLive={false} />)
    expect(group).toHaveAttribute('data-expanded', 'true')
    expect(row()).toHaveAttribute('data-tool-status', 'idle')
  })

  it('moves the locate-in-chat highlight onto a row and off it again', () => {
    const calls = [bash(0), bash(1)]
    const results = calls.map((toolCall) => resultFor(toolCall))
    const { rerender, container } = render(<ActivityGroup {...snapshot(calls, results)} isLive />)
    const highlighted = () => [...container.querySelectorAll('.chat-tool-navigation-target')]
      .map((node) => node.closest('[data-chat-anchor-id]')?.getAttribute('data-chat-anchor-id'))
    expect(highlighted()).toEqual([])

    rerender(<ActivityGroup {...snapshot(calls, results)} isLive revealToolUseId="bash-1" />)
    expect(highlighted()).toEqual(['use-1'])

    rerender(<ActivityGroup {...snapshot(calls, results)} isLive />)
    expect(highlighted()).toEqual([])
  })

  it('shows a call replaced under the same id, at the top level and under a parent', () => {
    const agent = bash(0, { toolName: 'Agent', toolUseId: 'agent-0', input: { description: 'Check vehicles' } })
    const child = bash(1, { toolUseId: 'agent-0/bash-1', parentToolUseId: 'agent-0' })
    const plain = bash(2)
    const { rerender, container } = render(
      <ActivityGroup {...snapshot([agent, plain], [], [['agent-0', [child]]])} isLive />,
    )
    const status = (id: string) => container.querySelector(`[data-chat-anchor-id="${id}"] [data-tool-status]`)
    expect(status('use-2')).toHaveAttribute('data-tool-status', 'running')
    expect(status('use-1')).toHaveAttribute('data-tool-status', 'running')

    // Stopping a turn replaces each pending call with a stopped copy of itself.
    const stoppedPlain: ToolCall = { ...plain, status: 'stopped' }
    const stoppedChild: ToolCall = { ...child, status: 'stopped' }
    rerender(<ActivityGroup {...snapshot([agent, stoppedPlain], [], [['agent-0', [stoppedChild]]])} isLive />)
    expect(status('use-2')).toHaveAttribute('data-tool-status', 'stopped')
    expect(status('use-1')).toHaveAttribute('data-tool-status', 'stopped')
  })

  it('still updates a row whose result is replaced, and a dispatched child under an unchanged parent', () => {
    const agent = bash(0, { toolName: 'Agent', toolUseId: 'agent-0', input: { description: 'Check vehicles' } })
    const child = bash(1, { toolUseId: 'agent-0/bash-1', parentToolUseId: 'agent-0' })
    const plain = bash(2)
    const plainResult = resultFor(plain)
    const childResult = resultFor(child, 'child finished')
    const calls = [agent, plain]
    const { rerender, container } = render(
      <ActivityGroup {...snapshot(calls, [plainResult], [['agent-0', [child]]])} isLive isStreaming />,
    )

    rendered.length = 0
    rerender(
      <ActivityGroup
        {...snapshot(calls, [plainResult, childResult], [['agent-0', [child]]])}
        isLive
        isStreaming
      />,
    )
    // The child row resolves without dragging its parent or its siblings along.
    expect(rendered).toEqual(['child:Bash'])
    const childRow = container.querySelector(`[data-chat-anchor-id="${child.id}"]`) as HTMLElement
    expect(within(childRow).queryByText(/running/i)).not.toBeInTheDocument()

    rendered.length = 0
    const corrected = { ...resultFor(plain, 'bash-2 failed'), isError: true }
    rerender(
      <ActivityGroup
        {...snapshot(calls, [corrected, childResult], [['agent-0', [child]]])}
        isLive
        isStreaming
      />,
    )
    expect(rendered).toEqual(['bash-2'])
    expect(screen.getByText('1 failed')).toBeInTheDocument()
  })

  it('re-renders a row when its approval state flips', () => {
    const calls = [bash(0), bash(1)]
    const { rerender } = render(
      <ActivityGroup {...snapshot(calls, [])} isLive isStreaming awaitingToolUseIds={new Set()} />,
    )
    rendered.length = 0
    rerender(<ActivityGroup {...snapshot(calls, [])} isLive isStreaming awaitingToolUseIds={new Set(['bash-1'])} />)
    expect(rendered).toEqual(['bash-1'])
  })
})
