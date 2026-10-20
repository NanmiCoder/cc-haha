import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TeamWorkbenchSnapshot } from '@/types/team'
import { AgentTeamsInlineCard, AgentTeamsStrip } from './AgentTeamsSummary'

const snapshot: TeamWorkbenchSnapshot = {
  version: '1', generatedAt: '2026-10-19T00:00:00Z',
  team: {
    name: 'repository-audit-'.repeat(20), leadAgentId: 'lead', leadSessionId: 'session',
    members: Array.from({ length: 8 }, (_, index) => ({ agentId: `member-${index}`, name: `Reviewer ${index}`, role: 'reviewer', status: 'running' as const })),
  },
  tasks: [], messages: [],
}

describe('Agent Teams conversation summaries', () => {
  it('lets header metadata wrap inside a narrow conversation pane', () => {
    const onOpen = vi.fn()
    render(<AgentTeamsStrip snapshot={snapshot} onOpen={onOpen} compact />)
    const strip = screen.getByTestId('agent-teams-strip')
    // A wide desktop viewport can still contain a narrow split pane.
    expect(strip).toHaveClass('min-w-0', 'max-w-full', 'flex-wrap')
    fireEvent.click(strip)
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('keeps long inline names and large rosters within the transcript bounds', () => {
    const onOpen = vi.fn()
    render(<AgentTeamsInlineCard snapshot={snapshot} teamName={snapshot.team.name} onOpen={onOpen} />)
    const card = screen.getByTestId('agent-teams-inline-card')
    expect(card).toHaveClass('min-w-0', 'max-w-full', 'flex-wrap')
    expect(screen.getByText(snapshot.team.name)).toHaveClass('truncate')
    expect(screen.getByText('+3')).toBeInTheDocument()
    expect(card.parentElement).toHaveClass('min-w-0', 'max-w-full')
    expect(card.parentElement).not.toHaveClass('px-1')
    fireEvent.click(card)
    expect(onOpen).toHaveBeenCalledOnce()
  })
})
