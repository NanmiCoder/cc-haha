import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { ActivityGroup } from './ActivityGroup'
import { buildActivitySegments, type ActivityStep } from './activityGroupModel'
import { useSettingsStore } from '../../stores/settingsStore'
import { translate } from '../../i18n'
import type { UIMessage } from '../../types/chat'

type ToolCall = Extract<UIMessage, { type: 'tool_use' }>
type ToolResult = Extract<UIMessage, { type: 'tool_result' }>

function toolCall(overrides: Partial<ToolCall> & Pick<ToolCall, 'id' | 'toolUseId' | 'toolName'>): ToolCall {
  return {
    type: 'tool_use',
    input: {},
    timestamp: 0,
    ...overrides,
  }
}

function toolResult(overrides: Partial<ToolResult> & Pick<ToolResult, 'id' | 'toolUseId'>): ToolResult {
  return {
    type: 'tool_result',
    content: 'ok',
    isError: false,
    timestamp: 0,
    ...overrides,
  }
}

function thinkingStep(id: string, content: string, timestamp = 0): ActivityStep {
  return { kind: 'thinking', message: { id, type: 'thinking', content, timestamp } }
}

function resultsOf(results: ToolResult[]): Map<string, ToolResult> {
  return new Map(results.map((result) => [result.toolUseId, result]))
}

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate('en', key, params)

describe('ActivityGroup', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  const readCall = toolCall({
    id: 'use-read',
    toolUseId: 'read-1',
    toolName: 'Read',
    input: { file_path: '/repo/src/MessageList.tsx' },
    timestamp: 1_000,
  })
  const bashCall = toolCall({
    id: 'use-bash',
    toolUseId: 'bash-1',
    toolName: 'Bash',
    input: { command: 'bun run lint' },
    timestamp: 2_000,
  })

  it('keeps stable tool anchors when an expanded group gains older steps', () => {
    const steps: ActivityStep[] = [{ kind: 'tool', toolCall: bashCall }]
    const props = { steps, resultMap: new Map(), childToolCallsByParent: new Map(), isStreaming: true, isLive: true }
    const view = render(<ActivityGroup {...props} />)
    expect(view.container.querySelector('[data-chat-anchor-id="use-bash"]')).not.toBeNull()
    view.rerender(<ActivityGroup {...props} steps={[{ kind: 'tool', toolCall: readCall }, ...steps]} />)
    expect(view.container.querySelector('[data-chat-anchor-id="use-bash"]')).not.toBeNull()
  })

  it('plays open while live, then folds itself into a counted summary', () => {
    const steps: ActivityStep[] = [
      thinkingStep('think-1', '- Locate the five call sites first.\nThen patch each file.', 500),
      thinkingStep('think-2', 'Then check the retry path.', 800),
      { kind: 'tool', toolCall: readCall },
      { kind: 'tool', toolCall: bashCall },
    ]
    const settled = resultsOf([
      toolResult({ id: 'res-read', toolUseId: 'read-1', timestamp: 2_400 }),
      toolResult({ id: 'res-bash', toolUseId: 'bash-1', timestamp: 5_700 }),
    ])

    const { rerender } = render(
      <ActivityGroup steps={steps} resultMap={settled} childToolCallsByParent={new Map()} isLive />,
    )
    let group = screen.getByTestId('activity-group')
    expect(group.getAttribute('data-expanded')).toBe('true')
    expect(within(group).getByText('MessageList.tsx')).toBeTruthy()

    // The turn moves on: rows fold away and the counted digest stands in for
    // them, so finished machinery stops competing with the prose around it.
    rerender(
      <ActivityGroup steps={steps} resultMap={settled} childToolCallsByParent={new Map()} isLive={false} />,
    )
    group = screen.getByTestId('activity-group')
    expect(group.getAttribute('data-expanded')).toBe('false')
    expect(within(group).queryByText('MessageList.tsx')).toBeNull()

    // Counted per family, thinking included — scale is the point of the line.
    const summary = group.querySelector('[data-chat-disclosure="true"]')!
    expect(summary.textContent).toContain('Thought 2 times')
    expect(summary.textContent).toContain('Read 1 file')
    expect(summary.textContent).toContain('ran a command')
  })

  it('stays open across the gaps between one tool resolving and the next starting', () => {
    // The bug this pins: a live run folds and reopens on every step boundary,
    // because "a tool is executing right now" goes false in each gap. Six tools
    // meant six open/shut cycles under a reader trying to watch the work.
    const steps: ActivityStep[] = [
      { kind: 'tool', toolCall: readCall },
      { kind: 'tool', toolCall: bashCall },
    ]
    const renderWith = (resultMap: ReturnType<typeof resultsOf>) => (
      <ActivityGroup steps={steps} resultMap={resultMap} childToolCallsByParent={new Map()} isLive />
    )

    const { rerender } = render(renderWith(resultsOf([])))
    expect(screen.getByTestId('activity-group').getAttribute('data-expanded')).toBe('true')

    for (const resultMap of [
      // Everything resolved — the lull the group used to collapse into.
      resultsOf([
        toolResult({ id: 'res-read', toolUseId: 'read-1', timestamp: 2_400 }),
        toolResult({ id: 'res-bash', toolUseId: 'bash-1', timestamp: 5_700 }),
      ]),
      // The next step starts, and the cycle would have repeated.
      resultsOf([toolResult({ id: 'res-read', toolUseId: 'read-1', timestamp: 2_400 })]),
    ]) {
      rerender(renderWith(resultMap))
      expect(screen.getByTestId('activity-group').getAttribute('data-expanded')).toBe('true')
    }
  })

  it('keeps the reader\'s choice once they open a settled run', () => {
    const settled = {
      steps: [
        thinkingStep('think-1', 'Check the call sites.', 500),
        { kind: 'tool' as const, toolCall: readCall },
      ],
      resultMap: resultsOf([toolResult({ id: 'res-read', toolUseId: 'read-1', timestamp: 2_400 })]),
      childToolCallsByParent: new Map(),
    }

    const { rerender } = render(<ActivityGroup {...settled} />)
    const group = screen.getByTestId('activity-group')
    expect(group.getAttribute('data-expanded')).toBe('false')

    fireEvent.click(group.querySelector('[data-chat-disclosure="true"]')!)
    expect(screen.getByTestId('activity-group').getAttribute('data-expanded')).toBe('true')

    // A later refresh must not snap it shut again under the reader.
    rerender(<ActivityGroup {...settled} />)
    expect(screen.getByTestId('activity-group').getAttribute('data-expanded')).toBe('true')

    fireEvent.click(screen.getByTestId('activity-group').querySelector('[data-chat-disclosure="true"]')!)
    expect(screen.getByTestId('activity-group').getAttribute('data-expanded')).toBe('false')
  })

  it('keeps each row openable for its own detail', () => {
    render(
      <ActivityGroup
        steps={[{ kind: 'tool', toolCall: bashCall }, { kind: 'tool', toolCall: readCall }]}
        resultMap={resultsOf([
          toolResult({ id: 'res-bash', toolUseId: 'bash-1', content: 'ok', timestamp: 3_000 }),
          toolResult({ id: 'res-read', toolUseId: 'read-1', timestamp: 1_400 }),
        ])}
        childToolCallsByParent={new Map()}
      />,
    )

    const group = screen.getByTestId('activity-group')
    // Settled, so it starts folded; open the run before reaching for a row.
    fireEvent.click(group.querySelector('[data-chat-disclosure="true"]')!)
    expect(group.querySelectorAll('[data-tool-call-details]')).toHaveLength(0)

    fireEvent.click(within(group).getByText('bun run lint'))

    // Opening one row reveals that row's detail and leaves the others closed.
    expect(group.querySelectorAll('[data-tool-call-details]')).toHaveLength(1)
    expect(within(group).getByText('MessageList.tsx')).toBeTruthy()
  })

  it('makes a lone tool call its own header row rather than hiding it behind a summary', () => {
    render(
      <ActivityGroup
        steps={[{ kind: 'tool', toolCall: readCall }]}
        resultMap={resultsOf([toolResult({ id: 'res-read', toolUseId: 'read-1', timestamp: 2_400 })])}
        childToolCallsByParent={new Map()}
      />,
    )

    const group = screen.getByTestId('activity-group')
    expect(group.getAttribute('data-single-step')).toBe('true')
    // The file is readable without a click; "Read 1 file" would say less.
    expect(within(group).getByText('MessageList.tsx')).toBeTruthy()
    expect(within(group).queryByText('Read 1 file')).toBeNull()
  })

  it('counts failed steps in the header while the run still reports its duration', () => {
    render(
      <ActivityGroup
        steps={[
          { kind: 'tool', toolCall: readCall },
          { kind: 'tool', toolCall: bashCall },
        ]}
        resultMap={resultsOf([
          toolResult({ id: 'res-read', toolUseId: 'read-1', timestamp: 1_400 }),
          toolResult({
            id: 'res-bash',
            toolUseId: 'bash-1',
            content: 'IndentationError',
            isError: true,
            timestamp: 3_000,
          }),
        ])}
        childToolCallsByParent={new Map()}
      />,
    )

    expect(screen.getByText(t('toolGroup.failedCount', { count: 1 }))).toBeTruthy()
  })

  it('reports the run as running while any step is still unresolved', () => {
    render(
      <ActivityGroup
        steps={[
          { kind: 'tool', toolCall: readCall },
          { kind: 'tool', toolCall: bashCall },
        ]}
        resultMap={resultsOf([toolResult({ id: 'res-read', toolUseId: 'read-1', timestamp: 1_400 })])}
        childToolCallsByParent={new Map()}
      />,
    )

    // There is no whole-run duration to get wrong any more: each row times
    // itself, so an unfinished step simply has no time yet rather than
    // suppressing a total that covered finished steps too.
    expect(screen.getByTestId('activity-group').getAttribute('data-running')).toBe('true')
  })

  it('reports a run as finished once every step has a result', () => {
    render(
      <ActivityGroup
        steps={[
          { kind: 'tool', toolCall: readCall },
          { kind: 'tool', toolCall: bashCall },
        ]}
        resultMap={resultsOf([
          toolResult({ id: 'res-read', toolUseId: 'read-1', timestamp: 1_400 }),
          toolResult({ id: 'res-bash', toolUseId: 'bash-1', timestamp: 3_000 }),
        ])}
        childToolCallsByParent={new Map()}
      />,
    )

    expect(screen.getByTestId('activity-group').getAttribute('data-running')).toBe('false')
  })
})

describe('buildActivitySegments', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('keeps families in first-appearance order and counts repeats', () => {
    const segments = buildActivitySegments(
      [
        { kind: 'tool', toolCall: toolCall({ id: 'a', toolUseId: 'a', toolName: 'Bash' }) },
        { kind: 'tool', toolCall: toolCall({ id: 'b', toolUseId: 'b', toolName: 'Read' }) },
        { kind: 'tool', toolCall: toolCall({ id: 'c', toolUseId: 'c', toolName: 'Read' }) },
      ],
      t,
    )

    expect(segments.map((segment) => segment.label)).toEqual(['ran a command', 'Read 2 files'])
  })

  it('places thinking where it happened and counts it like any other family', () => {
    const segments = buildActivitySegments(
      [
        { kind: 'tool', toolCall: toolCall({ id: 'a', toolUseId: 'a', toolName: 'Bash' }) },
        thinkingStep('t1', 'first'),
        thinkingStep('t2', 'second'),
      ],
      t,
    )

    // Counted now that this line is all a settled run shows: going back and
    // forth twice is a different run from going straight through, and that is
    // exactly the kind of shape the summary exists to convey.
    expect(segments.map((segment) => segment.label)).toEqual(['ran a command', 'Thought 2 times'])
  })

  it('leaves a single thought uncounted', () => {
    const segments = buildActivitySegments([thinkingStep('t1', 'only once')], t)
    expect(segments.map((segment) => segment.label)).toEqual(['Thinking'])
  })

  it('names a verbless tool rather than hiding it behind a generic count', () => {
    const segments = buildActivitySegments(
      [
        { kind: 'tool', toolCall: toolCall({ id: 'a', toolUseId: 'a', toolName: 'TaskUpdate' }) },
        { kind: 'tool', toolCall: toolCall({ id: 'b', toolUseId: 'b', toolName: 'SendMessage' }) },
        { kind: 'tool', toolCall: toolCall({ id: 'c', toolUseId: 'c', toolName: 'SendMessage' }) },
      ],
      t,
    )

    // Which tool ran is the point; a single call drops the redundant "(1)".
    expect(segments.map((segment) => segment.label)).toEqual(['TaskUpdate', 'SendMessage (2)'])
  })
})
