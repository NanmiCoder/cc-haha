import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsApi } from '@/api/settings'
import { useOpenTargetStore } from '@/stores/openTargetStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { GeneralSettings } from './GeneralSettings'

describe('General settings lean mode availability', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      locale: 'zh', leanModeEnabled: false,
      fetchOutputStyles: async () => {}, fetchAppMode: async () => {},
    })
    useOpenTargetStore.setState({ ensureTargets: async () => {} })
    vi.spyOn(settingsApi, 'updateUser').mockResolvedValue({ ok: true })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
    useOpenTargetStore.setState(useOpenTargetStore.getInitialState(), true)
  })
  it('defaults off and saves both choices', async () => {
    render(<GeneralSettings />)
    const toggle = screen.getByRole('switch', { name: '启用精简模式' })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toBeChecked())
    expect(settingsApi.updateUser).toHaveBeenCalledWith({ leanModeEnabled: true })
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(settingsApi.updateUser).toHaveBeenLastCalledWith({ leanModeEnabled: false })
  })
  it('keeps the previous choice when saving fails', async () => {
    vi.mocked(settingsApi.updateUser).mockRejectedValue(new Error('fixture failure'))
    render(<GeneralSettings />)
    const toggle = screen.getByRole('switch', { name: '启用精简模式' })
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).not.toBeDisabled())
    expect(toggle).not.toBeChecked()
  })
})
