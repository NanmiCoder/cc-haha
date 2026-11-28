import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { H5ConnectionView } from './H5ConnectionView'
import { readStoredH5Connection, saveAndVerifyH5Connection } from '../../lib/desktopRuntime'
import { useSettingsStore } from '../../stores/settingsStore'

vi.mock('../../lib/desktopRuntime', () => ({ readStoredH5Connection: vi.fn(), saveAndVerifyH5Connection: vi.fn() }))
beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  vi.mocked(readStoredH5Connection).mockReturnValue({ serverUrl: 'https://paired.example', token: 'saved-token' })
  vi.mocked(saveAndVerifyH5Connection).mockResolvedValue('https://paired.example')
})
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('retries a remembered pairing after a network failure without asking for its token', async () => {
  const connected = vi.fn()
  render(<H5ConnectionView initialServerUrl="https://paired.example" error="Network unavailable" onConnected={connected} />)
  expect(screen.getByLabelText(/H5 Token/)).toHaveValue('')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce())
  expect(saveAndVerifyH5Connection).toHaveBeenCalledWith('https://paired.example', 'saved-token')
})

it('does not offer the saved credential to another entered server', () => {
  render(<H5ConnectionView initialServerUrl="https://other.example" onConnected={vi.fn()} />)
  expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
})

it('aligns its card shell and heading with the V6C RemoteAccessGate glass dialog', () => {
  render(<H5ConnectionView initialServerUrl="https://paired.example" onConnected={vi.fn()} />)
  const card = screen.getByTestId('h5-connection-card')
  expect(card).toHaveClass('dialog-glass', 'rounded-[var(--radius-3xl)]', 'max-w-[400px]')
  const heading = screen.getByRole('heading', { level: 1 })
  expect(heading).toHaveClass('text-[18px]', 'font-semibold')
})
