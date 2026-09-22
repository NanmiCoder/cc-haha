import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ToolCallBlock } from './ToolCallBlock'
import { SessionToolLinks, sessionToolTargets, SESSION_TOOL_NAMES } from './SessionToolLinks'
import { useSessionStore } from '@/stores/sessionStore'
const openTab = vi.fn()
vi.mock('@/stores/tabStore', () => ({ useTabStore: { getState: () => ({ openTab }) } }))
beforeEach(() => {
  openTab.mockReset()
  useSessionStore.setState({ sessions: [] })
})
it('opens session sources returned inside a tool text block', () => {
  render(<SessionToolLinks input={{}} result={[{ type: 'text', text: '{"sessionId":"created"}' }]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Open session created' }))
  expect(openTab).toHaveBeenCalledWith('created', 'created')
})
it('publishes the title carried by a CreateSession result before the index catches up', async () => {
  // Regression: spawned sessions rendered as "Untitled Session" because the
  // session store had not refreshed yet when the tool card rendered.
  useSessionStore.setState({
    sessions: [{
      id: 'child', title: 'Untitled Session', createdAt: '2026-09-22T00:00:00.000Z',
      modifiedAt: '2026-09-22T00:00:00.000Z', messageCount: 0,
      projectPath: '/workspace', projectRoot: '/workspace', workDir: '/workspace',
      workDirExists: true,
    }],
  })
  render(<SessionToolLinks input={{}} result={{ sessionId: 'child', title: '安全检查', state: 'queued', delivery: 'queued', messageId: 'm' }} />)
  expect(screen.getByRole('button', { name: 'Open session 安全检查' })).toBeDefined()
  await waitFor(() => expect(useSessionStore.getState().sessions[0]?.title).toBe('安全检查'))
  fireEvent.click(screen.getByRole('button', { name: 'Open session 安全检查' }))
  expect(openTab).toHaveBeenCalledWith('child', '安全检查')
})
it('handles protocol targets without scraping arbitrary content', () => {
  expect(sessionToolTargets({ targetSessionId: 'target' }, { members: [{ sessionId: 'target' }, { sessionId: 'child' }], content: 'sessionId=not-a-reference' })).toEqual(['target', 'child'])
})

it.each([...SESSION_TOOL_NAMES])('renders navigation in the existing %s tool card', toolName => {
  render(<ToolCallBlock toolName={toolName} input={{ sessionId: 'source' }} result={{ content: [{ type: 'text', text: '{"sessionId":"child"}' }], isError: false }} />)
  expect(screen.getByRole('button', { name: 'Open session source' })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Open session child' })).toBeDefined()
})
