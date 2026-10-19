import { createRef, type RefObject } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { AgentProfileControl, type AgentProfileControlHandle } from '@/components/chat/AgentProfileControl'
vi.mock('@/i18n', () => ({ useTranslation: () => (key: string) => key }))
afterEach(cleanup)

it('explains both choices before selection and returns keyboard focus', () => {
  const change = vi.fn()
  render(<AgentProfileControl value="standard" onChange={change} />)
  const trigger = screen.getByRole('button', { name: /^agentProfile.label:/ })
  expect(trigger).toHaveAccessibleName('agentProfile.label: agentProfile.standard')
  fireEvent.keyDown(trigger, { key: 'Enter' })
  expect(screen.getByRole('option', { name: /agentProfile.standard/ })).toHaveTextContent('agentProfile.standardSummary')
  expect(screen.getByRole('option', { name: /agentProfile.lean/ })).toHaveTextContent('agentProfile.leanSummary')
  const list = screen.getByRole('listbox')
  fireEvent.keyDown(list, { key: 'ArrowDown' })
  fireEvent.keyDown(list, { key: 'Enter' })
  expect(change).toHaveBeenCalledWith('lean')
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
})
it('allows pointer selection and Escape without changing the profile', () => {
  const change = vi.fn()
  render(<AgentProfileControl value="standard" onChange={change} />)
  const trigger = screen.getByRole('button', { name: /^agentProfile.label:/ })
  fireEvent.click(trigger)
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
  expect(change).not.toHaveBeenCalled()
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('option', { name: /agentProfile.lean/ }))
  expect(change).toHaveBeenCalledWith('lean')
})
it('locks the profile after creation and identifies restored lean conversations', () => {
  render(<AgentProfileControl value="lean" />)
  expect(screen.queryByRole('button', { name: /^agentProfile.label:/ })).not.toBeInTheDocument()
  expect(screen.getByText('agentProfile.leanShort')).toHaveAttribute('title', 'agentProfile.locked')
})
it('disables changes during creation and leaves standard conversations uncluttered', () => {
  const { rerender } = render(<AgentProfileControl value="lean" onChange={vi.fn()} disabled />)
  expect(screen.getByRole('button', { name: /^agentProfile.label:/ })).toBeDisabled()
  rerender(<AgentProfileControl value="standard" />)
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})
it.each(['hover', 'focus', 'tap'])('explains capabilities and locking via %s on the info icon', (action) => {
  render(<AgentProfileControl value="lean" />)
  const trigger = screen.getByRole('button', { name: 'agentProfile.info' })
  if (action === 'hover') fireEvent.mouseEnter(trigger)
  else if (action === 'focus') fireEvent.focus(trigger)
  else fireEvent.click(trigger)
  const tooltip = screen.getByRole('tooltip')
  expect(tooltip).toHaveTextContent('agentProfile.available')
  expect(tooltip).toHaveTextContent('agentProfile.unavailable')
  expect(tooltip).toHaveTextContent('agentProfile.locked')
  expect(trigger).toHaveAttribute('aria-describedby', tooltip.id)
  fireEvent.keyDown(trigger, { key: 'Escape' })
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
})
it('tells drafts when the mode will lock instead of saying it is already locked', () => {
  render(<AgentProfileControl value="standard" onChange={vi.fn()} />)
  fireEvent.focus(screen.getByRole('button', { name: 'agentProfile.info' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent('agentProfile.draftHint')
  expect(screen.getByRole('tooltip')).not.toHaveTextContent('agentProfile.locked')
})

// The toolbar row shares its width with the project, branch and model. The chip
// used to read "Lean · experimental" (180px in English), which is what squeezed
// the project name down to "claude-cod…" and the branch to "…in". The chip and
// the locked badge now carry the short name; "experimental" stays on the menu
// row and in the explanation.
it('shows the short mode name on the chip while keeping the full name for assistive tech and the menu', () => {
  render(<AgentProfileControl value="lean" onChange={vi.fn()} />)
  const trigger = screen.getByRole('button', { name: /^agentProfile.label:/ })
  expect(trigger).toHaveTextContent(/^agentProfile\.leanShort$/)
  expect(trigger).toHaveAccessibleName('agentProfile.label: agentProfile.lean')
  fireEvent.click(trigger)
  const row = screen.getByRole('option', { name: /agentProfile.lean/ })
  expect(row).toHaveTextContent('agentProfile.lean')
  expect(row).not.toHaveTextContent('agentProfile.leanShort')
  expect(row).toHaveTextContent('agentProfile.leanSummary')
})
it('keeps the explanation for the toolbar in one place: the info button', () => {
  render(<AgentProfileControl value="lean" onChange={vi.fn()} />)
  expect(screen.getAllByRole('button', { name: 'agentProfile.info' })).toHaveLength(1)
  expect(screen.queryByText('agentProfile.available')).not.toBeInTheDocument()
})

// The phone cannot afford a chip, a badge and an info button on its toolbar:
// they covered the "+" and pushed the model name down to a single letter. The
// phone's "+" sheet holds a row for the mode instead, and the row opens this.
const openPhoneSheet = (handle: RefObject<AgentProfileControlHandle | null>) => act(() => handle.current!.open())
it('puts nothing on the toolbar when the phone presents it as a sheet', () => {
  render(<AgentProfileControl value="lean" onChange={vi.fn()} presentation="sheet" />)
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(screen.queryByText('agentProfile.leanShort')).not.toBeInTheDocument()
  expect(screen.queryByTestId('agent-profile-control')).not.toBeInTheDocument()
})
it('lets the phone choose the mode in a sheet and closes it after the choice', () => {
  const change = vi.fn()
  const handle = createRef<AgentProfileControlHandle>()
  render(<AgentProfileControl ref={handle} value="standard" onChange={change} presentation="sheet" />)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  openPhoneSheet(handle)
  const sheet = screen.getByRole('dialog', { name: 'agentProfile.label' })
  const radios = within(sheet).getAllByRole('radio')
  expect(radios).toHaveLength(2)
  expect(within(sheet).getByRole('radio', { name: /agentProfile.standard/ })).toBeChecked()
  expect(within(sheet).getByRole('radio', { name: /agentProfile.standard/ })).toHaveTextContent('agentProfile.standardSummary')
  expect(within(sheet).getByRole('radio', { name: /agentProfile.lean/ })).not.toBeChecked()
  // What lean gives up is read before choosing it, and the draft's timing is stated.
  expect(sheet).toHaveTextContent('agentProfile.available')
  expect(sheet).toHaveTextContent('agentProfile.unavailable')
  expect(sheet).toHaveTextContent('agentProfile.draftHint')
  // Each fact is said once: the name and the summary sit on the choice, not again below it.
  expect(sheet.textContent?.split('agentProfile.leanSummary').length).toBe(2)
  expect(within(sheet).getAllByText('agentProfile.lean')).toHaveLength(1)
  fireEvent.click(within(sheet).getByRole('radio', { name: /agentProfile.lean/ }))
  expect(change).toHaveBeenCalledWith('lean')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
it('shows a locked lean session its mode and limits on the phone, with nothing to change', () => {
  const handle = createRef<AgentProfileControlHandle>()
  render(<AgentProfileControl ref={handle} value="lean" presentation="sheet" />)
  openPhoneSheet(handle)
  const sheet = screen.getByRole('dialog', { name: 'agentProfile.label' })
  expect(within(sheet).queryByRole('radio')).not.toBeInTheDocument()
  expect(within(sheet).getAllByText('agentProfile.lean')).toHaveLength(1)
  expect(sheet).toHaveTextContent('agentProfile.leanSummary')
  expect(sheet).toHaveTextContent('agentProfile.unavailable')
  expect(sheet).toHaveTextContent('agentProfile.locked')
  expect(sheet).not.toHaveTextContent('agentProfile.draftHint')
})
it('does not open a sheet for a standard conversation, which has nothing to explain', () => {
  const handle = createRef<AgentProfileControlHandle>()
  render(<AgentProfileControl ref={handle} value="standard" presentation="sheet" />)
  openPhoneSheet(handle)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
it('keeps the phone sheet choices disabled while the conversation is being created', () => {
  const change = vi.fn()
  const handle = createRef<AgentProfileControlHandle>()
  render(<AgentProfileControl ref={handle} value="standard" onChange={change} disabled presentation="sheet" />)
  openPhoneSheet(handle)
  const lean = screen.getByRole('radio', { name: /agentProfile.lean/ })
  expect(lean).toBeDisabled()
  fireEvent.click(lean)
  expect(change).not.toHaveBeenCalled()
})
