import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { ToolCallBlock } from '../chat/ToolCallBlock'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTrajectoryViewStore } from '../../stores/trajectoryViewStore'
import { TrajectoryLinkContext } from './TrajectoryLinkContext'

function renderTool(toolUseId: string | undefined, linked: boolean) {
  const block = <ToolCallBlock toolName="Bash" input={{ command: 'ls' }} result={{ content: 'a.txt', isError: false }} toolUseId={toolUseId} />
  return render(linked ? <TrajectoryLinkContext.Provider value={{ sessionId: 's1' }}>{block}</TrajectoryLinkContext.Provider> : block)
}

describe('view in trajectory', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useTrajectoryViewStore.setState({ modes: {}, opened: {}, nav: null })
  })

  it('switches the session to its trajectory and requests that tool row', () => {
    renderTool('toolu_1', true)
    fireEvent.click(screen.getByRole('button', { name: 'View in trajectory' }))
    const state = useTrajectoryViewStore.getState()
    expect(state.modes.s1).toBe('trajectory')
    expect(state.opened.s1).toBe(true)
    expect(state.nav).toMatchObject({ to: 'trajectory', sessionId: 's1', rowId: 't:toolu_1' })
  })

  it('does not toggle the tool card when the action is clicked', () => {
    renderTool('toolu_1', true)
    const header = screen.getByRole('button', { name: /Bash/ })
    const before = header.getAttribute('aria-expanded')
    fireEvent.click(screen.getByRole('button', { name: 'View in trajectory' }))
    expect(header.getAttribute('aria-expanded')).toBe(before)
  })

  it.each(['card', 'row'] as const)('sits in the %s header beside the disclosure, left of the duration and chevron', (chrome) => {
    // Regression: the action was laid absolutely over the header's right edge,
    // clipping "1.5s" and swallowing clicks meant for the chevron.
    const { container } = render(
      <TrajectoryLinkContext.Provider value={{ sessionId: 's1' }}>
        <ToolCallBlock chrome={chrome} toolName="Bash" input={{ command: 'ls' }} result={{ content: 'a.txt', isError: false }} durationMs={1500} toolUseId="toolu_1" />
      </TrajectoryLinkContext.Provider>,
    )
    const disclosure = container.querySelector<HTMLButtonElement>('[data-chat-disclosure="true"]')!
    const action = screen.getByRole('button', { name: 'View in trajectory' })
    const duration = screen.getByText('1.5s')

    // Siblings in one header row: never an interactive element inside another.
    expect(disclosure.contains(action)).toBe(false)
    expect(action.closest('button')).toBe(action)
    expect(action.parentElement).toBe(disclosure.parentElement)
    expect(duration.parentElement).toBe(disclosure.parentElement)
    // In flow, ahead of the duration — not positioned over it.
    expect(action.compareDocumentPosition(duration) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(action.className).not.toMatch(/\babsolute\b/)
    // Hidden until the header is hovered, but keyboard focus still reveals it.
    expect(action.className).toContain('opacity-0')
    expect(action.className).toContain('focus-visible:opacity-100')

    // The disclosure keeps working on its own.
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(disclosure)
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  })

  it('reserves no slot when there is no trajectory to link to', () => {
    const { container } = renderTool('toolu_1', false)
    const disclosure = container.querySelector('[data-chat-disclosure="true"]')!
    expect(disclosure.parentElement?.querySelectorAll('button')).toHaveLength(1)
  })

  it('is absent outside the main session list and for subagent-scoped tool ids', () => {
    renderTool('toolu_1', false)
    expect(screen.queryByRole('button', { name: 'View in trajectory' })).not.toBeInTheDocument()
    renderTool('agent-a/toolu_2', true)
    expect(screen.queryByRole('button', { name: 'View in trajectory' })).not.toBeInTheDocument()
    renderTool(undefined, true)
    expect(screen.queryByRole('button', { name: 'View in trajectory' })).not.toBeInTheDocument()
  })
})
