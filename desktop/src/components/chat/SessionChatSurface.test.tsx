import { render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'
import { SessionChatHeader, SessionChatSurface } from './SessionChatSurface'

describe('SessionChatSurface', () => {
  it('keeps every conversation on the main session column measure', () => {
    render(
      <SessionChatSurface
        surfaceKind="agent"
        agentRunKind="subagent"
        isMobileLayout={false}
        activityRailOpen
        activityRail={<aside>Activity</aside>}
      >
        <SessionChatHeader
          title="Child run"
          metadata={[
            { key: 'status', content: <span>Running</span> },
            { key: 'messages', content: <span>3 messages</span> },
          ]}
        />
        <main>Transcript</main>
      </SessionChatSurface>,
    )

    const surface = screen.getByTestId('session-chat-surface')
    expect(surface).toHaveAttribute('data-session-chat-kind', 'agent')
    expect(surface).toHaveAttribute('data-agent-run-kind', 'subagent')
    expect(screen.getByTestId('session-chat-column')).toHaveClass('min-w-[360px]', 'pr-[352px]')
    expect(screen.getByText('Activity')).toBeInTheDocument()

    const header = screen.getByTestId('session-header')
    expect(header.firstElementChild).toHaveClass('max-w-[var(--chat-content-max-width)]')
    expect(within(header).getByRole('heading', { name: 'Child run' })).toHaveClass('truncate')
    expect(header.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1)
  })

  it('uses the same compact chat column contract when a side panel is present', () => {
    render(
      <SessionChatSurface
        surfaceKind="main"
        isMobileLayout={false}
        compact
        sidePanel={<aside>Workbench</aside>}
      >
        <div>Conversation</div>
      </SessionChatSurface>,
    )

    expect(screen.getByTestId('session-chat-column')).toHaveClass(
      'min-w-[400px]',
      'bg-[var(--color-surface)]',
    )
    expect(screen.getByText('Workbench')).toBeInTheDocument()
  })
})
