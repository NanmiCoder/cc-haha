import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ActivityGroup } from './ActivityGroup'
import { buildActivitySegments, formatActivitySummary, type ActivityStep } from './activityGroupModel'
import { useSettingsStore } from '../../stores/settingsStore'
import { translate } from '../../i18n'
import type { UIMessage } from '../../types/chat'
import { PLAN_REJECTION_MESSAGE, PLAN_REJECTION_WITH_REASON_PREFIX } from '../../../../src/constants/messages'

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
    fireEvent.click(screen.getByTestId('activity-group').querySelector('[data-chat-disclosure="true"]')!)
    expect(view.container.querySelector('[data-chat-anchor-id="use-bash"]')).not.toBeNull()
    view.rerender(<ActivityGroup {...props} steps={[{ kind: 'tool', toolCall: readCall }, ...steps]} />)
    expect(view.container.querySelector('[data-chat-anchor-id="use-bash"]')).not.toBeNull()
  })

  it('defaults collapsed with a shimmer live step while running, expands on click, and settles into a borderless summary', () => {
    const steps: ActivityStep[] = [
      thinkingStep('think-1', '- Locate the five call sites first.\nThen patch each file.', 500),
      thinkingStep('think-2', 'Then check the retry path.', 800),
      { kind: 'tool', toolCall: readCall },
      { kind: 'tool', toolCall: bashCall },
    ]
    const inFlight = resultsOf([
      toolResult({ id: 'res-read', toolUseId: 'read-1', timestamp: 2_400 }),
    ])
    const settled = resultsOf([
      toolResult({ id: 'res-read', toolUseId: 'read-1', timestamp: 2_400 }),
      toolResult({ id: 'res-bash', toolUseId: 'bash-1', timestamp: 5_700 }),
    ])

    const { rerender } = render(
      <ActivityGroup steps={steps} resultMap={inFlight} childToolCallsByParent={new Map()} isLive isStreaming />,
    )
    let group = screen.getByTestId('activity-group')
    // Defaults collapsed even while live (zero live-to-collapsed layout cliff).
    expect(group.getAttribute('data-expanded')).toBe('false')
    expect(group.className).not.toContain('v6c-glass-card')
    expect(group.querySelector('[data-activity-live-label="true"]')).not.toBeNull()
    expect(group.querySelector('.codex-shimmer-text')).not.toBeNull()
    expect(within(group).getByText('bun run lint')).toBeTruthy()
    expect(within(group).queryByText('MessageList.tsx')).toBeNull()

    // Reader can click to inspect live steps at any time.
    fireEvent.click(group.querySelector('[data-chat-disclosure="true"]')!)
    expect(screen.getByTestId('activity-group').getAttribute('data-expanded')).toBe('true')
    expect(within(screen.getByTestId('activity-group')).getByText('MessageList.tsx')).toBeTruthy()

    // Fold back, then settle the turn: calm borderless counted digest.
    fireEvent.click(screen.getByTestId('activity-group').querySelector('[data-chat-disclosure="true"]')!)
    rerender(
      <ActivityGroup steps={steps} resultMap={settled} childToolCallsByParent={new Map()} isLive={false} />,
    )
    group = screen.getByTestId('activity-group')
    expect(group.getAttribute('data-expanded')).toBe('false')
    expect(within(group).queryByText('MessageList.tsx')).toBeNull()

    const summary = group.querySelector('[data-chat-disclosure="true"]')!
    expect(summary.className).toContain('codex-work-row')
    expect(summary.textContent).toContain('Thought 2 times')
    expect(summary.textContent).toContain('Read 1 file')
    expect(summary.textContent).toContain('ran a command')
  })

  it('stays collapsed calmly across the gaps between one tool resolving and the next starting', () => {
    const steps: ActivityStep[] = [
      { kind: 'tool', toolCall: readCall },
      { kind: 'tool', toolCall: bashCall },
    ]
    const renderWith = (resultMap: ReturnType<typeof resultsOf>) => (
      <ActivityGroup steps={steps} resultMap={resultMap} childToolCallsByParent={new Map()} isLive />
    )

    const { rerender } = render(renderWith(resultsOf([])))
    expect(screen.getByTestId('activity-group').getAttribute('data-expanded')).toBe('false')

    // Reader opens it once; it must stay pinned open across step boundaries.
    fireEvent.click(screen.getByTestId('activity-group').querySelector('[data-chat-disclosure="true"]')!)
    expect(screen.getByTestId('activity-group').getAttribute('data-expanded')).toBe('true')

    for (const resultMap of [
      resultsOf([
        toolResult({ id: 'res-read', toolUseId: 'read-1', timestamp: 2_400 }),
        toolResult({ id: 'res-bash', toolUseId: 'bash-1', timestamp: 5_700 }),
      ]),
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

  it.each([
    { content: PLAN_REJECTION_MESSAGE },
    { content: [{ type: 'text', text: `${PLAN_REJECTION_WITH_REASON_PREFIX}Add a rollback step.` }] },
  ])('keeps a returned plan visible without counting the user decision as a failure', ({ content }) => {
    render(
      <ActivityGroup
        steps={[
          { kind: 'tool', toolCall: toolCall({ id: 'plan-1', toolUseId: 'plan-1', toolName: 'ExitPlanMode' }) },
          { kind: 'tool', toolCall: toolCall({ id: 'plan-2', toolUseId: 'plan-2', toolName: 'ExitPlanMode' }) },
        ]}
        resultMap={resultsOf([
          toolResult({ id: 'result-1', toolUseId: 'plan-1', content, isError: true }),
          toolResult({ id: 'result-2', toolUseId: 'plan-2' }),
        ])}
        childToolCallsByParent={new Map()}
      />,
    )

    expect(screen.queryByText(t('toolGroup.failedCount', { count: 1 }))).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('activity-group').querySelector('[data-chat-disclosure="true"]')!)
    expect(screen.getByRole('button', { name: t('permission.planRejected') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('permission.planApproved') })).toBeInTheDocument()
  })

  it('still counts an actual ExitPlanMode error as a failure', () => {
    render(
      <ActivityGroup
        steps={[
          { kind: 'tool', toolCall: readCall },
          { kind: 'tool', toolCall: toolCall({ id: 'plan-1', toolUseId: 'plan-1', toolName: 'ExitPlanMode' }) },
        ]}
        resultMap={resultsOf([
          toolResult({ id: 'res-read', toolUseId: 'read-1' }),
          toolResult({ id: 'result-1', toolUseId: 'plan-1', content: 'Plan file unavailable', isError: true }),
        ])}
        childToolCallsByParent={new Map()}
      />,
    )

    expect(screen.getByText(t('toolGroup.failedCount', { count: 1 }))).toBeInTheDocument()
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

  it('hides red error chrome and failed badges for self-recovered intermediate tool failures', () => {
    const retryBash = toolCall({
      id: 'use-bash-2',
      toolUseId: 'bash-2',
      toolName: 'Bash',
      input: { command: 'bun run lint --fix' },
      timestamp: 4_000,
    })
    render(
      <ActivityGroup
        steps={[
          { kind: 'tool', toolCall: bashCall },
          { kind: 'tool', toolCall: retryBash },
        ]}
        resultMap={resultsOf([
          toolResult({
            id: 'res-bash',
            toolUseId: 'bash-1',
            content: 'Lint error\nExit code 1',
            isError: true,
            timestamp: 3_000,
          }),
          toolResult({
            id: 'res-bash-2',
            toolUseId: 'bash-2',
            content: 'ok',
            isError: false,
            timestamp: 5_000,
          }),
        ])}
        childToolCallsByParent={new Map()}
      />,
    )

    const group = screen.getByTestId('activity-group')
    expect(group.className).not.toContain('v6c-ring-error')
    expect(screen.queryByText(t('toolGroup.failedCount', { count: 1 }))).toBeNull()

    // Expanding shows the failed intermediate step quietly in monochrome.
    fireEvent.click(group.querySelector('[data-chat-disclosure="true"]')!)
    const failedRow = group.querySelector('[data-tool-use-id="bash-1"]')!
    expect(failedRow.getAttribute('data-tool-status')).toBe('recovered')
    expect(failedRow.getAttribute('data-tool-error-severity')).toBe('recovered')
    expect(failedRow.className).not.toContain('v6c-ring-error')
  })

  it('surfaces a single written filename in a collapsed multi-step summary for quick scanning', () => {
    const writeCall = toolCall({
      id: 'use-write',
      toolUseId: 'write-1',
      toolName: 'Write',
      input: { file_path: '/repo/ui-smoke-output.txt', content: 'hello' },
      timestamp: 3_000,
    })
    render(
      <ActivityGroup
        steps={[
          { kind: 'tool', toolCall: readCall },
          { kind: 'tool', toolCall: writeCall },
        ]}
        resultMap={resultsOf([
          toolResult({ id: 'res-read', toolUseId: 'read-1', timestamp: 1_400 }),
          toolResult({ id: 'res-write', toolUseId: 'write-1', timestamp: 3_500 }),
        ])}
        childToolCallsByParent={new Map()}
      />,
    )

    const group = screen.getByTestId('activity-group')
    expect(group.getAttribute('data-expanded')).toBe('false')
    expect(group.textContent).toContain('ui-smoke-output.txt')
  })

  it('hangs every row of an expanded run on one timeline rail', () => {
    const { container } = render(
      <ActivityGroup
        steps={[
          thinkingStep('think-1', 'Check the call sites.', 500),
          { kind: 'tool', toolCall: readCall },
          { kind: 'tool', toolCall: bashCall },
        ]}
        resultMap={resultsOf([
          toolResult({ id: 'res-read', toolUseId: 'read-1', timestamp: 1_400 }),
          toolResult({ id: 'res-bash', toolUseId: 'bash-1', timestamp: 3_000 }),
        ])}
        childToolCallsByParent={new Map()}
        isLive
      />,
    )

    fireEvent.click(screen.getByTestId('activity-group').querySelector('[data-chat-disclosure="true"]')!)

    const rail = container.querySelector('[data-tool-timeline]')!
    expect(rail).toBeTruthy()
    // Each tool is a node on the rail, led by its verb, never its raw name.
    const rows = rail.querySelectorAll('[data-tool-call-chrome="row"]')
    expect(rows).toHaveLength(2)
    expect(rail.querySelectorAll('[data-tool-node]')).toHaveLength(2)
    expect(rows[0]?.textContent).toContain(t('toolVerb.read'))
    expect(rows[1]?.textContent).toContain(t('toolVerb.run'))
    expect(rows[1]?.textContent).not.toContain('Bash')
  })

  it('marks a call waiting on a permission prompt amber, in its row and in the header', () => {
    render(
      <ActivityGroup
        steps={[
          { kind: 'tool', toolCall: readCall },
          { kind: 'tool', toolCall: bashCall },
        ]}
        resultMap={resultsOf([toolResult({ id: 'res-read', toolUseId: 'read-1', timestamp: 1_400 })])}
        childToolCallsByParent={new Map()}
        awaitingToolUseIds={new Set(['bash-1'])}
        isLive
      />,
    )

    const group = screen.getByTestId('activity-group')
    expect(group.querySelector('[data-chat-disclosure="true"]')?.textContent).toContain(t('permission.awaitingApproval'))
    fireEvent.click(group.querySelector('[data-chat-disclosure="true"]')!)
    const waiting = group.querySelector('[data-tool-status="waiting"]')
    expect(waiting?.closest('[data-chat-anchor-id]')?.getAttribute('data-chat-anchor-id')).toBe('use-bash')
    expect(group.querySelector('[data-tool-status="done"]')?.closest('[data-chat-anchor-id]')?.getAttribute('data-chat-anchor-id')).toBe('use-read')
  })

  it('shows a resultless call as running only while its run is live', () => {
    const props = {
      steps: [
        { kind: 'tool' as const, toolCall: readCall },
        { kind: 'tool' as const, toolCall: bashCall },
      ],
      resultMap: resultsOf([toolResult({ id: 'res-read', toolUseId: 'read-1', timestamp: 1_400 })]),
      childToolCallsByParent: new Map(),
    }
    const { rerender } = render(<ActivityGroup {...props} isLive />)
    let group = screen.getByTestId('activity-group')
    expect(group.querySelector('[data-activity-live-label="true"]')).toBeTruthy()
    fireEvent.click(group.querySelector('[data-chat-disclosure="true"]')!)
    expect(group.querySelector('[data-tool-status="running"]')).toBeTruthy()

    // A replayed transcript whose last call never got a result is not running —
    // the process that would have produced it is gone.
    rerender(<ActivityGroup {...props} isLive={false} />)
    group = screen.getByTestId('activity-group')
    expect(group.querySelector('[data-activity-live-label="true"]')).toBeNull()
    expect(group.querySelector('[data-tool-status="running"]')).toBeNull()
    expect(group.querySelector('[data-tool-status="idle"]')).toBeTruthy()
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
        { kind: 'tool', toolCall: toolCall({ id: 'a', toolUseId: 'a', toolName: 'mcp__linear__create_issue' }) },
        { kind: 'tool', toolCall: toolCall({ id: 'b', toolUseId: 'b', toolName: 'SendMessage' }) },
        { kind: 'tool', toolCall: toolCall({ id: 'c', toolUseId: 'c', toolName: 'SendMessage' }) },
      ],
      t,
    )

    // Which tool ran is the point; a single call drops the redundant "(1)".
    expect(segments.map((segment) => segment.label)).toEqual(['mcp__linear__create_issue', 'SendMessage (2)'])
  })

  it('says what happened to the todo list instead of printing TodoWrite', () => {
    const segments = buildActivitySegments(
      [
        { kind: 'tool', toolCall: toolCall({ id: 'a', toolUseId: 'a', toolName: 'TodoWrite' }) },
        { kind: 'tool', toolCall: toolCall({ id: 'b', toolUseId: 'b', toolName: 'TodoWrite' }) },
      ],
      t,
    )
    expect(segments.map((segment) => segment.label)).toEqual([t('toolGroup.updatedTodos')])
    expect(segments[0]?.label).not.toContain('TodoWrite')
  })

  it('folds the four task tools into one clause', () => {
    const segments = buildActivitySegments(
      ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskUpdate'].map((toolName, index) => (
        { kind: 'tool' as const, toolCall: toolCall({ id: `t${index}`, toolUseId: `t${index}`, toolName }) }
      )),
      t,
    )
    expect(segments.map((segment) => segment.label)).toEqual([t('toolGroup.managedTasks')])
  })

  it('joins clauses with the locale\'s own list mark', () => {
    const steps: ActivityStep[] = [
      { kind: 'tool', toolCall: toolCall({ id: 'a', toolUseId: 'a', toolName: 'Grep' }) },
      { kind: 'tool', toolCall: toolCall({ id: 'b', toolUseId: 'b', toolName: 'Read' }) },
      { kind: 'tool', toolCall: toolCall({ id: 'c', toolUseId: 'c', toolName: 'Read' }) },
    ]
    const zh = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate('zh', key, params)
    const zhSummary = formatActivitySummary(buildActivitySegments(steps, zh), zh)
    expect(zhSummary).toBe(`${zh('toolGroup.searchedOne')}、${zh('toolGroup.readMany', { count: 2 })}`)
    expect(zhSummary).not.toContain(',')
    expect(formatActivitySummary(buildActivitySegments(steps, t), t)).toBe(`${t('toolGroup.searchedOne')}, ${t('toolGroup.readMany', { count: 2 })}`)
  })
})

describe('ActivityGroup on a phone', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  const read = toolCall({ id: 'use-read', toolUseId: 'read-1', toolName: 'Read', input: { file_path: '/repo/src/todo.ts' }, timestamp: 1_000 })
  const bash = toolCall({ id: 'use-bash', toolUseId: 'bash-1', toolName: 'Bash', input: { command: 'bun test' }, timestamp: 2_000 })
  const steps: ActivityStep[] = [{ kind: 'tool', toolCall: read }, { kind: 'tool', toolCall: bash }]

  it('folds a finished run into a borderless work row and opens the whole timeline in a sheet', () => {
    render(
      <ActivityGroup
        presentation="sheet"
        steps={steps}
        resultMap={resultsOf([
          toolResult({ id: 'r1', toolUseId: 'read-1', timestamp: 1_500 }),
          toolResult({ id: 'r2', toolUseId: 'bash-1', timestamp: 3_000 }),
        ])}
        childToolCallsByParent={new Map()}
      />,
    )

    const group = screen.getByTestId('activity-group')
    expect(group).toHaveAttribute('data-presentation', 'sheet')
    expect(group.className).not.toContain('bg-[var(--color-surface-container-lowest)]')
    expect(group.className).not.toContain('border-[var(--color-border)]')
    expect(group).toHaveTextContent(formatActivitySummary(buildActivitySegments(steps, t), t))
    // Nothing unfolds in place: the transcript keeps its place on a small screen.
    expect(within(group).queryByText('bun test')).toBeNull()
    expect(screen.queryByTestId('activity-live-step')).toBeNull()

    const trigger = within(group).getByRole('button')
    expect(trigger).toHaveClass('codex-work-row', 'min-h-11', 'rounded-[var(--radius-sm)]')
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const sheet = screen.getByTestId('activity-timeline-sheet')
    expect(within(sheet).getByText('bun test')).toBeTruthy()
  })

  it('shows the active step inline with calm shimmer while the run is live', () => {
    render(
      <ActivityGroup
        presentation="sheet"
        steps={steps}
        resultMap={resultsOf([toolResult({ id: 'r1', toolUseId: 'read-1', timestamp: 1_500 })])}
        childToolCallsByParent={new Map()}
        isLive
      />,
    )

    const group = screen.getByTestId('activity-group')
    expect(group).toHaveAttribute('data-running', 'true')
    expect(screen.queryByTestId('activity-live-step')).toBeNull()
    expect(group.querySelector('[data-activity-live-label="true"]')).not.toBeNull()
    expect(group.querySelector('.codex-shimmer-text')).not.toBeNull()
    expect(within(group).getByText('bun test')).toBeTruthy()
  })

  it('keeps self-recovered failures quiet and only highlights blocking errors', () => {
    const retryBash = toolCall({
      id: 'use-bash-2',
      toolUseId: 'bash-2',
      toolName: 'Bash',
      input: { command: 'bun test --retry' },
      timestamp: 3_500,
    })
    const { rerender } = render(
      <ActivityGroup
        presentation="sheet"
        steps={[{ kind: 'tool', toolCall: bash }, { kind: 'tool', toolCall: retryBash }]}
        resultMap={resultsOf([
          toolResult({ id: 'r-fail', toolUseId: 'bash-1', content: 'Exit code 1', isError: true, timestamp: 3_000 }),
          toolResult({ id: 'r-ok', toolUseId: 'bash-2', content: 'ok', isError: false, timestamp: 4_000 }),
        ])}
        childToolCallsByParent={new Map()}
      />,
    )

    expect(screen.queryByText(t('toolGroup.failedCount', { count: 1 }))).toBeNull()

    rerender(
      <ActivityGroup
        presentation="sheet"
        steps={steps}
        resultMap={resultsOf([
          toolResult({ id: 'r1', toolUseId: 'read-1', timestamp: 1_500 }),
          toolResult({ id: 'r2', toolUseId: 'bash-1', content: 'Exit code 1', isError: true, timestamp: 3_000 }),
        ])}
        childToolCallsByParent={new Map()}
      />,
    )

    const failedBadge = screen.getByText(t('toolGroup.failedCount', { count: 1 }))
    expect(failedBadge).toHaveClass('text-[var(--color-error)]')
  })

  it('keeps single-step runs on the same calm sheet disclosure', () => {
    render(
      <ActivityGroup
        presentation="sheet"
        steps={[{ kind: 'tool', toolCall: bash }]}
        resultMap={resultsOf([toolResult({ id: 'r2', toolUseId: 'bash-1', timestamp: 3_000 })])}
        childToolCallsByParent={new Map()}
      />,
    )
    const group = screen.getByTestId('activity-group')
    expect(group).toHaveAttribute('data-presentation', 'sheet')
    expect(within(group).getByRole('button')).toHaveClass('codex-work-row', 'min-h-11')
    expect(within(group).getByText('bun test')).toBeTruthy()
  })
})
