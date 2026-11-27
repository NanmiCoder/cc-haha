import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { browserHost } from '@/lib/desktopHost/browserHost'
import { useBrowserUseStore } from '@/stores/browserUseStore'
import { useSettingsStore } from '@/stores/settingsStore'
import type { UIMessage } from '@/types/chat'
import {
  BrowserActivityCard,
  BrowserTakeoverCard,
  BrowserUseEnableCard,
  SessionBrowserTakeoverBanner,
} from './BrowserActivityCard'
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

  it('renders inline 1-click BrowserUseEnableCard and opens confirmation dialog', () => {
    render(<BrowserUseEnableCard />)

    expect(screen.getByTestId('browser-use-enable-card')).toHaveTextContent('Browser Use is currently off')
    fireEvent.click(screen.getByRole('button', { name: 'Enable Browser Use' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Enable Browser Use?')
  })
})
