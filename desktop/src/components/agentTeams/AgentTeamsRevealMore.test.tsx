import { fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTeamsRevealMore } from '@/components/agentTeams/AgentTeamsRevealMore'
import type { useProgressiveReveal } from '@/components/agentTeams/useProgressiveReveal'
import { useSettingsStore } from '@/stores/settingsStore'

function reveal(overrides: Partial<ReturnType<typeof useProgressiveReveal>>): ReturnType<typeof useProgressiveReveal> {
  return {
    limit: 40,
    hasMore: true,
    showMore: vi.fn(),
    revealThrough: vi.fn(),
    canAutoReveal: false,
    scrollRootRef: createRef<HTMLDivElement>(),
    sentinelRef: createRef<HTMLDivElement>(),
    ...overrides,
  }
}

describe('AgentTeamsRevealMore', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('renders nothing once every row is mounted', () => {
    const { container } = render(<AgentTeamsRevealMore reveal={reveal({ hasMore: false })} remaining={0} />)
    expect(container.childElementCount).toBe(0)
  })

  it('leaves an invisible sentinel for the scroll observer instead of a button', () => {
    const state = reveal({ canAutoReveal: true })
    render(<AgentTeamsRevealMore reveal={state} remaining={12} />)

    const sentinel = screen.getByTestId('agent-teams-reveal-sentinel')
    expect(sentinel.getAttribute('aria-hidden')).toBe('true')
    expect(state.sentinelRef.current).toBe(sentinel)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers a button naming what is left where no observer exists', () => {
    const state = reveal({ canAutoReveal: false })
    render(<AgentTeamsRevealMore reveal={state} remaining={12} />)

    fireEvent.click(screen.getByRole('button', { name: 'Show earlier messages (12 more)' }))
    expect(state.showMore).toHaveBeenCalledOnce()
  })
})
