import { createRef, type RefObject } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { AgentProfileControl, type AgentProfileControlHandle } from '@/components/chat/AgentProfileControl'
vi.mock('@/i18n', () => ({ useTranslation: () => (key: string) => key }))
afterEach(cleanup)

// The control is the phone's Agent mode sheet only. The desktop picks the mode
// in a row of the "+" menu (capabilityMenuModel) and marks a lean conversation
// with a chip (AgentProfileChip), so nothing of this control sits on a toolbar.
const openPhoneSheet = (handle: RefObject<AgentProfileControlHandle | null>) => act(() => handle.current!.open())

it('puts nothing on the toolbar: the sheet opens from a row of the "+" sheet', () => {
  render(<AgentProfileControl value="lean" onChange={vi.fn()} />)
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(screen.queryByText('agentProfile.leanShort')).not.toBeInTheDocument()
  expect(screen.queryByTestId('agent-profile-control')).not.toBeInTheDocument()
})
it('lets the phone choose the mode in a sheet and closes it after the choice', () => {
  const change = vi.fn()
  const handle = createRef<AgentProfileControlHandle>()
  render(<AgentProfileControl ref={handle} value="standard" onChange={change} />)
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
  render(<AgentProfileControl ref={handle} value="lean" />)
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
  render(<AgentProfileControl ref={handle} value="standard" />)
  openPhoneSheet(handle)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
it('keeps the phone sheet choices disabled while the conversation is being created', () => {
  const change = vi.fn()
  const handle = createRef<AgentProfileControlHandle>()
  render(<AgentProfileControl ref={handle} value="standard" onChange={change} disabled />)
  openPhoneSheet(handle)
  const lean = screen.getByRole('radio', { name: /agentProfile.lean/ })
  expect(lean).toBeDisabled()
  fireEvent.click(lean)
  expect(change).not.toHaveBeenCalled()
})
