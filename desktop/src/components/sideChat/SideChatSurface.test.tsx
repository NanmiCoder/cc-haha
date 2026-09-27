import { render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { SideChatSurface } from './SideChatSurface'
import { useSideChatStore } from '@/stores/sideChatStore'
vi.mock('@/components/chat/ChatInput', () => ({ ChatInput: ({ sessionId, visible }: { sessionId: string; visible: boolean }) => <div data-testid="composer" data-session={sessionId} data-visible={String(visible)} /> }))
vi.mock('@/components/chat/MessageList', () => ({ MessageList: ({ sessionId }: { sessionId: string }) => <div data-testid="messages" data-session={sessionId} /> }))
beforeEach(() => useSideChatStore.setState({ entries: { child: { sessionId: 'child', parentSessionId: 'parent', workDir: '/repo', title: 'Side chat', ephemeral: true } } }))
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
