import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { GeneralSettings } from './GeneralSettings'

// The full settings panel pulls in many stores and host APIs; stub the heavy
// leaf components and host calls so this test can mount the real page and
// exercise just the context-compaction dropdown.
vi.mock('../../components/controls/PermissionModeSelector', () => ({ PermissionModeSelector: () => null }))
vi.mock('../../lib/desktopNotifications', () => ({
  getDesktopNotificationPermission: () => Promise.resolve('default'),
  notifyDesktop: () => undefined,
  getDesktopNotificationPlatform: () => 'linux',
  openDesktopNotificationSettings: () => undefined,
  requestDesktopNotificationPermission: () => Promise.resolve('default'),
}))

beforeEach(() => {
  useSettingsStore.setState({ locale: 'zh', vccCompactBackend: 'algorithm' })
  vi.spyOn(useSettingsStore.getState(), 'fetchAppMode').mockResolvedValue()
  vi.spyOn(useSettingsStore.getState(), 'fetchAll').mockResolvedValue()
  vi.spyOn(useSettingsStore.getState(), 'fetchOutputStyles').mockResolvedValue()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('renders the compaction dropdown options with translated labels, not raw i18n keys', async () => {
  render(<GeneralSettings />)

  const trigger = screen.getByRole('button', { name: '上下文压缩' })
  fireEvent.click(trigger)

  // Both options open with their Chinese label + description.
  expect(await screen.findByRole('option', { name: /算法压缩（VCC）/ })).toBeInTheDocument()
  const llmOption = screen.getByRole('option', { name: /LLM 摘要/ })
  expect(llmOption).toBeInTheDocument()

  // The raw i18n key must no longer leak into the option text.
  const listbox = screen.getByRole('listbox')
  expect(listbox.textContent).not.toContain('settings.general.compactionBackend')
  expect(listbox.textContent).not.toContain('Algorithmic')
})

