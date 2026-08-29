import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'

// Mock the settings API the store calls when persisting. The store imports it
// via a relative path; mock the same resolved module.
vi.mock('../../api/settings', () => ({
  settingsApi: {
    updateUser: vi.fn().mockResolvedValue(undefined),
  },
}))

import { settingsApi } from '@/api/settings'

describe('settingsStore attributionCommitDisabled (issue #1274)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ attributionCommitDisabled: false })
  })

  it('disables Co-Authored-By and persists an empty attribution.commit', async () => {
    await useSettingsStore.getState().setAttributionCommitDisabled(true)

    expect(useSettingsStore.getState().attributionCommitDisabled).toBe(true)
    expect(settingsApi.updateUser).toHaveBeenCalledWith({ attribution: { commit: '' } })
  })

  it('re-enables Co-Authored-By and drops attribution.commit on the server', async () => {
    await useSettingsStore.getState().setAttributionCommitDisabled(false)

    expect(useSettingsStore.getState().attributionCommitDisabled).toBe(false)
    expect(settingsApi.updateUser).toHaveBeenCalledWith({ attribution: { commit: undefined } })
  })
})
