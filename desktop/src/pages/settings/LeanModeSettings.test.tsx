import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsApi } from '@/api/settings'
import { useSettingsStore } from '@/stores/settingsStore'
import { LeanModeSettings } from './LeanModeSettings'

describe('LeanModeSettings feedback', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en', leanModeEnabled: false })
    vi.spyOn(settingsApi, 'updateUser').mockResolvedValue({ ok: true })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  })

  it('announces saving without showing an unconfirmed enabled state', async () => {
    let resolve!: (value: { ok: true }) => void
    vi.mocked(settingsApi.updateUser).mockImplementation(() => new Promise(done => { resolve = done }))
    render(<LeanModeSettings />)
    const toggle = screen.getByRole('switch', { name: 'Enable lean mode' })
    expect(screen.getByRole('status')).toHaveTextContent('Off')
    expect(toggle).toHaveAccessibleDescription(/fixed after the first message/)
    fireEvent.click(toggle)
    expect(toggle).toBeDisabled()
    expect(toggle).not.toBeChecked()
    expect(screen.getByRole('status')).toHaveTextContent('Saving')
    await waitFor(() => expect(resolve).toBeTypeOf('function'))
    await act(async () => resolve({ ok: true }))
    expect(toggle).toBeChecked()
    expect(toggle).not.toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('On')
  })

  it('associates the inline error with the switch and clears it after retry', async () => {
    vi.mocked(settingsApi.updateUser).mockRejectedValueOnce(new Error('offline'))
    render(<LeanModeSettings />)
    const toggle = screen.getByRole('switch', { name: 'Enable lean mode' })
    fireEvent.click(toggle)
    expect(await screen.findByRole('alert')).toHaveTextContent('Your previous setting is unchanged')
    expect(toggle).not.toBeChecked()
    expect(toggle).toHaveAccessibleDescription(/Toggle again to retry/)
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toBeChecked())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps enabled availability when disabling fails', async () => {
    useSettingsStore.setState({ leanModeEnabled: true })
    vi.mocked(settingsApi.updateUser).mockRejectedValueOnce(new Error('offline'))
    render(<LeanModeSettings />)
    const toggle = screen.getByRole('switch', { name: 'Enable lean mode' })
    fireEvent.click(toggle)
    await screen.findByRole('alert')
    expect(toggle).toBeChecked()
    expect(toggle).not.toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('On')
  })

  it('explains lean mode from a help button that leaves the switch alone', () => {
    render(<LeanModeSettings />)
    const toggle = screen.getByRole('switch', { name: 'Enable lean mode' })
    fireEvent.click(screen.getByRole('button', { name: 'What is lean mode?' }))
    expect(screen.getByRole('dialog', { name: 'What is lean mode?' })).toHaveTextContent('No MCP connectors')
    expect(toggle).not.toBeChecked()
    expect(settingsApi.updateUser).not.toHaveBeenCalled()
  })
})
