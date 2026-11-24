import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QueuedMessageList } from './QueuedMessageList'
import { createDefaultSessionState, useChatStore } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'

const SESSION_ID = 'session-queued-list'

function setQueue(content: string[]) {
  useChatStore.setState({
    sessions: {
      [SESSION_ID]: {
        ...createDefaultSessionState(),
        queuedUserMessages: content.map((text, index) => ({
          id: `q-${index}`,
          content: text,
          displayContent: text,
          createdAt: index,
        })),
      },
    },
  })
}

describe('QueuedMessageList', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    setQueue(['first', 'second'])
  })

  afterEach(() => {
    cleanup()
    useChatStore.setState({ sessions: {} })
  })

  it('keeps rows in send order and exposes one move control per direction per row', () => {
    render(
      <QueuedMessageList
        sessionId={SESSION_ID}
        messages={useChatStore.getState().sessions[SESSION_ID]!.queuedUserMessages!}
        guideDisabled={false}
      />,
    )

    const rows = screen.getAllByTestId('pending-user-message')
    expect(rows[0]).toHaveTextContent('first')
    expect(rows[1]).toHaveTextContent('second')
    expect(screen.getAllByRole('button', { name: /Move queued message up/i })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /Move queued message down/i })).toHaveLength(2)
  })

  it('moves a row with the buttons without sending it', () => {
    render(
      <QueuedMessageList
        sessionId={SESSION_ID}
        messages={useChatStore.getState().sessions[SESSION_ID]!.queuedUserMessages!}
        guideDisabled={false}
      />,
    )

    fireEvent.click(screen.getAllByRole('button', { name: /Move queued message down/i })[0]!)

    expect(useChatStore.getState().sessions[SESSION_ID]?.queuedUserMessages?.map((message) => message.content))
      .toEqual(['second', 'first'])
  })

  it('edits a queued prompt in place without sending or reordering', () => {
    render(
      <QueuedMessageList
        sessionId={SESSION_ID}
        messages={useChatStore.getState().sessions[SESSION_ID]!.queuedUserMessages!}
        guideDisabled={false}
      />,
    )

    fireEvent.click(screen.getAllByRole('button', { name: /Edit queued message/i })[1]!)
    fireEvent.change(screen.getByLabelText('Queued message text'), {
      target: { value: 'second, corrected' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(useChatStore.getState().sessions[SESSION_ID]?.queuedUserMessages?.map((message) => message.content))
      .toEqual(['first', 'second, corrected'])
  })

  it('shows why automatic sending paused', () => {
    render(
      <QueuedMessageList
        sessionId={SESSION_ID}
        messages={useChatStore.getState().sessions[SESSION_ID]!.queuedUserMessages!}
        pausedReason="The previous turn ended with an error, so queued messages are paused."
        guideDisabled={false}
      />,
    )

    expect(screen.getByText(/previous turn ended with an error/i)).toBeInTheDocument()
  })
})
