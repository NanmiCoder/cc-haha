import { act, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const viewport = vi.hoisted(() => ({ mobile: true }))
const clipboard = vi.hoisted(() => ({ copy: vi.fn(async () => true) }))

vi.mock('../../hooks/useMobileViewport', () => ({ useMobileViewport: () => viewport.mobile }))
vi.mock('../../lib/clipboard', () => ({ copyTextToClipboard: clipboard.copy }))

import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { LONG_PRESS_DELAY_MS } from '../../hooks/useLongPress'
import { UserMessage } from './UserMessage'

class TestPointerEvent extends MouseEvent {
  pointerType: string
  isPrimary: boolean
  constructor(type: string, init: MouseEventInit & { pointerType?: string; isPrimary?: boolean } = {}) {
    super(type, init)
    this.pointerType = init.pointerType ?? 'touch'
    this.isPrimary = init.isPrimary ?? true
  }
}

const TIMESTAMP = new Date('2026-10-06T14:35:00').getTime()

function hold(element: HTMLElement) {
  vi.useFakeTimers()
  fireEvent.pointerDown(element, { pointerType: 'touch', isPrimary: true, clientX: 4, clientY: 4 })
  act(() => { vi.advanceTimersByTime(LONG_PRESS_DELAY_MS) })
  fireEvent.pointerUp(element)
  vi.useRealTimers()
}

function renderPrompt(overrides: Partial<Parameters<typeof UserMessage>[0]> = {}) {
  const onBranch = vi.fn()
  const onStart = vi.fn()
  render(
    <UserMessage
      content="把登录页错误提示改成 i18n"
      timestamp={TIMESTAMP}
      branchAction={{ label: 'Branch from here', onBranch }}
      editAction={{
        label: 'Edit and resend',
        editing: false,
        submitting: false,
        disabled: false,
        getDraft: () => ({ text: '', attachments: [] }) as never,
        onStart,
        onCancel: vi.fn(),
        onDraftChange: vi.fn(),
        onSubmit: vi.fn(),
      }}
      {...overrides}
    />,
  )
  const shell = document.querySelector<HTMLElement>('[data-message-shell="user"]')!
  return { shell, onBranch, onStart }
}

describe('message actions on a phone', () => {
  beforeAll(() => {
    if (!('PointerEvent' in window)) {
      Object.defineProperty(window, 'PointerEvent', { configurable: true, value: TestPointerEvent })
    }
  })

  beforeEach(() => {
    viewport.mobile = true
    clipboard.copy.mockClear()
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ toasts: [] })
  })

  it('has no row of icons under the message; holding it opens the actions with the exact time', () => {
    const { shell } = renderPrompt()
    expect(shell.querySelector('[data-message-actions]')).toBeNull()
    expect(shell).toHaveClass('select-none')

    hold(shell)

    const sheet = screen.getByTestId('message-action-sheet')
    expect(sheet).toHaveTextContent('02:35')
    expect(within(sheet).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Copy', 'Select text', 'Edit and resend', 'Branch from here',
    ])
  })

  it('copies the prompt and says so', async () => {
    const { shell } = renderPrompt()
    hold(shell)

    await act(async () => {
      fireEvent.click(within(screen.getByTestId('message-action-sheet')).getByRole('menuitem', { name: 'Copy' }))
    })

    expect(clipboard.copy).toHaveBeenCalledWith('把登录页错误提示改成 i18n')
    expect(useUIStore.getState().toasts.at(-1)?.type).toBe('success')
    expect(screen.queryByTestId('message-action-sheet')).not.toBeInTheDocument()
  })

  it('opens the text where the browser can select it, since holding no longer does', () => {
    const { shell } = renderPrompt()
    hold(shell)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Select text' }))

    const text = screen.getByTestId('message-select-text')
    expect(text).toHaveTextContent('把登录页错误提示改成 i18n')
    expect(text).toHaveClass('select-text')
  })

  it('says why an edit cannot be made instead of hiding it', () => {
    const { shell, onStart } = renderPrompt({
      editAction: {
        label: 'Edit and resend',
        editing: false,
        submitting: false,
        disabled: true,
        disabledReason: 'Stop the current turn first',
        getDraft: () => ({ text: '', attachments: [] }) as never,
        onStart: vi.fn(),
        onCancel: vi.fn(),
        onDraftChange: vi.fn(),
        onSubmit: vi.fn(),
      },
    })
    hold(shell)

    const edit = screen.getByRole('menuitem', { name: /Edit and resend/ })
    expect(edit).toBeDisabled()
    expect(edit).toHaveTextContent('Stop the current turn first')
    expect(onStart).not.toHaveBeenCalled()
  })

  it('branches from the message', () => {
    const { shell, onBranch } = renderPrompt()
    hold(shell)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Branch from here' }))
    expect(onBranch).toHaveBeenCalledTimes(1)
  })

  it('keeps the hover bar on the desktop and does nothing on hold', () => {
    viewport.mobile = false
    const { shell } = renderPrompt()
    expect(shell.querySelector('[data-message-actions]')).not.toBeNull()
    hold(shell)
    expect(screen.queryByTestId('message-action-sheet')).not.toBeInTheDocument()
  })
})
