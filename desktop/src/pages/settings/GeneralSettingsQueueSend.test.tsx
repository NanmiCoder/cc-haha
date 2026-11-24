import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsApi } from '@/api/settings'
import { useOpenTargetStore } from '@/stores/openTargetStore'
import { useSettingsStore } from '@/stores/settingsStore'
import {
  DEFAULT_SEND_QUEUED_MESSAGES_AT_ONCE,
  QUEUE_SEND_AT_ONCE_STORAGE_KEY,
  useQueueSendPreferenceStore,
} from '@/stores/queueSendPreferenceStore'
import { GeneralSettings } from './GeneralSettings'

describe('General settings queued prompt send mode', () => {
  beforeEach(() => {
    localStorage.removeItem(QUEUE_SEND_AT_ONCE_STORAGE_KEY)
    useQueueSendPreferenceStore.setState({
      sendQueuedMessagesAtOnce: DEFAULT_SEND_QUEUED_MESSAGES_AT_ONCE,
    })
    useSettingsStore.setState({
      locale: 'zh',
      fetchOutputStyles: async () => {},
      fetchAppMode: async () => {},
    })
    useOpenTargetStore.setState({ ensureTargets: async () => {} })
    vi.spyOn(settingsApi, 'updateUser').mockResolvedValue({ ok: true })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
    useOpenTargetStore.setState(useOpenTargetStore.getInitialState(), true)
    useQueueSendPreferenceStore.setState({
      sendQueuedMessagesAtOnce: DEFAULT_SEND_QUEUED_MESSAGES_AT_ONCE,
    })
    localStorage.removeItem(QUEUE_SEND_AT_ONCE_STORAGE_KEY)
  })

  it('sends queued messages one at a time unless the user opts into batching', () => {
    render(<GeneralSettings />)

    const toggle = screen.getByRole('switch', { name: '排队消息一次性全部发送' })
    expect(toggle).not.toBeChecked()

    fireEvent.click(toggle)

    expect(toggle).toBeChecked()
    expect(useQueueSendPreferenceStore.getState().sendQueuedMessagesAtOnce).toBe(true)
    expect(localStorage.getItem(QUEUE_SEND_AT_ONCE_STORAGE_KEY)).toBe('1')

    fireEvent.click(toggle)

    expect(toggle).not.toBeChecked()
    expect(useQueueSendPreferenceStore.getState().sendQueuedMessagesAtOnce).toBe(false)
    expect(localStorage.getItem(QUEUE_SEND_AT_ONCE_STORAGE_KEY)).toBe('0')
  })
})
