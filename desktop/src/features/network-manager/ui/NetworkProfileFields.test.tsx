import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { createDefaultNetworkProfiles } from '../networkTypes'
import { NetworkProfileFields } from './NetworkProfileFields'

afterEach(cleanup)
it('routes sign-in and file selection to explicit actions, and edits only the requested field', () => {
  useSettingsStore.setState({ locale: 'en' })
  const profile = createDefaultNetworkProfiles()[0]!
  const onChange = vi.fn(), onLogin = vi.fn(), onPick = vi.fn(), onValidate = vi.fn(), onPreview = vi.fn()
  render(<NetworkProfileFields profile={profile} disabled={false} onChange={onChange} onLogin={onLogin} onPick={onPick} onValidate={onValidate} onPreview={onPreview} />)
  fireEvent.click(screen.getByRole('button', { name: 'Open Windows VPN sign-in' }))
  expect(onLogin).toHaveBeenCalledWith('vpn')
  expect(screen.queryByRole('navigation', { name: 'Network configuration stages' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Validate physical network' }))
  expect(onValidate).toHaveBeenCalledWith('physical')
  fireEvent.click(screen.getByRole('button', { name: 'Preview route changes' }))
  expect(onPreview).toHaveBeenCalledWith('physical')
  fireEvent.click(screen.getByRole('button', { name: 'Choose configuration file' }))
  expect(onPick).toHaveBeenCalledWith('proxyConfigPath')
  fireEvent.change(screen.getByLabelText('TCP relay port'), { target: { value: '51827' } })
  expect(onChange).toHaveBeenCalledWith({ ...profile, relayPort: 51827 })
})
