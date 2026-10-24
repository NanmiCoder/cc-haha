import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { AgentProfileChip } from '@/components/chat/AgentProfileChip'

vi.mock('@/i18n', () => ({ useTranslation: () => (key: string) => key }))
afterEach(cleanup)

it('names the lean draft briefly and lets it be taken off', () => {
  const remove = vi.fn()
  render(<AgentProfileChip onRemove={remove} />)
  const chip = screen.getByTestId('agent-profile-chip')
  expect(chip).toHaveTextContent('agentProfile.leanShort')
  expect(chip).toHaveAttribute('title', 'agentProfile.draftHint')
  fireEvent.click(screen.getByRole('button', { name: 'agentProfile.chipRemove' }))
  expect(remove).toHaveBeenCalledTimes(1)
})

it('is the locked record once the conversation exists: it says why and has nothing to click', () => {
  render(<AgentProfileChip />)
  const chip = screen.getByTestId('agent-profile-chip')
  expect(chip).toHaveTextContent('agentProfile.leanShort')
  expect(chip).toHaveAttribute('title', 'agentProfile.locked')
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})
