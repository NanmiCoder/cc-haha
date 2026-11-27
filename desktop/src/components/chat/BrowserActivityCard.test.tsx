import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { browserHost } from '@/lib/desktopHost/browserHost'
import { clearDisclosureMemory } from '@/lib/disclosureMemory'
import { useBrowserUseStore } from '@/stores/browserUseStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import type { UIMessage } from '@/types/chat'
import {
  BrowserActivityCard,
  BrowserTakeoverCard,
  BrowserUseEnableCard,
  SessionBrowserTakeoverBanner,
} from './BrowserActivityCard'
import { ToolCallGroup } from './ToolCallGroup'
import { maskSensitiveBrowserValue } from './toolCallPresentation'

type ToolCall = Extract<UIMessage, { type: 'tool_use' }>
type ToolResult = Extract<UIMessage, { type: 'tool_result' }>

function makeCall(overrides: Partial<ToolCall> & { toolName: string; input: unknown }): ToolCall {
  return {
    ...overrides,
    id: overrides.id ?? 'call-1',
    type: 'tool_use',
    toolUseId: overrides.toolUseId ?? 'tu-1',
    toolName: overrides.toolName,
    input: overrides.input,
    timestamp: overrides.timestamp ?? 1000,
  }
}

describe('BrowserActivityCard', () => {
  beforeEach(() => {
    clearDisclosureMemory()
    useSettingsStore.setState({ locale: 'en' })
    useBrowserUseStore.getState().reset()
    window.desktopHost = { ...browserHost, kind: 'electron', isDesktop: true }
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'desktopHost')
  })

  it('masks sensitive password values and renders human-readable steps without raw @eN refs', () => {
    expect(maskSensitiveBrowserValue('super-secret', true, 'Password')).toBe('••••••')
    expect(maskSensitiveBrowserValue('my-token', false, 'API Secret')).toBe('••••••')
    expect(maskSensitiveBrowserValue('hello', false, 'Search')).toBe('hello')

    const calls: ToolCall[] = [
      makeCall({
        id: 'c1',
        toolUseId: 'tu-1',
        toolName: 'BrowserAct',
        input: {
          steps: [
            { action: 'fill', ref: '@e4', label: 'Password', text: 'hunter2', sensitive: true },
            { action: 'click', ref: '@e14', label: 'Sign in' },
          ],
        },
      }),
    ]
    const results = new Map<string, ToolResult>([
      ['tu-1', { id: 'r1', type: 'tool_result', toolUseId: 'tu-1', content: 'ok', isError: false, timestamp: 1200 }],
    ])

    render(<BrowserActivityCard sessionId="s1" toolCalls={calls} resultMap={results} />)

    expect(screen.getByTestId('browser-activity-card')).toHaveTextContent('Browser actions · 2 steps')
    fireEvent.click(screen.getByRole('button', { name: /Browser actions/i }))

    const stepsList = screen.getByTestId('browser-activity-steps')
    expect(stepsList).toHaveTextContent('••••••')
    expect(stepsList).not.toHaveTextContent('hunter2')
    expect(stepsList).toHaveTextContent('Sign in')
    expect(stepsList).not.toHaveTextContent('@e14')
  })

  it('degrades cleanly in Remote/H5 mode as read-only without dead desktop-only buttons', () => {
    window.desktopHost = { ...browserHost, kind: 'browser', isDesktop: false }
    useBrowserUseStore.getState().applyActivityEvent('s1', {
      id: 'ev-1',
      timestamp: 1000,
      sessionId: 's1',
      tabId: 'tab-1',
      target: 'workspace',
      kind: 'snapshot',
      humanLabel: 'Read page structure',
      status: 'running',
      screenshotDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    })
    const calls: ToolCall[] = [
      makeCall({ id: 'c1', toolUseId: 'tu-1', toolName: 'BrowserSnapshot', input: { screenshot: true } }),
    ]

    render(<BrowserActivityCard sessionId="s1" toolCalls={calls} resultMap={new Map()} isStreaming />)

    expect(screen.queryByRole('button', { name: 'View' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
    expect(screen.getByAltText('Browser screenshot')).toBeInTheDocument()
  })

  it('does not bleed live screenshots into completed historical cards and resolves stopped calls', () => {
    useBrowserUseStore.getState().applyActivityEvent('s1', {
      id: 'ev-live',
      timestamp: 2000,
      sessionId: 's1',
      tabId: 'tab-1',
      target: 'workspace',
      kind: 'snapshot',
      humanLabel: 'Live snapshot',
      status: 'running',
      screenshotDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    })
    const completedCalls: ToolCall[] = [
      makeCall({ id: 'c1', toolUseId: 'tu-done', toolName: 'BrowserNavigate', input: { url: 'https://example.com' } }),
    ]
    const results = new Map<string, ToolResult>([
      ['tu-done', { id: 'r1', type: 'tool_result', toolUseId: 'tu-done', content: 'ok', isError: false, timestamp: 1200 }],
    ])

    const { rerender } = render(<BrowserActivityCard sessionId="s1" toolCalls={completedCalls} resultMap={results} />)
    expect(screen.queryByAltText('Browser screenshot')).not.toBeInTheDocument()

    // Stopped call with no tool_result must not spin as running.
    const stoppedCalls: ToolCall[] = [
      makeCall({
        id: 'c2',
        toolUseId: 'tu-stopped',
        toolName: 'BrowserAct',
        input: { steps: [{ action: 'click', label: 'Save' }] },
        status: 'stopped',
      }),
    ]
    rerender(<BrowserActivityCard sessionId="s1" toolCalls={stoppedCalls} resultMap={new Map()} />)
    expect(screen.getByTestId('browser-activity-card')).toHaveTextContent('Browser action · 1 step')
    expect(screen.queryByRole('button', { name: 'Take over' })).not.toBeInTheDocument()
  })

  it('renders SessionBrowserTakeoverBanner once, formats raw reason codes, and hides buttons on H5', () => {
    useBrowserUseStore.getState().applyTakeoverEvent('s1', {
      takeoverId: 'tk-raw',
      tabId: 'tab-1',
      target: 'workspace',
      sessionId: 's1',
      reason: 'user_requested',
      message: 'user_requested',
      createdAt: 1000,
      status: 'pending',
    })

    window.desktopHost = { ...browserHost, kind: 'browser', isDesktop: false }
    render(<SessionBrowserTakeoverBanner sessionId="s1" />)

    const card = screen.getByTestId('browser-takeover-card')
    expect(card).toHaveTextContent('You took over browser control')
    expect(card).not.toHaveTextContent('user_requested')
    expect(card).toHaveTextContent('Complete and resume browser takeover on the desktop app.')
    expect(screen.queryByRole('button', { name: 'Done, continue' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })

  it('renders non-collapsible BrowserTakeoverCard and dispatches resume/abort without duplicate IPC', async () => {
    const sendUserAction = vi.fn().mockResolvedValue(undefined)
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      browserUse: {
        ...browserHost.browserUse,
        sendUserAction,
      },
    }
    const resumeSpy = vi.spyOn(useBrowserUseStore.getState(), 'resumeTakeover').mockResolvedValue(true)
    const abortSpy = vi.spyOn(useBrowserUseStore.getState(), 'abortTakeover').mockResolvedValue(true)

    render(
      <BrowserTakeoverCard
        sessionId="s1"
        takeover={{
          takeoverId: 'tk-1',
          tabId: 'tab-1',
          target: 'workspace',
          sessionId: 's1',
          reason: 'payment',
          message: 'Confirm payment in checkout',
          url: 'https://shop.example.com/pay',
          createdAt: 1000,
          status: 'pending',
        }}
      />,
    )

    expect(screen.getByTestId('browser-takeover-card')).toHaveTextContent('Confirm payment in checkout')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Done, continue' }))
      await Promise.resolve()
    })
    expect(resumeSpy).toHaveBeenCalledWith('s1', 'tk-1')
    expect(sendUserAction).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      await Promise.resolve()
    })
    expect(abortSpy).toHaveBeenCalledWith('s1', 'tk-1', 'user_cancelled')
    expect(sendUserAction).not.toHaveBeenCalled()
  })

  it('renders inline 1-click BrowserUseEnableCard and handles confirm success and error', async () => {
    useUIStore.setState({ toasts: [] })
    const updateSpy = vi.spyOn(useBrowserUseStore.getState(), 'updateConfig')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        enabled: true,
        preferredTarget: 'auto',
        showCursorOverlay: true,
        autoOpenWorkspacePanel: true,
        managedChromeHeadless: false,
      })

    render(<BrowserUseEnableCard />)

    expect(screen.getByTestId('browser-use-enable-card')).toHaveTextContent('Browser Use is currently off')
    fireEvent.click(screen.getByRole('button', { name: 'Enable Browser Use' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Enable Browser Use?')

    const confirmBtn = screen.getAllByRole('button', { name: 'Enable Browser Use' }).at(-1)!
    await act(async () => {
      fireEvent.click(confirmBtn)
      await Promise.resolve()
    })
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(useUIStore.getState().toasts.at(-1)?.type).toBe('error')
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(confirmBtn)
      await Promise.resolve()
    })
    expect(updateSpy).toHaveBeenCalledTimes(2)
    expect(useUIStore.getState().toasts.at(-1)?.type).toBe('success')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('keeps a single stable View button for workspace runs without button swapping, and offers Take over only for live Chrome runs', () => {
    const sendUserAction = vi.fn().mockResolvedValue(undefined)
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      browserUse: {
        ...browserHost.browserUse,
        sendUserAction,
      },
    }
    useWorkspaceStore.setState({ bySession: {} })
    const tabId = useWorkspaceStore.getState().openTarget('s1', { kind: 'browser', url: 'https://example.com' })!
    const browserTab = useWorkspaceStore.getState().getTab('s1', tabId)
    const browserTabId = browserTab?.kind === 'browser' ? browserTab.browserTabId : 'tab-1'
    useWorkspaceStore.getState().setLayout('s1', 'hidden')

    useBrowserUseStore.getState().applyActivityEvent('s1', {
      id: 'ev-run',
      timestamp: 1000,
      sessionId: 's1',
      tabId: browserTabId,
      target: 'workspace',
      kind: 'act',
      humanLabel: 'Click submit',
      status: 'running',
      screenshotDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    })
    const calls: ToolCall[] = [
      makeCall({ id: 'c1', toolUseId: 'tu-1', toolName: 'BrowserAct', input: { steps: [{ action: 'click', label: 'Submit' }] } }),
    ]
    const { rerender } = render(
      <BrowserActivityCard sessionId="s1" toolCalls={calls} resultMap={new Map()} isStreaming isLive />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    expect(useWorkspaceStore.getState().getSession('s1').layout).toBe('split')
    // Workspace runs keep a single steady View button (takeover lives on the browser overlay pill).
    expect(screen.queryByRole('button', { name: 'Take over' })).not.toBeInTheDocument()

    // While isLive is true, a thinking gap after tool_result arrives keeps the card calmly active
    // instead of flipping back to the settled summary or flashing a recovered error.
    const settledMap = new Map<string, ToolResult>([
      ['tu-1', { id: 'r1', type: 'tool_result', toolUseId: 'tu-1', content: 'ok', isError: false, timestamp: 1100 }],
    ])
    rerender(<BrowserActivityCard sessionId="s1" toolCalls={calls} resultMap={settledMap} isLive />)
    expect(screen.getByTestId('browser-activity-card')).toHaveTextContent('Submit')
    expect(screen.queryByRole('button', { name: 'Take over' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Preview browser screenshot' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // System Chrome live runs expose Take over directly since there is no Workspace tab to View.
    useBrowserUseStore.getState().applyActivityEvent('s1', {
      id: 'ev-chrome',
      timestamp: 1200,
      sessionId: 's1',
      tabId: 'chrome-tab-1',
      target: 'chrome',
      kind: 'act',
      humanLabel: 'Click login',
      status: 'running',
    })
    rerender(<BrowserActivityCard sessionId="s1" toolCalls={calls} resultMap={new Map()} isStreaming isLive />)
    expect(screen.queryByRole('button', { name: 'View' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }))
    expect(sendUserAction).toHaveBeenCalledWith({
      tabId: 'chrome-tab-1',
      action: 'takeover',
      reason: 'user_requested',
    })
  })

  it('does not show a red error icon on intermediate self-recovered steps when the final browser step succeeded', () => {
    const calls: ToolCall[] = [
      makeCall({ id: 'c1', toolUseId: 'tu-1', toolName: 'BrowserAct', input: { steps: [{ action: 'click', label: 'Retry' }] } }),
      makeCall({ id: 'c2', toolUseId: 'tu-2', toolName: 'BrowserSnapshot', input: {} }),
    ]
    const results = new Map<string, ToolResult>([
      ['tu-1', { id: 'r1', type: 'tool_result', toolUseId: 'tu-1', content: 'stale ref', isError: true, timestamp: 1100 }],
      ['tu-2', { id: 'r2', type: 'tool_result', toolUseId: 'tu-2', content: 'ok', isError: false, timestamp: 1200 }],
    ])
    const { container } = render(<BrowserActivityCard sessionId="s1" toolCalls={calls} resultMap={results} />)
    expect(container.querySelector('.lucide-circle-x')).toBeNull()
  })

  it('extracts screenshots from structured image blocks and data URLs, and renders EnableCard on disabled error', () => {
    const calls: ToolCall[] = [
      makeCall({ id: 'c1', toolUseId: 'tu-img', toolName: 'BrowserSnapshot', input: { screenshot: true } }),
      makeCall({ id: 'c2', toolUseId: 'tu-err', toolName: 'BrowserNavigate', input: { url: 'https://a.test' } }),
    ]
    const results = new Map<string, ToolResult>([
      [
        'tu-img',
        {
          id: 'r1',
          type: 'tool_result',
          toolUseId: 'tu-img',
          content: [
            { type: 'text', text: 'snapshot ok' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
          ],
          isError: false,
          timestamp: 1100,
        },
      ],
      [
        'tu-err',
        {
          id: 'r2',
          type: 'tool_result',
          toolUseId: 'tu-err',
          content: { error: 'browser_use_disabled' },
          isError: true,
          timestamp: 1200,
        },
      ],
    ])
    render(<BrowserActivityCard sessionId="s1" toolCalls={calls} resultMap={results} />)

    expect(screen.getByAltText('Browser screenshot')).toHaveAttribute('src', 'data:image/png;base64,iVBORw0KGgo=')
    expect(screen.getByTestId('browser-use-enable-card')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Browser actions/i }))
    expect(screen.getByTestId('browser-activity-steps')).toBeInTheDocument()
  })

  it('falls back to IPC sendUserAction in BrowserTakeoverCard when sessionId is empty and supports View', async () => {
    const sendUserAction = vi.fn().mockResolvedValue(undefined)
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      browserUse: { ...browserHost.browserUse, sendUserAction },
    }
    useWorkspaceStore.setState({ bySession: {} })
    useWorkspaceStore.getState().openTarget('s-fallback', { kind: 'browser', url: 'https://a.test' })
    useWorkspaceStore.getState().setLayout('s-fallback', 'hidden')

    render(
      <BrowserTakeoverCard
        sessionId=""
        takeover={{
          takeoverId: 'tk-ipc',
          tabId: 'tab-x',
          target: 'workspace',
          reason: 'login',
          message: '',
          createdAt: 1000,
          status: 'pending',
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Done, continue' }))
      await Promise.resolve()
    })
    expect(sendUserAction).toHaveBeenCalledWith({ tabId: 'tab-x', action: 'resume' })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      await Promise.resolve()
    })
    expect(sendUserAction).toHaveBeenCalledWith({ tabId: 'tab-x', action: 'cancel' })
  })

  it('segments pure and mixed Browser Use tool calls inside ToolCallGroup', () => {
    const browserCall = makeCall({
      id: 'b1',
      toolUseId: 'tu-b1',
      toolName: 'BrowserNavigate',
      input: { url: 'https://example.com' },
    })
    const readCall = makeCall({
      id: 'r1',
      toolUseId: 'tu-r1',
      toolName: 'Read',
      input: { file_path: 'README.md' },
    })
    const snapCall = makeCall({
      id: 'b2',
      toolUseId: 'tu-b2',
      toolName: 'BrowserSnapshot',
      input: {},
    })
    const resultMap = new Map<string, ToolResult>([
      ['tu-b1', { id: 'res-b1', type: 'tool_result', toolUseId: 'tu-b1', content: 'ok', isError: false, timestamp: 1100 }],
      ['tu-r1', { id: 'res-r1', type: 'tool_result', toolUseId: 'tu-r1', content: 'hello', isError: false, timestamp: 1150 }],
      ['tu-b2', { id: 'res-b2', type: 'tool_result', toolUseId: 'tu-b2', content: 'tree', isError: false, timestamp: 1200 }],
    ])

    // Pure browser group
    const { rerender } = render(
      <ToolCallGroup
        sessionId="s1"
        toolCalls={[browserCall, snapCall]}
        resultMap={resultMap}
        childToolCallsByParent={new Map()}
        agentTaskNotifications={{}}
      />,
    )
    expect(screen.getAllByTestId('browser-activity-card')).toHaveLength(1)

    // Mixed regular + browser + regular segmentation
    rerender(
      <ToolCallGroup
        sessionId="s1"
        toolCalls={[readCall, browserCall, snapCall]}
        resultMap={resultMap}
        childToolCallsByParent={new Map()}
        agentTaskNotifications={{}}
      />,
    )
    expect(screen.getAllByTestId('browser-activity-card')).toHaveLength(1)
    expect(screen.getByTestId('activity-group')).toBeInTheDocument()
  })

  it('uses borderless codex-work-row disclosure, shimmer while live, disclosureKey persistence, and suppresses ghost spinners', () => {
    const calls: ToolCall[] = [
      makeCall({ id: 'c1', toolUseId: 'tu-1', toolName: 'BrowserNavigate', input: { url: 'https://example.com' } }),
    ]

    // Unresolved call in a non-live, non-streaming historical transcript must not spin.
    const { rerender, unmount } = render(
      <BrowserActivityCard
        sessionId="s1"
        toolCalls={calls}
        resultMap={new Map()}
        disclosureKey="turn-1:browser"
      />,
    )
    const card = screen.getByTestId('browser-activity-card')
    expect(card).toHaveAttribute('data-running', 'false')
    expect(card.className).not.toContain('border')
    expect(card.querySelector('.codex-shimmer-text')).toBeNull()
    const disclosure = card.querySelector('[data-chat-disclosure="true"]')!
    expect(disclosure.className).toContain('codex-work-row')
    expect(disclosure.className).toContain('rounded-[var(--radius-sm)]')

    // Target badge is non-pill.
    const badge = screen.getByText('Workspace')
    expect(badge.className).toContain('rounded-[var(--radius-sm)]')
    expect(badge.className).not.toContain('rounded-full')

    // Live turn activates shimmer running state even when isStreaming is false.
    rerender(
      <BrowserActivityCard
        sessionId="s1"
        toolCalls={calls}
        resultMap={new Map()}
        isLive
        disclosureKey="turn-1:browser"
      />,
    )
    expect(screen.getByTestId('browser-activity-card')).toHaveAttribute('data-running', 'true')
    expect(screen.getByTestId('browser-activity-card').querySelector('.codex-shimmer-text')).not.toBeNull()

    // Expand and verify disclosureKey persists across unmount/remount, and can still collapse after remount.
    fireEvent.click(screen.getByTestId('browser-activity-card').querySelector('[data-chat-disclosure="true"]')!)
    expect(screen.getByTestId('browser-activity-steps')).toBeInTheDocument()
    unmount()

    render(
      <BrowserActivityCard
        sessionId="s1"
        toolCalls={calls}
        resultMap={new Map()}
        disclosureKey="turn-1:browser"
      />,
    )
    expect(screen.getByTestId('browser-activity-steps')).toBeInTheDocument()
    // Clicking disclosure after remount must collapse cleanly (no React bailout against module Map).
    const remountDisclosure = screen.getByTestId('browser-activity-card').querySelector('[data-chat-disclosure="true"]')!
    expect(remountDisclosure).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(remountDisclosure)
    expect(screen.queryByTestId('browser-activity-steps')).not.toBeInTheDocument()
    expect(remountDisclosure).toHaveAttribute('aria-expanded', 'false')
    // Header icon on dead/interrupted transcript (unresolved call with !isLive && !isStreaming) uses CircleStop, not Globe.
    expect(remountDisclosure.querySelector('svg.lucide-circle-stop')).not.toBeNull()
    expect(remountDisclosure.querySelector('svg.lucide-globe')).toBeNull()
  })

  it('defaults unknown tool errors in a partial errorSeverityByToolUseId map to blocking', () => {
    const call = makeCall({
      id: 'b-partial',
      toolUseId: 'tu-partial-err',
      toolName: 'BrowserNavigate',
      input: { url: 'https://partial.example.com' },
    })
    const resultMap = new Map<string, ToolResult>([
      ['tu-partial-err', { id: 'res-partial', type: 'tool_result', toolUseId: 'tu-partial-err', content: 'boom', isError: true, timestamp: 1200 }],
    ])

    render(
      <BrowserActivityCard
        sessionId="s1"
        toolCalls={[call]}
        resultMap={resultMap}
        errorSeverityByToolUseId={new Map()}
      />,
    )
    expect(screen.getByTestId('browser-activity-card').innerHTML).toContain('text-[var(--color-error)]')
  })

  it('keeps recovered errors neutral monochrome and surfaces red only for blocking errors, including across mixed ToolCallGroup splits', () => {
    const readCall = makeCall({
      id: 'r1',
      toolUseId: 'tu-read-err',
      toolName: 'Read',
      input: { file_path: 'missing.ts' },
    })
    const browserErrCall = makeCall({
      id: 'b1',
      toolUseId: 'tu-b-err',
      toolName: 'BrowserNavigate',
      input: { url: 'https://retry.example.com' },
    })
    const browserOkCall = makeCall({
      id: 'b2',
      toolUseId: 'tu-b-ok',
      toolName: 'BrowserSnapshot',
      input: {},
    })
    const resultMap = new Map<string, ToolResult>([
      ['tu-read-err', { id: 'res-r1', type: 'tool_result', toolUseId: 'tu-read-err', content: 'ENOENT', isError: true, timestamp: 1100 }],
      ['tu-b-err', { id: 'res-b1', type: 'tool_result', toolUseId: 'tu-b-err', content: 'timeout', isError: true, timestamp: 1200 }],
      ['tu-b-ok', { id: 'res-b2', type: 'tool_result', toolUseId: 'tu-b-ok', content: 'ok', isError: false, timestamp: 1300 }],
    ])
    const recoveredMap = new Map([
      ['tu-read-err', 'recovered' as const],
      ['tu-b-err', 'recovered' as const],
    ])

    const { rerender } = render(
      <ToolCallGroup
        sessionId="s1"
        toolCalls={[readCall, browserErrCall, browserOkCall]}
        resultMap={resultMap}
        childToolCallsByParent={new Map()}
        errorSeverityByToolUseId={recoveredMap}
        agentTaskNotifications={{}}
      />,
    )

    // Both regular ActivityGroup and BrowserActivityCard stay calm monochrome on recovered errors.
    expect(screen.getByTestId('activity-group')).not.toHaveTextContent(/failed/i)
    const browserCard = screen.getByTestId('browser-activity-card')
    expect(browserCard.innerHTML).not.toContain('text-[var(--color-error)]')

    // Expand steps: neither recovered error nor completed step uses loud red or green.
    fireEvent.click(browserCard.querySelector('[data-chat-disclosure="true"]')!)
    const stepsList = screen.getByTestId('browser-activity-steps')
    expect(stepsList.innerHTML).not.toContain('text-[var(--color-error)]')
    expect(stepsList.innerHTML).not.toContain('text-[var(--color-success)]')

    // Flip browser error to blocking -> red indicator appears on header and step.
    const blockingMap = new Map([
      ['tu-read-err', 'recovered' as const],
      ['tu-b-err', 'blocking' as const],
    ])
    rerender(
      <ToolCallGroup
        sessionId="s1"
        toolCalls={[readCall, browserErrCall, browserOkCall]}
        resultMap={resultMap}
        childToolCallsByParent={new Map()}
        errorSeverityByToolUseId={blockingMap}
        agentTaskNotifications={{}}
      />,
    )
    expect(screen.getByTestId('browser-activity-card').innerHTML).toContain('text-[var(--color-error)]')
    expect(screen.getByTestId('browser-activity-steps').innerHTML).toContain('text-[var(--color-error)]')
  })

  it('forwards isLive through mixed ToolCallGroup splits to both regular ActivityGroup and BrowserActivityCard', () => {
    const readCall = makeCall({
      id: 'r-live',
      toolUseId: 'tu-read-live',
      toolName: 'Read',
      input: { file_path: 'app.ts' },
    })
    const browserCall = makeCall({
      id: 'b-live',
      toolUseId: 'tu-b-live',
      toolName: 'BrowserNavigate',
      input: { url: 'https://live.example.com' },
    })

    render(
      <ToolCallGroup
        sessionId="s1"
        toolCalls={[readCall, browserCall]}
        resultMap={new Map()}
        childToolCallsByParent={new Map()}
        agentTaskNotifications={{}}
        isLive
      />,
    )

    expect(screen.getByTestId('activity-group').querySelector('.codex-shimmer-text')).not.toBeNull()
    expect(screen.getByTestId('browser-activity-card')).toHaveAttribute('data-running', 'true')
    expect(screen.getByTestId('browser-activity-card').querySelector('.codex-shimmer-text')).not.toBeNull()
  })

  it('styles BrowserTakeoverCard and BrowserUseEnableCard with V6C frosted glass tokens', () => {
    render(
      <>
        <BrowserTakeoverCard
          sessionId="s1"
          takeover={{
            takeoverId: 'tk-glass',
            tabId: 'tab-1',
            target: 'workspace',
            reason: 'login',
            message: 'Sign in',
            createdAt: 1000,
            status: 'pending',
          }}
        />
        <BrowserUseEnableCard />
      </>,
    )

    const takeover = screen.getByTestId('browser-takeover-card')
    expect(takeover.className).toContain('v6c-glass-card')
    expect(takeover.className).toContain('v6c-ring-waiting')
    expect(takeover.className).not.toContain('bg-[var(--color-warning-container)]')
    expect(takeover.querySelector('[class*="bg-[var(--color-warning-container)]"]')).not.toBeNull()

    const enableCard = screen.getByTestId('browser-use-enable-card')
    expect(enableCard.className).toContain('v6c-glass-card')
  })
})
