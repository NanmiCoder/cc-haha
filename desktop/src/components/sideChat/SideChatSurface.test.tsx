import { render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { SideChatSurface } from './SideChatSurface'
import { useSideChatStore } from '@/stores/sideChatStore'
import { createDefaultSessionState, useChatStore } from '@/stores/chatStore'
vi.mock('@/components/chat/ChatInput', () => ({ ChatInput: ({ sessionId, visible }: { sessionId: string; visible: boolean }) => <div data-testid="composer" data-session={sessionId} data-visible={String(visible)} /> }))
vi.mock('@/components/chat/MessageList', () => ({ MessageList: ({ sessionId }: { sessionId: string }) => <div data-testid="messages" data-session={sessionId} /> }))
const connectToSession = vi.fn()
beforeEach(() => {
  useSideChatStore.setState({ entries: { child: { sessionId: 'child', parentSessionId: 'parent', workDir: '/repo', title: 'Side chat', ephemeral: true } } })
  connectToSession.mockReset()
  useChatStore.setState({
    connectToSession,
    sessions: { child: { ...createDefaultSessionState(), connectionState: 'connected' } },
  } as Partial<ReturnType<typeof useChatStore.getState>>)
})
it('constrains the message list to the space above the composer', () => {
  render(<SideChatSurface parentSessionId="parent" sideChatId="child" />)
  // MessageList uses flex-1 and an h-full scroll area. Without a flex parent,
  // long conversations grow behind overflow-hidden instead of scrolling.
  const viewport = screen.getByTestId('messages').parentElement!
  expect([...viewport.classList]).toEqual(expect.arrayContaining(['flex', 'flex-col', 'flex-1', 'min-h-0', 'overflow-hidden']))
  expect(viewport.nextElementSibling).toBe(screen.getByTestId('composer'))
})
it('binds both full conversation components to child scope and retains it while hidden', () => {
  const close = vi.spyOn(useSideChatStore.getState(), 'close')
  const view = render(<SideChatSurface parentSessionId="parent" sideChatId="child" />)
  expect(screen.getByTestId('composer').getAttribute('data-session')).toBe('child')
  expect(screen.getByTestId('messages').getAttribute('data-session')).toBe('child')
  view.rerender(<SideChatSurface parentSessionId="parent" sideChatId="child" visible={false} />)
  expect(screen.getByTestId('composer').getAttribute('data-visible')).toBe('false')
  view.unmount()
  expect(close).not.toHaveBeenCalled()
})
it('does not display a child belonging to another parent', () => {
  render(<SideChatSurface parentSessionId="other" sideChatId="child" />)
  expect(screen.queryByTestId('composer')).toBeNull()
})

it('explains the temporary lifetime in the empty conversation', () => {
  render(<SideChatSurface parentSessionId="parent" sideChatId="child" />)
  expect(screen.getByRole('heading')).toBeTruthy()
  expect(screen.getByText(/temporary conversation|临时对话/)).toBeTruthy()
})

it('reconnects a side chat released with its parent once it is shown again', () => {
  // Released while its parent was out of the warm set: the transcript stayed.
  useChatStore.setState((state) => ({
    sessions: { ...state.sessions, child: { ...state.sessions.child!, connectionState: 'disconnected' } },
  }))
  const view = render(<SideChatSurface parentSessionId="parent" sideChatId="child" visible={false} />)
  expect(connectToSession).not.toHaveBeenCalled()

  view.rerender(<SideChatSurface parentSessionId="parent" sideChatId="child" visible />)

  expect(connectToSession).toHaveBeenCalledExactlyOnceWith('child', { prewarm: false, applyRuntimeSelection: false })
})

it('leaves a connected side chat alone', () => {
  render(<SideChatSurface parentSessionId="parent" sideChatId="child" />)
  expect(connectToSession).not.toHaveBeenCalled()
})
