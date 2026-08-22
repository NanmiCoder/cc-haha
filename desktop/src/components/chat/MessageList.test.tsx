import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  MessageList,
  buildRenderModel,
  buildTurnRailPositions,
  buildVirtualItemOffsets,
  estimateRenderItemHeight,
  getActiveConversationNavigationItemId,
  getConversationNavigationTargetScrollTop,
  isRenderItemFullyVisibleInChatScroller,
  resetSessionScrollSnapshotsForTests,
  shouldVirtualizeRenderItems,
  trailingStreamingRailPosition,
} from './MessageList'
import type { ConversationNavigationItem } from './ConversationNavigator'
import {
  dropSession,
  getHeightsForSession,
  type VirtualRenderItemMetric,
} from './virtualHeightCache'
import { relativizeWorkspacePath } from './CurrentTurnChangeCard'
import { sessionsApi } from '../../api/sessions'
import { teamsApi } from '../../api/teams'
import { useChatStore } from '../../stores/chatStore'
import { useWorkspaceChatContextStore } from '../../stores/workspaceChatContextStore'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import { useTeamStore } from '../../stores/teamStore'
import { formatExactMessageTimestamp, formatMessageHoverTime } from '../../lib/formatMessageTimestamp'
import type { UIMessage } from '../../types/chat'
import type { PerSessionState } from '../../stores/chatStore'
import { FindInPageModal } from '../search/FindInPageModal'

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

function makeConversationNavigationMessages(): UIMessage[] {
  return [
    { id: 'user-1', type: 'user_text', content: 'First prompt', timestamp: 1 },
    { id: 'assistant-1', type: 'assistant_text', content: 'First answer', timestamp: 2 },
    { id: 'user-2', type: 'user_text', content: 'Second prompt', timestamp: 3 },
    { id: 'assistant-2', type: 'assistant_text', content: 'Second answer', timestamp: 4 },
    { id: 'user-3', type: 'user_text', content: 'Third prompt', timestamp: 5 },
    { id: 'assistant-3', type: 'assistant_text', content: 'Third answer', timestamp: 6 },
    { id: 'user-4', type: 'user_text', content: 'Fourth prompt', timestamp: 7 },
    { id: 'assistant-4', type: 'assistant_text', content: 'Fourth answer', timestamp: 8 },
  ]
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

function fireSelectionPointerEvent(
  target: Element | Document,
  type: 'down' | 'up',
  {
    button,
    clientX,
    clientY,
    pointerId,
    pointerType,
    ctrlKey = false,
  }: {
    button: number
    clientX: number
    clientY: number
    pointerId: number
    pointerType: string
    ctrlKey?: boolean
  },
) {
  const event = type === 'down'
    ? createEvent.pointerDown(target)
    : createEvent.pointerUp(target)
  Object.defineProperties(event, {
    button: { value: button },
    clientX: { value: clientX },
    clientY: { value: clientY },
    pointerId: { value: pointerId },
    pointerType: { value: pointerType },
    ctrlKey: { value: ctrlKey },
  })
  fireEvent(target, event)
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
    fireSelectionPointerEvent(element, 'down', {
      button: 0,
      clientX: rect.left ?? 160,
      clientY: rect.top ?? 80,
      pointerId: 1,
      pointerType: 'mouse',
    })
    fireSelectionPointerEvent(element, 'up', {
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
    getClientRects: () => [
      {
        left: rect.left ?? 160,
        top: rect.top ?? 80,
        right: (rect.left ?? 160) + 200,
        bottom: (rect.top ?? 80) + 18,
        width: 200,
        height: 18,
      },
      {
        left: rect.left ?? 160,
        top: (rect.bottom ?? 150) - 18,
        right: rect.right ?? 520,
        bottom: rect.bottom ?? 150,
        width: (rect.right ?? 520) - (rect.left ?? 160),
        height: 18,
      },
    ],
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
    fireSelectionPointerEvent(startElement, 'down', {
      button: 0,
      clientX: rect.left ?? 160,
      clientY: rect.top ?? 80,
      pointerId: 1,
      pointerType: 'mouse',
    })
    fireSelectionPointerEvent(endElement, 'up', {
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
    resetSessionScrollSnapshotsForTests()
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ pendingSettingsTab: null })
    useTabStore.setState({ activeTabId: ACTIVE_TAB, tabs: [{ sessionId: ACTIVE_TAB, title: 'Test', type: 'session' as const, status: 'idle' }] })
    useSessionStore.setState({ sessions: [], activeSessionId: null, isLoading: false, error: null })
    useChatStore.setState({ sessions: { [ACTIVE_TAB]: makeSessionState() } })
    useTeamStore.getState().clearTeam()
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

  afterEach(() => {
    vi.useRealTimers()
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

  it('renders a single optimistic image attachment at readable size through the real send transition', () => {
    render(<MessageList sessionId={ACTIVE_TAB} />)

    act(() => {
      useChatStore.getState().sendMessage(ACTIVE_TAB, '', [{
        type: 'image',
        name: 'single.png',
        data: 'data:image/png;base64,AAAA',
        mimeType: 'image/png',
      }])
    })

    const className = screen.getByRole('img', { name: 'single.png' }).className
    expect(className).toContain('max-h-[340px]')
    expect(className).toContain('max-w-[360px]')
  })

  it('keeps the ImageGen result as the only image owner when final Markdown repeats its managed path', () => {
    const generatedPath = '/Users/me/.claude/cc-haha/generated-images/session/result.png'
    render(<MessageList sessionId={ACTIVE_TAB} />)
    const store = useChatStore.getState()

    act(() => {
      store.sendMessage(ACTIVE_TAB, 'Generate an image')
      store.handleServerMessage(ACTIVE_TAB, {
        type: 'content_start',
        blockType: 'tool_use',
        toolName: 'ImageGen',
        toolUseId: 'imagegen-1',
      })
      store.handleServerMessage(ACTIVE_TAB, {
        type: 'tool_use_complete',
        toolName: 'ImageGen',
        toolUseId: 'imagegen-1',
        input: { prompt: 'A paper-cut fox', count: 1 },
      })
      store.handleServerMessage(ACTIVE_TAB, {
        type: 'tool_result',
        toolUseId: 'imagegen-1',
        content: JSON.stringify({
          type: 'image_generation_result',
          operation: 'generate',
          inputImageCount: 0,
          providerId: 'openai-official',
          providerKind: 'openai_oauth',
          model: 'gpt-image-2',
          prompt: 'A paper-cut fox',
          images: [{ path: generatedPath, mimeType: 'image/png' }],
          durationMs: 1200,
        }),
        isError: false,
      })
      store.handleServerMessage(ACTIVE_TAB, { type: 'content_start', blockType: 'text' })
      store.handleServerMessage(ACTIVE_TAB, {
        type: 'content_delta',
        text: `Created ![result](${generatedPath})`,
      })
      store.handleServerMessage(ACTIVE_TAB, { type: 'status', state: 'idle' })
    })

    const images = screen.getAllByRole('img')
    expect(images).toHaveLength(1)
    expect(images[0]?.getAttribute('src')).toContain(encodeURIComponent(generatedPath))
    expect(document.querySelector('img:not([src])')).toBeNull()
  })

  it('keeps fractional border-box jitter from invalidating a settled virtual row', async () => {
    const sessionId = 'virtual-row-measurement-jitter'
    const observers: Array<{
      callback: ResizeObserverCallback
      targets: Element[]
    }> = []
    class TestResizeObserver {
      targets: Element[] = []
      observe = vi.fn((target: Element) => {
        this.targets.push(target)
      })
      unobserve = vi.fn()
      disconnect = vi.fn()

      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, targets: this.targets })
      }
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    dropSession(sessionId)
    useChatStore.setState({
      sessions: {
        [sessionId]: makeSessionState({
          messages: Array.from({ length: 220 }, (_, index) => ({
            id: `fractional-assistant-${index}`,
            type: 'assistant_text' as const,
            content: `fractional transcript line ${index}`,
            timestamp: index,
          })),
        }),
      },
    })

    const { container } = render(<MessageList sessionId={sessionId} />)
    const item = container.querySelector<HTMLElement>('[data-virtual-message-item]')
    expect(item).toBeTruthy()
    const itemKey = item!.dataset.virtualMessageItem!
    const itemObserver = observers.find(({ targets }) => targets.includes(item!))
    expect(itemObserver).toBeTruthy()

    const reportHeight = async (height: number) => {
      act(() => {
        itemObserver?.callback([{
          target: item!,
          borderBoxSize: [{ blockSize: height, inlineSize: 800 }],
          contentRect: { height: height - 8 },
        } as unknown as ResizeObserverEntry], {} as ResizeObserver)
      })
      await waitForProgrammaticScrollReset()
    }

    // Windows fractional DPI can place a stable border box on opposite sides
    // of an integer boundary. Ceil turned this sub-pixel noise into an endless
    // 1px cache update and MessageList repaint (#1223).
    await reportHeight(117.99)
    expect(getHeightsForSession(sessionId).get(itemKey)).toBeCloseTo(117.99)

    await reportHeight(118.01)
    expect(getHeightsForSession(sessionId).get(itemKey)).toBeCloseTo(117.99)

    await reportHeight(119.99)
    expect(getHeightsForSession(sessionId).get(itemKey)).toBeCloseTo(117.99)

    // A real layout change still has to update the virtual offsets.
    await reportHeight(121.25)
    expect(getHeightsForSession(sessionId).get(itemKey)).toBeCloseTo(121.25)
    dropSession(sessionId)
  })

  it('finds, mounts, navigates, and highlights matches outside a 120-item virtual window', async () => {
    const highlights = new Map<string, { ranges: Range[]; priority?: number }>()
    class TestHighlight {
      ranges: Range[] = []
      priority?: number

      add(range: Range) {
        this.ranges.push(range)
      }
    }
    vi.stubGlobal('CSS', { highlights })
    vi.stubGlobal('Highlight', TestHighlight)

    const messages = Array.from({ length: 130 }, (_, index) => ({
      id: `assistant-${index}`,
      type: 'assistant_text' as const,
      content: index === 0 || index === 64
        ? `Virtual history needle ${index}`
        : `Virtual history filler ${index}`,
      timestamp: index,
    }))
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages,
        }),
      },
    })

    const { container } = render(
      <>
        <MessageList />
        <FindInPageModal open onClose={() => {}} />
      </>,
    )
    const scroller = container.querySelector('.chat-scroll-area') as HTMLElement
    let scrollTop = 15_000
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 })
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 16_000 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value },
    })

    expect(screen.queryByText('Virtual history needle 0')).toBeNull()
    expect(screen.queryByText('Virtual history needle 64')).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value: 'Virtual history needle' } })

    await waitFor(() => expect(screen.getByText('1 / 2')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('Virtual history needle 0')).toBeTruthy())
    expect(scrollTop).toBe(0)
    await waitFor(() => expect(highlights.get('cc-find-active')?.ranges[0]?.startContainer.parentElement?.closest('[data-chat-render-item-key]')?.getAttribute('data-chat-render-item-key')).toBe('assistant-0'))

    fireEvent.click(screen.getByRole('button', { name: 'Next match' }))

    await waitFor(() => expect(screen.getByText('2 / 2')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('Virtual history needle 64')).toBeTruthy())
    expect(scrollTop).toBeGreaterThan(0)
    expect(highlights.get('cc-find-active')?.ranges[0]?.startContainer.parentElement?.closest('[data-chat-render-item-key]')?.getAttribute('data-chat-render-item-key')).toBe('assistant-64')

    act(() => {
      useChatStore.setState({
        sessions: {
          [ACTIVE_TAB]: makeSessionState({
            messages: [...messages, {
              id: 'assistant-new-tail',
              type: 'assistant_text',
              content: 'new Virtual history needle response',
              timestamp: 131,
            }],
          }),
        },
      })
    })
    await waitFor(() => expect(screen.getByText('2 / 3')).toBeTruthy())
    expect(highlights.get('cc-find-active')?.ranges[0]?.startContainer.parentElement?.closest('[data-chat-render-item-key]')?.getAttribute('data-chat-render-item-key')).toBe('assistant-64')
  })

  it('bounds semantic conversation matches and ignores hidden tool payloads', async () => {
    const highlights = new Map<string, { ranges: Range[] }>()
    class TestHighlight {
      ranges: Range[] = []

      add(range: Range) {
        this.ranges.push(range)
      }
    }
    vi.stubGlobal('CSS', { highlights })
    vi.stubGlobal('Highlight', TestHighlight)
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'assistant-many-matches',
              type: 'assistant_text',
              content: 'boundedneedle '.repeat(1_100),
              timestamp: 1,
            },
            {
              id: 'hidden-tool-payload',
              type: 'tool_result',
              toolUseId: 'tool-1',
              content: 'hiddenpayloadneedle '.repeat(10_000),
              isError: false,
              timestamp: 2,
            },
          ],
        }),
      },
    })

    render(
      <>
        <MessageList />
        <FindInPageModal open onClose={() => {}} />
      </>,
    )

    fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value: 'boundedneedle' } })
    await waitFor(() => expect(screen.getByText('1 / 1000')).toBeTruthy())
    await waitFor(() => expect(highlights.get('cc-find-results')?.ranges).toHaveLength(1_000))

    fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value: 'hiddenpayloadneedle' } })
    await waitFor(() => expect(screen.getByText('0')).toBeTruthy())
  })

  it('finds the current streaming assistant response', async () => {
    const highlights = new Map<string, { ranges: Range[] }>()
    class TestHighlight {
      ranges: Range[] = []

      add(range: Range) {
        this.ranges.push(range)
      }
    }
    vi.stubGlobal('CSS', { highlights })
    vi.stubGlobal('Highlight', TestHighlight)
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'streaming',
          streamingText: 'Current streaming response without the target',
        }),
      },
    })

    render(
      <>
        <MessageList />
        <FindInPageModal open onClose={() => {}} />
      </>,
    )

    fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value: 'late streaming needle' } })

    await waitFor(() => expect(screen.getByText('0')).toBeTruthy())
    act(() => {
      useChatStore.setState({
        sessions: {
          [ACTIVE_TAB]: makeSessionState({
            chatState: 'streaming',
            streamingText: 'Current late streaming needle',
          }),
        },
      })
    })

    await waitFor(() => expect(screen.getByText('1 / 1')).toBeTruthy())
    await waitFor(() => expect(highlights.get('cc-find-active')?.ranges[0]?.startContainer.parentElement?.closest('[data-chat-render-item-key]')?.getAttribute('data-chat-render-item-key')).toBe('streaming-assistant-message'))

    act(() => {
      useChatStore.setState({
        sessions: {
          [ACTIVE_TAB]: makeSessionState({
            messages: [{
              id: 'assistant-completed-stream',
              type: 'assistant_text',
              content: 'Current late streaming needle',
              timestamp: 2,
            }],
            chatState: 'idle',
            streamingText: '',
          }),
        },
      })
    })
    await waitFor(() => expect(highlights.get('cc-find-active')?.ranges[0]?.startContainer.parentElement?.closest('[data-chat-render-item-key]')?.getAttribute('data-chat-render-item-key')).toBe('assistant-completed-stream'))
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

  it('keeps the conversation navigator available in compact desktop transcripts', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: makeConversationNavigationMessages(),
        }),
      },
    })

    const { rerender } = render(<MessageList />)
    expect(screen.getByRole('navigation', { name: 'Conversation navigation' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /Turn \d of 4/ })).toHaveLength(4)
    expect(screen.queryByRole('button', { name: /Assistant message/ })).toBeNull()

    rerender(<MessageList compact />)
    expect(screen.getByRole('navigation', { name: 'Conversation navigation' })).toBeTruthy()
  })

  it('adapts the conversation navigator when the chat column is resized by adjacent panels', () => {
    const observers: Array<{
      callback: ResizeObserverCallback
      targets: Element[]
    }> = []
    class TestResizeObserver {
      targets: Element[] = []
      observe = vi.fn((target: Element) => {
        this.targets.push(target)
      })
      unobserve = vi.fn()
      disconnect = vi.fn()

      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, targets: this.targets })
      }
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver)

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: makeConversationNavigationMessages(),
        }),
      },
    })

    const { rerender } = render(<MessageList />)
    const messageList = screen.getByTestId('message-list')
    const scroller = messageList.querySelector('.chat-scroll-area') as HTMLElement
    const layoutObserver = observers.find(({ targets }) => targets.includes(messageList))
    expect(layoutObserver).toBeTruthy()
    expect(screen.getByTestId('conversation-navigator').getAttribute('data-mode')).toBe('full')
    expect(scroller.className.split(/\s+/)).toContain('px-20')

    const resizeTo = (width: number) => {
      act(() => {
        layoutObserver?.callback([{
          target: messageList,
          contentRect: { width },
        } as unknown as ResizeObserverEntry], {} as ResizeObserver)
      })
    }

    resizeTo(900)
    expect(screen.getByTestId('conversation-navigator').getAttribute('data-mode')).toBe('compact')
    expect(scroller.className.split(/\s+/)).toContain('px-12')

    resizeTo(640)
    expect(screen.getByTestId('conversation-navigator').getAttribute('data-mode')).toBe('compact')

    resizeTo(520)
    expect(screen.getByTestId('conversation-navigator').getAttribute('data-mode')).toBe('edge')
    expect(scroller.className.split(/\s+/)).toContain('px-7')

    resizeTo(1000)
    expect(screen.getByTestId('conversation-navigator').getAttribute('data-mode')).toBe('full')
    expect(scroller.className.split(/\s+/)).toContain('px-20')
    expect(scroller.className.split(/\s+/)).not.toContain('px-12')
    expect(scroller.className.split(/\s+/)).not.toContain('px-7')

    rerender(<MessageList compact />)
    expect(scroller.className.split(/\s+/)).toContain('px-20')

    resizeTo(900)
    expect(scroller.className.split(/\s+/)).toContain('px-12')

    resizeTo(520)
    expect(scroller.className.split(/\s+/)).toContain('px-7')
  })

  it('updates the active conversation marker while the transcript scrolls', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: makeConversationNavigationMessages(),
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.chat-scroll-area') as HTMLElement
    let scrollTop = 2
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 200 })
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 600 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value },
    })

    fireEvent.scroll(scroller)
    expect(screen.getByRole('button', { name: /Turn 1 of 4: First prompt/ }).getAttribute('aria-current')).toBe('location')

    scrollTop = 250
    fireEvent.scroll(scroller)
    expect(screen.getByRole('button', { name: /Turn 2 of 4: Second prompt/ }).getAttribute('aria-current')).toBe('location')

    scrollTop = 400
    fireEvent.scroll(scroller)
    expect(screen.getAllByRole('button', { name: /Turn \d of 4/ }).every((marker) => (
      marker.getAttribute('aria-current') === null
    ))).toBe(true)
  })

  it('keeps a clicked turn active until user scrolling resumes, then clears it at latest', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: makeConversationNavigationMessages(),
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.chat-scroll-area') as HTMLElement
    let scrollTop = 0
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 200 })
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 900 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value },
    })
    Object.defineProperty(scroller, 'scrollTo', {
      configurable: true,
      value: (options: ScrollToOptions) => { scrollTop = options.top ?? 0 },
    })

    const thirdTurn = screen.getByRole('button', { name: /Turn 3 of 4: Third prompt/ })
    fireEvent.click(thirdTurn)

    scrollTop = 250
    fireEvent.scroll(scroller)
    expect(thirdTurn.getAttribute('aria-current')).toBe('location')

    fireEvent.pointerDown(scroller)
    expect(thirdTurn.getAttribute('aria-current')).toBe('location')
    fireEvent.wheel(scroller, { deltaY: -100 })
    expect(thirdTurn.getAttribute('aria-current')).toBe('location')

    scrollTop = 0
    fireEvent.scroll(scroller)
    expect(screen.getByRole('button', { name: /Turn 1 of 4: First prompt/ }).getAttribute('aria-current')).toBe('location')

    fireEvent.click(thirdTurn)
    expect(thirdTurn.getAttribute('aria-current')).toBe('location')
    fireEvent.wheel(scroller, { deltaY: 100 })
    scrollTop = 700
    fireEvent.scroll(scroller)
    expect(screen.getAllByRole('button', { name: /Turn \d of 4/ }).every((marker) => (
      marker.getAttribute('aria-current') === null
    ))).toBe(true)
  })

  it('mounts and highlights a far virtualized message selected from the navigator', async () => {
    const messages: UIMessage[] = Array.from({ length: 220 }, (_, index) => ({
      id: `${index % 2 === 0 ? 'user' : 'assistant'}-${index}`,
      type: index % 2 === 0 ? 'user_text' : 'assistant_text',
      content: `${index % 2 === 0 ? 'Prompt' : 'Answer'} ${index}`,
      timestamp: index,
    })) as UIMessage[]
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({ messages }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.chat-scroll-area') as HTMLElement
    let scrollTop = 24_000
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 })
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 25_000 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value },
    })

    fireEvent.click(screen.getByRole('button', { name: /Turn 1 of 110: Prompt 0/ }))

    await waitFor(() => expect(screen.getByText('Prompt 0')).toBeTruthy())
    expect(scrollTop).toBe(0)
    expect(container.querySelector('[data-chat-render-item-key="user-0"]')?.className).toContain('chat-render-item--navigation-target')
  })

  it('keeps streaming output out of the user-turn navigator after a prompt jump', async () => {
    const messages = makeConversationNavigationMessages()
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({ messages }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.chat-scroll-area') as HTMLElement
    let scrollTop = 100
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1400 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value >= 1_000_000_000 ? 1000 : value },
    })
    Object.defineProperty(scroller, 'scrollTo', {
      configurable: true,
      value: (options: ScrollToOptions) => { scroller.scrollTop = options.top ?? 0 },
    })

    fireEvent.click(screen.getByRole('button', { name: /Turn 4 of 4: Fourth prompt/ }))
    const promptScrollTop = scrollTop
    act(() => {
      useChatStore.setState({
        sessions: {
          [ACTIVE_TAB]: makeSessionState({
            messages,
            chatState: 'streaming',
            streamingText: 'More output from the latest reply',
          }),
        },
      })
    })

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /Turn \d of 4/ })).toHaveLength(4)
    })
    expect(screen.queryByRole('button', { name: /More output from the latest reply/ })).toBeNull()
    expect(scrollTop).toBe(promptScrollTop)
    expect(scrollTop).not.toBe(1000)
  })

  // #1149 — end-to-end pin for the tool duration badge. Injecting `durationMs`
  // straight into ToolCallBlock only proves formatDuration reaches the header;
  // it leaves the whole wiring severable with every test green. This drives it
  // from real transcript messages, so it fails if any link breaks: the
  // toolResultByToolUseId projection dropping `timestamp`, or either
  // ToolCallBlock call site dropping the `durationMs` prop.
  it('derives the tool duration badge from the tool_use/tool_result timestamps', async () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            { id: 'user-1', type: 'user_text', content: 'Run it', timestamp: 1 },
            {
              id: 'tool-use-1',
              type: 'tool_use',
              toolName: 'Bash',
              toolUseId: 'bash-1',
              input: { command: 'ls -la', description: 'List files' },
              timestamp: 10_000,
            },
            {
              id: 'tool-result-1',
              type: 'tool_result',
              toolUseId: 'bash-1',
              content: 'file-a',
              isError: false,
              timestamp: 11_598,
            },
          ],
        }),
      },
    })

    const { container } = render(<MessageList />)

    // 11_598 - 10_000 = 1598ms -> "1.6s"
    await waitFor(() => expect(container.textContent).toContain('1.6s'))
  })

  it('does not treat the last text marker as the transcript tail when tool output follows it', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            ...makeConversationNavigationMessages(),
            {
              id: 'tool-tail',
              type: 'tool_use',
              toolName: 'Read',
              toolUseId: 'tool-tail-use',
              input: { file_path: '/tmp/example.txt' },
              timestamp: 9,
            },
          ],
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.chat-scroll-area') as HTMLElement
    let scrollTop = 100
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value >= 1_000_000_000 ? 600 : value },
    })

    fireEvent.click(screen.getByRole('button', { name: /Turn 4 of 4: Fourth prompt/ }))

    expect(scrollTop).not.toBe(600)
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

  it('renders goal continuation status as a divider between assistant turns', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: '上一轮回答到这里。',
              timestamp: 1,
            },
            {
              id: 'goal-continue',
              type: 'goal_event',
              action: 'status',
              status: 'continuing',
              message: 'Goal continuing: 还需要补充验证',
              timestamp: 2,
            },
            {
              id: 'assistant-2',
              type: 'assistant_text',
              content: '后续轮次从这里开始。',
              timestamp: 3,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    expect(screen.getByTestId('goal-continuation-divider')).toBeTruthy()
    expect(screen.getByText('Goal continuing')).toBeTruthy()
    expect(screen.getByText('还需要补充验证')).toBeTruthy()
    expect(screen.queryByText('Goal status')).toBeNull()
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

  it('localizes non-agent background task duration units', () => {
    useSettingsStore.setState({ locale: 'zh' })
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'background-task-shell-1',
              type: 'background_task',
              timestamp: 2,
              task: {
                taskId: 'shell-task-1',
                toolUseId: 'shell-tool-1',
                // `stopped`, not `completed`: a cleanly finished task is left to
                // the activity panel now. What this asserts is duration
                // formatting, which does not depend on which end state it is.
                status: 'stopped',
                taskType: 'local_bash',
                summary: 'Running Playwright checks',
                usage: {
                  totalTokens: 1200,
                  toolUses: 4,
                  durationMs: 65000,
                },
                startedAt: 2,
                updatedAt: 2,
              },
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    expect(screen.getByTestId('background-task-event-card').textContent).toContain('1 分 5 秒')
  })

  it('leaves a completed background task to the activity panel, but keeps a failure', () => {
    const task = (id: string, status: 'completed' | 'failed') => ({
      id: `background-task-${id}`,
      type: 'background_task' as const,
      timestamp: 2,
      task: {
        taskId: id,
        toolUseId: `${id}-tool`,
        status,
        taskType: 'local_bash',
        summary: `Ran ${id}`,
        startedAt: 1,
        updatedAt: 2,
      },
    })

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({ messages: [task('done-1', 'completed'), task('broke-1', 'failed')] }),
      },
    })

    render(<MessageList />)

    // A team session emits dozens of "task completed" reports and the panel
    // already lists every one of them; repeating each as a card buries the
    // conversation. A failure still interrupts — it changes what the turn means,
    // and the panel it would otherwise live in can be closed.
    const cards = screen.getAllByTestId('background-task-event-card')
    expect(cards).toHaveLength(1)
    expect(cards[0]?.textContent).toContain('broke-1')
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
                // See above: the label is what this asserts, and a cleanly
                // finished task no longer draws a card to read it off.
                status: 'stopped',
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

  it('does not render auto-dream background task events as separate transcript cards', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [{
            id: 'background-task-dream-hidden',
            type: 'background_task',
            timestamp: 2,
            task: {
              taskId: 'dream-task-hidden',
              status: 'running',
              taskType: 'dream',
              description: 'dreaming',
              startedAt: 1,
              updatedAt: 2,
            },
          }],
        }),
      },
    })

    render(<MessageList />)

    expect(screen.queryByTestId('background-task-event-card')).toBeNull()
    expect(screen.queryByText('dreaming')).toBeNull()
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
    const messages: UIMessage[] = Array.from({ length: 240 }, (_, index) => ({
      id: `assistant-${index}`,
      type: 'assistant_text',
      content: `assistant transcript line ${index}`,
      timestamp: index,
    }))
    useChatStore.setState({
      sessions: { [ACTIVE_TAB]: makeSessionState({ messages }) },
    })

    // Derived from the estimator rather than a literal, so "the middle" keeps
    // meaning the middle when item heights change. A hardcoded scrollTop silently
    // becomes "past the end" the moment the transcript gets denser.
    const estimatedContentHeight = buildRenderModel(messages).renderItems
      .reduce((total, item) => total + estimateRenderItemHeight(item), 0)

    const { container } = render(<MessageList />)
    const scrollArea = container.querySelector('.chat-scroll-area') as HTMLElement
    Object.defineProperty(scrollArea, 'clientHeight', { configurable: true, value: 500 })
    Object.defineProperty(scrollArea, 'scrollHeight', { configurable: true, value: estimatedContentHeight })
    await waitForProgrammaticScrollReset()

    // Scroll to middle so both top and bottom spacers are present
    scrollArea.scrollTop = Math.round(estimatedContentHeight / 2)
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
    expect(screen.queryByText(/Read .*example\.ts.*done/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /dispatched an agent/i }))
    expect(screen.getByText(/Read .*example\.ts.*done/i)).toBeTruthy()

    const agentRow = container.querySelector('[data-agent-call-layout="row"]')
    expect(agentRow).toBeTruthy()
    expect(agentRow?.className).not.toMatch(/\b(?:border|rounded)-/)

    fireEvent.click(screen.getByRole('button', { name: 'Expand agent' }))
    const nestedToolRow = container.querySelector('[data-tool-call-chrome="row"]')
    expect(nestedToolRow).toBeTruthy()
    expect(nestedToolRow?.textContent).toContain('Read')
    expect(container.textContent).toContain('Agent')
  })

  it('keeps parallel agent rows running while the shared chat state crosses tool boundaries', async () => {
    const agentMessages: Array<Extract<UIMessage, { type: 'tool_use' }>> = Array.from({ length: 4 }, (_, index) => ({
      id: `tool-agent-${index}`,
      type: 'tool_use',
      toolName: 'Agent',
      toolUseId: `agent-${index}`,
      input: { description: `Review area ${index}` },
      timestamp: index + 1,
    }))
    const backgroundAgentTasks = Object.fromEntries(
      agentMessages.map((message, index) => {
        return [
          `task-${index}`,
          {
            taskId: `task-${index}`,
            toolUseId: message.toolUseId,
            status: 'running' as const,
            taskType: 'local_agent',
            description: `Review area ${index}`,
            startedAt: index + 1,
            updatedAt: index + 1,
          },
        ]
      }),
    )
    const setChatState = (chatState: PerSessionState['chatState']) => {
      useChatStore.setState({
        sessions: {
          [ACTIVE_TAB]: makeSessionState({
            chatState,
            messages: agentMessages,
            backgroundAgentTasks,
          }),
        },
      })
    }

    setChatState('thinking')
    render(<MessageList />)
    fireEvent.click(screen.getByRole('button', { name: /dispatched 4 agents/i }))

    expect(screen.queryByText('Starting')).toBeNull()
    expect(screen.getAllByText('Running')).toHaveLength(5)

    act(() => setChatState('tool_executing'))
    await waitFor(() => {
      expect(screen.queryByText('Starting')).toBeNull()
      expect(screen.getAllByText('Running')).toHaveLength(5)
    })

    act(() => setChatState('thinking'))
    await waitFor(() => {
      expect(screen.queryByText('Starting')).toBeNull()
      expect(screen.getAllByText('Running')).toHaveLength(5)
    })
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

  it('shows a thinking placeholder as soon as first-turn preparation begins', () => {
    render(<MessageList />)

    act(() => {
      useChatStore.getState().setPreparingTurn(ACTIVE_TAB, true)
    })

    const status = screen.getByTestId('turn-status-indicator')
    expect(status.getAttribute('role')).toBe('status')
    expect(status.textContent).toContain('Thinking')
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

    // Settled, so it opens as a summary; the nested call is part of the run's
    // trajectory once opened, not a detail buried a further click down.
    const group = screen.getByTestId('activity-group')
    fireEvent.click(group.querySelector('[data-chat-disclosure="true"]')!)
    expect(within(group).getByText('local_bash')).toBeTruthy()
    expect(within(group).getByText('bun run dev')).toBeTruthy()
    // Icon ligature names must never leak into the row text.
    expect(group.textContent).not.toContain('check_circle')
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

  it('renders stopped tool calls as terminal instead of still generating content', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'idle',
          messages: [
            {
              id: 'tool-write',
              type: 'tool_use',
              toolName: 'Write',
              toolUseId: 'write-1',
              input: { file_path: '/tmp/story.md' },
              timestamp: 1,
              isPending: false,
              status: 'stopped',
            } as UIMessage,
          ],
        }),
      },
    })

    render(<MessageList />)

    expect(screen.getByText('Stopped')).toBeTruthy()
    expect(screen.queryByText('Generating content')).toBeNull()
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
    expect(screen.queryByText('preferences.md')).toBeNull()
    expect(screen.queryByText('Tool details')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Saved 1 memory item/i }))

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

  it('keeps thinking inside the surrounding activity run instead of splitting it', () => {
    const messages: UIMessage[] = [
      {
        id: 'tool-read',
        type: 'tool_use',
        toolName: 'Read',
        toolUseId: 'read-1',
        input: { file_path: '/tmp/example.ts' },
        timestamp: 1,
      },
      { id: 'think-1', type: 'thinking', content: 'The delay is unconditional here.', timestamp: 2 },
      {
        id: 'tool-bash',
        type: 'tool_use',
        toolName: 'Bash',
        toolUseId: 'bash-1',
        input: { command: 'bun test' },
        timestamp: 3,
      },
    ]

    const { renderItems } = buildRenderModel(messages)

    expect(renderItems).toHaveLength(1)
    const group = renderItems[0]
    expect(group?.kind).toBe('tool_group')
    if (group?.kind !== 'tool_group') throw new Error('expected a tool group')
    expect(group.steps.map((step) => step.kind === 'tool' ? step.toolCall.toolUseId : step.message.id)).toEqual([
      'read-1',
      'think-1',
      'bash-1',
    ])
    // The tools-only projection stays intact for the agent/image/memory paths.
    expect(group.toolCalls.map((toolCall) => toolCall.toolUseId)).toEqual(['read-1', 'bash-1'])
  })

  it('keeps a completed tool group visibly live while post-tool thinking streams', () => {
    render(<MessageList sessionId={ACTIVE_TAB} />)

    const store = useChatStore.getState()
    act(() => {
      store.handleServerMessage(ACTIVE_TAB, {
        type: 'content_start',
        blockType: 'tool_use',
        toolName: 'Bash',
        toolUseId: 'bash-live-1',
      })
      store.handleServerMessage(ACTIVE_TAB, {
        type: 'tool_use_complete',
        toolName: 'Bash',
        toolUseId: 'bash-live-1',
        input: { command: 'git status --short' },
      })
      store.handleServerMessage(ACTIVE_TAB, {
        type: 'tool_result',
        toolUseId: 'bash-live-1',
        content: '',
        isError: false,
      })
      store.handleServerMessage(ACTIVE_TAB, {
        type: 'thinking',
        text: 'Now inspect the remaining UI paths.',
      })
    })

    const group = screen.getByTestId('activity-group')
    expect(group.getAttribute('data-running')).toBe('true')
    // The tool finished but the run has not: feedback has to stay somewhere the
    // reader can see (#d3ba73af3, which restored it after an earlier collapse
    // dropped it). It now sits on the step that is actually still going — the
    // streaming thinking row — rather than on a summary header above them all.
    expect(group.querySelector('.thinking-dots')).not.toBeNull()

    act(() => {
      store.handleServerMessage(ACTIVE_TAB, { type: 'status', state: 'idle' })
    })

    expect(group.getAttribute('data-running')).toBe('false')
    expect(group.querySelector('.thinking-dots')).toBeNull()
  })

  it('spaces turns without drawing a rail', () => {
    const { container } = render(<MessageList sessionId={ACTIVE_TAB} />)
    const store = useChatStore.getState()

    act(() => {
      store.handleServerMessage(ACTIVE_TAB, {
        type: 'content_start',
        blockType: 'tool_use',
        toolName: 'Bash',
        toolUseId: 'bash-rail-1',
      })
      store.handleServerMessage(ACTIVE_TAB, {
        type: 'tool_use_complete',
        toolName: 'Bash',
        toolUseId: 'bash-rail-1',
        input: { command: 'npx xo' },
      })
    })

    // The wrapper survives because it still owns turn spacing and the block
    // formatting context the virtualizer measures against...
    expect(container.querySelectorAll('.chat-turn-rail').length).toBeGreaterThan(0)
    // ...but it draws nothing. Tone separates prose from machinery now, and a
    // line on top of that was a third way of saying what the turn gap and the
    // right-aligned prompt already say.
    expect(container.querySelectorAll('.chat-turn-rail--live')).toHaveLength(0)
  })

  it('draws a lone thinking block the same as one sitting in a run', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            { id: 'user-1', type: 'user_text', content: '看下 issue', timestamp: 1 },
            // Opens the turn with reasoning and then narrates, so this one is
            // flushed as a tool-less run — the case that used to get the bare
            // label with no reasoning shown at all.
            { id: 'think-lone', type: 'thinking', content: '先加载浏览器技能再读 issue。', timestamp: 2 },
            { id: 'reply-1', type: 'assistant_text', content: '我先加载浏览器技能。', timestamp: 3 },
            { id: 'think-in-run', type: 'thinking', content: 'gh issue 失败了,改用 REST API。', timestamp: 4 },
            {
              id: 'tool-1',
              type: 'tool_use',
              toolName: 'Bash',
              toolUseId: 'bash-1',
              input: { command: 'gh api', description: '取 issue 内容' },
              timestamp: 5,
            },
          ],
        }),
      },
    })

    const { container } = render(<MessageList />)

    // Open the settled run so both thinking rows are on screen at once.
    fireEvent.click(
      screen.getByTestId('activity-group').querySelector('[data-chat-disclosure="true"]')!,
    )

    // Whether a thought is followed by a tool call is a fact about the run, not
    // about the thought, so it must not change how the thought is drawn — the
    // lone one used to show its label and nothing else.
    expect(screen.getByText('先加载浏览器技能再读 issue。')).toBeTruthy()
    expect(screen.getByText('gh issue 失败了,改用 REST API。')).toBeTruthy()

    const [lone, inRun] = Array.from(
      container.querySelectorAll<HTMLElement>('[data-thinking-row="true"]'),
    )
    expect(lone).toBeTruthy()
    expect(inRun).toBeTruthy()
    expect(lone!.className).toBe(inRun!.className)
  })

  it('leaves a run of pure reasoning as standalone thinking blocks', () => {
    const messages: UIMessage[] = [
      { id: 'think-1', type: 'thinking', content: 'First consider the call sites.', timestamp: 1 },
      { id: 'think-2', type: 'thinking', content: 'Then the retry path.', timestamp: 2 },
    ]

    const { renderItems } = buildRenderModel(messages)

    expect(renderItems.map((item) => item.kind === 'message' ? item.message.id : item.id)).toEqual([
      'think-1',
      'think-2',
    ])
  })

  it('keeps thinking out of an agent dispatch group', () => {
    const messages: UIMessage[] = [
      { id: 'think-1', type: 'thinking', content: 'Split the review by subsystem.', timestamp: 1 },
      {
        id: 'tool-agent',
        type: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'agent-1',
        input: { description: 'Review desktop impact' },
        timestamp: 2,
      },
    ]

    const { renderItems } = buildRenderModel(messages)

    expect(renderItems.map((item) => item.kind === 'message' ? `message:${item.message.id}` : `group:${item.id}`)).toEqual([
      'message:think-1',
      'group:group-tool-agent',
    ])
  })

  it('ends an activity run at the assistant reply that narrates it', () => {
    const messages: UIMessage[] = [
      { id: 'think-1', type: 'thinking', content: 'Check the handler first.', timestamp: 1 },
      {
        id: 'tool-read',
        type: 'tool_use',
        toolName: 'Read',
        toolUseId: 'read-1',
        input: { file_path: '/tmp/example.ts' },
        timestamp: 2,
      },
      { id: 'assistant-1', type: 'assistant_text', content: 'Found the unconditional delay.', timestamp: 3 },
      {
        id: 'tool-bash',
        type: 'tool_use',
        toolName: 'Bash',
        toolUseId: 'bash-1',
        input: { command: 'bun test' },
        timestamp: 4,
      },
    ]

    const { renderItems } = buildRenderModel(messages)

    expect(renderItems.map((item) => item.kind === 'message' ? `message:${item.message.id}` : `group:${item.id}`)).toEqual([
      'group:group-tool-read',
      'message:assistant-1',
      'group:group-tool-bash',
    ])
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

  it('honors a manual collapse of an agent group while more SubAgents stream in', async () => {
    const initialMessages: UIMessage[] = [
      {
        id: 'tool-agent-a',
        type: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'agent-a',
        input: { description: 'Review renderer' },
        timestamp: 1,
      },
      {
        id: 'result-agent-a',
        type: 'tool_result',
        toolUseId: 'agent-a',
        content: 'Async agent launched successfully.',
        isError: false,
        timestamp: 2,
      },
      {
        id: 'tool-agent-b',
        type: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'agent-b',
        input: { description: 'Review stores' },
        timestamp: 3,
      },
      {
        id: 'result-agent-b',
        type: 'tool_result',
        toolUseId: 'agent-b',
        content: 'Async agent launched successfully.',
        isError: false,
        timestamp: 4,
      },
    ]

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({ messages: initialMessages }),
      },
    })

    render(<MessageList />)

    const agentGroupButton = screen.getByRole('button', { name: /dispatched 2 agents/i })
    expect(screen.queryByText('Review renderer')).toBeNull()
    fireEvent.click(agentGroupButton)
    expect(screen.getByText('Review renderer')).toBeTruthy()
    fireEvent.click(agentGroupButton)
    expect(screen.queryByText('Review renderer')).toBeNull()

    act(() => {
      useChatStore.setState({
        sessions: {
          [ACTIVE_TAB]: makeSessionState({
            chatState: 'tool_executing',
            messages: [
              ...initialMessages,
              {
                id: 'tool-agent-c',
                type: 'tool_use',
                toolName: 'Agent',
                toolUseId: 'agent-c',
                input: { description: 'Review coverage' },
                timestamp: 5,
              },
            ],
          }),
        },
      })
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /dispatched 3 agents/i })).toBeTruthy()
    })
    expect(screen.queryByText('Review renderer')).toBeNull()
    expect(screen.queryByText('Review coverage')).toBeNull()
  })

  it('keeps a row the reader opened open when nested tool calls arrive', async () => {
    const initialMessages: UIMessage[] = [
      {
        id: 'tool-task-update',
        type: 'tool_use',
        toolName: 'TaskUpdate',
        toolUseId: 'task-update-1',
        input: { id: '1', status: 'in_progress' },
        timestamp: 1,
      },
      {
        id: 'tool-bash',
        type: 'tool_use',
        toolName: 'Bash',
        toolUseId: 'bash-1',
        input: { command: 'git status --short' },
        timestamp: 2,
      },
    ]

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'tool_executing',
          messages: initialMessages,
        }),
      },
    })

    render(<MessageList />)

    // Every step is on screen already; what the reader opts into is one row's
    // detail. That choice is what has to survive the next server update — the
    // regression here was expansion state resetting on every live refresh.
    const group = screen.getByTestId('activity-group')
    expect(group.querySelectorAll('[data-tool-call-details]')).toHaveLength(0)
    fireEvent.click(within(group).getByText('git status --short'))
    expect(group.querySelectorAll('[data-tool-call-details]')).toHaveLength(1)

    act(() => {
      useChatStore.setState({
        sessions: {
          [ACTIVE_TAB]: makeSessionState({
            chatState: 'tool_executing',
            messages: [
              ...initialMessages,
              {
                id: 'tool-child-read',
                type: 'tool_use',
                toolName: 'Read',
                toolUseId: 'read-1',
                input: { file_path: '/workspace/package.json' },
                timestamp: 3,
                parentToolUseId: 'task-update-1',
              },
            ],
          }),
        },
      })
    })

    // The newly dispatched child shows up...
    await waitFor(() => {
      expect(screen.getByText('package.json')).toBeTruthy()
    })
    // ...and the row the reader opened is still open.
    expect(
      screen.getByTestId('activity-group').querySelectorAll('[data-tool-call-details]'),
    ).toHaveLength(1)
  })

  it('honors a manual collapse of memory activity when regular tools join the group', async () => {
    const initialMessages: UIMessage[] = [
      {
        id: 'tool-memory-write',
        type: 'tool_use',
        toolName: 'Write',
        toolUseId: 'memory-write-1',
        input: {
          file_path: '/Users/test/.codex/memory/project-notes.md',
          content: 'Persisted context',
        },
        timestamp: 1,
      },
      {
        id: 'result-memory-write',
        type: 'tool_result',
        toolUseId: 'memory-write-1',
        content: 'Wrote 1 line to /Users/test/.codex/memory/project-notes.md',
        isError: false,
        timestamp: 2,
      },
    ]

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({ messages: initialMessages }),
      },
    })

    render(<MessageList />)

    expect(screen.getByText('Saved 1 memory item(s)')).toBeTruthy()
    const memoryActivityButton = screen.getByRole('button', { name: /Saved 1 memory item/i })
    expect(screen.queryByText('project-notes.md')).toBeNull()
    fireEvent.click(memoryActivityButton)
    expect(screen.getByText('project-notes.md')).toBeTruthy()
    fireEvent.click(memoryActivityButton)
    expect(screen.queryByText('project-notes.md')).toBeNull()

    act(() => {
      useChatStore.setState({
        sessions: {
          [ACTIVE_TAB]: makeSessionState({
            chatState: 'tool_executing',
            messages: [
              ...initialMessages,
              {
                id: 'tool-bash',
                type: 'tool_use',
                toolName: 'Bash',
                toolUseId: 'bash-1',
                input: { command: 'bun test memory.test.ts' },
                timestamp: 3,
              },
            ],
          }),
        },
      })
    })

    await waitFor(() => {
      expect(screen.getByText('bun test memory.test.ts')).toBeTruthy()
    })
    expect(screen.queryByText('project-notes.md')).toBeNull()
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
        : item.kind === 'team_card'
          ? `team:${item.id}`
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

    fireEvent.click(screen.getByRole('button', { name: /dispatched an agent/i }))
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

    fireEvent.click(screen.getByRole('button', { name: /dispatched an agent/i }))
    expect(screen.getByText('Done')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View result' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'View result' }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/第二段补充内容用于验证 dialog 展示的是完整结果而不是截断摘要。/)).toBeTruthy()
    expect(within(dialog).queryByText(/agentId:/)).toBeNull()
    expect(within(dialog).queryByText(/total_tokens/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeTruthy()
  })

  it('opens the SubAgent run tab from an agent tool card', () => {
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
          ],
        }),
      },
    })

    render(<MessageList />)

    fireEvent.click(screen.getByRole('button', { name: /dispatched an agent/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Open run Inspect src/components' }))

    const expectedTabId = '__subagent__active-tab__agent-1'
    expect(useTabStore.getState().activeTabId).toBe(expectedTabId)
    expect(useTabStore.getState().tabs.find((tab) => tab.sessionId === expectedTabId)).toMatchObject({
      title: 'Inspect src/components',
      type: 'subagent',
      sourceSessionId: ACTIVE_TAB,
      subagentToolUseId: 'agent-1',
    })
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

    fireEvent.click(screen.getByRole('button', { name: /dispatched an agent/i }))
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

    fireEvent.click(screen.getByRole('button', { name: /dispatched an agent/i }))
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

    fireEvent.click(screen.getByRole('button', { name: /dispatched an agent/i }))
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

    // One copy per turn, on the reply that closes it. The intermediate reply
    // ("先看 CLI 和服务端入口。") carries no action bar at all — nobody copies a
    // step, and reserving its 36px on every one outweighed the text itself.
    const replyCopies = screen.getAllByRole('button', { name: 'Copy reply' })
    expect(replyCopies).toHaveLength(1)

    fireEvent.click(replyCopies[0]!)

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('再看 desktop 前后端边界。')
    })
    // Still that reply alone, never the turn's replies glued together.
    expect(writeText).not.toHaveBeenCalledWith(
      '先看 CLI 和服务端入口。\n再看 desktop 前后端边界。'
    )
  })

  it('leaves a mid-turn reply with no action bar to reserve space for', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'thinking',
          messages: [
            { id: 'user-1', type: 'user_text', content: '接着改', timestamp: 1 },
            { id: 'assistant-1', type: 'assistant_text', content: '先看调用点。', timestamp: 2 },
          ],
        }),
      },
    })

    const { container } = render(<MessageList />)

    const assistantShell = container.querySelector('[data-message-shell="assistant"]')
    expect(assistantShell).toBeTruthy()
    // Absent, not hidden: a hover-gated bar still reserved its height whether or
    // not anyone hovered, which is the cost this removes.
    expect(assistantShell!.querySelector('[data-message-actions]')).toBeNull()
    // The prompt keeps its own — reworking a question is what the bar is for.
    expect(
      container.querySelector('[data-message-shell="user"] [data-message-actions]'),
    ).not.toBeNull()
  })

  it('releases pointer focus from message actions after clicking copy', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          // A closed turn: actions live on the reply that ends one.
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '看一下操作条',
              timestamp: 1,
            },
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: '点完复制后焦点不应该留在按钮上。',
              timestamp: 2,
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

  it('cancels a pending Add to chat update when the native context menu opens', async () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [{
            id: 'assistant-1',
            type: 'assistant_text',
            content: 'Right-click should copy this selected reply.',
            timestamp: 1,
          }],
        }),
      },
    })

    render(<MessageList />)

    const assistantText = screen.getByText(/Right-click should copy/)
    prepareMessageTextSelection(assistantText, 'copy this selected reply')

    await act(async () => {
      fireSelectionPointerEvent(assistantText, 'down', {
        button: 0,
        clientX: 180,
        clientY: 88,
        pointerId: 1,
        pointerType: 'mouse',
      })
      fireSelectionPointerEvent(assistantText, 'up', {
        button: 0,
        clientX: 260,
        clientY: 104,
        pointerId: 1,
        pointerType: 'mouse',
      })
      fireSelectionPointerEvent(assistantText, 'down', {
        button: 2,
        clientX: 240,
        clientY: 96,
        pointerId: 2,
        pointerType: 'mouse',
      })
      fireSelectionPointerEvent(assistantText, 'up', {
        button: 2,
        clientX: 240,
        clientY: 96,
        pointerId: 2,
        pointerType: 'mouse',
      })
      fireEvent.mouseUp(assistantText, { button: 2, clientX: 240, clientY: 96 })
      fireEvent.contextMenu(assistantText, { clientX: 240, clientY: 96 })
    })
    await waitForSelectionMenuUpdate()

    expect(screen.queryByRole('button', { name: 'Add to chat' })).toBeNull()
    expect(window.getSelection()?.toString()).toBe('copy this selected reply')
  })

  it('dismisses Add to chat on right-click without clearing the selected text', async () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [{
            id: 'assistant-1',
            type: 'assistant_text',
            content: 'Selected text must remain copyable after opening its context menu.',
            timestamp: 1,
          }],
        }),
      },
    })

    render(<MessageList />)

    const assistantText = screen.getByText(/Selected text must remain copyable/)
    await selectMessageText(assistantText, 'remain copyable')
    expect(screen.getByRole('button', { name: 'Add to chat' })).toBeTruthy()

    await act(async () => {
      fireSelectionPointerEvent(assistantText, 'down', {
        button: 2,
        clientX: 260,
        clientY: 104,
        pointerId: 2,
        pointerType: 'mouse',
      })
      fireEvent.contextMenu(assistantText, { clientX: 260, clientY: 104 })
    })

    expect(screen.queryByRole('button', { name: 'Add to chat' })).toBeNull()
    expect(window.getSelection()?.toString()).toBe('remain copyable')
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
      fireSelectionPointerEvent(assistantText, 'down', {
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
      fireSelectionPointerEvent(document, 'up', {
        button: 0,
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
    expect(floatingAddButton.style.top).toBe('129px')

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
      fireSelectionPointerEvent(firstParagraph, 'down', {
        button: 0,
        clientX: 150,
        clientY: 76,
        pointerId: 1,
        pointerType: 'mouse',
      })
      fireSelectionPointerEvent(secondParagraph, 'up', {
        button: 0,
        clientX: 500,
        clientY: 140,
        pointerId: 1,
        pointerType: 'mouse',
      })
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
    await waitForProgrammaticScrollReset()
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
      expect(screen.getByText('2 lines · 36 chars')).toBeTruthy()
    })
    await waitForProgrammaticScrollReset()
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(scrollTop).toBe(600)
  })

  // #1177: expanding a collapsed run is the reader rearranging their own view.
  // The content-resize follow used to read that height jump as new output and
  // slam the transcript to the bottom, throwing the just-clicked row off screen.
  it('does not follow the height jump the reader causes by expanding a run, but still follows the next token', async () => {
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
          chatState: 'tool_executing',
          messages: [
            { id: 'user-1', type: 'user_text', content: 'latest prompt', timestamp: 1 },
            {
              id: 'tool-read',
              type: 'tool_use',
              toolName: 'Read',
              toolUseId: 'read-1',
              input: { file_path: '/repo/a.ts' },
              timestamp: 2,
            },
            {
              id: 'result-read',
              type: 'tool_result',
              toolUseId: 'read-1',
              content: 'ok',
              isError: false,
              timestamp: 3,
            },
            {
              id: 'tool-bash',
              type: 'tool_use',
              toolName: 'Bash',
              toolUseId: 'bash-1',
              input: { command: 'bun test' },
              timestamp: 4,
            },
            {
              id: 'result-bash',
              type: 'tool_result',
              toolUseId: 'bash-1',
              content: 'done',
              isError: false,
              timestamp: 5,
            },
          ],
          streamingText: 'seed',
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement
    let scrollTop = 600
    let scrollHeight = 1000
    let scrollTopWriteCount = 0
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTopWriteCount += 1
        scrollTop = value
      },
    })

    await waitFor(() => expect(resizeCallback).not.toBeNull())
    await waitForProgrammaticScrollReset()
    scrollTopWriteCount = 0

    const queuedFrames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback)
      return queuedFrames.length
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const flushFrame = () => {
      const callbacks = queuedFrames.splice(0)
      act(() => {
        for (const callback of callbacks) callback(performance.now())
      })
    }

    // The reader opens the run; it grows by 500px.
    const setStreamingText = (text: string) => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [ACTIVE_TAB]: { ...state.sessions[ACTIVE_TAB]!, streamingText: text },
        },
      }))
    }

    const disclosure = container.querySelector('[data-chat-disclosure="true"]') as HTMLButtonElement
    expect(disclosure).toBeTruthy()
    scrollHeight = 1500
    act(() => {
      fireEvent.click(disclosure)
      resizeCallback?.([{ contentRect: { height: 900 } } as ResizeObserverEntry], {} as ResizeObserver)
    })
    flushFrame()

    expect(scrollTopWriteCount).toBe(0)
    expect(scrollTop).toBe(600)

    // Expanding pushed the container off the bottom, so following stops until
    // the reader returns — same semantics as scrolling up by hand.
    scrollHeight = 1520
    act(() => {
      setStreamingText('seed more')
      resizeCallback?.([{ contentRect: { height: 920 } } as ResizeObserverEntry], {} as ResizeObserver)
    })
    flushFrame()
    expect(scrollTop).toBe(600)

    // Back at the bottom, streaming follows again — the guard suppresses the
    // reader's own resize, never the model's output.
    act(() => {
      scrollTop = 1120
      fireEvent.scroll(scroller)
    })
    scrollHeight = 1560
    act(() => {
      setStreamingText('seed more still')
      resizeCallback?.([{ contentRect: { height: 960 } } as ResizeObserverEntry], {} as ResizeObserver)
    })
    flushFrame()
    expect(scrollTop).toBe(1160)
  })

  it('coalesces real streaming transitions and ignores fractional bottom wobble', async () => {
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
              content: 'latest prompt',
              timestamp: 1,
            },
          ],
          streamingText: 'streaming seed',
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement
    let scrollTop = 600
    let scrollHeight = 1004
    let scrollTopWriteCount = 0
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    })
    Object.defineProperty(scroller, 'clientHeight', {
      configurable: true,
      value: 400,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTopWriteCount += 1
        scrollTop = value
      },
    })

    await waitFor(() => expect(resizeCallback).not.toBeNull())
    await waitForProgrammaticScrollReset()
    scrollTopWriteCount = 0

    const queuedFrames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback)
      return queuedFrames.length
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const flushFrame = () => {
      const callbacks = queuedFrames.splice(0)
      act(() => {
        for (const callback of callbacks) callback(performance.now())
      })
    }

    act(() => {
      const store = useChatStore.getState()
      store.handleServerMessage(ACTIVE_TAB, { type: 'content_delta', text: ' next' })
      store.handleServerMessage(ACTIVE_TAB, { type: 'content_delta', text: ' token' })
      resizeCallback?.([{
        contentRect: { height: 404 },
      } as ResizeObserverEntry], {} as ResizeObserver)
    })

    await waitFor(() => {
      expect(screen.getByText('streaming seed next token')).toBeTruthy()
    })
    expect(queuedFrames.length).toBeGreaterThan(0)
    flushFrame()

    expect(scrollTopWriteCount).toBe(0)
    expect(scrollTop).toBe(600)

    scrollHeight = 1020
    act(() => {
      const store = useChatStore.getState()
      store.handleServerMessage(ACTIVE_TAB, { type: 'content_delta', text: ' with' })
      store.handleServerMessage(ACTIVE_TAB, { type: 'content_delta', text: ' growth' })
      resizeCallback?.([{
        contentRect: { height: 420 },
      } as ResizeObserverEntry], {} as ResizeObserver)
    })
    await waitFor(() => {
      expect(screen.getByText('streaming seed next token with growth')).toBeTruthy()
    })
    flushFrame()

    expect(scrollTopWriteCount).toBe(1)
    expect(scrollTop).toBe(620)
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
    await waitForProgrammaticScrollReset()
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(scrollTop).toBe(1000)

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
    await waitForProgrammaticScrollReset()

    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(scrollTop).toBe(1200)
    expect(screen.queryByRole('button', { name: 'Latest' })).toBeNull()
  })

  it('keeps a pending file permission pinned when its preview grows after render', async () => {
    const observers: Array<{
      callback: ResizeObserverCallback
      targets: Element[]
    }> = []
    class TestResizeObserver {
      targets: Element[] = []
      observe = vi.fn((target: Element) => {
        this.targets.push(target)
      })
      unobserve = vi.fn()
      disconnect = vi.fn()

      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, targets: this.targets })
      }
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver)

    const pendingPermission = {
      requestId: 'permission-write-memory',
      toolName: 'Write',
      input: {
        file_path: '/tmp/MEMORY.md',
        content: Array.from({ length: 80 }, (_, index) => `Memory line ${index}`).join('\n'),
      },
    }
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'permission_pending',
          pendingPermission,
          pendingPermissions: {
            [pendingPermission.requestId]: pendingPermission,
          },
          messages: [
            ...Array.from({ length: 130 }, (_, index) => ({
              id: `assistant-history-${index}`,
              type: 'assistant_text' as const,
              content: `History line ${index}`,
              timestamp: index,
            })),
            {
              id: 'permission-write-memory-message',
              type: 'permission_request',
              requestId: pendingPermission.requestId,
              toolName: pendingPermission.toolName,
              input: pendingPermission.input,
              timestamp: 131,
            },
          ],
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.chat-scroll-area') as HTMLDivElement
    const scrollContent = scroller.firstElementChild as HTMLElement
    let scrollTop = 15000
    let scrollHeight = 15521
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 521 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = value
      },
    })

    await waitForProgrammaticScrollReset()
    fireEvent.scroll(scroller)
    const allowButton = await screen.findByRole('button', { name: 'Allow: /tmp/MEMORY.md' })

    const contentObserver = observers.find(({ targets }) => targets.includes(scrollContent))
    expect(contentObserver).toBeTruthy()
    const permissionItem = allowButton.closest('[data-virtual-message-item]') as HTMLElement
    expect(permissionItem).toBeTruthy()
    const permissionItemObserver = observers.find(({ targets }) => targets.includes(permissionItem))
    expect(permissionItemObserver).toBeTruthy()

    scrollHeight = 15717
    fireEvent.scroll(scroller)
    act(() => {
      permissionItemObserver?.callback([{
        contentRect: { height: 520 },
        target: permissionItem,
      } as unknown as ResizeObserverEntry], {} as ResizeObserver)
    })
    act(() => {
      contentObserver?.callback([{
        contentRect: { height: 15717 },
        target: scrollContent,
      } as unknown as ResizeObserverEntry], {} as ResizeObserver)
    })
    await waitForProgrammaticScrollReset()

    expect(scrollTop).toBe(15196)
    expect(screen.queryByRole('button', { name: 'Latest' })).toBeNull()
  })

  it('does not follow resize for stale permission state without a pending file permission', async () => {
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
          chatState: 'permission_pending',
          messages: [{
            id: 'assistant-restored',
            type: 'assistant_text',
            content: 'Restored completed response',
            timestamp: 1,
          }],
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.chat-scroll-area') as HTMLDivElement
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

    await waitForProgrammaticScrollReset()
    fireEvent.scroll(scroller)

    scrollHeight = 1400
    act(() => {
      resizeCallback?.([{
        contentRect: { height: 1400 },
      } as ResizeObserverEntry], {} as ResizeObserver)
    })

    expect(scrollTop).toBe(600)
  })

  it('preserves upward wheel and keyboard intent while a pending file permission preview resizes', async () => {
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

    const pendingPermission = {
      requestId: 'permission-write-memory-wheel',
      toolName: 'Write',
      input: {
        file_path: '/tmp/MEMORY.md',
        content: 'Remember this preference',
      },
    }
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'permission_pending',
          pendingPermission,
          pendingPermissions: {
            [pendingPermission.requestId]: pendingPermission,
          },
          messages: [{
            id: 'permission-write-memory-wheel-message',
            type: 'permission_request',
            requestId: pendingPermission.requestId,
            toolName: pendingPermission.toolName,
            input: pendingPermission.input,
            timestamp: 1,
          }],
        }),
      },
    })

    const { container } = render(<MessageList />)
    const scroller = container.querySelector('.chat-scroll-area') as HTMLDivElement
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

    await waitForProgrammaticScrollReset()
    fireEvent.scroll(scroller)

    fireEvent.wheel(scroller, { deltaY: -120 })
    fireEvent.keyDown(scroller, { key: 'PageUp', shiftKey: false })
    fireEvent.keyDown(scroller, { key: 'ArrowDown', shiftKey: false })
    scrollTop = 300
    scrollHeight = 1400
    act(() => {
      resizeCallback?.([{
        contentRect: { height: 1400 },
      } as ResizeObserverEntry], {} as ResizeObserver)
    })

    expect(scrollTop).toBe(300)
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

  it('ignores stepwise two-pixel content resize oscillation while pinned to active thinking output', async () => {
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
    await waitForProgrammaticScrollReset()
    expect(scrollTop).toBe(600)

    scrollTopWriteCount = 0
    // Chromium can reach the opposite edge of a 2px oscillation through
    // adjacent 1px observations. The sticky follow baseline must not turn
    // either edge into a bottom-scroll correction.
    for (const height of [401, 402, 401, 400, 401, 402, 401, 400]) {
      act(() => {
        resizeCallback?.(makeResizeEntry(height), {} as ResizeObserver)
      })
    }

    expect(scrollTopWriteCount).toBe(0)
    expect(scrollTop).toBe(600)

    scrollHeight = 1040
    act(() => {
      resizeCallback?.(makeResizeEntry(420), {} as ResizeObserver)
    })
    await waitForProgrammaticScrollReset()

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

  it('restores a session scroll position after the message list remounts between conversations', async () => {
    const sessionA = 'issue-1057-session-a'
    const sessionB = 'issue-1057-session-b'
    useChatStore.setState({
      sessions: {
        [sessionA]: makeSessionState({
          messages: [
            { id: 'a-user', type: 'user_text', content: 'A prompt', timestamp: 1 },
            { id: 'a-assistant', type: 'assistant_text', content: 'A response', timestamp: 2 },
          ],
        }),
        [sessionB]: makeSessionState({
          messages: [
            { id: 'b-user', type: 'user_text', content: 'B prompt', timestamp: 1 },
            { id: 'b-assistant', type: 'assistant_text', content: 'B response', timestamp: 2 },
          ],
        }),
      },
    })

    const firstSession = render(<MessageList sessionId={sessionA} />)
    const firstScroller = firstSession.container.querySelector('.overflow-y-auto') as HTMLDivElement
    let firstScrollTop = 180
    Object.defineProperty(firstScroller, 'scrollHeight', { configurable: true, value: 1200 })
    Object.defineProperty(firstScroller, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(firstScroller, 'scrollTop', {
      configurable: true,
      get: () => firstScrollTop,
      set: (value) => {
        firstScrollTop = value
      },
    })

    await waitForProgrammaticScrollReset()
    fireEvent.scroll(firstScroller)
    expect(screen.getByRole('button', { name: 'Latest' })).toBeTruthy()
    firstSession.unmount()

    const secondSession = render(<MessageList sessionId={sessionB} />)
    expect(screen.getByText('B response')).toBeTruthy()
    secondSession.unmount()

    const restoredSession = render(<MessageList sessionId={sessionA} />)
    const restoredScroller = restoredSession.container.querySelector('.overflow-y-auto') as HTMLDivElement

    expect(restoredScroller.scrollTop).toBe(180)
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
    const now = Date.now()
    const userTimestamp = now - 5 * 60_000
    const assistantTimestamp = now - 2 * 60 * 60_000

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'user-1',
              type: 'user_text',
              content: '请把这条 prompt 放在右侧',
              timestamp: userTimestamp,
            },
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: '这条回复应该停在左侧。',
              timestamp: assistantTimestamp,
            },
            // Keeps the first reply mid-turn, which now means it carries no
            // action bar at all — only the reply that closes a turn does.
            {
              id: 'tool-1',
              type: 'tool_use',
              toolName: 'Read',
              toolUseId: 'tool-use-1',
              input: { file_path: '/tmp/a.ts' },
              timestamp: assistantTimestamp + 1_000,
            },
            {
              id: 'assistant-2',
              type: 'assistant_text',
              content: '这条收尾回复带操作条。',
              timestamp: assistantTimestamp + 2_000,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    const userShell = screen.getByText('请把这条 prompt 放在右侧').closest('[data-message-shell="user"]')
    const assistantShell = screen.getByText('这条回复应该停在左侧。').closest('[data-message-shell="assistant"]')
    const closingShell = screen.getByText('这条收尾回复带操作条。').closest('[data-message-shell="assistant"]')
    const userActions = screen.getByRole('button', { name: 'Copy prompt' }).closest('[data-message-actions]')
    const assistantActions = screen.getByRole('button', { name: 'Copy reply' }).closest('[data-message-actions]')
    const userTime = within(userActions as HTMLElement).getByText(formatMessageHoverTime(userTimestamp, 'en'))

    // The bar the assistant does get belongs to the closing reply, not the
    // mid-turn one, and it is the only one on that side.
    expect(assistantActions?.closest('[data-message-shell="assistant"]')).toBe(closingShell)
    expect(assistantShell?.querySelector('[data-message-actions]')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Copy reply' })).toHaveLength(1)

    expect(userShell).toBeTruthy()
    expect(userShell?.className).toContain('items-end')
    expect(userShell?.className).toContain('group')
    expect(userShell?.className).not.toContain('w-full')
    expect(assistantShell).toBeTruthy()
    expect(assistantShell?.className).toContain('items-start')
    expect(assistantShell?.className).toContain('group')
    // Replies take the full column even when they are one short line — only the
    // user bubble hugs its text. Side is what distinguishes them, not width.
    expect(assistantShell?.className).toContain('w-full')
    expect(assistantShell?.className).not.toContain('ml-10')
    expect(userActions?.getAttribute('data-align')).toBe('end')
    expect(assistantActions?.getAttribute('data-align')).toBe('start')
    expect(userActions?.className).toContain('h-7')
    expect(userActions?.className).toContain('mt-2')
    expect(userActions?.className).not.toContain('h-0')
    expect(userActions?.className).not.toContain('group-hover:h-7')
    expect(userActions?.className).not.toContain('invisible')
    expect(userTime.getAttribute('title')).toBe(formatExactMessageTimestamp(userTimestamp, 'en'))
    // The closing reply's bar is not hover-gated: it is rare and deliberate now,
    // so hiding it until hover would only make a present affordance hard to find.
    expect(assistantActions?.className).not.toContain('opacity-0')
    expect(assistantActions?.className).not.toContain('pointer-events-none')
  })

  describe('turn completion footer (#1151)', () => {
    const T0 = new Date('2026-07-30T07:08:22Z').getTime()
    const MINUTE = 60_000

    function turnMessages(): UIMessage[] {
      return [
        { id: 'user-1', type: 'user_text', content: '先问一个问题', timestamp: T0 },
        { id: 'assistant-1', type: 'assistant_text', content: '先答第一轮。', timestamp: T0 + 30_000 },
        { id: 'user-2', type: 'user_text', content: '再问一个问题', timestamp: T0 + 2 * MINUTE },
        {
          id: 'assistant-2',
          type: 'assistant_text',
          content: '第二轮跑了很久才答完。',
          timestamp: T0 + 14 * MINUTE + 19_000,
        },
      ]
    }

    function shellFor(text: string) {
      return screen.getByText(text).closest('[data-message-shell]') as HTMLElement | null
    }

    function stampFor(text: string) {
      return shellFor(text)?.querySelector('[data-turn-completion]') as HTMLElement | null
    }

    it('keeps actions, end time, and duration in one visible row', () => {
      useChatStore.setState({
        sessions: { [ACTIVE_TAB]: makeSessionState({ messages: turnMessages() }) },
      })

      render(<MessageList />)

      const stamp = stampFor('第二轮跑了很久才答完。')
      expect(stamp?.textContent).toContain(formatMessageHoverTime(T0 + 14 * MINUTE + 19_000, 'en'))
      expect(stamp?.textContent).toContain('took 12m 19s')
      const footer = stamp?.closest('[data-message-actions]')
      expect(footer).toBe(
        within(shellFor('第二轮跑了很久才答完。') as HTMLElement)
          .getByRole('button', { name: 'Copy reply' })
          .closest('[data-message-actions]'),
      )
      expect(footer?.className).not.toContain('opacity-0')
    })

    it('measures each turn from its own prompt', () => {
      useChatStore.setState({
        sessions: { [ACTIVE_TAB]: makeSessionState({ messages: turnMessages() }) },
      })

      render(<MessageList />)

      expect(stampFor('先答第一轮。')?.textContent).toContain('took 30s')
    })

    it('prints the completion time only once in the combined footer', () => {
      useChatStore.setState({
        sessions: { [ACTIVE_TAB]: makeSessionState({ messages: turnMessages() }) },
      })

      render(<MessageList />)

      const closing = shellFor('第二轮跑了很久才答完。')
      expect(closing?.querySelector('[data-turn-completion]')).not.toBeNull()
      expect(
        within(closing as HTMLElement).getAllByText(formatMessageHoverTime(T0 + 14 * MINUTE + 19_000, 'en')),
      ).toHaveLength(1)
    })

    it('leaves prompts and mid-turn replies on the hover-only timestamp', () => {
      useChatStore.setState({
        sessions: {
          [ACTIVE_TAB]: makeSessionState({
            messages: [
              { id: 'user-1', type: 'user_text', content: '接着改', timestamp: T0 },
              { id: 'assistant-1', type: 'assistant_text', content: '接下来把两处调用点都接上：', timestamp: T0 + 10_000 },
              {
                id: 'tool-1',
                type: 'tool_use',
                toolName: 'Edit',
                toolUseId: 'tool-use-1',
                input: { file_path: '/tmp/a.ts' },
                timestamp: T0 + 20_000,
              },
            ],
          }),
        },
      })

      render(<MessageList />)

      // Caught in a real session: the last reply of the turn was an aside
      // ("Now wire the duration at both call sites:") followed by edits, so a
      // stamp there rendered above the work it introduced.
      expect(stampFor('接下来把两处调用点都接上：')).toBeNull()
      expect(stampFor('接着改')).toBeNull()
      // The prompt keeps its timestamp in the hover-gated bar.
      const promptBar = shellFor('接着改')?.querySelector('[data-message-actions]')
      expect(promptBar?.className).toContain('opacity-0')
      expect(within(promptBar as HTMLElement).getByText(formatMessageHoverTime(T0, 'en'))).toBeTruthy()

      // The mid-turn reply has no bar, so it has no per-reply timestamp either —
      // a deliberate trade for the 36px the bar reserved on every reply. The
      // turn is still locatable in time: the prompt above stamps its start and
      // the closing reply stamps its end.
      expect(shellFor('接下来把两处调用点都接上：')?.querySelector('[data-message-actions]')).toBeNull()
    })

    it('leaves the running turn unstamped while keeping earlier turns stamped', () => {
      useChatStore.setState({
        sessions: {
          [ACTIVE_TAB]: makeSessionState({ messages: turnMessages(), chatState: 'tool_executing' }),
        },
      })

      render(<MessageList />)

      expect(stampFor('第二轮跑了很久才答完。')).toBeNull()
      expect(stampFor('先答第一轮。')?.textContent).toContain(
        formatMessageHoverTime(T0 + 30_000, 'en'),
      )
    })
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

  it('reloads live turn checkpoints when the completed transcript mutation is committed', async () => {
    const getTurnCheckpoints = vi.spyOn(sessionsApi, 'getTurnCheckpoints')
      .mockResolvedValueOnce({ checkpoints: [] })
      .mockResolvedValue({
        checkpoints: [
          {
            target: {
              targetUserMessageId: 'transcript-user-1',
              userMessageIndex: 0,
              userMessageCount: 1,
            },
            code: {
              available: true,
              filesChanged: ['/private/tmp/generated/src/App.jsx'],
              insertions: 12,
              deletions: 3,
            },
            workDir: '/private/tmp',
          },
        ],
      })

    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          chatState: 'idle',
          historyMutationEpoch: 1,
          messages: [
            {
              id: 'local-user-1',
              type: 'user_text',
              content: '在 /tmp 下创建项目',
              timestamp: 1,
            },
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: '完成。',
              timestamp: 2,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    await waitFor(() => {
      expect(getTurnCheckpoints).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByText('App.jsx')).toBeNull()

    act(() => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [ACTIVE_TAB]: {
            ...state.sessions[ACTIVE_TAB]!,
            historyMutationEpoch: 2,
          },
        },
      }))
    })

    expect(await screen.findByText('App.jsx')).toBeTruthy()
    expect(getTurnCheckpoints).toHaveBeenCalledTimes(2)
  })

  it('aborts the stale turn checkpoint request when the viewed session changes', async () => {
    const requests: Array<{ sessionId: string; signal?: AbortSignal }> = []
    vi.mocked(sessionsApi.getTurnCheckpoints).mockImplementation((sessionId, options) => {
      requests.push({ sessionId, signal: options?.signal })
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(options.signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'))
        }, { once: true })
      })
    })

    const completedMessages: UIMessage[] = [
      { id: 'user-1', type: 'user_text', content: 'Generate a file', timestamp: 1 },
      { id: 'assistant-1', type: 'assistant_text', content: 'Done', timestamp: 2 },
    ]
    useChatStore.setState({
      sessions: {
        'session-one': makeSessionState({ messages: completedMessages }),
        'session-two': makeSessionState({ messages: completedMessages }),
      },
    })

    const { rerender } = render(<MessageList sessionId="session-one" />)
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]).toMatchObject({ sessionId: 'session-one' })
    expect(requests[0]?.signal?.aborted).toBe(false)

    rerender(<MessageList sessionId="session-two" />)

    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[0]?.signal?.aborted).toBe(true)
    expect(requests[1]).toMatchObject({ sessionId: 'session-two' })
    expect(requests[1]?.signal?.aborted).toBe(false)
  })

  it('rewinds a live turn with the authoritative checkpoint id when the local UI id differs', async () => {
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
            insertions: 1,
            deletions: 0,
          },
        },
      ],
    })
    const rewind = vi.spyOn(sessionsApi, 'rewind').mockResolvedValue({
      target: {
        targetUserMessageId: 'transcript-user-1',
        userMessageIndex: 0,
        userMessageCount: 1,
      },
      conversation: {
        messagesRemoved: 2,
      },
      code: {
        available: true,
        filesChanged: ['src/live.ts'],
        insertions: 1,
        deletions: 0,
      },
    })

    useChatStore.setState({
      reloadHistory: vi.fn().mockResolvedValue(undefined),
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

    await screen.findByText('live.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Undo current turn changes' }))
    const dialog = await screen.findByRole('dialog', { name: 'Undo current turn?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Undo current turn' }))

    await waitFor(() => {
      expect(rewind).toHaveBeenCalledWith(ACTIVE_TAB, {
        targetUserMessageId: 'transcript-user-1',
        userMessageIndex: 0,
        expectedContent: '实时这一轮',
        mode: 'both',
      })
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

  it('keeps checkpoint evidence while hiding change cards for a running background task', async () => {
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
        content: '我正准备查看 test123.md',
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
    expect(screen.queryByText('Markdown')).toBeNull()

    act(() => {
      useChatStore.setState({
        sessions: {
          [ACTIVE_TAB]: makeSessionState({
            messages,
            chatState: 'idle',
            backgroundAgentTasks: {
              'agent-task-1': {
                taskId: 'agent-task-1',
                status: 'running',
                taskType: 'local_agent',
                description: 'Review screenshots',
                startedAt: 1,
                updatedAt: 2,
              },
            },
          }),
        },
      })
    })

    await waitFor(() => {
      expect(screen.queryByText('first.ts')).toBeNull()
    })
    expect(screen.queryByText('Markdown')).toBeNull()

    act(() => {
      useChatStore.setState({
        sessions: {
          [ACTIVE_TAB]: makeSessionState({
            messages,
            chatState: 'thinking',
            backgroundAgentTasks: {
              'agent-task-1': {
                taskId: 'agent-task-1',
                status: 'completed',
                taskType: 'local_agent',
                description: 'Review screenshots',
                startedAt: 1,
                updatedAt: 3,
              },
            },
          }),
        },
      })
    })

    await waitFor(() => {
      expect(screen.getByText('first.ts')).toBeTruthy()
    })
    expect(screen.queryByText('Markdown')).toBeNull()
  })

  it('does not load turn change cards while background tasks are still running', async () => {
    const getTurnCheckpoints = vi.spyOn(sessionsApi, 'getTurnCheckpoints').mockResolvedValue({
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
          chatState: 'idle',
          backgroundAgentTasks: {
            'agent-task-1': {
              taskId: 'agent-task-1',
              status: 'running',
              taskType: 'local_agent',
              description: 'Review screenshots',
              startedAt: 1,
              updatedAt: 2,
            },
          },
        }),
      },
    })

    render(<MessageList />)

    await act(async () => {
      await Promise.resolve()
    })

    expect(getTurnCheckpoints).not.toHaveBeenCalled()
    expect(screen.queryByText('first.ts')).toBeNull()
  })

  it('does not call parent-session checkpoint APIs for a completed SubAgent conversation', async () => {
    const subagentTabId = '__subagent__parent-session__agent-tool-1'
    const getTurnCheckpoints = vi.spyOn(sessionsApi, 'getTurnCheckpoints')
      .mockRejectedValue(new Error(`Session not found: ${subagentTabId}`))
    useTabStore.setState({
      activeTabId: subagentTabId,
      tabs: [{
        sessionId: subagentTabId,
        title: 'Completed reviewer',
        type: 'subagent',
        status: 'idle',
        sourceSessionId: 'parent-session',
        subagentToolUseId: 'agent-tool-1',
      }],
    })
    useChatStore.setState({
      sessions: {
        [subagentTabId]: makeSessionState({
          messages: [
            { id: 'user-1', type: 'user_text', content: 'Review the patch', timestamp: 1 },
            { id: 'assistant-1', type: 'assistant_text', content: 'Review complete', timestamp: 2 },
          ],
        }),
      },
    })

    render(<MessageList sessionId={subagentTabId} />)

    await act(async () => {
      await Promise.resolve()
    })

    expect(getTurnCheckpoints).not.toHaveBeenCalled()
    expect(screen.queryByText(`Session not found: ${subagentTabId}`)).toBeNull()
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
        mode: 'both',
      })
    })
    expect(reloadHistory).toHaveBeenCalledWith(ACTIVE_TAB)
    expect(queueComposerPrefill).toHaveBeenCalledWith(ACTIVE_TAB, {
      text: '做一个页面',
      attachments: undefined,
    })
  })

  it('offers a conversation-only rewind when the checkpoint cannot restore the files', async () => {
    // Regression for #1192: an unrestorable checkpoint used to disable the undo
    // outright, which also cost the user the conversation rollback. The files
    // genuinely cannot be restored here, but backing out of the prompt can.
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
          restoreAvailable: false,
        },
      ],
    })
    const rewind = vi.spyOn(sessionsApi, 'rewind').mockResolvedValue({
      target: { targetUserMessageId: 'user-1', userMessageIndex: 0, userMessageCount: 1 },
      conversation: { messagesRemoved: 2, removedMessageIds: ['user-1', 'assistant-1'] },
      code: { available: true, filesChanged: ['src/first.ts'], insertions: 1, deletions: 0 },
      restoreAvailable: false,
      mode: 'conversation',
    })
    const reloadHistory = vi.fn().mockResolvedValue(undefined)
    const queueComposerPrefill = vi.fn()

    useChatStore.setState({
      reloadHistory,
      queueComposerPrefill,
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            { id: 'user-1', type: 'user_text', content: '做一个页面', timestamp: 1 },
            { id: 'assistant-1', type: 'assistant_text', content: 'first done', timestamp: 2 },
          ],
        }),
      },
    })

    render(<MessageList />)

    await screen.findByText('first.ts')
    const undoButton = screen.getByRole('button', { name: 'Undo current turn changes' })
    expect((undoButton as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(undoButton)

    const dialog = await screen.findByRole('dialog', { name: 'Undo current turn?' })
    expect(
      within(dialog).getByText(/the files cannot be restored safely/i),
    ).toBeTruthy()
    // The code-restoring action must be gone — offering it would fail server-side.
    expect(within(dialog).queryByRole('button', { name: 'Undo current turn' })).toBeNull()

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Roll back conversation only' }),
    )

    await waitFor(() => {
      expect(rewind).toHaveBeenCalledWith(ACTIVE_TAB, {
        targetUserMessageId: 'user-1',
        userMessageIndex: 0,
        expectedContent: '做一个页面',
        mode: 'conversation',
      })
    })
    expect(reloadHistory).toHaveBeenCalledWith(ACTIVE_TAB)
  })

  it('keeps Bash-only undo reachable when the completed turn has no checkpointed files', async () => {
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
            filesChanged: [],
            insertions: 0,
            deletions: 0,
          },
          restoreAvailable: true,
          unverifiedChangeSources: ['Bash'],
        },
      ],
    })
    const rewind = vi.spyOn(sessionsApi, 'rewind').mockResolvedValue({
      target: {
        targetUserMessageId: 'transcript-user-1',
        userMessageIndex: 0,
        userMessageCount: 1,
      },
      conversation: {
        messagesRemoved: 4,
        removedMessageIds: [
          'transcript-user-1',
          'transcript-tool-1',
          'transcript-result-1',
          'transcript-assistant-1',
        ],
      },
      code: {
        available: true,
        filesChanged: [],
        insertions: 0,
        deletions: 0,
      },
      restoreAvailable: true,
      unverifiedChangeSources: ['Bash'],
      mode: 'both',
    })
    vi.spyOn(sessionsApi, 'getMessages').mockResolvedValue({ messages: [] })

    render(<MessageList />)

    // Drive the first turn through the same store actions and server events as
    // a live Bash-only response. The bug sits at the transition from this
    // completed turn to the checkpoint card, so assigning final messages would
    // make the regression self-consistent by construction.
    const store = useChatStore.getState()
    act(() => {
      store.sendMessage(ACTIVE_TAB, 'write only with Bash')
      store.handleServerMessage(ACTIVE_TAB, {
        type: 'content_start',
        blockType: 'tool_use',
        toolName: 'Bash',
        toolUseId: 'bash-only-1',
      })
      store.handleServerMessage(ACTIVE_TAB, {
        type: 'tool_use_complete',
        toolName: 'Bash',
        toolUseId: 'bash-only-1',
        input: { command: "printf 'bash-only\\n' > qa/rewind-bash-only.txt" },
      })
      store.handleServerMessage(ACTIVE_TAB, {
        type: 'tool_result',
        toolUseId: 'bash-only-1',
        content: '',
        isError: false,
      })
      store.handleServerMessage(ACTIVE_TAB, {
        type: 'content_start',
        blockType: 'text',
      })
      store.handleServerMessage(ACTIVE_TAB, {
        type: 'content_delta',
        text: 'BASH_ONLY_DONE',
      })
      store.handleServerMessage(ACTIVE_TAB, { type: 'status', state: 'idle' })
    })

    const undoButton = await screen.findByRole('button', { name: 'Undo current turn changes' })
    expect((undoButton as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByText(
      'Undo restores the files above; changes from Bash were not checkpointed and will remain',
    )).toBeTruthy()

    fireEvent.click(undoButton)
    const dialog = await screen.findByRole('dialog', { name: 'Undo current turn?' })
    expect(within(dialog).getByText(
      'Note: file changes made by Bash were not checkpointed, so undo will not revert them.',
    )).toBeTruthy()
    expect((
      within(dialog).getByRole('button', { name: 'Roll back conversation only' }) as HTMLButtonElement
    ).disabled).toBe(false)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Undo current turn' }))

    await waitFor(() => {
      expect(rewind).toHaveBeenCalledWith(ACTIVE_TAB, {
        targetUserMessageId: 'transcript-user-1',
        userMessageIndex: 0,
        expectedContent: 'write only with Bash',
        mode: 'both',
      })
    })
    expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
      type: 'warning',
      message: 'Rewound 4 messages and restored the checkpointed files; changes from Bash were not checkpointed and remain on disk.',
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
              content: '我正准备查看 test123.md',
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
    await waitFor(() => {
      expect(screen.queryByText('Markdown')).toBeNull()
    })
  })

  it('keeps an inline absolute image when the turn checkpoint recorded no tracked changes', async () => {
    // Regression: Bash-written files (e.g. a PIL render at /tmp/result.png) are
    // invisible to the checkpoint, so filesChanged=[] must NOT hide the image.
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
              content: '在 /tmp 生成一张图',
              timestamp: 1,
            },
            {
              id: 'assistant-1',
              type: 'assistant_text',
              content: '已生成，保存到 /tmp/result.png（1280×800）。',
              timestamp: 2,
            },
          ],
        }),
      },
    })

    render(<MessageList />)

    // Wait for the checkpoint fetch to resolve and its state update to flush —
    // the bug only hid the image AFTER the empty checkpoint arrived.
    await waitFor(() => {
      expect(sessionsApi.getTurnCheckpoints).toHaveBeenCalled()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByRole('img', { name: 'result.png' })).toBeTruthy()
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

  it('restores opener focus without scrolling when its render item remains fully visible', async () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          // A prompt closes the turn, which is what gives the reply the action
          // bar this test borrows as its focus target.
          messages: [
            { id: 'user-origin', type: 'user_text', content: 'review please', timestamp: 0 },
            { id: 'assistant-origin', type: 'assistant_text', content: 'review result', timestamp: 1 },
          ],
        }),
      },
    })
    const { container } = render(<MessageList />)
    const opener = screen.getByRole('button', { name: 'Copy reply' })
    opener.id = 'origin-opener'
    const renderItem = container.querySelector<HTMLElement>('[data-chat-render-item-key="assistant-origin"]')!
    const scroller = renderItem.closest<HTMLElement>('.chat-scroll-area')!
    const scrollIntoView = vi.fn()
    Object.defineProperty(renderItem, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 500, left: 40, right: 640 } as DOMRect)
    vi.spyOn(renderItem, 'getBoundingClientRect').mockReturnValue({ top: 120, bottom: 480, left: 60, right: 620 } as DOMRect)

    await act(async () => {
      useWorkspacePanelStore.getState().openPanel(ACTIVE_TAB)
      useWorkspacePanelStore.setState({
        originBySession: {
          [ACTIVE_TAB]: { sourceTurnKey: 'assistant-origin', sourceElementId: 'origin-opener' },
        },
      })
      await Promise.resolve()
    })
    await act(async () => {
      useWorkspacePanelStore.getState().closePanel(ACTIVE_TAB)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })

    await waitFor(() => expect(document.activeElement).toBe(opener))
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('scrolls a render item clipped by the chat container before restoring opener focus', async () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            { id: 'user-clipped', type: 'user_text', content: 'review please', timestamp: 0 },
            { id: 'assistant-clipped', type: 'assistant_text', content: 'review result', timestamp: 1 },
          ],
        }),
      },
    })
    const { container } = render(<MessageList />)
    const opener = screen.getByRole('button', { name: 'Copy reply' })
    opener.id = 'clipped-origin-opener'
    const renderItem = container.querySelector<HTMLElement>('[data-chat-render-item-key="assistant-clipped"]')!
    const scroller = renderItem.closest<HTMLElement>('.chat-scroll-area')!
    const scrollIntoView = vi.fn()
    Object.defineProperty(renderItem, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 500, left: 40, right: 640 } as DOMRect)
    vi.spyOn(renderItem, 'getBoundingClientRect').mockReturnValue({ top: 80, bottom: 460, left: 60, right: 620 } as DOMRect)

    await act(async () => {
      useWorkspacePanelStore.getState().openPanel(ACTIVE_TAB)
      useWorkspacePanelStore.setState({
        originBySession: {
          [ACTIVE_TAB]: { sourceTurnKey: 'assistant-clipped', sourceElementId: 'clipped-origin-opener' },
        },
      })
      await Promise.resolve()
    })
    await act(async () => {
      useWorkspacePanelStore.getState().closePanel(ACTIVE_TAB)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })

    await waitFor(() => expect(document.activeElement).toBe(opener))
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('uses the semantic render key to remount a virtualized origin before focusing it', async () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          // Prompts, because this test needs an action bar on an arbitrary item
          // deep in the list as its focus target, and prompts keep theirs on
          // every message. What is under test is the remount-then-focus path,
          // which does not care which side the message came from.
          messages: Array.from({ length: 220 }, (_, index) => ({
            id: `virtual-origin-${index}`,
            type: 'user_text' as const,
            content: `virtual transcript ${index}`,
            timestamp: index,
          })),
        }),
      },
    })
    const { container } = render(<MessageList />)
    expect(container.querySelector('[data-chat-render-item-key="virtual-origin-0"]')).toBeNull()

    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }))

    await act(async () => {
      useWorkspacePanelStore.getState().openPanel(ACTIVE_TAB)
      useWorkspacePanelStore.setState({
        originBySession: {
          [ACTIVE_TAB]: { sourceTurnKey: 'virtual-origin-0', sourceElementId: 'virtual-origin-opener' },
        },
      })
      await Promise.resolve()
    })
    await act(async () => {
      useWorkspacePanelStore.getState().closePanel(ACTIVE_TAB)
      await Promise.resolve()
    })

    await act(async () => {
      frames.shift()?.(0)
      await Promise.resolve()
    })
    const restoredItem = container.querySelector<HTMLElement>('[data-chat-render-item-key="virtual-origin-0"]')
    expect(restoredItem).not.toBeNull()
    const opener = restoredItem!.querySelector<HTMLButtonElement>('[aria-label="Copy prompt"]')!
    opener.id = 'virtual-origin-opener'

    await act(async () => {
      frames.shift()?.(16)
      await Promise.resolve()
    })

    expect(document.activeElement).toBe(opener)
    expect(useWorkspacePanelStore.getState().getOrigin(ACTIVE_TAB)).toBeNull()
    vi.unstubAllGlobals()
  })

  it('consumes a closed-panel origin when the source conversation mounts after returning from a workbench tab', async () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            { id: 'user-return', type: 'user_text', content: 'review please', timestamp: 0 },
            { id: 'assistant-return', type: 'assistant_text', content: 'returned conversation', timestamp: 1 },
          ],
        }),
      },
    })
    useWorkspacePanelStore.setState({
      panelBySession: {
        [ACTIVE_TAB]: { isOpen: false, activeView: 'changed' },
      },
      originBySession: {
        [ACTIVE_TAB]: { sourceTurnKey: 'assistant-return', sourceElementId: 'return-origin-opener' },
      },
    })
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }))

    const { container } = render(<MessageList />)
    const opener = screen.getByRole('button', { name: 'Copy reply' })
    opener.id = 'return-origin-opener'
    const renderItem = container.querySelector<HTMLElement>('[data-chat-render-item-key="assistant-return"]')!
    const scroller = renderItem.closest<HTMLElement>('.chat-scroll-area')!
    const scrollIntoView = vi.fn()
    Object.defineProperty(renderItem, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 500, left: 40, right: 640 } as DOMRect)
    vi.spyOn(renderItem, 'getBoundingClientRect').mockReturnValue({ top: 60, bottom: 460, left: 60, right: 620 } as DOMRect)

    for (let attempt = 0; attempt < 20 && document.activeElement !== opener; attempt += 1) {
      const frame = frames.shift()
      if (!frame) break
      await act(async () => {
        frame(attempt * 16)
        await Promise.resolve()
      })
    }

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(document.activeElement).toBe(opener)
    expect(useWorkspacePanelStore.getState().getOrigin(ACTIVE_TAB)).toBeNull()
    vi.unstubAllGlobals()
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

describe('conversation navigation layout', () => {
  const metrics: VirtualRenderItemMetric[] = [
    { signature: 'a', contentWeight: 1, estimatedHeight: 100 },
    { signature: 'b', contentWeight: 1, estimatedHeight: 200 },
    { signature: 'c', contentWeight: 1, estimatedHeight: 300 },
  ]
  const items: ConversationNavigationItem[] = [
    { id: 'a', renderItemKey: 'a', renderIndex: 0, turnNumber: 1, preview: 'A', attachmentCount: 0 },
    { id: 'b', renderItemKey: 'b', renderIndex: 1, turnNumber: 2, preview: 'B', attachmentCount: 0 },
    { id: 'c', renderItemKey: 'c', renderIndex: 2, turnNumber: 3, preview: 'C', attachmentCount: 0 },
  ]

  it('uses measured heights when calculating transcript offsets', () => {
    const offsets = buildVirtualItemOffsets(
      ['a', 'b', 'c'],
      metrics,
      new Map([['b', 250]]),
    )

    expect(offsets).toEqual([0, 100, 350, 650])
  })

  it('selects the last navigation item above the viewport reading anchor', () => {
    const offsets = [0, 100, 350, 650]

    expect(getActiveConversationNavigationItemId(items, offsets, 0, 300)).toBe('a')
    expect(getActiveConversationNavigationItemId(items, offsets, 0, 600)).toBe('a')
    expect(getActiveConversationNavigationItemId(items, offsets, 120, 300)).toBe('b')
    expect(getActiveConversationNavigationItemId(items, offsets, 330, 300)).toBe('c')
  })

  it('places navigation targets near the upper reading anchor and clamps the range', () => {
    const offsets = [0, 100, 350, 650]

    expect(getConversationNavigationTargetScrollTop(items[0]!, offsets, 400, 650)).toBe(0)
    expect(getConversationNavigationTargetScrollTop(items[2]!, offsets, 400, 650)).toBe(250)
  })

  it('does not render the desktop conversation rail in the mobile chat layout', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: makeConversationNavigationMessages(),
        }),
      },
    })

    const { rerender } = render(<MessageList />)
    expect(screen.getByRole('navigation', { name: 'Conversation navigation' })).toBeTruthy()

    rerender(<MessageList mobileLayout />)
    expect(screen.queryByRole('navigation', { name: 'Conversation navigation' })).toBeNull()
  })
})

describe('workspace panel origin visibility', () => {
  it('does not request scrolling when the render item is fully visible in the chat scroller', () => {
    const scroller = document.createElement('div')
    scroller.className = 'chat-scroll-area'
    const item = document.createElement('div')
    scroller.append(item)
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 500, left: 40, right: 640 } as DOMRect)
    vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({ top: 120, bottom: 480, left: 60, right: 620 } as DOMRect)

    expect(isRenderItemFullyVisibleInChatScroller(item)).toBe(true)
  })

  it('detects an item clipped by its chat scroller even while inside the window viewport', () => {
    const scroller = document.createElement('div')
    scroller.className = 'chat-scroll-area'
    const item = document.createElement('div')
    scroller.append(item)
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 500, left: 40, right: 640 } as DOMRect)
    vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({ top: 80, bottom: 460, left: 60, right: 620 } as DOMRect)

    expect(isRenderItemFullyVisibleInChatScroller(item)).toBe(false)
  })
})

describe('virtual height estimates', () => {
  // jsdom has no layout, so the virtualizer's estimates are never exercised by
  // the rendering tests — a stale constant here shows up only as a long real
  // transcript jumping under the reader on scroll-up. These pin the ordering and
  // the ceiling instead of exact pixels, so they survive retuning but not a
  // constant left behind by a density change.
  const itemFor = (message: UIMessage) => ({ kind: 'message' as const, message })

  const oneLineReply = itemFor({
    id: 'reply-1', type: 'assistant_text', content: 'Waiting on #10.', timestamp: 1,
  })
  const collapsedActivity = buildRenderModel([
    { id: 'tool-1', type: 'tool_use', toolName: 'Bash', toolUseId: 'bash-1', input: { command: 'npx xo' }, timestamp: 1 },
    { id: 'think-1', type: 'thinking', content: 'Check the lint spread.', timestamp: 2 },
  ]).renderItems[0]!

  it('orders a collapsed run under a one-line reply under a prompt with attachments', () => {
    const promptWithAttachments = itemFor({
      id: 'user-1',
      type: 'user_text',
      content: 'Look at this',
      timestamp: 1,
      attachments: [{ type: 'image', name: 'shot.png' }],
    })

    expect(estimateRenderItemHeight(collapsedActivity))
      .toBeLessThan(estimateRenderItemHeight(oneLineReply))
    expect(estimateRenderItemHeight(oneLineReply))
      .toBeLessThan(estimateRenderItemHeight(promptWithAttachments))
  })

  it('keeps a one-line reply under 80px now that the card is gone', () => {
    expect(estimateRenderItemHeight(oneLineReply)).toBeLessThan(80)
  })

  it('never estimates below the clamp that also floors measured heights', () => {
    // VIRTUAL_MIN_ITEM_HEIGHT is applied to the ResizeObserver's reading too, so
    // it has to stay under the shortest real item or that row is recorded too
    // tall permanently.
    expect(estimateRenderItemHeight(collapsedActivity)).toBeGreaterThan(24)
  })
})

describe('turn rail positions', () => {
  /** Rail positions for a transcript, driven through the real render model. */
  const railFor = (messages: UIMessage[], hasTrailingStreamingItem = false) =>
    buildTurnRailPositions(buildRenderModel(messages).renderItems, { hasTrailingStreamingItem })

  it('runs one rail from the first response to the last, breaking at each prompt', () => {
    const positions = railFor([
      { id: 'user-1', type: 'user_text', content: 'Fix the lint', timestamp: 1 },
      { id: 'think-1', type: 'thinking', content: 'Check the call sites.', timestamp: 2 },
      { id: 'tool-1', type: 'tool_use', toolName: 'Bash', toolUseId: 'bash-1', input: { command: 'npx xo' }, timestamp: 3 },
      { id: 'reply-1', type: 'assistant_text', content: 'Dispatched release-engineer.', timestamp: 4 },
      { id: 'user-2', type: 'user_text', content: 'And the rest?', timestamp: 5 },
      { id: 'reply-2', type: 'assistant_text', content: 'Only two files left.', timestamp: 6 },
    ])

    // The thinking + tool run collapses into one activity group, so the first
    // turn renders as [group, reply] and the second as a lone reply.
    expect(positions).toEqual(['none', 'start', 'end', 'none', 'solo'])
  })

  it('keeps a team card inside the turn that dispatched it', () => {
    const positions = railFor([
      { id: 'user-1', type: 'user_text', content: 'Build it with a team', timestamp: 1 },
      {
        id: 'tool-create',
        type: 'tool_use',
        toolName: 'TeamCreate',
        toolUseId: 'team-1',
        input: { name: 'pqueue-hardening' },
        timestamp: 2,
      },
      { id: 'reply-1', type: 'assistant_text', content: 'Team is up.', timestamp: 3 },
    ])

    // `team_card` is the one render item that is neither a message nor a tool
    // group, so it is the one that could silently fall out of the turn walk and
    // take the spacing with it. It is a response like any other.
    expect(positions).toEqual(['none', 'start', 'end'])
  })

  it('marks a turn that produced a single item as solo, not start', () => {
    const positions = railFor([
      { id: 'user-1', type: 'user_text', content: 'Status?', timestamp: 1 },
      { id: 'reply-1', type: 'assistant_text', content: 'Still waiting on #10.', timestamp: 2 },
    ])

    expect(positions).toEqual(['none', 'solo'])
  })

  it('leaves the run open for the streaming reply to cap', () => {
    const messages: UIMessage[] = [
      { id: 'user-1', type: 'user_text', content: 'Fix the lint', timestamp: 1 },
      { id: 'tool-1', type: 'tool_use', toolName: 'Bash', toolUseId: 'bash-1', input: { command: 'npx xo' }, timestamp: 2 },
      { id: 'reply-1', type: 'assistant_text', content: 'One file left.', timestamp: 3 },
    ]

    // Settled: the last transcript item caps the rail itself.
    expect(railFor(messages, false)).toEqual(['none', 'start', 'end'])
    // Streaming: the live reply renders below the window and becomes the cap, so
    // no transcript item may close the line or it breaks right where the reader
    // is watching it grow.
    expect(railFor(messages, true)).toEqual(['none', 'start', 'middle'])
  })

  it('breaks the rail at a pending prompt even though turn attribution does not', () => {
    // A member session echoes the prompt with `pending: true`. The three turn
    // walks skip those so a checkpoint keeps its owner, but it still renders as a
    // right-aligned bubble — the line has to stop at a visible bubble.
    const positions = railFor([
      { id: 'user-1', type: 'user_text', content: 'Review the diff', timestamp: 1 },
      { id: 'reply-1', type: 'assistant_text', content: 'On it.', timestamp: 2 },
      { id: 'user-2', type: 'user_text', content: 'Review the diff', timestamp: 3, pending: true },
      { id: 'reply-2', type: 'assistant_text', content: 'Two findings.', timestamp: 4 },
    ])

    expect(positions).toEqual(['none', 'solo', 'none', 'solo'])
  })

  it('rails a transcript that opens without a prompt', () => {
    // Resumed history can start mid-turn; the response still deserves a line.
    const positions = railFor([
      { id: 'reply-1', type: 'assistant_text', content: 'Picking up where we left off.', timestamp: 1 },
      { id: 'reply-2', type: 'assistant_text', content: 'Two files left.', timestamp: 2 },
    ])

    expect(positions).toEqual(['start', 'end'])
  })

  it('gives an empty transcript no rail and lets a streaming reply stand alone', () => {
    expect(railFor([])).toEqual([])
    expect(trailingStreamingRailPosition([])).toBe('solo')
  })

  it('caps an open run with the streaming reply and stands alone after a fresh prompt', () => {
    expect(trailingStreamingRailPosition(['none', 'start', 'middle'])).toBe('end')
    expect(trailingStreamingRailPosition(['none', 'start'])).toBe('end')
    // The user just sent: nothing has landed under the new prompt yet.
    expect(trailingStreamingRailPosition(['none', 'solo', 'none'])).toBe('solo')
  })
})

describe('Agent Teams chat projection', () => {
  function renderedToolUseIds(messages: UIMessage[], options?: Parameters<typeof buildRenderModel>[2]) {
    return buildRenderModel(messages, null, options).renderItems.flatMap((item) => (
      item.kind === 'tool_group' ? item.toolCalls.map((toolCall) => toolCall.toolUseId) : []
    ))
  }

  function sendMessageRun(
    id: string,
    result: unknown,
    isError = false,
    input: unknown = { to: 'worker', message: 'Review task #2' },
  ): UIMessage[] {
    return [
      {
        id: `tool-${id}`,
        type: 'tool_use',
        toolName: 'SendMessage',
        toolUseId: id,
        input,
        timestamp: 1,
      },
      {
        id: `result-${id}`,
        type: 'tool_result',
        toolUseId: id,
        content: result,
        isError,
        timestamp: 2,
      },
    ]
  }

  it('hides a successful routed teammate message only in a lead workbench session', () => {
    const messages = sendMessageRun('team-message', {
      routing: {
        sender: 'team-lead',
        target: 'worker',
        content: 'Review task #2',
      },
    })

    expect(buildRenderModel(messages).renderItems).toHaveLength(1)
    const lead = buildRenderModel(messages, null, {
      hideTeamCoordinationTools: true,
      teamMemberNames: new Set(['worker']),
      teamName: 'audit-team',
    })
    expect(lead.renderItems).toEqual([
      expect.objectContaining({ kind: 'team_card', coordinationToolCalls: [messages[0]] }),
    ])
  })

  it('hides successful team messages from their real input shape when the transport omits routing', () => {
    const direct = sendMessageRun('direct', 'Message sent to worker inbox')
    const broadcast = sendMessageRun('broadcast', 'Message broadcast to 4 teammates', false, {
      to: '*',
      message: 'Start the dependency graph',
    })
    const messages = [...direct, ...broadcast]

    const lead = buildRenderModel(messages, null, {
      hideTeamCoordinationTools: true,
      teamMemberNames: new Set(['worker']),
      teamName: 'audit-team',
    })
    expect(lead.renderItems).toEqual([
      expect.objectContaining({ kind: 'team_card', coordinationToolCalls: [direct[0], broadcast[0]] }),
    ])
  })

  it('keeps ordinary agent continuation and failed team SendMessage calls visible', () => {
    const ordinary = sendMessageRun(
      'ordinary',
      'Message queued to async agent a1',
      false,
      { to: 'async-agent-a1', message: 'Continue' },
    )
    const failed = sendMessageRun('failed', {
      routing: { sender: 'team-lead', target: 'missing-worker' },
    }, true)

    expect(buildRenderModel(ordinary, null, {
      hideTeamCoordinationTools: true,
      teamMemberNames: new Set(['worker']),
    }).renderItems).toHaveLength(1)
    expect(buildRenderModel(failed, null, {
      hideTeamCoordinationTools: true,
    }).renderItems).toHaveLength(1)
  })

  it('stops using a historical Team roster after delete when a same-name direct Agent is messaged', () => {
    const messages: UIMessage[] = [
      {
        id: 'create-tool', type: 'tool_use', toolName: 'TeamCreate', toolUseId: 'create',
        input: { team_name: 'audit-team' }, timestamp: 1,
      },
      {
        id: 'create-result', type: 'tool_result', toolUseId: 'create',
        content: { success: true, team_name: 'audit-team' }, isError: false, timestamp: 2,
      },
      {
        id: 'team-message-tool', type: 'tool_use', toolName: 'SendMessage', toolUseId: 'team-message',
        input: { to: 'reviewer', message: 'Finish the Team review' }, timestamp: 3,
      },
      {
        id: 'team-message-result', type: 'tool_result', toolUseId: 'team-message',
        content: 'Message sent to reviewer inbox', isError: false, timestamp: 4,
      },
      {
        id: 'delete-tool', type: 'tool_use', toolName: 'TeamDelete', toolUseId: 'delete',
        input: {}, timestamp: 5,
      },
      {
        id: 'delete-result', type: 'tool_result', toolUseId: 'delete',
        content: { success: true, team_name: 'audit-team' }, isError: false, timestamp: 6,
      },
      {
        id: 'direct-agent-tool', type: 'tool_use', toolName: 'Agent', toolUseId: 'direct-agent',
        input: { name: 'reviewer', description: 'Continue as an ordinary SubAgent' }, timestamp: 7,
      },
      {
        id: 'direct-agent-result', type: 'tool_result', toolUseId: 'direct-agent',
        content: { status: 'completed', agentId: 'direct-reviewer' }, isError: false, timestamp: 8,
      },
      {
        id: 'direct-message-tool', type: 'tool_use', toolName: 'SendMessage', toolUseId: 'direct-message',
        input: { to: 'reviewer', message: 'Continue the direct review' }, timestamp: 9,
      },
      {
        id: 'direct-message-result', type: 'tool_result', toolUseId: 'direct-message',
        content: 'Message queued for delivery to reviewer at its next tool round.',
        isError: false,
        timestamp: 10,
      },
    ]

    const options = {
      hideTeamCoordinationTools: true,
      teamMemberNames: new Set(['reviewer']),
      teamName: 'audit-team',
    }
    const model = buildRenderModel(messages, null, options)
    const teamCards = model.renderItems.filter((item) => item.kind === 'team_card')

    expect(teamCards).toHaveLength(1)
    expect(teamCards[0]).toMatchObject({
      teamName: 'audit-team',
      endedAt: 5,
      coordinationToolCalls: [
        expect.objectContaining({ toolUseId: 'team-message' }),
        expect.objectContaining({ toolUseId: 'delete' }),
      ],
    })
    expect(renderedToolUseIds(messages, options)).toEqual([
      'direct-agent',
      'direct-message',
    ])
  })

  it('replaces the TeamCreate call with a team card at the point the team was formed', () => {
    const messages: UIMessage[] = [
      { id: 'user-1', type: 'user_text', content: 'Audit the queue', timestamp: 1 },
      {
        id: 'tool-create',
        type: 'tool_use',
        toolName: 'TeamCreate',
        toolUseId: 'create-1',
        input: { team_name: 'audit-team' },
        timestamp: 2,
      },
      {
        id: 'result-create',
        type: 'tool_result',
        toolUseId: 'create-1',
        content: '{"team_name":"audit-team","lead_agent_id":"team-lead@audit-team"}',
        isError: false,
        timestamp: 3,
      },
      { id: 'assistant-1', type: 'assistant_text', content: 'Team is up.', timestamp: 4 },
    ]

    const lead = buildRenderModel(messages, null, { hideTeamCoordinationTools: true })
    expect(lead.renderItems.map((item) => item.kind))
      .toEqual(['message', 'team_card', 'message'])
    // The card sits where the call was, not appended at the end — scrolling
    // back must still show that this turn handed work to a team.
    expect(lead.renderItems[1]).toMatchObject({ kind: 'team_card', id: 'team-card-tool-create' })

    // An ordinary session with no workbench keeps the raw tool call.
    expect(buildRenderModel(messages).renderItems.map((item) => item.kind))
      .toEqual(['message', 'tool_group', 'message'])
  })

  it('projects team orchestration into the team card without hiding ordinary tools', () => {
    const tool = (
      id: string,
      toolName: string,
      input: unknown,
      timestamp: number,
    ): UIMessage => ({
      id: `tool-${id}`,
      type: 'tool_use',
      toolName,
      toolUseId: id,
      input,
      timestamp,
    })
    const result = (
      id: string,
      content: unknown,
      timestamp: number,
      isError = false,
    ): UIMessage => ({
      id: `result-${id}`,
      type: 'tool_result',
      toolUseId: id,
      content,
      isError,
      timestamp,
    })
    const messages: UIMessage[] = [
      tool('pre-task', 'TaskCreate', { subject: 'Operator todo' }, 1),
      result('pre-task', 'Task #1 created successfully', 2),
      tool('create-team', 'TeamCreate', { team_name: 'audit-team' }, 3),
      result('create-team', { team_name: 'audit-team' }, 4),
      tool('team-task', 'TaskCreate', { subject: 'Review API' }, 5),
      result('team-task', 'Task #1 created successfully', 6),
      tool('team-update', 'TaskUpdate', { taskId: '1', owner: 'reviewer' }, 7),
      result('team-update', 'Task #1 updated successfully', 8),
      tool('team-agent', 'Agent', {
        description: 'Review API',
        name: 'reviewer',
        team_name: 'audit-team',
      }, 9),
      result('team-agent', { status: 'teammate_spawned', name: 'reviewer', team_name: 'audit-team' }, 10),
      tool('direct-agent', 'Agent', { description: 'Check an unrelated question' }, 11),
      result('direct-agent', 'agentId: direct-1', 12),
      tool('team-message', 'SendMessage', { to: 'reviewer', message: 'Start task #1' }, 13),
      result('team-message', 'Message sent to reviewer inbox', 14),
      tool('failed-update', 'TaskUpdate', { taskId: 'missing', status: 'completed' }, 15),
      result('failed-update', 'Task missing not found', 16, true),
      tool('failed-team-agent', 'Agent', {
        description: 'Spawn missing teammate',
        name: 'missing',
        team_name: 'audit-team',
      }, 17),
      result('failed-team-agent', 'Agent spawn failed', 18, true),
      tool('delete-team', 'TeamDelete', {}, 19),
      result('delete-team', { success: true, team_name: 'audit-team' }, 20),
      tool('post-task', 'TaskCreate', { subject: 'Operator follow-up' }, 21),
      result('post-task', 'Task #2 created successfully', 22),
      tool('post-agent', 'Agent', { description: 'Summarize the follow-up' }, 23),
      result('post-agent', 'agentId: direct-2', 24),
    ]

    const model = buildRenderModel(messages, null, {
      hideTeamCoordinationTools: true,
      teamMemberNames: new Set(['reviewer']),
    })

    expect(renderedToolUseIds(messages, {
      hideTeamCoordinationTools: true,
      teamMemberNames: new Set(['reviewer']),
    })).toEqual([
      'pre-task',
      'direct-agent',
      'failed-update',
      'failed-team-agent',
      'post-task',
      'post-agent',
    ])
    const teamCards = model.renderItems.filter((item) => item.kind === 'team_card')
    expect(teamCards).toHaveLength(1)
    expect(teamCards[0]).toMatchObject({
      teamName: 'audit-team',
      endedAt: 19,
      coordinationToolCalls: [
        expect.objectContaining({ toolUseId: 'team-task' }),
        expect.objectContaining({ toolUseId: 'team-update' }),
        expect.objectContaining({ toolUseId: 'team-agent' }),
        expect.objectContaining({ toolUseId: 'team-message' }),
        expect.objectContaining({ toolUseId: 'delete-team' }),
      ],
    })
    // Projection removes duplicate UI only. The raw audit result remains
    // available to the transcript/store and the workbench owns its presentation.
    expect(model.toolResultMap.get('team-task')?.content).toBe('Task #1 created successfully')
    expect(messages).toHaveLength(24)
  })

  it('does not enter Team scope when TeamCreate returns success false', () => {
    const messages: UIMessage[] = [
      {
        id: 'create-tool', type: 'tool_use', toolName: 'TeamCreate', toolUseId: 'create',
        input: { team_name: 'failed-team' }, timestamp: 1,
      },
      {
        id: 'create-result', type: 'tool_result', toolUseId: 'create',
        content: { success: false, error: 'already exists' }, isError: false, timestamp: 2,
      },
      {
        id: 'task-tool', type: 'tool_use', toolName: 'TaskCreate', toolUseId: 'task',
        input: { subject: 'Main-session task' }, timestamp: 3,
      },
    ]

    expect(renderedToolUseIds(messages, {
      hideTeamCoordinationTools: true,
    })).toEqual(['create', 'task'])
    expect(buildRenderModel(messages, null, {
      hideTeamCoordinationTools: true,
    }).renderItems.some(item => item.kind === 'team_card')).toBe(false)
  })

  it('keeps Team scope active when TeamDelete returns success false', () => {
    const messages: UIMessage[] = [
      {
        id: 'create-tool', type: 'tool_use', toolName: 'TeamCreate', toolUseId: 'create',
        input: { team_name: 'audit-team' }, timestamp: 1,
      },
      {
        id: 'create-result', type: 'tool_result', toolUseId: 'create',
        content: { success: true }, isError: false, timestamp: 2,
      },
      {
        id: 'delete-tool', type: 'tool_use', toolName: 'TeamDelete', toolUseId: 'delete',
        input: {}, timestamp: 3,
      },
      {
        id: 'delete-result', type: 'tool_result', toolUseId: 'delete',
        content: { success: false, team_name: 'audit-team', error: 'still running' }, isError: false, timestamp: 4,
      },
      {
        id: 'task-tool', type: 'tool_use', toolName: 'TaskCreate', toolUseId: 'task',
        input: { subject: 'Shared Team task' }, timestamp: 5,
      },
    ]

    expect(renderedToolUseIds(messages, {
      hideTeamCoordinationTools: true,
    })).toEqual(['delete'])
  })

  it('never renders an identity-unknown pending Agent as a SubAgent during a team lifecycle', () => {
    vi.useFakeTimers()
    const sessionId = 'team-transcript-stream'
    useChatStore.setState({
      sessions: { [sessionId]: makeSessionState() },
    })
    const store = useChatStore.getState()
    const renderedIds = () => renderedToolUseIds(
      useChatStore.getState().sessions[sessionId]?.messages ?? [],
      { hideTeamCoordinationTools: true },
    )

    store.handleServerMessage(sessionId, {
      type: 'content_start', blockType: 'tool_use', toolName: 'TeamCreate', toolUseId: 'create-team',
    })
    store.handleServerMessage(sessionId, {
      type: 'tool_use_complete',
      toolName: 'TeamCreate',
      toolUseId: 'create-team',
      input: { team_name: 'audit-team' },
    })
    store.handleServerMessage(sessionId, {
      type: 'tool_result',
      toolUseId: 'create-team',
      content: { team_name: 'audit-team' },
      isError: false,
    })

    store.handleServerMessage(sessionId, {
      type: 'content_start', blockType: 'tool_use', toolName: 'Agent', toolUseId: 'team-agent',
    })
    store.handleServerMessage(sessionId, {
      type: 'content_delta', toolInput: '{"description":"Review API","name":',
    })
    vi.advanceTimersByTime(60)

    expect(useChatStore.getState().sessions[sessionId]?.messages).toContainEqual(
      expect.objectContaining({
        type: 'tool_use',
        toolUseId: 'team-agent',
        input: { description: 'Review API' },
        isPending: true,
      }),
    )
    expect(renderedIds()).toEqual([])

    store.handleServerMessage(sessionId, {
      type: 'tool_use_complete',
      toolName: 'Agent',
      toolUseId: 'team-agent',
      input: { description: 'Review API', name: 'reviewer', team_name: 'audit-team' },
    })
    store.handleServerMessage(sessionId, {
      type: 'tool_result',
      toolUseId: 'team-agent',
      content: { status: 'teammate_spawned', name: 'reviewer', team_name: 'audit-team' },
      isError: false,
    })
    expect(renderedIds()).toEqual([])

    store.handleServerMessage(sessionId, {
      type: 'content_start', blockType: 'tool_use', toolName: 'Agent', toolUseId: 'direct-agent',
    })
    store.handleServerMessage(sessionId, {
      type: 'content_delta', toolInput: '{"description":"Check an unrelated question"',
    })
    vi.advanceTimersByTime(60)
    expect(renderedIds()).toEqual([])

    store.handleServerMessage(sessionId, {
      type: 'tool_use_complete',
      toolName: 'Agent',
      toolUseId: 'direct-agent',
      input: { description: 'Check an unrelated question' },
    })
    expect(renderedIds()).toEqual(['direct-agent'])

    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('uses a team lifecycle window only when compacted history omits TeamCreate', () => {
    const messages: UIMessage[] = [
      {
        id: 'pre-task', type: 'tool_use', toolName: 'TaskCreate', toolUseId: 'pre-task',
        input: { subject: 'Before team' }, timestamp: 90,
      },
      {
        id: 'team-task', type: 'tool_use', toolName: 'TaskCreate', toolUseId: 'team-task',
        input: { subject: 'Team task' }, timestamp: 150,
      },
      {
        id: 'post-task', type: 'tool_use', toolName: 'TaskCreate', toolUseId: 'post-task',
        input: { subject: 'After team' }, timestamp: 210,
      },
    ]

    expect(renderedToolUseIds(messages, {
      hideTeamCoordinationTools: true,
      teamTaskWindows: [{ startedAt: 100, endedAt: 200 }],
      teamName: 'audit-team',
    })).toEqual(['pre-task', 'post-task'])
    expect(renderedToolUseIds(messages)).toEqual(['pre-task', 'team-task', 'post-task'])
  })

  it('lets a durable end close an explicit TeamCreate when TeamDelete was compacted', () => {
    const messages: UIMessage[] = [
      {
        id: 'create-tool', type: 'tool_use', toolName: 'TeamCreate', toolUseId: 'create',
        input: { team_name: 'audit-team' }, timestamp: 100,
      },
      {
        id: 'create-result', type: 'tool_result', toolUseId: 'create',
        content: { success: true }, isError: false, timestamp: 101,
      },
      {
        id: 'team-task', type: 'tool_use', toolName: 'TaskCreate', toolUseId: 'team-task',
        input: { subject: 'Inside lifecycle' }, timestamp: 150,
      },
      {
        id: 'post-task', type: 'tool_use', toolName: 'TaskCreate', toolUseId: 'post-task',
        input: { subject: 'After lifecycle' }, timestamp: 250,
      },
    ]

    expect(renderedToolUseIds(messages, {
      hideTeamCoordinationTools: true,
      teamTaskWindows: [{ startedAt: 100, endedAt: 200 }],
      teamName: 'audit-team',
    })).toEqual(['post-task'])
  })

  it('uses a newer durable Team window after an older explicit TeamDelete', () => {
    const messages: UIMessage[] = [
      {
        id: 'old-delete', type: 'tool_use', toolName: 'TeamDelete', toolUseId: 'old-delete',
        input: {}, timestamp: 90,
      },
      {
        id: 'old-delete-result', type: 'tool_result', toolUseId: 'old-delete',
        content: { success: true, team_name: 'old-team' }, isError: false, timestamp: 91,
      },
      {
        id: 'team-task', type: 'tool_use', toolName: 'TaskCreate', toolUseId: 'team-task',
        input: { subject: 'Compacted new Team task' }, timestamp: 150,
      },
      {
        id: 'post-task', type: 'tool_use', toolName: 'TaskCreate', toolUseId: 'post-task',
        input: { subject: 'After compacted Team' }, timestamp: 250,
      },
    ]

    const options = {
      hideTeamCoordinationTools: true,
      teamTaskWindows: [{ startedAt: 100, endedAt: 200 }],
      teamName: 'audit-team',
      teamStartedAt: 100,
    }
    expect(renderedToolUseIds(messages, options)).toEqual(['post-task'])
    expect(buildRenderModel(messages, null, options).renderItems.filter(
      (item) => item.kind === 'team_card',
    )).toEqual([
      expect.objectContaining({
        teamName: 'old-team',
        endedAt: 90,
        coordinationToolCalls: [expect.objectContaining({ toolUseId: 'old-delete' })],
      }),
      expect.objectContaining({
        teamName: 'audit-team',
        startedAt: 100,
        coordinationToolCalls: [expect.objectContaining({ toolUseId: 'team-task' })],
      }),
    ])
  })

  it('starts a new audit card when a compacted Team lifecycle follows an explicit delete', () => {
    const messages: UIMessage[] = [
      {
        id: 'old-create', type: 'tool_use', toolName: 'TeamCreate', toolUseId: 'old-create',
        input: { team_name: 'old-team' }, timestamp: 10,
      },
      {
        id: 'old-create-result', type: 'tool_result', toolUseId: 'old-create',
        content: { success: true, team_name: 'old-team' }, isError: false, timestamp: 11,
      },
      {
        id: 'old-delete', type: 'tool_use', toolName: 'TeamDelete', toolUseId: 'old-delete',
        input: {}, timestamp: 20,
      },
      {
        id: 'old-delete-result', type: 'tool_result', toolUseId: 'old-delete',
        content: { success: true, team_name: 'old-team' }, isError: false, timestamp: 21,
      },
      {
        id: 'new-team-task', type: 'tool_use', toolName: 'TaskCreate', toolUseId: 'new-team-task',
        input: { subject: 'Task from compacted new Team' }, timestamp: 150,
      },
    ]

    const model = buildRenderModel(messages, null, {
      hideTeamCoordinationTools: true,
      teamTaskWindows: [{ startedAt: 100, endedAt: 200 }],
      teamName: 'new-team',
      teamStartedAt: 100,
    })
    const cards = model.renderItems.filter((item) => item.kind === 'team_card')

    expect(cards).toHaveLength(2)
    expect(cards[0]).toMatchObject({
      teamName: 'old-team',
      startedAt: 10,
      endedAt: 20,
      coordinationToolCalls: [expect.objectContaining({ toolUseId: 'old-delete' })],
    })
    expect(cards[1]).toMatchObject({
      teamName: 'new-team',
      startedAt: 100,
      coordinationToolCalls: [expect.objectContaining({ toolUseId: 'new-team-task' })],
    })
  })

  it('uses the successful TeamCreate identity and never substitutes the current Team for an explicit old scope', () => {
    const createMessages: UIMessage[] = [
      {
        id: 'create-tool', type: 'tool_use', toolName: 'TeamCreate', toolUseId: 'create',
        input: { team_name: 'requested-name' }, timestamp: 10,
      },
      {
        id: 'create-result', type: 'tool_result', toolUseId: 'create',
        content: { success: true, team_name: 'requested-name-2' }, isError: false, timestamp: 11,
      },
    ]
    const createdCard = buildRenderModel(createMessages, null, {
      hideTeamCoordinationTools: true,
    }).renderItems.find((item) => item.kind === 'team_card')
    expect(createdCard).toMatchObject({
      teamName: 'requested-name-2',
      startedAt: 10,
    })

    const explicitOldScope = buildRenderModel([{
      id: 'old-agent', type: 'tool_use', toolName: 'Agent', toolUseId: 'old-agent',
      input: { name: 'reviewer', team_name: 'old-team', description: 'Review the old run' },
      timestamp: 150,
    }], null, {
      hideTeamCoordinationTools: true,
      teamName: 'new-team',
      teamStartedAt: 200,
    }).renderItems.find((item) => item.kind === 'team_card')
    expect(explicitOldScope).toMatchObject({
      teamName: 'old-team',
      startedAt: 150,
      coordinationToolCalls: [expect.objectContaining({ toolUseId: 'old-agent' })],
    })
  })

  it('uses synchronous Team lifecycle ownership before the first workbench snapshot resolves', async () => {
    let resolveWorkbench!: (snapshot: Awaited<ReturnType<typeof teamsApi.getWorkbench>>) => void
    vi.spyOn(teamsApi, 'get').mockImplementation(() => new Promise(() => {}))
    vi.spyOn(teamsApi, 'getWorkbench').mockImplementation(() => new Promise((resolve) => {
      resolveWorkbench = resolve
    }))
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            {
              id: 'task-tool', type: 'tool_use', toolName: 'TaskCreate', toolUseId: 'team-task',
              input: { subject: 'Never flash this Team task' }, timestamp: 102,
            },
            {
              id: 'agent-tool', type: 'tool_use', toolName: 'Agent', toolUseId: 'team-agent',
              input: { description: 'Never flash this teammate', name: 'reviewer' },
              timestamp: 103, isPending: true,
            },
            {
              id: 'message-tool', type: 'tool_use', toolName: 'SendMessage', toolUseId: 'team-message',
              input: { to: 'reviewer', message: 'Never flash this Team message' },
              timestamp: 104, isPending: false,
            },
          ],
        }),
      },
    })

    act(() => {
      useTeamStore.getState().handleTeamCreated('audit-team', ACTIVE_TAB, { createdAt: 100 })
    })
    render(<MessageList sessionId={ACTIVE_TAB} />)

    const pendingCard = screen.getByTestId('agent-teams-inline-card')
    const audit = screen.getByTestId('agent-teams-coordination-audit')
    expect((pendingCard as HTMLButtonElement).disabled).toBe(true)
    expect(within(audit).getByText('Never flash this Team task')).toBeTruthy()
    expect(within(audit).getByText(/Never flash this teammate/)).toBeTruthy()
    expect(within(audit).getByText(/Never flash this Team message/)).toBeTruthy()
    expect(screen.getAllByText('Never flash this Team task')).toHaveLength(1)
    expect(screen.getAllByText(/Never flash this teammate/)).toHaveLength(1)
    expect(screen.getAllByText(/Never flash this Team message/)).toHaveLength(1)
    expect(useTeamStore.getState().workbenchesBySession[ACTIVE_TAB]).toBeUndefined()

    await act(async () => {
      resolveWorkbench({
        version: 'snapshot-v1',
        generatedAt: new Date(110).toISOString(),
        team: {
          name: 'audit-team',
          leadSessionId: ACTIVE_TAB,
          leadAgentId: 'team-lead@audit-team',
          createdAt: '100',
          members: [{
            agentId: 'team-lead@audit-team', name: 'team-lead', role: 'lead', status: 'running',
          }],
        },
        tasks: [],
        messages: [],
      })
      await Promise.resolve()
    })

    await waitFor(() => expect(
      (screen.getByTestId('agent-teams-inline-card') as HTMLButtonElement).disabled,
    ).toBe(false))
    expect(screen.getAllByText('Never flash this Team task')).toHaveLength(1)
    expect(screen.getAllByText(/Never flash this teammate/)).toHaveLength(1)
    expect(screen.getAllByText(/Never flash this Team message/)).toHaveLength(1)
  })

  it('never binds an older TeamCreate card to a newer incarnation with the same name', async () => {
    let resolveWorkbench!: (snapshot: Awaited<ReturnType<typeof teamsApi.getWorkbench>>) => void
    vi.spyOn(teamsApi, 'get').mockImplementation(() => new Promise(() => {}))
    vi.spyOn(teamsApi, 'getWorkbench').mockImplementation(() => new Promise((resolve) => {
      resolveWorkbench = resolve
    }))
    const createRun = (id: string, timestamp: number): UIMessage[] => [
      {
        id: `${id}-tool`, type: 'tool_use', toolName: 'TeamCreate', toolUseId: id,
        input: { team_name: 'reused-team' }, timestamp,
      },
      {
        id: `${id}-result`, type: 'tool_result', toolUseId: id,
        content: { success: true, team_name: 'reused-team' }, isError: false, timestamp: timestamp + 1,
      },
    ]
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState({
          messages: [
            ...createRun('old-create', 100_000),
            {
              id: 'old-delete-tool', type: 'tool_use', toolName: 'TeamDelete', toolUseId: 'old-delete',
              input: {}, timestamp: 101_000,
            },
            {
              id: 'old-delete-result', type: 'tool_result', toolUseId: 'old-delete',
              content: { success: true, team_name: 'reused-team' }, isError: false, timestamp: 101_001,
            },
            // The next incarnation starts within the transport-tolerance
            // window of the first. Its snapshot must still never revive the
            // already-ended historical card.
            ...createRun('new-create', 102_000),
          ],
        }),
      },
    })

    act(() => {
      useTeamStore.getState().handleTeamCreated('reused-team', ACTIVE_TAB, { createdAt: 102_000 })
    })
    render(<MessageList sessionId={ACTIVE_TAB} />)

    await act(async () => {
      resolveWorkbench({
        version: 'new-incarnation',
        generatedAt: new Date(102_010).toISOString(),
        team: {
          name: 'reused-team',
          leadSessionId: ACTIVE_TAB,
          leadAgentId: 'team-lead@reused-team',
          incarnationId: 'new-incarnation',
          createdAt: '102000',
          members: [{
            agentId: 'team-lead@reused-team', name: 'team-lead', role: 'lead', status: 'running',
          }],
        },
        tasks: [],
        messages: [],
      })
      await Promise.resolve()
    })

    const cards = await screen.findAllByTestId('agent-teams-inline-card')
    expect(cards).toHaveLength(2)
    expect((cards[0] as HTMLButtonElement).disabled).toBe(true)
    expect((cards[1] as HTMLButtonElement).disabled).toBe(false)
    expect(within(cards[0]!).getByText('Completed')).toBeTruthy()
    expect(within(cards[1]!).getByText('Forming team')).toBeTruthy()

    fireEvent.click(cards[1]!)
    expect(useTabStore.getState().tabs).toContainEqual(expect.objectContaining({
      type: 'team',
      title: 'reused-team',
      teamLeadSessionId: ACTIVE_TAB,
    }))
  })
})
