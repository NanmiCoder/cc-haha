import '@testing-library/jest-dom'
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const viewport = vi.hoisted(() => ({ mobile: true }))

vi.mock('../../hooks/useMobileViewport', () => ({ useMobileViewport: () => viewport.mobile }))
vi.mock('../../lib/desktopRuntime', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isDesktopRuntime: () => false,
}))

import { useSettingsStore } from '../../stores/settingsStore'
import { AssistantMessage } from './AssistantMessage'

const COMPLETION = {
  completedAt: new Date('2026-10-06T14:35:00').getTime(),
  durationMs: 42_000,
}

describe('AssistantMessage turn completion visibility', () => {
  beforeEach(() => {
    viewport.mobile = true
    useSettingsStore.setState({ locale: 'en' })
  })

  it('renders the turn completion stamp visibly on touch layouts without hover-only actions', () => {
    render(
      <AssistantMessage
        content="All checks passed."
        turnCompletion={COMPLETION}
        branchAction={{ label: 'Branch from here', onBranch: vi.fn() }}
      />,
    )

    const shell = document.querySelector<HTMLElement>('[data-message-shell="assistant"]')!
    const footer = shell.querySelector<HTMLElement>('[data-message-actions]')!
    expect(footer).not.toBeNull()
    expect(footer.className).not.toContain('opacity-0')
    expect(footer.className).not.toContain('pointer-events-none')

    const stamp = footer.querySelector('[data-turn-completion]')
    expect(stamp).not.toBeNull()
    expect(stamp).toHaveTextContent('42s')
    // Touch replaces hover buttons with the long-press action sheet.
    expect(within(footer).queryByRole('button', { name: 'Copy reply' })).not.toBeInTheDocument()
    expect(within(footer).queryByRole('button', { name: 'Branch from here' })).not.toBeInTheDocument()
  })

  it('keeps the closing footer hover-gated on desktop pointers', () => {
    viewport.mobile = false
    render(
      <AssistantMessage
        content="All checks passed."
        turnCompletion={COMPLETION}
        branchAction={{ label: 'Branch from here', onBranch: vi.fn() }}
      />,
    )

    const shell = document.querySelector<HTMLElement>('[data-message-shell="assistant"]')!
    const footer = shell.querySelector<HTMLElement>('[data-message-actions]')!
    expect(footer.className).toContain('opacity-0')
    expect(footer.className).toContain('group-hover:opacity-100')
    expect(within(footer).getByRole('button', { name: 'Copy reply' })).toBeInTheDocument()
    expect(footer.querySelector('[data-turn-completion]')).not.toBeNull()
    expect(screen.getByText('All checks passed.')).toBeInTheDocument()
  })
})
