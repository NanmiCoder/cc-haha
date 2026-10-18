import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsApi } from '@/api/settings'
import { useSettingsStore } from '@/stores/settingsStore'
import { LeanModeSettings } from './LeanModeSettings'

describe('LeanModeSettings feedback', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'zh', leanModeEnabled: false })
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
    const toggle = screen.getByRole('switch', { name: '启用精简模式' })
    expect(screen.getByRole('status')).toHaveTextContent('已关闭')
    expect(toggle).toHaveAccessibleDescription(/首次发送后模式固定/)
    fireEvent.click(toggle)
    expect(toggle).toBeDisabled()
    expect(toggle).not.toBeChecked()
    expect(screen.getByRole('status')).toHaveTextContent('正在保存')
    await waitFor(() => expect(resolve).toBeTypeOf('function'))
    await act(async () => resolve({ ok: true }))
    expect(toggle).toBeChecked()
    expect(toggle).not.toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('已开启')
  })

  it('associates the inline error with the switch and clears it after retry', async () => {
    vi.mocked(settingsApi.updateUser).mockRejectedValueOnce(new Error('offline'))
    render(<LeanModeSettings />)
    const toggle = screen.getByRole('switch', { name: '启用精简模式' })
    fireEvent.click(toggle)
    expect(await screen.findByRole('alert')).toHaveTextContent('已保留原设置')
    expect(toggle).not.toBeChecked()
    expect(toggle).toHaveAccessibleDescription(/重新切换以重试/)
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toBeChecked())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps enabled availability when disabling fails', async () => {
    useSettingsStore.setState({ leanModeEnabled: true })
    vi.mocked(settingsApi.updateUser).mockRejectedValueOnce(new Error('offline'))
    render(<LeanModeSettings />)
    const toggle = screen.getByRole('switch', { name: '启用精简模式' })
    fireEvent.click(toggle)
    await screen.findByRole('alert')
    expect(toggle).toBeChecked()
    expect(toggle).not.toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('已开启')
  })
})
