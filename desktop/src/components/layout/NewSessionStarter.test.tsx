import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { NewSessionStarter, pickRecentSessions } from './NewSessionStarter'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import type { SessionListItem } from '../../types/session'

const NOW = Date.now()

function session(
  id: string,
  overrides: Partial<SessionListItem> & { minutesAgo?: number } = {},
): SessionListItem {
  const { minutesAgo = 10, ...rest } = overrides
  const at = new Date(NOW - minutesAgo * 60_000).toISOString()
  return {
    id,
    title: id,
    createdAt: at,
    modifiedAt: at,
    messageCount: 3,
    projectPath: '/workspace/alpha',
    projectRoot: '/workspace/alpha',
    workDir: '/workspace/alpha',
    workDirExists: true,
    ...rest,
  }
}

describe('pickRecentSessions', () => {
  it('keeps the project’s threads with content, newest first, three at most', () => {
    const picked = pickRecentSessions([
      session('a', { minutesAgo: 30 }),
      session('b', { minutesAgo: 5 }),
      session('c', { minutesAgo: 60 }),
      session('d', { minutesAgo: 1 }),
      session('blank', { minutesAgo: 0, messageCount: 0 }),
      session('other', { minutesAgo: 0, projectRoot: '/workspace/beta', workDir: '/workspace/beta' }),
    ], '/workspace/alpha', null)

    expect(picked.map((item) => item.id)).toEqual(['d', 'b', 'a'])
  })

  it('leaves out the draft on screen', () => {
    const picked = pickRecentSessions([session('draft', { minutesAgo: 0 }), session('kept')], '/workspace/alpha', 'draft')

    expect(picked.map((item) => item.id)).toEqual(['kept'])
  })

  it('matches a temp-dir project whichever /private spelling either side uses', () => {
    const picked = pickRecentSessions([
      session('tmp', { projectRoot: '/private/var/folders/x/T/proj', workDir: '/var/folders/x/T/proj' }),
    ], '/var/folders/x/T/proj', null)

    expect(picked.map((item) => item.id)).toEqual(['tmp'])
  })

  it('lists recent threads from any project when no project is chosen yet', () => {
    const picked = pickRecentSessions([
      session('a', { minutesAgo: 2 }),
      session('b', { minutesAgo: 1, projectRoot: '/workspace/beta', workDir: '/workspace/beta' }),
    ], null, null)

    expect(picked.map((item) => item.id)).toEqual(['b', 'a'])
  })
})

describe('NewSessionStarter', () => {
  const openHistoricalSession = vi.fn()
  const connectToSession = vi.fn()

  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useSessionStore.setState({
      sessions: [session('Fix login', { minutesAgo: 3 }), session('Write docs', { minutesAgo: 90 })],
      openHistoricalSession,
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
    useChatStore.setState({ connectToSession } as Partial<ReturnType<typeof useChatStore.getState>>)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('hands a starter’s words to the caller, which owns the draft', () => {
    const onSuggestion = vi.fn()
    render(<NewSessionStarter projectPath="/workspace/alpha" onSuggestion={onSuggestion} />)

    const group = screen.getByRole('group', { name: 'Suggestions' })
    const chips = within(group).getAllByRole('button')
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'Explain how this repo is structured',
      'Fix the failing tests',
      'Review my uncommitted changes',
      'Build a new feature',
    ])

    fireEvent.click(chips[2]!)
    expect(onSuggestion).toHaveBeenCalledWith('Review my uncommitted changes')
  })

  it('reopens a recent thread the way the sidebar does', () => {
    render(<NewSessionStarter projectPath="/workspace/alpha" projectLabel="alpha" onSuggestion={vi.fn()} />)

    const recent = screen.getByRole('region', { name: 'Recent sessions' })
    expect(within(recent).getByText('alpha')).toBeInTheDocument()

    fireEvent.click(within(recent).getByRole('button', { name: /Fix login/ }))
    expect(openHistoricalSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'Fix login' }))
    expect(connectToSession).toHaveBeenCalledWith('Fix login')
  })

  it('shows no recent section when the project has nothing to return to', () => {
    render(<NewSessionStarter projectPath="/workspace/empty" onSuggestion={vi.fn()} />)

    expect(screen.queryByRole('region')).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Suggestions' })).toBeInTheDocument()
  })
})
