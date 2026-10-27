import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { buildVirtualItemOffsets, MessageList } from '@/components/chat/MessageList'
import { dropSession, getHeightsForSession } from '@/components/chat/virtualHeightCache'
import { createDefaultSessionState, mapHistoryMessagesToUiMessages, useChatStore } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useTeamStore } from '@/stores/teamStore'
import { useTabStore } from '@/stores/tabStore'
import { sessionsApi } from '@/api/sessions'
import type { MessageEntry } from '@/types/session'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

beforeEach(() => {
  vi.spyOn(sessionsApi, 'getTurnCheckpoints').mockImplementation(() => new Promise(() => {}))
  vi.spyOn(sessionsApi, 'getWorkspaceStatus').mockImplementation(() => new Promise(() => {}))
  useSettingsStore.setState({ locale: 'en' })
  useSessionStore.setState({ sessions: [], activeSessionId: null })
  useTeamStore.getState().clearTeam()
  useTabStore.setState({ activeTabId: 'old', tabs: [{ sessionId: 'old', title: 'Old', type: 'session', status: 'idle' }] })
})

function RetainedChat({ sessionId, draftVisible = false }: { sessionId: string; draftVisible?: boolean }) {
  // ContentRouter retains the previous chat while the new-chat draft is open.
  // The first send changes this same MessageList instance to the new session.
  return (
    <>
      <div hidden={draftVisible}><MessageList sessionId={sessionId} /></div>
      {draftVisible && <div data-testid="new-session-draft">New chat</div>}
    </>
  )
}

it('does not retain replayed API errors when the first message opens a new chat', () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  const error = "API Error: 429 You've reached your 5-hour usage limit. https://www.kimi.com/membership/subscription?tab=quota"
  const history: MessageEntry[] = ['error-a', 'error-b', 'error-a', 'error-b'].map((id, index) => ({
    id, type: 'assistant', timestamp: new Date(index * 1000).toISOString(), model: '<synthetic>',
    content: [{ type: 'text', text: error }],
  }))
  const oldMessages = mapHistoryMessagesToUiMessages(history)
  useChatStore.setState({ sessions: {
    old: { ...createDefaultSessionState(), messages: oldMessages },
    fresh: { ...createDefaultSessionState(), messages: [{ id: 'fresh-user', type: 'user_text', content: 'First fresh prompt', timestamp: 10000 }] },
  } })
  const view = render(<RetainedChat sessionId="old" />)
  expect(screen.getAllByText(/API Error: 429/)).toHaveLength(2)
  act(() => { view.rerender(<RetainedChat sessionId="old" draftVisible />) })
  expect(screen.getByTestId('new-session-draft')).toBeTruthy()
  expect(screen.getAllByText(/API Error: 429/)[0]!.closest('[hidden]')).toBeTruthy()
  act(() => { view.rerender(<RetainedChat sessionId="fresh" />) })
  expect(screen.getByText('First fresh prompt')).toBeTruthy()
  expect(useChatStore.getState().sessions.fresh!.messages).toHaveLength(1)
  expect(screen.queryAllByText(/API Error: 429/)).toHaveLength(0)
  expect(consoleError.mock.calls.filter(args => args.some(arg => String(arg).includes('same key')))).toHaveLength(0)
})

it('keeps distinct parent projections without orphaning their shared record IDs in another chat', () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  const history: MessageEntry[] = ['parent-a', 'parent-b'].map(parentToolUseId => ({
    id: 'shared-reply', type: 'assistant', timestamp: '2026-10-25T00:00:00.000Z', parentToolUseId,
    content: [{ type: 'text', text: `Reply under ${parentToolUseId}` }],
  }))
  const oldMessages = mapHistoryMessagesToUiMessages(history)
  useChatStore.setState({ sessions: {
    old: { ...createDefaultSessionState(), messages: oldMessages },
    fresh: { ...createDefaultSessionState(), messages: [{ id: 'fresh-user', type: 'user_text', content: 'Different task', timestamp: 10000 }] },
  } })
  const view = render(<RetainedChat sessionId="old" />)
  expect(screen.getByText('Reply under parent-a')).toBeTruthy()
  expect(screen.getByText('Reply under parent-b')).toBeTruthy()
  act(() => { view.rerender(<RetainedChat sessionId="fresh" />) })

  expect(screen.getByText('Different task')).toBeTruthy()
  expect(screen.queryAllByText(/Reply under parent-/)).toHaveLength(0)
  expect(useChatStore.getState().sessions.old!.messages).toBe(oldMessages)
  expect(consoleError.mock.calls.filter(args => args.some(arg => String(arg).includes('same key')))).toHaveLength(0)
})

it('measures different-height projections independently in a long virtual transcript', () => {
  const sessionId = 'projection-measurements'
  dropSession(sessionId)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const height = !this.hasAttribute('data-virtual-message-item') ? 0
      : this.textContent?.includes('Short projection') ? 60
      : this.textContent?.includes('Tall projection') ? 280 : 100
    return { top: 0, bottom: height, width: 800, height } as DOMRect
  })
  const history: MessageEntry[] = [
    ...Array.from({ length: 220 }, (_, index): MessageEntry => ({
      id: `history-${index}`, type: 'assistant', timestamp: '2026-10-25T00:00:00.000Z', content: `Line ${index}`,
    })),
    ...['Short', 'Tall'].map((label): MessageEntry => ({
      id: 'same-record', type: 'assistant', timestamp: '2026-10-25T00:00:00.000Z', parentToolUseId: label,
      content: [{ type: 'text', text: `${label} projection` }],
    })),
  ]
  useChatStore.setState({ sessions: {
    [sessionId]: { ...createDefaultSessionState(), messages: mapHistoryMessagesToUiMessages(history) },
  } })
  render(<MessageList sessionId={sessionId} />)
  const rows = ['Short', 'Tall'].map(label => screen.getByText(`${label} projection`).closest<HTMLElement>('[data-virtual-message-item]')!)
  const keys = rows.map(row => row.dataset.virtualMeasurementKey ?? row.dataset.virtualMessageItem!)
  const heights = getHeightsForSession(sessionId)

  expect(heights.get(keys[0]!)).toBe(60)
  expect(heights.get(keys[1]!)).toBe(280)
  expect(keys[0]).not.toBe(keys[1])
  expect(rows.map(row => row.dataset.chatRenderItemKey)).toEqual(['same-record-block-0', 'same-record-block-0'])
  expect(buildVirtualItemOffsets(keys, [], heights)).toEqual([0, 60, 340])
  dropSession(sessionId)
})
