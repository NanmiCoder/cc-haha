import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MessageList, buildRenderModel, shouldVirtualizeRenderItems } from './MessageList'
import type { VirtualRenderItemMetric } from './virtualHeightCache'
import { relativizeWorkspacePath } from './CurrentTurnChangeCard'
import { sessionsApi } from '../../api/sessions'
import { useChatStore } from '../../stores/chatStore'
import { useWorkspaceChatContextStore } from '../../stores/workspaceChatContextStore'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import type { UIMessage } from '../../types/chat'
import type { PerSessionState } from '../../stores/chatStore'

const ACTIVE_TAB = 'active-tab'

async function waitForProgrammaticScrollReset() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })
  })
}

function makeSessionState(overrides: Partial<PerSessionState> = {}): PerSessionState {
  return {
    messages: [],
    chatState: 'idle',
    connectionState: 'connected',
    streamingText: '',
    streamingToolInput: '',
    activeToolUseId: null,
    activeToolName: null,
    activeThinkingId: null,
    pendingPermission: null,
    pendingComputerUsePermission: null,
    tokenUsage: { input_tokens: 0, output_tokens: 0 },
    streamingResponseChars: 0,
    elapsedSeconds: 0,
    statusVerb: '',
    apiRetry: null,
    slashCommands: [],
    agentTaskNotifications: {},
    elapsedTimer: null,
    composerPrefill: null,
    ...overrides,
  }
}

function findTextNodeContaining(container: Element, text: string) {
  const walker = document.createTreeWalker(container, 4)
  let current = walker.nextNode()
  while (current) {
    if (current.textContent?.includes(text)) return current
    current = walker.nextNode()
  }
  throw new Error(`Unable to find text node containing ${text}`)
}

async function waitForSelectionMenuUpdate() {
  await act(async () => {
    await Promise.resolve()
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })
  })
}

function prepareMessageTextSelection(
  element: Element,
  text: string,
  rect: Partial<DOMRect> = {},
) {
  const textNode = findTextNodeContaining(element, text)
  const startOffset = textNode.textContent?.indexOf(text) ?? -1
  const range = document.createRange()
  range.setStart(textNode, startOffset)
  range.setEnd(textNode, startOffset + text.length)
  Object.assign(range, {
    getBoundingClientRect: () => ({
      left: rect.left ?? 160,
      top: rect.top ?? 80,
      right: rect.right ?? 280,
      bottom: rect.bottom ?? 98,
      width: rect.width ?? 120,
      height: rect.height ?? 18,
      x: rect.x ?? rect.left ?? 160,
      y: rect.y ?? rect.top ?? 80,
      toJSON: () => ({}),
    }),
  })

  const selectableRoot = element.closest('[data-message-shell]')?.parentElement?.parentElement
  Object.assign(selectableRoot ?? element, {
    getBoundingClientRect: () => ({
      left: 120,
      top: 48,
      right: 620,
      bottom: 240,
      width: 500,
      height: 192,
      x: 120,
      y: 48,
      toJSON: () => ({}),
    }),
  })

  window.getSelection()?.removeAllRanges()
  window.getSelection()?.addRange(range)

  return selectableRoot ?? element
}

async function selectMessageText(
  element: Element,
  text: string,
  rect: Partial<DOMRect> = {},
) {
  prepareMessageTextSelection(element, text, rect)

  await act(async () => {
    fireEvent.pointerDown(element, {
      button: 0,
      clientX: rect.left ?? 160,
      clientY: rect.top ?? 80,
      pointerId: 1,
      pointerType: 'mouse',
    })
    fireEvent.pointerUp(element, {
      button: 0,
      clientX: rect.right ?? 280,
      clientY: rect.bottom ?? 98,
      pointerId: 1,
      pointerType: 'mouse',
    })
    fireEvent.mouseUp(element, { clientX: 260, clientY: 104 })
    await Promise.resolve()
  })
  await waitForSelectionMenuUpdate()
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Add to chat' })).toBeTruthy()
  })
}

async function selectAcrossMessageText(
  startElement: Element,
  startText: string,
  endElement: Element,
  endText: string,
  rect: Partial<DOMRect> = {},
) {
  const startNode = findTextNodeContaining(startElement, startText)
  const endNode = findTextNodeContaining(endElement, endText)
  const startOffset = startNode.textContent?.indexOf(startText) ?? -1
  const endOffset = (endNode.textContent?.indexOf(endText) ?? -1) + endText.length
  const range = document.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  Object.assign(range, {
    getBoundingClientRect: () => ({
      left: rect.left ?? 160,
      top: rect.top ?? 80,
      right: rect.right ?? 520,
      bottom: rect.bottom ?? 150,
      width: rect.width ?? 360,
      height: rect.height ?? 70,
      x: rect.x ?? rect.left ?? 160,
      y: rect.y ?? rect.top ?? 80,
      toJSON: () => ({}),
    }),
  })

  const selectableRoot = startElement.closest('[data-message-shell]')?.parentElement?.parentElement
  Object.assign(selectableRoot ?? startElement, {
    getBoundingClientRect: () => ({
      left: 120,
      top: 48,
      right: 720,
      bottom: 320,
      width: 600,
      height: 272,
      x: 120,
      y: 48,
      toJSON: () => ({}),
    }),
  })

  window.getSelection()?.removeAllRanges()
  window.getSelection()?.addRange(range)

  await act(async () => {
    fireEvent.pointerDown(startElement, {
      button: 0,
      clientX: rect.left ?? 160,
      clientY: rect.top ?? 80,
      pointerId: 1,
      pointerType: 'mouse',
    })
    fireEvent.pointerUp(endElement, {
      button: 0,
      clientX: rect.right ?? 520,
      clientY: rect.bottom ?? 150,
      pointerId: 1,
      pointerType: 'mouse',
    })
    await Promise.resolve()
  })
  await waitForSelectionMenuUpdate()
}

describe('MessageList nested tool calls', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ pendingSettingsTab: null })
    useTabStore.setState({ activeTabId: ACTIVE_TAB, tabs: [{ sessionId: ACTIVE_TAB, title: 'Test', type: 'session' as const, status: 'idle' }] })
    useSessionStore.setState({ sessions: [], activeSessionId: null, isLoading: false, error: null })
    useChatStore.setState({ sessions: { [ACTIVE_TAB]: makeSessionState() } })
    useWorkspaceChatContextStore.setState(useWorkspaceChatContextStore.getInitialState(), true)
    // The workspace panel store is a shared singleton; reset it so preview tabs opened by
    // one test (clicking a change-card row) don't dedupe/leak into the next test.
    useWorkspacePanelStore.setState(useWorkspacePanelStore.getInitialState(), true)
    vi.spyOn(sessionsApi, 'getTurnCheckpoints').mockImplementation(
      () => new Promise(() => {}),
    )
    vi.spyOn(sessionsApi, 'getWorkspaceStatus').mockResolvedValue({
      state: 'ok',
      workDir: '/tmp/example-project',
      repoName: 'example-project',
      branch: null,
      isGitRepo: false,
      changedFiles: [],
    })
  })

  it('windows long transcripts instead of mounting every historical message at once', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: Array.from({ length: 220 }, (_, index) => ({
            id: `assistant-${index}`,
            type: 'assistant_text',
            content: index % 25 === 0
              ? [
                  `assistant transcript line ${index}`,
                  '',
                  '```ts',
                  'const value = "this intentionally makes the row much taller"',
                  '```',
                ].join('\n')
              : `assistant transcript line ${index}`,
            timestamp: index,
          })),
        }),
      },
    })

    const { container } = render(<MessageList />)

    expect(screen.getByText('assistant transcript line 219')).toBeTruthy()
    expect(screen.queryByText('assistant transcript line 0')).toBeNull()
    expect(container.querySelectorAll('[data-message-shell="assistant"]').length).toBeLessThan(220)
    expect(container.querySelector('[data-virtual-message-item]')).not.toBeNull()
    expect(container.querySelector('[data-virtual-spacer="top"]')).not.toBeNull()
    // Virtualized window items must NOT get content-visibility: it zeroes their
    // ResizeObserver-measured height in the virtualizer (the regression this guards).
    for (const item of container.querySelectorAll('[data-virtual-message-item]')) {
      expect((item as HTMLElement).className).not.toContain('chat-render-item--cv')
    }
  })

  it('keeps small transcripts fully mounted without deferred browser painting', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: 'first assistant reply',
              timestamp: 1,
            },
            {
              id: 'assistant-2',
              type: 'assistant_text',
              content: 'second assistant reply',
              timestamp: 2,
            },
          ],
        }),
      },
    })

    const { container } = render(<MessageList />)
    const renderItems = container.querySelectorAll('.chat-render-item')

    expect(renderItems).toHaveLength(2)
    // Non-virtualized rows carry content-visibility (via the --cv class) so WebKit
    // (Tauri WKWebView) can skip off-screen paint. Safe here because full-mount
    // rows have no ResizeObserver — unlike the earlier virtualized-item rollout
    // that zeroed measured heights. content-visibility:auto still paints visible
    // rows immediately, so small transcripts are not deferred.
    for (const item of renderItems) {
      expect(item.className).toContain('chat-render-item--cv')
    }
    expect(container.querySelector('[data-virtual-message-item]')).toBeNull()
  })

  it('virtualizes short message lists when their content is very large', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'user-huge',
              type: 'user_text',
              content: '超长设计内容 '.repeat(24_000),
              timestamp: 1,
            },
            {
              id: 'assistant-tail',
              type: 'assistant_text',
              content: 'latest assistant reply',
              timestamp: 2,
            },
          ],
        }),
      },
    })

    const { container } = render(<MessageList />)

    expect(container.querySelector('[data-virtual-message-item]')).not.toBeNull()
    expect(screen.getByText('latest assistant reply')).toBeTruthy()
  })

  it('filters duplicate unresolved AskUserQuestion cards while a matching permission is pending', () => {
    const messages: UIMessage[] = [
      {
        id: 'stale-ask',
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolUseId: 'stale-tool',
        input: {
          questions: [
            {
              question: 'Restore this context?',
              options: [{ label: 'No' }, { label: 'Yes' }],
            },
          ],
        },
        timestamp: 1,
      },
      {
        id: 'active-ask',
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolUseId: 'active-tool',
        input: {
          questions: [
            {
              question: 'Restore this context?',
              options: [{ label: 'No' }, { label: 'Yes' }],
            },
          ],
        },
        timestamp: 2,
      },
    ]

    const { renderItems } = buildRenderModel(messages, 'active-tool')

    expect(renderItems).toHaveLength(1)
    expect(renderItems[0]).toMatchObject({
      kind: 'message',
      message: {
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolUseId: 'active-tool',
      },
    })
  })

  it('keeps resolved AskUserQuestion history visible when filtering active duplicates', () => {
    const messages: UIMessage[] = [
      {
        id: 'answered-ask',
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolUseId: 'answered-tool',
        input: {
          questions: [
            {
              question: 'Already answered?',
              options: [{ label: 'No' }, { label: 'Yes' }],
            },
          ],
        },
        timestamp: 1,
      },
      {
        id: 'answered-result',
        type: 'tool_result',
        toolUseId: 'answered-tool',
        content: { answers: { 'Already answered?': 'Yes' } },
        isError: false,
        timestamp: 2,
      },
      {
        id: 'active-ask',
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolUseId: 'active-tool',
        input: {
          questions: [
            {
              question: 'Restore this context?',
              options: [{ label: 'No' }, { label: 'Yes' }],
            },
          ],
        },
        timestamp: 3,
      },
    ]

    const { renderItems } = buildRenderModel(messages, 'active-tool')

    expect(renderItems).toHaveLength(2)
    expect(renderItems.map((item) => item.kind === 'message' && item.message.type === 'tool_use'
      ? item.message.toolUseId
      : null,
    )).toEqual(['answered-tool', 'active-tool'])
  })

  it('keeps only the latest unresolved AskUserQuestion when no pending permission is active', () => {
    const messages: UIMessage[] = [
      {
        id: 'first-ask',
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolUseId: 'first-tool',
        input: {
          questions: [
            {
              question: 'First question?',
              options: [{ label: 'A' }, { label: 'B' }],
            },
          ],
        },
        timestamp: 1,
      },
      {
        id: 'second-ask',
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolUseId: 'second-tool',
        input: {
          questions: [
            {
              question: 'Second question?',
              options: [{ label: 'A' }, { label: 'B' }],
            },
          ],
        },
        timestamp: 2,
      },
    ]

    const { renderItems } = buildRenderModel(messages, null)

    expect(renderItems).toHaveLength(1)
    expect(renderItems[0]).toMatchObject({
      kind: 'message',
      message: {
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolUseId: 'second-tool',
      },
    })
  })

  it('renders goal events as visible status cards', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [{
            id: 'goal-1',
            type: 'goal_event',
            action: 'created',
            status: 'active',
            objective: 'ship the smoke test',
            budget: '0 / 2,000 tokens',
            continuations: '0',
            timestamp: 1,
          }],
        }),
      },
    })

    render(<MessageList />)

    expect(screen.getByText('Goal set')).toBeTruthy()
    expect(screen.getByText('Objective: ship the smoke test')).toBeTruthy()
    expect(screen.getByText('Status: active')).toBeTruthy()
    expect(screen.getByText('Budget: 0 / 2,000 tokens')).toBeTruthy()
  })

  it('renders replacement goal events distinctly', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [{
            id: 'goal-replaced',
            type: 'goal_event',
            action: 'replaced',
            status: 'active',
            objective: 'ship the replacement target',
            budget: '0 / unlimited tokens',
            timestamp: 1,
          }],
        }),
      },
    })

    render(<MessageList />)

    expect(screen.getByText('Goal set')).toBeTruthy()
    expect(screen.getByText('Objective: ship the replacement target')).toBeTruthy()
    expect(screen.getByText('Budget: 0 / unlimited tokens')).toBeTruthy()
  })

  it('renders non-agent background progress inline in the transcript', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: 'run review',
              timestamp: 1,
            },
            {
              id: 'background-task-shell-1',
              type: 'background_task',
              timestamp: 2,
              task: {
                taskId: 'shell-task-1',
                toolUseId: 'shell-tool-1',
                status: 'running',
                taskType: 'local_bash',
                summary: 'Running Playwright checks',
                usage: {
                  totalTokens: 1200,
                  toolUses: 4,
                  durationMs: 45000,
                },
                startedAt: 2,
                updatedAt: 2,
              },
            },
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: 'continuing',
              timestamp: 3,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    const card = screen.getByTestId('background-task-event-card')
    expect(card.textContent).toContain('Background command')
    expect(card.textContent).toContain('running')
    expect(card.textContent).toContain('Running Playwright checks')
    expect(card.textContent).toContain('1.2k tokens')
    expect(card.textContent).toContain('45s')
  })

  it('renders stopped non-agent background tasks as neutral transcript events', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [{
            id: 'background-task-shell-stopped',
            type: 'background_task',
            timestamp: 2,
            task: {
              taskId: 'shell-task-stopped',
              toolUseId: 'shell-tool-stopped',
              status: 'stopped',
              taskType: 'local_bash',
              summary: 'Command "bun test" was stopped',
              startedAt: 1,
              updatedAt: 2,
            },
          }],
        }),
      },
    })

    render(<MessageList />)

    const card = screen.getByTestId('background-task-event-card')
    expect(card.getAttribute('data-status')).toBe('stopped')
    expect(card.textContent).toContain('stopped')
    expect(card.querySelector('.text-\\[var\\(--color-error\\)\\]')).toBeNull()
  })

  it('uses user-facing labels for workflow and unknown background tasks', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'background-task-workflow',
              type: 'background_task',
              timestamp: 2,
              task: {
                taskId: 'workflow-task',
                status: 'running',
                taskType: 'local_workflow',
                summary: 'Running release checklist',
                startedAt: 1,
                updatedAt: 2,
              },
            },
            {
              id: 'background-task-unknown',
              type: 'background_task',
              timestamp: 3,
              task: {
                taskId: 'unknown-task',
                status: 'completed',
                summary: 'Finished background work',
                startedAt: 1,
                updatedAt: 3,
              },
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    const cards = screen.getAllByTestId('background-task-event-card')
    expect(cards).toHaveLength(2)
    expect(cards[0]?.textContent).toContain('Background workflow')
    expect(cards[1]?.textContent).toContain('Background task')
  })

  it('does not render agent background task events as separate transcript cards', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [{
            id: 'background-task-agent-hidden',
            type: 'background_task',
            timestamp: 2,
            task: {
              taskId: 'agent-task-hidden',
              toolUseId: 'agent-tool-hidden',
              status: 'running',
              taskType: 'local_agent',
              summary: 'Running Read',
              startedAt: 1,
              updatedAt: 2,
            },
          }],
        }),
      },
    })

    render(<MessageList />)

    expect(screen.queryByTestId('background-task-event-card')).toBeNull()
    expect(screen.queryByText('local_agent')).toBeNull()
  })

  it('renders the historical window when scrolling away from latest', async () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: Array.from({ length: 220 }, (_, index) => ({
            id: `assistant-${index}`,
            type: 'assistant_text',
            content: `assistant transcript line ${index}`,
            timestamp: index,
          })),
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scrollArea = container.querySelector('.chat-scroll-area') as HTMLElement
    Object.defineProperty(scrollArea, 'clientHeight', { configurable: true, value: 500 })
    Object.defineProperty(scrollArea, 'scrollHeight', { configurable: true, value: 220 * 112 })
    await waitForProgrammaticScrollReset()

    scrollArea.scrollTop = 0
    await act(async () => {
      fireEvent.scroll(scrollArea)
    })

    expect(screen.getByText('assistant transcript line 0')).toBeTruthy()
    expect(screen.queryByText('assistant transcript line 219')).toBeNull()
    expect(container.querySelectorAll('[data-message-shell="assistant"]').length).toBeLessThan(220)
  })

  it('keeps tool-call groups reachable while scrolling virtualized history', async () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'tool-read',
              type: 'tool_use',
              toolName: 'Read',
              toolUseId: 'read-1',
              input: { file_path: '/tmp/example.ts' },
              timestamp: 0,
            },
            {
              id: 'tool-read-result',
              type: 'tool_result',
              toolUseId: 'read-1',
              content: 'read result content',
              isError: false,
              timestamp: 1,
            },
            ...Array.from({ length: 220 }, (_, index) => ({
              id: `assistant-${index}`,
              type: 'assistant_text' as const,
              content: `assistant transcript line ${index}`,
              timestamp: index + 2,
            })),
          ],
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scrollArea = container.querySelector('.chat-scroll-area') as HTMLElement
    Object.defineProperty(scrollArea, 'clientHeight', { configurable: true, value: 500 })
    Object.defineProperty(scrollArea, 'scrollHeight', { configurable: true, value: 222 * 112 })
    await waitForProgrammaticScrollReset()

    expect(screen.queryByText('Read')).toBeNull()
    expect(screen.getByText('assistant transcript line 219')).toBeTruthy()

    scrollArea.scrollTop = 0
    await act(async () => {
      fireEvent.scroll(scrollArea)
    })

    expect(screen.getByText('Read')).toBeTruthy()
    expect(screen.queryByText('assistant transcript line 219')).toBeNull()
    expect(container.querySelector('[data-virtual-message-item]')).not.toBeNull()
  })

  it('splits large virtualization spacers into content-visibility chunks', async () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: Array.from({ length: 240 }, (_, index) => ({
            id: `assistant-${index}`,
            type: 'assistant_text',
            content: `assistant transcript line ${index}`,
            timestamp: index,
          })),
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scrollArea = container.querySelector('.chat-scroll-area') as HTMLElement
    Object.defineProperty(scrollArea, 'clientHeight', { configurable: true, value: 500 })
    Object.defineProperty(scrollArea, 'scrollHeight', { configurable: true, value: 240 * 200 })
    await waitForProgrammaticScrollReset()

    // Scroll to middle so both top and bottom spacers are present
    scrollArea.scrollTop = 20_000
    await act(async () => {
      fireEvent.scroll(scrollArea)
    })

    const topChunks = container.querySelectorAll('[data-virtual-spacer-chunk="top"]')
    const bottomChunks = container.querySelectorAll('[data-virtual-spacer-chunk="bottom"]')
    expect(topChunks.length).toBeGreaterThan(1)
    expect(bottomChunks.length).toBeGreaterThan(1)

    const firstTopChunk = topChunks[0] as HTMLElement
    expect(firstTopChunk.style.contentVisibility).toBe('auto')
    expect(firstTopChunk.style.containIntrinsicSize).toMatch(/^0 \d+px$/)

    // Items inside the active window must NOT carry content-visibility (this
    // is the regression guard that previous content-visibility rollout hit).
    const visibleItems = container.querySelectorAll('[data-virtual-message-item]')
    for (const item of visibleItems) {
      expect((item as HTMLElement).style.contentVisibility).toBe('')
    }
  })

  it('renders sub-agent tool calls inline beneath the parent agent tool call', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'tool-agent',
              type: 'tool_use',
              toolName: 'Agent',
              toolUseId: 'agent-1',
              input: { description: 'Inspect src/components' },
              timestamp: 1,
            },
            {
              id: 'tool-read',
              type: 'tool_use',
              toolName: 'Read',
              toolUseId: 'read-1',
              input: { file_path: '/tmp/example.ts' },
              timestamp: 2,
              parentToolUseId: 'agent-1',
            },
            {
              id: 'result-read',
              type: 'tool_result',
              toolUseId: 'read-1',
              content: 'const answer = 42',
              isError: false,
              timestamp: 3,
              parentToolUseId: 'agent-1',
            },
          ],
        }),
      },
    })

    const { container } = render(<MessageList />)

    expect(screen.getAllByText('Running').length).toBeGreaterThan(0)
    expect(screen.getByText(/Read .*example\.ts.*done/i)).toBeTruthy()
    expect(container.textContent).toContain('Agent')
  })

  it('shows a dedicated compacting status indicator', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'compacting',
          statusVerb: 'Compacting conversation',
        }),
      },
    })

    render(<MessageList />)

    const divider = screen.getByTestId('compact-status-divider')
    expect(within(divider).getByText('Compacting context')).toBeTruthy()
    expect(screen.queryByText('Compacting context...')).toBeNull()
  })

  it('shows API retry metadata in the active turn indicator', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'thinking',
          apiRetry: {
            attempt: 2,
            maxRetries: 10,
            retryDelayMs: 3000,
            errorStatus: 503,
            errorType: 'server_error',
            receivedAt: Date.now(),
          },
        }),
      },
    })

    render(<MessageList />)

    expect(screen.getByTestId('api-retry-indicator')).toBeTruthy()
    expect(screen.getByText('Request failed, retrying')).toBeTruthy()
    expect(screen.getByText('retry 2/10')).toBeTruthy()
    expect(screen.getByText('HTTP 503')).toBeTruthy()
    expect(screen.getByText(/waiting \d+s/)).toBeTruthy()
  })

  it('shows the non-streaming fallback notice in the active turn indicator', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'thinking',
          streamingFallback: {
            cause: 'watchdog',
            receivedAt: Date.now(),
          },
        }),
      },
    })

    render(<MessageList />)

    expect(screen.getByTestId('streaming-fallback-indicator')).toBeTruthy()
    expect(screen.getByText(/switched to non-streaming mode/)).toBeTruthy()
  })

  it('renders compact completion as an expandable timeline divider', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'compact-1',
              type: 'compact_summary',
              title: 'Context compacted',
              trigger: 'auto',
              preTokens: 123000,
              summary: 'Built the invoice import flow and verified retry behavior.',
              timestamp: 1,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    const divider = screen.getByTestId('compact-status-divider')
    expect(within(divider).getByText('Context automatically compacted')).toBeTruthy()
    expect(divider.textContent).not.toContain('123k tokens before compact')
    expect(divider.textContent).not.toContain('Built the invoice import flow')

    fireEvent.click(within(divider).getByRole('button'))

    expect(divider.textContent).toContain('auto')
    expect(divider.textContent).toContain('123k tokens before compact')
    expect(divider.textContent).toContain('Built the invoice import flow and verified retry behavior.')
  })

  it('keeps mixed tool groups active while a nested child tool call is unresolved', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'idle',
          messages: [
            {
              id: 'tool-task-update',
              type: 'tool_use',
              toolName: 'TaskUpdate',
              toolUseId: 'task-update-1',
              input: { tasks: [{ id: '4', status: 'in_progress', content: 'Run page integration' }] },
              timestamp: 1,
            },
            {
              id: 'tool-bash',
              type: 'tool_use',
              toolName: 'Bash',
              toolUseId: 'bash-1',
              input: { command: 'bun run dev' },
              timestamp: 2,
            },
            {
              id: 'result-task-update',
              type: 'tool_result',
              toolUseId: 'task-update-1',
              content: 'updated',
              isError: false,
              timestamp: 3,
            },
            {
              id: 'result-bash',
              type: 'tool_result',
              toolUseId: 'bash-1',
              content: 'started',
              isError: false,
              timestamp: 4,
            },
            {
              id: 'tool-local-bash',
              type: 'tool_use',
              toolName: 'local_bash',
              toolUseId: 'local-bash-1',
              input: { description: 'Run page integration checks' },
              timestamp: 5,
              parentToolUseId: 'task-update-1',
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    const groupSummary = screen.getByText('TaskUpdate (1), ran a command')
    const groupButton = groupSummary.closest('button')
    expect(groupButton?.textContent).not.toContain('check_circle')
    expect(screen.getByText('local_bash')).toBeTruthy()
  })

  it('does not render blank assistant bubbles for whitespace-only text', () => {
    const messages: UIMessage[] = [
      {
        id: 'assistant-empty',
        type: 'assistant_text',
        content: '\n\n  ',
        timestamp: 1,
      },
      {
        id: 'tool-bash',
        type: 'tool_use',
        toolName: 'Bash',
        toolUseId: 'bash-1',
        input: { command: 'pwd' },
        timestamp: 2,
      },
    ]

    const { renderItems } = buildRenderModel(messages)
    expect(renderItems).toHaveLength(1)
    expect(renderItems[0]).toMatchObject({ kind: 'tool_group' })

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages,
          streamingText: '\n  ',
        }),
      },
    })

    const { container } = render(<MessageList />)
    expect(container.querySelectorAll('[data-message-shell="assistant"]')).toHaveLength(0)
  })

  it('renders saved memory events with an entrypoint to memory settings', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'memory-1',
              type: 'memory_event',
              event: 'saved',
              files: [
                { path: '/Users/test/.claude/projects/example/memory/preferences.md', action: 'saved' },
              ],
              timestamp: 1,
            },
          ],
        }),
      },
    })

    render(<MessageList sessionId={ACTIVE_TAB} />)

    expect(screen.getByText('Saved 1 memory file(s)')).toBeTruthy()
    expect(screen.getByText('preferences.md')).toBeTruthy()

    const openButton = screen.getByText('Open Memory').closest('button')
    expect(openButton).toBeTruthy()
    fireEvent.click(openButton!)

    expect(useUIStore.getState().pendingSettingsTab).toBe('memory')
    expect(useUIStore.getState().pendingMemoryPath).toBe('/Users/test/.claude/projects/example/memory/preferences.md')
    expect(useTabStore.getState().activeTabId).toBe('__settings__')
  })

  it('promotes memory file writes from tool calls into a dedicated memory card', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'tool-write-memory',
              type: 'tool_use',
              toolName: 'Write',
              toolUseId: 'write-memory',
              input: {
                file_path: '/Users/test/.claude/projects/example/memory/preferences.md',
                content: '# Preferences\n',
              },
              timestamp: 1,
            },
            {
              id: 'result-write-memory',
              type: 'tool_result',
              toolUseId: 'write-memory',
              content: 'File written successfully',
              isError: false,
              timestamp: 2,
            },
          ],
        }),
      },
    })

    render(<MessageList sessionId={ACTIVE_TAB} />)

    expect(screen.getByText('Saved 1 memory item(s)')).toBeTruthy()
    expect(screen.getByText('preferences.md')).toBeTruthy()
    expect(screen.getByText('Tool details')).toBeTruthy()
    const memoryCardClassName = screen.getByTestId('memory-tool-activity-card').className
    expect(memoryCardClassName).toContain('border-[var(--color-memory-border)]')
    expect(memoryCardClassName).toContain('bg-[var(--color-memory-surface)]')
  })

  it('promotes memory file reads into collapsible memory references', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'tool-read-memory-1',
              type: 'tool_use',
              toolName: 'Read',
              toolUseId: 'read-memory-1',
              input: { file_path: '/Users/test/.claude/projects/example/memory/MEMORY.md' },
              timestamp: 1,
            },
            {
              id: 'result-read-memory-1',
              type: 'tool_result',
              toolUseId: 'read-memory-1',
              content: '1 # Project Memory\n2\n3 billing ledger rules',
              isError: false,
              timestamp: 2,
            },
            {
              id: 'tool-read-memory-2',
              type: 'tool_use',
              toolName: 'Read',
              toolUseId: 'read-memory-2',
              input: { file_path: '/Users/test/.claude/projects/example/memory/workflow.md' },
              timestamp: 3,
            },
          ],
        }),
      },
    })

    render(<MessageList sessionId={ACTIVE_TAB} />)

    expect(screen.getByText('2 memory reference(s)')).toBeTruthy()
    fireEvent.click(screen.getByText('2 memory reference(s)'))
    expect(screen.getByText('MEMORY.md')).toBeTruthy()
    expect(screen.getByText('workflow.md')).toBeTruthy()
  })

  it('keeps non-memory tools visible when a tool group also touches memory files', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'tool-read-memory',
              type: 'tool_use',
              toolName: 'Read',
              toolUseId: 'read-memory',
              input: { file_path: '/Users/test/.claude/projects/example/memory/MEMORY.md' },
              timestamp: 1,
            },
            {
              id: 'tool-bash',
              type: 'tool_use',
              toolName: 'Bash',
              toolUseId: 'bash-1',
              input: { command: 'bun test' },
              timestamp: 2,
            },
            {
              id: 'result-bash',
              type: 'tool_result',
              toolUseId: 'bash-1',
              content: 'ok',
              isError: false,
              timestamp: 3,
            },
          ],
        }),
      },
    })

    render(<MessageList sessionId={ACTIVE_TAB} />)

    expect(screen.getByText('1 memory reference(s)')).toBeTruthy()
    expect(screen.getByText('Bash')).toBeTruthy()
    expect(screen.getByText('bun test')).toBeTruthy()
  })

  it('keeps root tool runs split when nested child tool calls appear between them', () => {
    const messages: UIMessage[] = [
      {
        id: 'tool-agent',
        type: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'agent-1',
        input: { description: 'Inspect src/components' },
        timestamp: 1,
      },
      {
        id: 'tool-read',
        type: 'tool_use',
        toolName: 'Read',
        toolUseId: 'read-1',
        input: { file_path: '/tmp/example.ts' },
        timestamp: 2,
        parentToolUseId: 'agent-1',
      },
      {
        id: 'result-read',
        type: 'tool_result',
        toolUseId: 'read-1',
        content: 'const answer = 42',
        isError: false,
        timestamp: 3,
        parentToolUseId: 'agent-1',
      },
      {
        id: 'tool-write',
        type: 'tool_use',
        toolName: 'Write',
        toolUseId: 'write-1',
        input: { file_path: '/tmp/out.ts', content: 'export const value = 1' },
        timestamp: 4,
      },
    ]

    const { renderItems } = buildRenderModel(messages)
    const toolGroups = renderItems.filter((item) => item.kind === 'tool_group')

    expect(toolGroups).toHaveLength(2)
    expect(toolGroups.map((item) => item.toolCalls[0]?.toolUseId)).toEqual(['agent-1', 'write-1'])
  })

  it('keeps task-management tools from downgrading dispatched agents into a mixed tool tree', () => {
    const messages: UIMessage[] = [
      {
        id: 'tool-task-create',
        type: 'tool_use',
        toolName: 'TaskCreate',
        toolUseId: 'task-create-1',
        input: { subject: 'Review recent changes' },
        timestamp: 1,
      },
      {
        id: 'tool-task-update',
        type: 'tool_use',
        toolName: 'TaskUpdate',
        toolUseId: 'task-update-1',
        input: { id: '1', status: 'in_progress' },
        timestamp: 2,
      },
      {
        id: 'tool-agent-a',
        type: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'agent-a',
        input: { description: 'Review desktop impact' },
        timestamp: 3,
      },
      {
        id: 'tool-agent-b',
        type: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'agent-b',
        input: { description: 'Review runtime impact' },
        timestamp: 4,
      },
      {
        id: 'tool-agent-child-bash',
        type: 'tool_use',
        toolName: 'Bash',
        toolUseId: 'agent-a-bash',
        input: { command: 'git status --short' },
        timestamp: 5,
        parentToolUseId: 'agent-a',
      },
    ]

    const { renderItems, childToolCallsByParent } = buildRenderModel(messages)
    const toolGroups = renderItems.filter((item) => item.kind === 'tool_group')

    expect(toolGroups).toHaveLength(2)
    expect(toolGroups[0]?.toolCalls.map((toolCall) => toolCall.toolName)).toEqual([
      'TaskCreate',
      'TaskUpdate',
    ])
    expect(toolGroups[1]?.toolCalls.map((toolCall) => toolCall.toolName)).toEqual([
      'Agent',
      'Agent',
    ])
    expect(childToolCallsByParent.get('agent-a')?.map((toolCall) => toolCall.toolUseId)).toEqual([
      'agent-a-bash',
    ])
  })

  it('keeps later nested tool calls under their parent after an interleaved user message', () => {
    const messages: UIMessage[] = [
      {
        id: 'tool-agent',
        type: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'agent-1',
        input: { description: 'Inspect src/components' },
        timestamp: 1,
      },
      {
        id: 'tool-read',
        type: 'tool_use',
        toolName: 'Read',
        toolUseId: 'read-1',
        input: { file_path: '/tmp/example.ts' },
        timestamp: 2,
        parentToolUseId: 'agent-1',
      },
      {
        id: 'user-follow-up',
        type: 'user_text',
        content: '顺便把刚才的问题也处理掉',
        timestamp: 3,
      },
      {
        id: 'tool-write',
        type: 'tool_use',
        toolName: 'Write',
        toolUseId: 'write-1',
        input: { file_path: '/tmp/out.ts', content: 'export const value = 1' },
        timestamp: 4,
        parentToolUseId: 'agent-1',
      },
    ]

    const { renderItems, childToolCallsByParent } = buildRenderModel(messages)
    const renderedKinds = renderItems.map((item) =>
      item.kind === 'tool_group'
        ? `tool:${item.toolCalls[0]?.toolUseId}`
        : `message:${item.message.id}`,
    )

    expect(renderedKinds).toEqual([
      'tool:agent-1',
      'message:user-follow-up',
    ])
    expect(
      (childToolCallsByParent.get('agent-1') ?? []).map((toolCall) => toolCall.toolUseId),
    ).toEqual(['read-1', 'write-1'])
  })

  it('does not render parented orphan tool results as root session messages', () => {
    const messages: UIMessage[] = [
      {
        id: 'tool-agent',
        type: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'agent-1',
        input: { description: 'Inspect src/components' },
        timestamp: 1,
      },
      {
        id: 'result-child',
        type: 'tool_result',
        toolUseId: 'grep-1',
        content: 'Found 22 files',
        isError: false,
        timestamp: 2,
        parentToolUseId: 'agent-1',
      },
    ]

    const { renderItems } = buildRenderModel(messages)

    expect(renderItems).toHaveLength(1)
    expect(renderItems[0]).toMatchObject({ kind: 'tool_group' })
  })

  it('shows failed agent status and compact unavailable summary for Explore launch errors', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'tool-agent',
              type: 'tool_use',
              toolName: 'Agent',
              toolUseId: 'agent-1',
              input: { description: '探索整体架构', subagent_type: 'Explore' },
              timestamp: 1,
            },
            {
              id: 'result-agent',
              type: 'tool_result',
              toolUseId: 'agent-1',
              content: `Agent type 'Explore' not found. Available agents: general-purpose`,
              isError: true,
              timestamp: 2,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    expect(screen.getByText('Failed')).toBeTruthy()
    expect(screen.getByText('Explore agent unavailable in this session')).toBeTruthy()
  })

  it('renders subagent_type as → Explore badge next to Agent header', () => {
    // Item 5 (routing observability) — desktop surface mirrors the CLI/Ink
    // change in src/tools/AgentTool/UI.tsx so that operators can see which
    // specialist was routed to without expanding the call.
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'tool-agent',
              type: 'tool_use',
              toolName: 'Agent',
              toolUseId: 'agent-1',
              input: { description: '查找路由模块', subagent_type: 'Explore' },
              timestamp: 1,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    expect(screen.getByText('→ Explore')).toBeTruthy()
    expect(screen.getByText('查找路由模块')).toBeTruthy()
  })

  it('omits subagent_type badge when input has no subagent_type', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'tool-agent',
              type: 'tool_use',
              toolName: 'Agent',
              toolUseId: 'agent-1',
              input: { description: '随便看看' },
              timestamp: 1,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    expect(screen.queryByText(/→\s+\S+/)).toBeNull()
    expect(screen.getByText('随便看看')).toBeTruthy()
  })

  it('shows completed agent output when no nested tool activity is available', () => {
    const longResult = '探索完成。让我将结果整合写入计划文件。第二段补充内容用于验证 dialog 展示的是完整结果而不是截断摘要。'

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'tool-agent',
              type: 'tool_use',
              toolName: 'Agent',
              toolUseId: 'agent-1',
              input: { description: '探索整体架构' },
              timestamp: 1,
            },
            {
              id: 'result-agent',
              type: 'tool_result',
              toolUseId: 'agent-1',
              content: {
                status: 'completed',
                content: [
                  { type: 'text', text: longResult },
                  {
                    type: 'text',
                    text: "agentId: a0c0c732f61442dc1 (use SendMessage with to: 'a0c0c732f61442dc1' to continue this agent)\n<usage>total_tokens: 17195\ntool_uses: 2\nduration_ms: 41368</usage>",
                  },
                ],
              },
              isError: false,
              timestamp: 2,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    expect(screen.getByText('Done')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View result' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'View result' }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/第二段补充内容用于验证 dialog 展示的是完整结果而不是截断摘要。/)).toBeTruthy()
    expect(within(dialog).queryByText(/agentId:/)).toBeNull()
    expect(within(dialog).queryByText(/total_tokens/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeTruthy()
  })

  it('keeps async launched agents in running state until a terminal notification arrives', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'tool-agent',
              type: 'tool_use',
              toolName: 'Agent',
              toolUseId: 'agent-1',
              input: { description: '修复临时文件泄漏' },
              timestamp: 1,
            },
            {
              id: 'result-agent',
              type: 'tool_result',
              toolUseId: 'agent-1',
              content:
                "Async agent launched successfully.\nagentId: a29934b04b20ed564 (internal ID - do not mention to user. Use SendMessage with to: 'a29934b04b20ed564' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.",
              isError: false,
              timestamp: 2,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    expect(screen.getAllByText('Running').length).toBeGreaterThan(0)
    expect(screen.queryByText('Done')).toBeNull()
    expect(screen.queryByRole('button', { name: 'View result' })).toBeNull()
  })

  it('shows completed background agent result from the terminal task notification', () => {
    const resultText = '后台 agent 已经完成：定位到 parentToolUseId 丢失并补齐了 live 事件链。'

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'tool-agent',
              type: 'tool_use',
              toolName: 'Agent',
              toolUseId: 'agent-1',
              input: { description: '排查 subagent UI' },
              timestamp: 1,
            },
            {
              id: 'result-agent',
              type: 'tool_result',
              toolUseId: 'agent-1',
              content:
                "Async agent launched successfully.\nagentId: a29934b04b20ed564 (internal ID - do not mention to user. Use SendMessage with to: 'a29934b04b20ed564' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.",
              isError: false,
              timestamp: 2,
            },
          ],
          agentTaskNotifications: {
            'agent-1': {
              taskId: 'agent-task-1',
              toolUseId: 'agent-1',
              status: 'completed',
              summary: 'Agent "排查 subagent UI" completed',
              result: resultText,
            },
          },
        }),
      },
    })

    render(<MessageList />)

    expect(screen.getByText('Done')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View result' }))

    expect(within(screen.getByRole('dialog')).getByText(resultText)).toBeTruthy()
  })

  it('prefers the terminal task report over structured agent tool result JSON', () => {
    const markdownReport = '## 审查安全风险\n\n- 最终报告应该按 Markdown 展示。'

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'tool-agent',
              type: 'tool_use',
              toolName: 'Agent',
              toolUseId: 'agent-1',
              input: { description: '查看安全报告' },
              timestamp: 1,
            },
            {
              id: 'result-agent',
              type: 'tool_result',
              toolUseId: 'agent-1',
              content: {
                results: [
                  {
                    file: 'git:v0.2.6..v0.2.7',
                    line: 0,
                    snippet: 'raw structured JSON should not be shown',
                    context: '结构化检索结果不是给用户看的最终报告。',
                  },
                ],
              },
              isError: false,
              timestamp: 2,
            },
          ],
          agentTaskNotifications: {
            'agent-1': {
              taskId: 'agent-task-1',
              toolUseId: 'agent-1',
              status: 'completed',
              summary: 'Agent "审查安全风险" completed',
              result: markdownReport,
            },
          },
        }),
      },
    })

    render(<MessageList />)

    expect(screen.getByText(/最终报告应该按 Markdown 展示。/)).toBeTruthy()
    expect(screen.queryByText(/raw structured JSON should not be shown/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'View result' }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: '审查安全风险' })).toBeTruthy()
    expect(within(dialog).getByText('最终报告应该按 Markdown 展示。')).toBeTruthy()
    expect(within(dialog).queryByText(/raw structured JSON should not be shown/)).toBeNull()
  })

  it('formats structured agent fallback results as readable markdown', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'tool-agent',
              type: 'tool_use',
              toolName: 'Agent',
              toolUseId: 'agent-1',
              input: { description: '审查安全风险' },
              timestamp: 1,
            },
            {
              id: 'result-agent',
              type: 'tool_result',
              toolUseId: 'agent-1',
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    results: [
                      {
                        file: 'git:v0.2.6..v0.2.7',
                        line: 0,
                        snippet: 'v0.2.7 tag = a4c92ec7',
                        context: '版本范围判断：release-notes/v0.2.7.md 明确相比 v0.2.6。',
                      },
                      {
                        risk: 'medium',
                        items: [
                          {
                            file: '/tmp/example/src/lib.rs',
                            line: 220,
                            context: '中风险：服务默认监听 0.0.0.0。',
                          },
                        ],
                      },
                    ],
                  }),
                },
              ],
              isError: false,
              timestamp: 2,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    expect(screen.getByText(/git:v0\.2\.6\.\.v0\.2\.7:0/)).toBeTruthy()
    expect(screen.queryByText(/\{"results"/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'View result' }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('git:v0.2.6..v0.2.7:0')).toBeTruthy()
    expect(within(dialog).getByText('/tmp/example/src/lib.rs:220')).toBeTruthy()
    expect(within(dialog).getByText(/服务默认监听 0\.0\.0\.0/)).toBeTruthy()
    expect(within(dialog).queryByText(/\{"results"/)).toBeNull()
  })

  it('renders copy controls for user messages and scopes assistant copy to a single reply', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, {
      clipboard: {
        writeText,
      },
    })

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '请帮我探索整体架构',
              timestamp: 1,
            },
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: '先看 CLI 和服务端入口。',
              timestamp: 2,
            },
            {
              id: 'assistant-2',
              type: 'assistant_text',
              content: '再看 desktop 前后端边界。',
              timestamp: 3,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: 'Copy reply' })[1]!)

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('再看 desktop 前后端边界。')
    })
    expect(writeText).not.toHaveBeenCalledWith(
      '先看 CLI 和服务端入口。\n再看 desktop 前后端边界。'
    )
  })

  it('releases pointer focus from message actions after clicking copy', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: '离开 hover 后操作条应该恢复隐藏。',
              timestamp: 1,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    const copyButton = screen.getByRole('button', { name: 'Copy reply' })
    copyButton.focus()
    expect(document.activeElement).toBe(copyButton)

    fireEvent.pointerUp(copyButton)

    expect(document.activeElement).not.toBe(copyButton)
  })

  it('adds selected user message text to the composer context', async () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [{
            id: 'user-1',
            type: 'user_text',
            content: 'Please inspect the workspace selection behavior.',
            timestamp: 1,
          }],
        }),
      },
    })

    render(<MessageList />)

    const userText = screen.getByText('Please inspect the workspace selection behavior.')
    await selectMessageText(userText, 'workspace selection behavior')
    const floatingAddButton = screen.getByRole('button', { name: 'Add to chat' })

    expect(floatingAddButton.style.left).toBe('141px')
    expect(floatingAddButton.style.top).toBe('26px')

    fireEvent.click(floatingAddButton)

    expect(useWorkspaceChatContextStore.getState().referencesBySession[ACTIVE_TAB]).toMatchObject([
      {
        kind: 'chat-selection',
        path: 'chat://user/user-1',
        name: 'User message',
        messageId: 'user-1',
        sourceRole: 'user',
        quote: 'workspace selection behavior',
      },
    ])
    expect(window.getSelection()?.toString()).toBe('')
  })

  it('shows the selected-message action when text selection ends outside the message', async () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [{
            id: 'assistant-1',
            type: 'assistant_text',
            content: 'Drag selection gestures can finish outside the message bubble.',
            timestamp: 1,
          }],
        }),
      },
    })

    render(<MessageList />)

    const assistantText = screen.getByText(/Drag selection gestures/)
    prepareMessageTextSelection(assistantText, 'selection gestures')

    await act(async () => {
      fireEvent.pointerDown(assistantText, {
        button: 0,
        clientX: 172,
        clientY: 88,
        pointerId: 1,
        pointerType: 'mouse',
      })
      fireEvent.pointerMove(document.body, {
        clientX: 640,
        clientY: 120,
        pointerId: 1,
        pointerType: 'mouse',
      })
      fireEvent.pointerUp(document.body, {
        clientX: 640,
        clientY: 120,
        pointerId: 1,
        pointerType: 'mouse',
      })
      await Promise.resolve()
    })
    await waitForSelectionMenuUpdate()

    expect(screen.getByRole('button', { name: 'Add to chat' })).toBeTruthy()
  })

  it('places the selected-message action to the right when there is no room above', async () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [{
            id: 'assistant-1',
            type: 'assistant_text',
            content: 'Top edge selections need a nearby right-side action.',
            timestamp: 1,
          }],
        }),
      },
    })

    render(<MessageList />)

    const assistantText = screen.getByText(/Top edge selections/)
    await selectMessageText(assistantText, 'right-side action', {
      left: 160,
      top: 18,
      right: 280,
      bottom: 36,
      width: 120,
      height: 18,
      x: 160,
      y: 18,
    })
    const floatingAddButton = screen.getByRole('button', { name: 'Add to chat' })

    expect(floatingAddButton.style.left).toBe('290px')
    expect(floatingAddButton.style.top).toBe('12px')
  })

  it('adds multi-line assistant reply selections across markdown blocks to the composer context', async () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [{
            id: 'assistant-1',
            type: 'assistant_text',
            content: [
              'First line can start the selection.',
              '',
              'Second paragraph should still belong to the same chat message.',
              '',
              '- Third block can finish the selection.',
            ].join('\n'),
            timestamp: 1,
          }],
        }),
      },
    })

    render(<MessageList />)

    const firstParagraph = screen.getByText('First line can start the selection.')
    const listItem = screen.getByText('Third block can finish the selection.')
    await selectAcrossMessageText(
      firstParagraph,
      'First line',
      listItem,
      'finish the selection',
      { left: 160, top: 80, right: 520, bottom: 160, width: 360, height: 80 },
    )
    const floatingAddButton = screen.getByRole('button', { name: 'Add to chat' })

    expect(floatingAddButton.style.left).toBe('530px')
    expect(floatingAddButton.style.top).toBe('98px')

    fireEvent.click(floatingAddButton)

    expect(useWorkspaceChatContextStore.getState().referencesBySession[ACTIVE_TAB]).toMatchObject([
      {
        kind: 'chat-selection',
        messageId: 'assistant-1',
        sourceRole: 'assistant',
      },
    ])
    expect(useWorkspaceChatContextStore.getState().referencesBySession[ACTIVE_TAB]?.[0]?.quote).toContain('First line')
    expect(useWorkspaceChatContextStore.getState().referencesBySession[ACTIVE_TAB]?.[0]?.quote).toContain('finish the selection')
  })

  it('shows the selected-message action after browser selectionchange for multi-line replies', async () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [{
            id: 'assistant-1',
            type: 'assistant_text',
            content: [
              'Browser selection can settle after pointerup.',
              '',
              'The document selectionchange event should be enough to show the action.',
            ].join('\n'),
            timestamp: 1,
          }],
        }),
      },
    })

    render(<MessageList />)

    const firstParagraph = screen.getByText('Browser selection can settle after pointerup.')
    const secondParagraph = screen.getByText('The document selectionchange event should be enough to show the action.')
    const startNode = findTextNodeContaining(firstParagraph, 'Browser selection')
    const endNode = findTextNodeContaining(secondParagraph, 'show the action')
    const range = document.createRange()
    range.setStart(startNode, startNode.textContent?.indexOf('Browser selection') ?? 0)
    range.setEnd(
      endNode,
      (endNode.textContent?.indexOf('show the action') ?? 0) + 'show the action'.length,
    )
    Object.assign(range, {
      getBoundingClientRect: () => ({
        left: 150,
        top: 76,
        right: 500,
        bottom: 140,
        width: 350,
        height: 64,
        x: 150,
        y: 76,
        toJSON: () => ({}),
      }),
    })

    const selectableRoot = firstParagraph.closest('[data-chat-selectable-message]')
    Object.assign(selectableRoot ?? firstParagraph, {
      getBoundingClientRect: () => ({
        left: 120,
        top: 48,
        right: 720,
        bottom: 280,
        width: 600,
        height: 232,
        x: 120,
        y: 48,
        toJSON: () => ({}),
      }),
    })

    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)

    await act(async () => {
      document.dispatchEvent(new Event('selectionchange'))
    })
    await waitForSelectionMenuUpdate()

    expect(screen.getByRole('button', { name: 'Add to chat' })).toBeTruthy()
  })

  it('adds selected assistant reply text to the composer context', async () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [{
            id: 'assistant-1',
            type: 'assistant_text',
            content: 'First inspect the file tree. Then quote the selected lines.',
            timestamp: 1,
          }],
        }),
      },
    })

    render(<MessageList />)

    const assistantText = screen.getByText(/First inspect the file tree/)
    await selectMessageText(assistantText, 'quote the selected lines')
    const floatingAddButton = screen.getByRole('button', { name: 'Add to chat' })

    expect(floatingAddButton.closest('[data-chat-selectable-message]')).toBeNull()

    fireEvent.click(floatingAddButton)

    expect(useWorkspaceChatContextStore.getState().referencesBySession[ACTIVE_TAB]).toMatchObject([
      {
        kind: 'chat-selection',
        path: 'chat://assistant/assistant-1',
        name: 'Assistant message',
        messageId: 'assistant-1',
        sourceRole: 'assistant',
        quote: 'quote the selected lines',
      },
    ])
  })

  it('dismisses the selected-message action when clicking outside the popover', async () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [{
            id: 'assistant-1',
            type: 'assistant_text',
            content: 'Clicking outside should clear this selected reply.',
            timestamp: 1,
          }],
        }),
      },
    })

    render(<MessageList />)

    const assistantText = screen.getByText(/Clicking outside should clear/)
    await selectMessageText(assistantText, 'selected reply')
    expect(screen.getByRole('button', { name: 'Add to chat' })).toBeTruthy()

    await act(async () => {
      fireEvent.pointerDown(document.body)
      await Promise.resolve()
    })

    expect(screen.queryByRole('button', { name: 'Add to chat' })).toBeNull()
    expect(window.getSelection()?.toString()).toBe('')
  })

  it('dismisses the selected-message action when the message list scrolls', async () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [{
            id: 'assistant-1',
            type: 'assistant_text',
            content: 'Scrolling should clear this selected reply.',
            timestamp: 1,
          }],
        }),
      },
    })

    const { container } = render(<MessageList />)

    const assistantText = screen.getByText(/Scrolling should clear/)
    await selectMessageText(assistantText, 'selected reply')
    expect(screen.getByRole('button', { name: 'Add to chat' })).toBeTruthy()

    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement
    await act(async () => {
      fireEvent.scroll(scroller)
      await Promise.resolve()
    })

    expect(screen.queryByRole('button', { name: 'Add to chat' })).toBeNull()
    expect(window.getSelection()?.toString()).toBe('')
  })

  it('keeps only the latest selected-message action when selecting across messages', async () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: 'First assistant reply can be selected.',
              timestamp: 1,
            },
            {
              id: 'assistant-2',
              type: 'assistant_text',
              content: 'Second assistant reply should replace it.',
              timestamp: 2,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    const firstText = screen.getByText(/First assistant reply/)
    const secondText = screen.getByText(/Second assistant reply/)
    await selectMessageText(firstText, 'First assistant reply')
    expect(screen.getAllByRole('button', { name: 'Add to chat' })).toHaveLength(1)

    await act(async () => {
      fireEvent.pointerDown(secondText)
      await Promise.resolve()
    })
    await selectMessageText(secondText, 'Second assistant reply')

    expect(screen.getAllByRole('button', { name: 'Add to chat' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))
    expect(useWorkspaceChatContextStore.getState().referencesBySession[ACTIVE_TAB]).toMatchObject([
      {
        messageId: 'assistant-2',
        quote: 'Second assistant reply',
      },
    ])
  })

  it('does not force-scroll to the bottom while the user is reading history', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'streaming',
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '历史消息',
              timestamp: 1,
            },
          ],
          streamingText: 'streaming',
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement
    let scrollTop = 120
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = value
      },
    })

    scrollIntoView.mockClear()
    await waitForProgrammaticScrollReset()
    fireEvent.scroll(scroller)

    act(() => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [ACTIVE_TAB]: {
            ...state.sessions[ACTIVE_TAB]!,
            streamingText: 'streaming new token',
          },
        },
      }))
    })

    await waitFor(() => {
      expect(screen.getByText('streaming new token')).toBeTruthy()
    })
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('keeps auto-scrolling when new output arrives while already near the bottom', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'streaming',
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '最新消息',
              timestamp: 1,
            },
          ],
          streamingText: 'streaming',
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement
    let scrollTop = 552
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = value
      },
    })

    scrollIntoView.mockClear()
    await waitForProgrammaticScrollReset()
    fireEvent.scroll(scroller)

    act(() => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [ACTIVE_TAB]: {
            ...state.sessions[ACTIVE_TAB]!,
            streamingText: 'streaming next token',
          },
        },
      }))
    })

    await waitFor(() => {
      expect(screen.getByText('streaming next token')).toBeTruthy()
    })
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(scrollTop).toBe(600)
  })

  it('keeps auto-scrolling when active tool input updates in place', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'tool_executing',
          streamingToolInput: '{"file_path":"/tmp/app.vue","content":"<template>',
          activeToolUseId: 'write-1',
          activeToolName: 'Write',
          messages: [
            {
              id: 'tool-write',
              type: 'tool_use',
              toolName: 'Write',
              toolUseId: 'write-1',
              input: {},
              partialInput: '{"file_path":"/tmp/app.vue","content":"<template>',
              isPending: true,
              timestamp: 1,
            },
          ],
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement
    let scrollTop = 552
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = value
      },
    })

    scrollIntoView.mockClear()
    await waitForProgrammaticScrollReset()
    fireEvent.scroll(scroller)

    act(() => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [ACTIVE_TAB]: {
            ...state.sessions[ACTIVE_TAB]!,
            streamingToolInput: '{"file_path":"/tmp/app.vue","content":"<template>\\n<section>latest</section>',
            streamingResponseChars: 32,
            messages: [
              {
                ...state.sessions[ACTIVE_TAB]!.messages[0] as Extract<UIMessage, { type: 'tool_use' }>,
                input: { file_path: '/tmp/app.vue', content: '<template>\n<section>latest</section>' },
                partialInput: '{"file_path":"/tmp/app.vue","content":"<template>\\n<section>latest</section>',
              },
            ],
          },
        },
      }))
    })

    await waitFor(() => {
      expect(screen.getByText('app.vue')).toBeTruthy()
    })
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(scrollTop).toBe(600)
  })

  it('keeps auto-scrolling without reading scroll geometry synchronously', async () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'streaming',
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: 'latest prompt',
              timestamp: 1,
            },
          ],
          streamingText: 'streaming',
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement
    const readScrollHeight = vi.fn(() => {
      throw new Error('scrollHeight should not be read while pinning to bottom')
    })
    const readClientHeight = vi.fn(() => {
      throw new Error('clientHeight should not be read while pinning to bottom')
    })
    let scrollTop = 552
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: readScrollHeight,
    })
    Object.defineProperty(scroller, 'clientHeight', {
      configurable: true,
      get: readClientHeight,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = value >= 1_000_000_000 ? 600 : value
      },
    })
    Object.defineProperty(scroller, 'scrollTo', {
      configurable: true,
      value: vi.fn((options: ScrollToOptions | number, y?: number) => {
        scroller.scrollTop = typeof options === 'number' ? y ?? 0 : options.top ?? 0
      }),
    })

    await waitForProgrammaticScrollReset()
    act(() => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [ACTIVE_TAB]: {
            ...state.sessions[ACTIVE_TAB]!,
            streamingText: 'streaming next token',
          },
        },
      }))
    })

    await waitFor(() => {
      expect(screen.getByText('streaming next token')).toBeTruthy()
    })
    await waitForProgrammaticScrollReset()

    expect(scrollTop).toBe(600)
    expect(readScrollHeight).not.toHaveBeenCalled()
    expect(readClientHeight).not.toHaveBeenCalled()
  })

  it('keeps mobile H5 streaming output pinned after the transcript height grows', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'streaming',
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '移动端长回复',
              timestamp: 1,
            },
          ],
          streamingText: 'streaming',
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement
    let scrollTop = 552
    let scrollHeight = 1000
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = value
      },
    })

    await waitForProgrammaticScrollReset()
    fireEvent.scroll(scroller)
    expect(screen.queryByRole('button', { name: 'Latest' })).toBeNull()

    scrollIntoView.mockClear()
    scrollHeight = 1400
    act(() => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [ACTIVE_TAB]: {
            ...state.sessions[ACTIVE_TAB]!,
            streamingText: 'streaming next token after height change',
          },
        },
      }))
    })

    await waitFor(() => {
      expect(screen.getByText('streaming next token after height change')).toBeTruthy()
    })
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(scrollTop).toBe(1000)

    await waitForProgrammaticScrollReset()
    fireEvent.scroll(scroller)

    expect(screen.queryByRole('button', { name: 'Latest' })).toBeNull()
  })

  it('keeps H5 pinned when streaming content resizes after render', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    let resizeCallback: ResizeObserverCallback | null = null
    class TestResizeObserver {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()

      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback
      }
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver)

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'streaming',
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '移动端异步重排',
              timestamp: 1,
            },
          ],
          streamingText: 'streaming',
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement
    let scrollTop = 552
    let scrollHeight = 1000
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = value
      },
    })

    await waitFor(() => {
      expect(resizeCallback).not.toBeNull()
    })
    await waitForProgrammaticScrollReset()
    fireEvent.scroll(scroller)
    expect(screen.queryByRole('button', { name: 'Latest' })).toBeNull()

    scrollIntoView.mockClear()
    scrollHeight = 1600
    act(() => {
      resizeCallback?.([], {} as ResizeObserver)
    })

    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(scrollTop).toBe(1200)
    expect(screen.queryByRole('button', { name: 'Latest' })).toBeNull()
  })

  it('lets the user drag away from active thinking output before the programmatic scroll settles', async () => {
    let resizeCallback: ResizeObserverCallback | null = null
    class TestResizeObserver {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()

      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback
      }
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver)

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'thinking',
          activeThinkingId: 'thinking-1',
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '分析一下这段代码',
              timestamp: 1,
            },
            {
              id: 'thinking-1',
              type: 'thinking',
              content: '正在阅读代码路径',
              timestamp: 2,
            },
          ],
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement
    let scrollTop = 600
    let scrollHeight = 1000
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = value
      },
    })

    await waitFor(() => {
      expect(resizeCallback).not.toBeNull()
    })

    act(() => {
      resizeCallback?.([{
        contentRect: { height: 600 },
      } as ResizeObserverEntry], {} as ResizeObserver)
    })

    scrollTop = 200
    fireEvent.scroll(scroller)
    expect(screen.getByRole('button', { name: 'Latest' })).toBeTruthy()

    scrollHeight = 1200
    act(() => {
      resizeCallback?.([{
        contentRect: { height: 760 },
      } as ResizeObserverEntry], {} as ResizeObserver)
    })

    expect(scrollTop).toBe(200)
  })

  it('ignores one-pixel content resize jitter while pinned to active thinking output', async () => {
    let resizeCallback: ResizeObserverCallback | null = null
    class TestResizeObserver {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()

      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback
      }
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver)

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'thinking',
          activeThinkingId: 'thinking-1',
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '触发 Windows WebView2 细微重排',
              timestamp: 1,
            },
            {
              id: 'thinking-1',
              type: 'thinking',
              content: '正在分析一个静态问题',
              timestamp: 2,
            },
          ],
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement
    let scrollTop = 600
    let scrollTopWriteCount = 0
    let scrollHeight = 1000
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTopWriteCount += 1
        scrollTop = value
      },
    })

    await waitFor(() => {
      expect(resizeCallback).not.toBeNull()
    })
    await waitForProgrammaticScrollReset()

    const makeResizeEntry = (height: number) => ([{
      contentRect: { height },
    } as ResizeObserverEntry])

    act(() => {
      resizeCallback?.(makeResizeEntry(400), {} as ResizeObserver)
    })
    expect(scrollTop).toBe(600)

    scrollTopWriteCount = 0
    act(() => {
      resizeCallback?.(makeResizeEntry(401), {} as ResizeObserver)
    })
    act(() => {
      resizeCallback?.(makeResizeEntry(400), {} as ResizeObserver)
    })

    expect(scrollTopWriteCount).toBe(0)
    expect(scrollTop).toBe(600)

    scrollHeight = 1040
    act(() => {
      resizeCallback?.(makeResizeEntry(420), {} as ResizeObserver)
    })

    expect(scrollTop).toBe(640)
  })

  it('does not pull a completed session back to the bottom when content resizes', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    let resizeCallback: ResizeObserverCallback | null = null
    class TestResizeObserver {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()

      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback
      }
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver)

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'idle',
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '生成一个 todo app',
              timestamp: 1,
            },
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: [
                '已完成。',
                '',
                '```bash',
                'cd /private/tmp/todo-app',
                'npm run dev',
                '```',
              ].join('\n'),
              timestamp: 2,
            },
          ],
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement
    let scrollTop = 180
    let scrollHeight = 1400
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = value
      },
    })

    await waitFor(() => {
      expect(resizeCallback).not.toBeNull()
    })

    scrollIntoView.mockClear()
    scrollHeight = 1600
    act(() => {
      resizeCallback?.([], {} as ResizeObserver)
    })

    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(scrollTop).toBe(180)
  })

  it('does not pull a restored completed session back to the bottom from stale running state', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    let resizeCallback: ResizeObserverCallback | null = null
    class TestResizeObserver {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()

      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback
      }
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver)

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'thinking',
          activeThinkingId: null,
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '复盘这个已完成会话',
              timestamp: 1,
            },
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: [
                '这个会话已经完成。',
                '',
                '```tsx',
                'export function TodoListView() {',
                '  return <section>Done</section>',
                '}',
                '```',
              ].join('\n'),
              timestamp: 2,
            },
          ],
          streamingText: '',
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement
    let scrollTop = 260
    let scrollHeight = 1800
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = value
      },
    })

    await waitFor(() => {
      expect(resizeCallback).not.toBeNull()
    })

    scrollIntoView.mockClear()
    scrollHeight = 2100
    act(() => {
      resizeCallback?.([], {} as ResizeObserver)
    })

    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(scrollTop).toBe(260)
  })

  it('restores a session scroll position when switching back to a tab', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    useTabStore.setState({
      activeTabId: 'session-a',
      tabs: [
        { sessionId: 'session-a', title: 'A', type: 'session' as const, status: 'idle' },
        { sessionId: 'session-b', title: 'B', type: 'session' as const, status: 'idle' },
      ],
    })
    useChatStore.setState({
      sessions: {
        'session-a': makeSessionState({
          messages: [
            { id: 'a-user', type: 'user_text', content: 'A prompt', timestamp: 1 },
            { id: 'a-assistant', type: 'assistant_text', content: 'A response', timestamp: 2 },
          ],
        }),
        'session-b': makeSessionState({
          messages: [
            { id: 'b-user', type: 'user_text', content: 'B prompt', timestamp: 1 },
            { id: 'b-assistant', type: 'assistant_text', content: 'B response', timestamp: 2 },
          ],
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement
    let scrollTop = 180
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1200 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = value
      },
    })

    await waitForProgrammaticScrollReset()
    fireEvent.scroll(scroller)
    expect(screen.getByRole('button', { name: 'Latest' })).toBeTruthy()

    act(() => {
      useTabStore.setState({ activeTabId: 'session-b' })
    })
    await waitFor(() => {
      expect(screen.getByText('B response')).toBeTruthy()
    })

    scrollTop = 760
    await waitForProgrammaticScrollReset()
    fireEvent.scroll(scroller)

    act(() => {
      useTabStore.setState({ activeTabId: 'session-a' })
    })
    await waitFor(() => {
      expect(screen.getByText('A response')).toBeTruthy()
    })

    expect(scrollTop).toBe(180)
    expect(screen.getByRole('button', { name: 'Latest' })).toBeTruthy()
  })

  it('scrolls new sessions to the latest message instead of inheriting another tab position', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    useTabStore.setState({
      activeTabId: 'session-a',
      tabs: [
        { sessionId: 'session-a', title: 'A', type: 'session' as const, status: 'idle' },
        { sessionId: 'session-fresh', title: 'Fresh', type: 'session' as const, status: 'idle' },
      ],
    })
    useChatStore.setState({
      sessions: {
        'session-a': makeSessionState({
          messages: [
            { id: 'a-user', type: 'user_text', content: 'A prompt', timestamp: 1 },
            { id: 'a-assistant', type: 'assistant_text', content: 'A response', timestamp: 2 },
          ],
        }),
        'session-fresh': makeSessionState({
          messages: [
            { id: 'fresh-user', type: 'user_text', content: 'Fresh prompt', timestamp: 1 },
            { id: 'fresh-assistant', type: 'assistant_text', content: 'Fresh latest response', timestamp: 2 },
          ],
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1200 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      value: 150,
      writable: true,
    })

    fireEvent.scroll(scroller)
    scrollIntoView.mockClear()

    act(() => {
      useTabStore.setState({ activeTabId: 'session-fresh' })
    })

    await waitFor(() => {
      expect(screen.getByText('Fresh latest response')).toBeTruthy()
      expect(scrollIntoView).not.toHaveBeenCalled()
    })
    expect(scroller.scrollTop).toBe(800)
  })

  it('shows a latest button when reading history and resumes following after clicking it', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'streaming',
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '历史消息',
              timestamp: 1,
            },
          ],
          streamingText: 'streaming',
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement
    let scrollTop = 120
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = value
      },
    })

    scrollIntoView.mockClear()
    await waitForProgrammaticScrollReset()
    fireEvent.scroll(scroller)
    fireEvent.click(screen.getByRole('button', { name: 'Latest' }))

    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(scrollTop).toBe(600)
    expect(screen.queryByRole('button', { name: 'Latest' })).toBeNull()

    scrollIntoView.mockClear()
    act(() => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [ACTIVE_TAB]: {
            ...state.sessions[ACTIVE_TAB]!,
            streamingText: 'streaming after jump',
          },
        },
      }))
    })

    await waitFor(() => {
      expect(screen.getByText('streaming after jump')).toBeTruthy()
    })
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(scrollTop).toBe(600)
  })

  it('jumps to the latest message when the user sends a new prompt from history', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '历史消息',
              timestamp: 1,
            },
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: '历史回复',
              timestamp: 2,
            },
          ],
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement
    let scrollTop = 120
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = value
      },
    })

    scrollIntoView.mockClear()
    await waitForProgrammaticScrollReset()
    fireEvent.scroll(scroller)
    expect(screen.getByRole('button', { name: 'Latest' })).toBeTruthy()

    act(() => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [ACTIVE_TAB]: {
            ...state.sessions[ACTIVE_TAB]!,
            chatState: 'thinking',
            messages: [
              ...state.sessions[ACTIVE_TAB]!.messages,
              {
                id: 'user-2',
                type: 'user_text',
                content: '新的问题',
                timestamp: 3,
              },
            ],
          },
        },
      }))
    })

    await waitFor(() => {
      expect(screen.getByText('新的问题')).toBeTruthy()
    })
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(scrollTop).toBe(600)
    expect(screen.queryByRole('button', { name: 'Latest' })).toBeNull()
  })

  it('jumps to the latest message when a sent prompt lands before chat state changes', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '历史消息',
              timestamp: 1,
            },
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: '历史回复',
              timestamp: 2,
            },
          ],
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement
    let scrollTop = 120
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = value
      },
    })

    scrollIntoView.mockClear()
    await waitForProgrammaticScrollReset()
    fireEvent.scroll(scroller)
    expect(screen.getByRole('button', { name: 'Latest' })).toBeTruthy()

    act(() => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [ACTIVE_TAB]: {
            ...state.sessions[ACTIVE_TAB]!,
            chatState: 'idle',
            messages: [
              ...state.sessions[ACTIVE_TAB]!.messages,
              {
                id: 'user-2',
                type: 'user_text',
                content: '刚发送的问题',
                timestamp: 3,
              },
            ],
          },
        },
      }))
    })

    await waitFor(() => {
      expect(screen.getByText('刚发送的问题')).toBeTruthy()
    })
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(scrollTop).toBe(600)
    expect(screen.queryByRole('button', { name: 'Latest' })).toBeNull()

    act(() => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [ACTIVE_TAB]: {
            ...state.sessions[ACTIVE_TAB]!,
            chatState: 'thinking',
          },
        },
      }))
    })

    await waitFor(() => {
      expect(screen.getByText('刚发送的问题')).toBeTruthy()
    })
    expect(scrollTop).toBe(600)
  })

  it('keeps user actions anchored to the right bubble and assistant actions to the left bubble', () => {
    const now = new Date('2026-05-29T16:00:00+08:00').getTime()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '请把这条 prompt 放在右侧',
              timestamp: now - 5 * 60_000,
            },
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: '这条回复应该停在左侧。',
              timestamp: now - 2 * 60 * 60_000,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    const userShell = screen.getByText('请把这条 prompt 放在右侧').closest('[data-message-shell="user"]')
    const assistantShell = screen.getByText('这条回复应该停在左侧。').closest('[data-message-shell="assistant"]')
    const userActions = screen.getByRole('button', { name: 'Copy prompt' }).closest('[data-message-actions]')
    const assistantActions = screen.getByRole('button', { name: 'Copy reply' }).closest('[data-message-actions]')

    expect(userShell).toBeTruthy()
    expect(userShell?.className).toContain('items-end')
    expect(userShell?.className).toContain('group')
    expect(userShell?.className).not.toContain('w-full')
    expect(assistantShell).toBeTruthy()
    expect(assistantShell?.className).toContain('items-start')
    expect(assistantShell?.className).toContain('group')
    expect(assistantShell?.className).not.toContain('w-full')
    expect(assistantShell?.className).not.toContain('ml-10')
    expect(userActions?.getAttribute('data-align')).toBe('end')
    expect(assistantActions?.getAttribute('data-align')).toBe('start')
    expect(userActions?.className).toContain('h-7')
    expect(userActions?.className).toContain('mt-2')
    expect(userActions?.className).not.toContain('h-0')
    expect(userActions?.className).not.toContain('group-hover:h-7')
    expect(userActions?.className).not.toContain('invisible')
    expect(within(userActions as HTMLElement).getByText('5m ago')).toBeTruthy()
    expect(within(assistantActions as HTMLElement).getByText('2h ago')).toBeTruthy()
  })

  it('uses the document column for markdown-heavy assistant replies', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'assistant-doc',
              type: 'assistant_text',
              content: [
                '## 交付结果',
                '',
                '已完成以下内容：',
                '',
                '- 添加任务',
                '- 删除任务',
                '',
                '```bash',
                'npm run build',
                '```',
              ].join('\n'),
              timestamp: 1,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    const assistantShell = screen.getByText('交付结果').closest('[data-message-shell="assistant"]')
    expect(assistantShell?.getAttribute('data-layout')).toBe('document')
    expect(assistantShell?.className).toContain('w-full')
    expect(assistantShell?.className).not.toContain('ml-10')
  })

  it('does not expose the old message-level rewind action', async () => {
    vi.spyOn(sessionsApi, 'getTurnCheckpoints').mockResolvedValue({
      checkpoints: [
        {
          target: {
            targetUserMessageId: 'user-1',
            userMessageIndex: 0,
            userMessageCount: 1,
          },
          code: {
            available: true,
            filesChanged: ['src/App.tsx'],
            insertions: 4,
            deletions: 1,
          },
        },
      ],
    })

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '做一个页面',
              timestamp: 1,
            },
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: 'done',
              timestamp: 2,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    expect(await screen.findByRole('button', { name: 'Undo current turn changes' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Rewind to here' })).toBeNull()
  })

  it('branches from completed transcript-backed chat messages using the original transcript id', async () => {
    const branchSession = vi.fn().mockResolvedValue({
      sessionId: 'branched-session-1',
      title: 'Branched session',
      workDir: '/tmp/branched-session-1',
    })
    const connectToSession = vi.fn()
    useSessionStore.setState({
      sessions: [{
        id: ACTIVE_TAB,
        title: 'Source session',
        createdAt: '2026-05-19T00:00:00.000Z',
        modifiedAt: '2026-05-19T00:00:00.000Z',
        messageCount: 2,
        projectPath: '/tmp/source-project',
        projectRoot: '/tmp/source-project',
        workDir: '/tmp/source-project',
        workDirExists: true,
      }],
      branchSession: branchSession as never,
    })
    useChatStore.setState({
      connectToSession: connectToSession as never,
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'local-user-1',
              transcriptMessageId: 'transcript-user-1',
              type: 'user_text',
              content: '从这里开始',
              timestamp: 1,
            },
            {
              id: 'local-assistant-1',
              transcriptMessageId: 'transcript-assistant-1',
              type: 'assistant_text',
              content: '这是完成的答复。',
              timestamp: 2,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    const branchButtons = screen.getAllByRole('button', { name: 'Fork a new conversation' })
    expect(branchButtons).toHaveLength(2)
    expect(branchButtons[0]!.closest('[data-message-actions]')).toBe(
      screen.getByRole('button', { name: 'Copy prompt' }).closest('[data-message-actions]')
    )
    expect(branchButtons[1]!.closest('[data-message-actions]')).toBe(
      screen.getByRole('button', { name: 'Copy reply' }).closest('[data-message-actions]')
    )
    expect(branchButtons[1]?.getAttribute('title')).toBe('Fork a new conversation')

    fireEvent.click(branchButtons[1]!)

    await waitFor(() => {
      expect(branchSession).toHaveBeenCalledWith(ACTIVE_TAB, 'transcript-assistant-1')
    })
    expect(connectToSession).toHaveBeenCalledWith('branched-session-1')
    expect(useTabStore.getState().activeTabId).toBe('branched-session-1')
    const tabs = useTabStore.getState().tabs
    expect(tabs[tabs.length - 1]).toMatchObject({
      sessionId: 'branched-session-1',
      title: 'Branched session',
      type: 'session',
    })
    const toasts = useUIStore.getState().toasts
    expect(toasts[toasts.length - 1]).toMatchObject({
      type: 'success',
      message: 'Created forked conversation "Branched session".',
    })
  })

  it('hides branch actions while the current session is still running', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'streaming',
          streamingText: 'partial',
          messages: [
            {
              id: 'local-user-1',
              transcriptMessageId: 'transcript-user-1',
              type: 'user_text',
              content: '从这里开始',
              timestamp: 1,
            },
            {
              id: 'local-assistant-1',
              transcriptMessageId: 'transcript-assistant-1',
              type: 'assistant_text',
              content: '这是完成的答复。',
              timestamp: 2,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    expect(screen.queryByRole('button', { name: 'Fork a new conversation' })).toBeNull()
  })

  it('keeps historical sessions readable when turn checkpoint payloads are missing', async () => {
    vi.spyOn(sessionsApi, 'getTurnCheckpoints').mockResolvedValue({} as never)

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '继续优化 workflow.py',
              timestamp: 1,
            },
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: '两个文件均已优化完成，功能保持不变。',
              timestamp: 2,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    expect(await screen.findByText('两个文件均已优化完成，功能保持不变。')).toBeTruthy()
    await waitFor(() => {
      expect(sessionsApi.getTurnCheckpoints).toHaveBeenCalled()
    })
    expect(screen.queryByText(/Cannot read properties/)).toBeNull()
    expect(screen.queryByLabelText('Turn changed files')).toBeNull()
  })

  it('renders multiple historical turn change cards across three turns', async () => {
    vi.spyOn(sessionsApi, 'getTurnCheckpoints').mockResolvedValue({
      checkpoints: [
        {
          target: {
            targetUserMessageId: 'user-1',
            userMessageIndex: 0,
            userMessageCount: 3,
          },
          code: {
            available: true,
            filesChanged: ['src/first.ts'],
            insertions: 3,
            deletions: 1,
          },
        },
        {
          target: {
            targetUserMessageId: 'user-2',
            userMessageIndex: 1,
            userMessageCount: 3,
          },
          code: {
            available: true,
            filesChanged: ['src/second.ts'],
            insertions: 5,
            deletions: 2,
          },
        },
        {
          target: {
            targetUserMessageId: 'user-3',
            userMessageIndex: 2,
            userMessageCount: 3,
          },
          code: {
            available: true,
            filesChanged: [],
            insertions: 0,
            deletions: 0,
          },
        },
      ],
    })

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '第一段',
              timestamp: 1,
            },
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: 'ok',
              timestamp: 2,
            },
            {
              id: 'user-2',
              type: 'user_text',
              content: '第二段',
              timestamp: 3,
            },
            {
              id: 'assistant-2',
              type: 'assistant_text',
              content: 'done',
              timestamp: 4,
            },
            {
              id: 'user-3',
              type: 'user_text',
              content: '第三段',
              timestamp: 5,
            },
            {
              id: 'assistant-3',
              type: 'assistant_text',
              content: 'done',
              timestamp: 6,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    const cards = await screen.findAllByLabelText('Turn changed files')
    expect(cards).toHaveLength(2)
    expect(screen.getByText('first.ts')).toBeTruthy()
    expect(screen.getByText('second.ts')).toBeTruthy()
    expect(screen.queryByText('third.ts')).toBeNull()
  })

  it('opens the workspace diff (working-tree) when a historical turn change row is clicked', async () => {
    vi.spyOn(sessionsApi, 'getTurnCheckpoints').mockResolvedValue({
      checkpoints: [
        {
          target: {
            targetUserMessageId: 'user-1',
            userMessageIndex: 0,
            userMessageCount: 2,
          },
          code: {
            available: true,
            filesChanged: ['src/first.ts'],
            insertions: 1,
            deletions: 1,
          },
        },
        {
          target: {
            targetUserMessageId: 'user-2',
            userMessageIndex: 1,
            userMessageCount: 2,
          },
          code: {
            available: true,
            filesChanged: ['src/second.ts'],
            insertions: 2,
            deletions: 0,
          },
        },
      ],
    })
    const getWorkspaceDiff = vi.spyOn(sessionsApi, 'getWorkspaceDiff').mockResolvedValue({
      state: 'ok',
      path: 'src/first.ts',
      diff: 'diff --session a/src/first.ts b/src/first.ts\n-old\n+new',
    })
    const getTurnCheckpointDiff = vi.spyOn(sessionsApi, 'getTurnCheckpointDiff')

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '第一轮',
              timestamp: 1,
            },
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: 'done',
              timestamp: 2,
            },
            {
              id: 'user-2',
              type: 'user_text',
              content: '第二轮',
              timestamp: 3,
            },
            {
              id: 'assistant-2',
              type: 'assistant_text',
              content: 'done',
              timestamp: 4,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    // Clicking the row no longer expands an inline diff inside the card — it jumps to
    // the right-side workspace and opens a diff tab (via workspacePanelStore.openPreview,
    // which fetches the *current working-tree* diff through getWorkspaceDiff).
    fireEvent.click(await screen.findByRole('button', { name: 'Open src/first.ts in workspace' }))

    await waitFor(() => {
      expect(getWorkspaceDiff).toHaveBeenCalledWith(ACTIVE_TAB, 'src/first.ts')
    })
    // The turn-snapshot diff endpoint is no longer used by the card.
    expect(getTurnCheckpointDiff).not.toHaveBeenCalled()
    // No inline diff surface is mounted inside the transcript anymore.
    expect(screen.queryByTestId('workspace-code')).toBeNull()
  })

  it('opens the workspace diff with the turn-relativized path (working-tree, not the turn snapshot)', async () => {
    vi.spyOn(sessionsApi, 'getWorkspaceStatus').mockResolvedValue({
      state: 'ok',
      workDir: '/tmp/current-project',
      repoName: 'current-project',
      branch: null,
      isGitRepo: false,
      changedFiles: [],
    })
    vi.spyOn(sessionsApi, 'getTurnCheckpoints').mockResolvedValue({
      checkpoints: [
        {
          target: {
            targetUserMessageId: 'user-1',
            userMessageIndex: 0,
            userMessageCount: 2,
          },
          workDir: '/tmp/old-project',
          code: {
            available: true,
            filesChanged: ['/tmp/old-project/src/first.ts'],
            insertions: 1,
            deletions: 1,
          },
        },
      ],
    })
    const getWorkspaceDiff = vi.spyOn(sessionsApi, 'getWorkspaceDiff').mockResolvedValue({
      state: 'ok',
      path: 'src/first.ts',
      diff: 'diff --git a/src/first.ts b/src/first.ts\n-old\n+new',
    })
    const getTurnCheckpointDiff = vi.spyOn(sessionsApi, 'getTurnCheckpointDiff')

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '第一轮',
              timestamp: 1,
            },
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: 'done',
              timestamp: 2,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    // The checkpoint's absolute path (under the turn's original cwd /tmp/old-project) is
    // relativized to 'src/first.ts' for display. Clicking the row opens the right-side
    // workspace diff for that relative path. Caveat (intended): the workspace diff is the
    // current working-tree diff, NOT the historical turn snapshot — so the turn cwd is no
    // longer carried through, and getTurnCheckpointDiff is not called.
    fireEvent.click(await screen.findByRole('button', { name: 'Open src/first.ts in workspace' }))

    await waitFor(() => {
      expect(getWorkspaceDiff).toHaveBeenCalledWith(ACTIVE_TAB, 'src/first.ts')
    })
    expect(getTurnCheckpointDiff).not.toHaveBeenCalled()
  })

  it('relativizes Windows checkpoint paths against the turn workdir', () => {
    expect(relativizeWorkspacePath(
      'C:\\Users\\Relakkes\\aacc\\src\\App.tsx',
      'c:/users/relakkes/aacc',
    )).toBe('src/App.tsx')
  })

  it('matches live turn change checkpoints by user message index when transcript ids differ from local UI ids', async () => {
    vi.spyOn(sessionsApi, 'getTurnCheckpoints').mockResolvedValue({
      checkpoints: [
        {
          target: {
            targetUserMessageId: 'transcript-user-1',
            userMessageIndex: 0,
            userMessageCount: 1,
          },
          code: {
            available: true,
            filesChanged: ['src/live.ts'],
            insertions: 7,
            deletions: 0,
          },
        },
      ],
    })
    const getWorkspaceDiff = vi.spyOn(sessionsApi, 'getWorkspaceDiff').mockResolvedValue({
      state: 'ok',
      path: 'src/live.ts',
      diff: 'diff --session a/src/live.ts b/src/live.ts\n+live',
    })

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'local-user-temp-id',
              type: 'user_text',
              content: '实时这一轮',
              timestamp: 1,
            },
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: 'done',
              timestamp: 2,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    // The card only renders if the transcript checkpoint (id 'transcript-user-1') was
    // matched to the local message ('local-user-temp-id') by userMessageIndex.
    expect(await screen.findByText('live.ts')).toBeTruthy()
    // Clicking the row jumps to the right-side workspace diff for the relativized path.
    fireEvent.click(screen.getByRole('button', { name: 'Open src/live.ts in workspace' }))
    await waitFor(() => {
      expect(getWorkspaceDiff).toHaveBeenCalledWith(ACTIVE_TAB, 'src/live.ts')
    })
  })

  it('keeps turn change cards anchored when the only response item is filtered from rendering', async () => {
    vi.spyOn(sessionsApi, 'getTurnCheckpoints').mockResolvedValue({
      checkpoints: [
        {
          target: {
            targetUserMessageId: 'user-1',
            userMessageIndex: 0,
            userMessageCount: 1,
          },
          code: {
            available: true,
            filesChanged: ['src/blank-response.ts'],
            insertions: 3,
            deletions: 0,
          },
        },
      ],
    })

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '生成文件',
              timestamp: 1,
            },
            {
              id: 'assistant-empty',
              type: 'assistant_text',
              content: '\n  ',
              timestamp: 2,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    expect(await screen.findByText('blank-response.ts')).toBeTruthy()
  })

  it('keeps historical turn change cards visible while the next turn is running', async () => {
    vi.spyOn(sessionsApi, 'getTurnCheckpoints').mockResolvedValue({
      checkpoints: [
        {
          target: {
            targetUserMessageId: 'user-1',
            userMessageIndex: 0,
            userMessageCount: 1,
          },
          code: {
            available: true,
            filesChanged: ['src/first.ts'],
            insertions: 1,
            deletions: 0,
          },
        },
      ],
    })

    const messages: UIMessage[] = [
      {
        id: 'user-1',
        type: 'user_text',
        content: '第一轮',
        timestamp: 1,
      },
      {
        id: 'assistant-1',
        type: 'assistant_text',
        content: 'done',
        timestamp: 2,
      },
    ]

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({ messages }),
      },
    })

    render(<MessageList />)

    expect(await screen.findByText('first.ts')).toBeTruthy()

    act(() => {
      useChatStore.setState({
        sessions: {
          [ACTIVE_TAB]: makeSessionState({
            messages,
            chatState: 'thinking',
          }),
        },
      })
    })

    await waitFor(() => {
      expect(screen.getByText('first.ts')).toBeTruthy()
    })
  })

  it('confirms before rewinding to an earlier turn from a historical change card', async () => {
    vi.spyOn(sessionsApi, 'getTurnCheckpoints').mockResolvedValue({
      checkpoints: [
        {
          target: {
            targetUserMessageId: 'user-1',
            userMessageIndex: 0,
            userMessageCount: 2,
          },
          code: {
            available: true,
            filesChanged: ['src/first.ts'],
            insertions: 1,
            deletions: 0,
          },
        },
        {
          target: {
            targetUserMessageId: 'user-2',
            userMessageIndex: 1,
            userMessageCount: 2,
          },
          code: {
            available: true,
            filesChanged: ['src/second.ts'],
            insertions: 1,
            deletions: 0,
          },
        },
      ],
    })
    vi.spyOn(sessionsApi, 'rewind')
      .mockResolvedValueOnce({
        target: {
          targetUserMessageId: 'user-1',
          userMessageIndex: 0,
          userMessageCount: 1,
        },
        conversation: {
          messagesRemoved: 2,
        },
        code: {
          available: true,
          filesChanged: ['src/App.tsx'],
          insertions: 1,
          deletions: 0,
        },
      })
      .mockResolvedValueOnce({
        target: {
          targetUserMessageId: 'user-1',
          userMessageIndex: 0,
          userMessageCount: 1,
        },
        conversation: {
          messagesRemoved: 2,
          removedMessageIds: ['user-1', 'assistant-1'],
        },
        code: {
          available: true,
          filesChanged: ['src/App.tsx'],
          insertions: 1,
          deletions: 0,
        },
      })
    const reloadHistory = vi.fn().mockResolvedValue(undefined)
    const queueComposerPrefill = vi.fn()

    useChatStore.setState({
      reloadHistory,
      queueComposerPrefill,
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '做一个页面',
              timestamp: 1,
            },
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: 'first done',
              timestamp: 2,
            },
            {
              id: 'user-2',
              type: 'user_text',
              content: '第二轮需求',
              timestamp: 3,
            },
            {
              id: 'assistant-2',
              type: 'assistant_text',
              content: 'second done',
              timestamp: 4,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    const historicalCard = (await screen.findByText('first.ts')).closest('section')
    expect(historicalCard).toBeTruthy()
    fireEvent.click(
      within(historicalCard as HTMLElement).getByRole('button', {
        name: 'Rewind to before this turn',
      }),
    )

    expect(sessionsApi.rewind).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog', { name: 'Rewind to before this turn?' })
    expect(
      within(dialog).getByText(
        'This will rewind the conversation to before this turn and restore tracked files for that checkpoint.',
      ),
    ).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Rewind to before this turn' }))

    await waitFor(() => {
      expect(sessionsApi.rewind).toHaveBeenLastCalledWith(ACTIVE_TAB, {
        targetUserMessageId: 'user-1',
        userMessageIndex: 0,
        expectedContent: '做一个页面',
      })
    })
    expect(reloadHistory).toHaveBeenCalledWith(ACTIVE_TAB)
    expect(queueComposerPrefill).toHaveBeenCalledWith(ACTIVE_TAB, {
      text: '做一个页面',
      attachments: undefined,
    })
  })

  it('does not render cards for turns without file changes', async () => {
    vi.spyOn(sessionsApi, 'getTurnCheckpoints').mockResolvedValue({
      checkpoints: [
        {
          target: {
            targetUserMessageId: 'user-1',
            userMessageIndex: 0,
            userMessageCount: 2,
          },
          code: {
            available: true,
            filesChanged: ['src/first.ts'],
            insertions: 2,
            deletions: 1,
          },
        },
        {
          target: {
            targetUserMessageId: 'user-2',
            userMessageIndex: 1,
            userMessageCount: 2,
          },
          code: {
            available: true,
            filesChanged: [],
            insertions: 0,
            deletions: 0,
          },
        },
      ],
    })

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '第一轮改文件',
              timestamp: 1,
            },
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: 'first done',
              timestamp: 2,
            },
            {
              id: 'user-2',
              type: 'user_text',
              content: '第二轮只解释',
              timestamp: 3,
            },
            {
              id: 'assistant-2',
              type: 'assistant_text',
              content: 'second done',
              timestamp: 4,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    const cards = await screen.findAllByLabelText('Turn changed files')
    expect(cards).toHaveLength(1)
    expect(screen.getByText('first.ts')).toBeTruthy()
    expect(screen.queryByText('second.ts')).toBeNull()
  })

  it('shows raw startup details under translated CLI startup errors', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'error-1',
              type: 'error',
              code: 'CLI_START_FAILED',
              message:
                'CLI exited during startup (code 1): Claude Code on Windows requires git-bash (https://git-scm.com/downloads/win).',
              timestamp: 1,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    expect(screen.getByText('Failed to start CLI process.')).toBeTruthy()
    expect(
      screen.getByText(
        'CLI exited during startup (code 1): Claude Code on Windows requires git-bash (https://git-scm.com/downloads/win).',
      ),
    ).toBeTruthy()
  })

  it('renders business API errors in the active locale without raw English fallback', () => {
    useSettingsStore.setState({ locale: 'zh' })
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'error-1',
              type: 'error',
              code: 'invalid_request',
              businessErrorCode: 'image_unsupported',
              message:
                'This model does not support images. Continue with text, or switch to a vision-capable model and send the image again.',
              timestamp: 1,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    expect(screen.getByText('错误:')).toBeTruthy()
    expect(
      screen.getByText(
        '当前模型不支持图片。请继续使用文字，或切换到支持视觉的模型后重新发送图片。',
      ),
    ).toBeTruthy()
    expect(screen.queryByText(/This model does not support images/)).toBeNull()
  })
})

describe('shouldVirtualizeRenderItems', () => {
  const metric = (contentWeight: number): VirtualRenderItemMetric => ({
    signature: 'sig',
    contentWeight,
    estimatedHeight: 100,
  })

  it('virtualizes at the desktop thresholds (120 items / 120k chars)', () => {
    expect(shouldVirtualizeRenderItems(Array.from({ length: 119 }, () => metric(10)), false)).toBe(false)
    expect(shouldVirtualizeRenderItems(Array.from({ length: 120 }, () => metric(10)), false)).toBe(true)
    expect(shouldVirtualizeRenderItems([metric(119_999)], false)).toBe(false)
    expect(shouldVirtualizeRenderItems([metric(120_000)], false)).toBe(true)
  })

  it('virtualizes at half the thresholds on touch-H5, where content-visibility is disabled', () => {
    expect(shouldVirtualizeRenderItems(Array.from({ length: 59 }, () => metric(10)), true)).toBe(false)
    expect(shouldVirtualizeRenderItems(Array.from({ length: 60 }, () => metric(10)), true)).toBe(true)
    expect(shouldVirtualizeRenderItems([metric(59_999)], true)).toBe(false)
    expect(shouldVirtualizeRenderItems([metric(60_000)], true)).toBe(true)
  })

  it('defaults the touch flag from the document marker', () => {
    const metrics = Array.from({ length: 60 }, () => metric(10))
    expect(shouldVirtualizeRenderItems(metrics)).toBe(false)

    document.documentElement.setAttribute('data-touch-h5', 'true')
    try {
      expect(shouldVirtualizeRenderItems(metrics)).toBe(true)
    } finally {
      document.documentElement.removeAttribute('data-touch-h5')
    }
  })
})
