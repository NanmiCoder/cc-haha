import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MessageList, buildRenderModel } from './MessageList'
import { relativizeWorkspacePath } from './CurrentTurnChangeCard'
import { sessionsApi } from '../../api/sessions'
import { useChatStore } from '../../stores/chatStore'
import { useWorkspaceChatContextStore } from '../../stores/workspaceChatContextStore'
import { useSettingsStore } from '../../stores/settingsStore'
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
    elapsedSeconds: 0,
    statusVerb: '',
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

async function selectMessageText(element: Element, text: string) {
  const textNode = findTextNodeContaining(element, text)
  const startOffset = textNode.textContent?.indexOf(text) ?? -1
  const range = document.createRange()
  range.setStart(textNode, startOffset)
  range.setEnd(textNode, startOffset + text.length)
  Object.assign(range, {
    getBoundingClientRect: () => ({
      left: 160,
      top: 80,
      right: 280,
      bottom: 98,
      width: 120,
      height: 18,
      x: 160,
      y: 80,
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

  await act(async () => {
    fireEvent.mouseUp(element, { clientX: 260, clientY: 104 })
    await Promise.resolve()
  })
}

describe('MessageList nested tool calls', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ pendingSettingsTab: null })
    useTabStore.setState({ activeTabId: ACTIVE_TAB, tabs: [{ sessionId: ACTIVE_TAB, title: 'Test', type: 'session' as const, status: 'idle' }] })
    useChatStore.setState({ sessions: { [ACTIVE_TAB]: makeSessionState() } })
    useWorkspaceChatContextStore.setState(useWorkspaceChatContextStore.getInitialState(), true)
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

  it('keeps full long transcripts mounted so variable-height messages cannot leave spacer gaps', () => {
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

    expect(screen.getByText('assistant transcript line 0')).toBeTruthy()
    expect(screen.getByText('assistant transcript line 219')).toBeTruthy()
    expect(container.querySelectorAll('[data-message-shell="assistant"]').length).toBe(220)
    expect(container.querySelector('[data-virtual-message-item]')).toBeNull()
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

  it('renders background agent progress inline in the transcript', () => {
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
              id: 'background-task-agent-1',
              type: 'background_task',
              timestamp: 2,
              task: {
                taskId: 'agent-task-1',
                toolUseId: 'agent-tool-1',
                status: 'running',
                taskType: 'local_agent',
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
    expect(card.textContent).toContain('local_agent')
    expect(card.textContent).toContain('running')
    expect(card.textContent).toContain('Running Playwright checks')
    expect(card.textContent).toContain('1,200 tokens')
    expect(card.textContent).toContain('45s')
  })

  it('renders stopped background agents as neutral transcript events', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [{
            id: 'background-task-agent-stopped',
            type: 'background_task',
            timestamp: 2,
            task: {
              taskId: 'agent-task-stopped',
              toolUseId: 'agent-tool-stopped',
              status: 'stopped',
              taskType: 'local_agent',
              summary: 'Agent "Code review for todo app" was stopped',
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

  it('restores the full transcript when scrolling away from latest', async () => {
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
    expect(screen.getByText('assistant transcript line 219')).toBeTruthy()
    expect(container.querySelectorAll('[data-message-shell="assistant"]').length).toBe(220)
  })

  it('keeps long histories with tool-call groups mounted while scrolling history', async () => {
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

    expect(screen.getByText('Read')).toBeTruthy()
    expect(screen.getByText('assistant transcript line 219')).toBeTruthy()

    scrollArea.scrollTop = 0
    await act(async () => {
      fireEvent.scroll(scrollArea)
    })

    expect(screen.getByText('Read')).toBeTruthy()
    expect(screen.getByText('assistant transcript line 219')).toBeTruthy()
    expect(container.querySelector('[data-virtual-message-item]')).toBeNull()
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

    expect(floatingAddButton.style.left).toBe('260px')
    expect(floatingAddButton.style.top).toBe('112px')

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
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))

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
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '请把这条 prompt 放在右侧',
              timestamp: 1,
            },
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: '这条回复应该停在左侧。',
              timestamp: 2,
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
    expect(assistantShell).toBeTruthy()
    expect(assistantShell?.className).toContain('items-start')
    expect(assistantShell?.className).not.toContain('ml-10')
    expect(userActions?.getAttribute('data-align')).toBe('end')
    expect(assistantActions?.getAttribute('data-align')).toBe('start')
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
    expect(screen.getByText('src/first.ts')).toBeTruthy()
    expect(screen.getByText('src/second.ts')).toBeTruthy()
    expect(screen.queryByText('src/third.ts')).toBeNull()
  })

  it('expands a historical turn diff through the turn checkpoint diff API', async () => {
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
    vi.spyOn(sessionsApi, 'getWorkspaceDiff').mockResolvedValue({
      state: 'ok',
      path: 'src/first.ts',
      diff: 'diff --session a/src/first.ts b/src/first.ts\n-old\n+new',
    })
    vi.spyOn(sessionsApi, 'getTurnCheckpointDiff').mockResolvedValue({
      state: 'ok',
      path: 'src/first.ts',
      diff: 'diff --session a/src/first.ts b/src/first.ts\n-old\n+new',
    })

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

    fireEvent.click(await screen.findByRole('button', { name: 'Show diff for src/first.ts' }))

    const diffSurface = await screen.findByTestId('workspace-code')
    expect(diffSurface.textContent).toContain('+new')
    expect(sessionsApi.getTurnCheckpointDiff).toHaveBeenCalledWith(
      ACTIVE_TAB,
      'user-1',
      'src/first.ts',
      0,
    )
    expect(sessionsApi.getWorkspaceDiff).not.toHaveBeenCalled()
  })

  it('keeps checkpoint paths bound to the original turn cwd when expanding historical diffs', async () => {
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
    vi.spyOn(sessionsApi, 'getTurnCheckpointDiff').mockResolvedValue({
      state: 'ok',
      path: '/tmp/old-project/src/first.ts',
      diff: 'diff --git a/src/first.ts b/src/first.ts\n-old\n+new',
    })

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

    fireEvent.click(await screen.findByRole('button', { name: 'Show diff for src/first.ts' }))

    await screen.findByTestId('workspace-code')
    expect(sessionsApi.getTurnCheckpointDiff).toHaveBeenCalledWith(
      ACTIVE_TAB,
      'user-1',
      '/tmp/old-project/src/first.ts',
      0,
    )
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
    vi.spyOn(sessionsApi, 'getTurnCheckpointDiff').mockResolvedValue({
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

    expect(await screen.findByText('src/live.ts')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show diff for src/live.ts' }))
    await screen.findByTestId('workspace-code')
    expect(sessionsApi.getTurnCheckpointDiff).toHaveBeenCalledWith(
      ACTIVE_TAB,
      'transcript-user-1',
      'src/live.ts',
      0,
    )
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

    expect(await screen.findByText('src/blank-response.ts')).toBeTruthy()
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

    expect(await screen.findByText('src/first.ts')).toBeTruthy()

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
      expect(screen.getByText('src/first.ts')).toBeTruthy()
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

    const historicalCard = (await screen.findByText('src/first.ts')).closest('section')
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
    expect(screen.getByText('src/first.ts')).toBeTruthy()
    expect(screen.queryByText('src/second.ts')).toBeNull()
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
})
