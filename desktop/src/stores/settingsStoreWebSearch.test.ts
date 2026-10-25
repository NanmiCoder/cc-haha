import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsApi } from '../api/settings'
import { modelsApi } from '../api/models'
import { h5AccessApi } from '../api/h5Access'
import { tracesApi } from '../api/traces'
import type { UserSettings } from '../types/settings'
import { useSettingsStore } from './settingsStore'

describe('settingsStore WebSearch', () => {
  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
    vi.spyOn(settingsApi, 'getPermissionMode').mockResolvedValue({ mode: 'default' })
    vi.spyOn(settingsApi, 'getUser').mockResolvedValue({})
    vi.spyOn(settingsApi, 'updateUser').mockResolvedValue({ ok: true })
    vi.spyOn(modelsApi, 'list').mockResolvedValue({ models: [], provider: null })
    vi.spyOn(modelsApi, 'getCurrent').mockResolvedValue({ model: { id: 'fixture', name: 'Fixture', description: '', context: '' } })
    vi.spyOn(modelsApi, 'getEffort').mockResolvedValue({ level: 'low', available: ['low'] })
    vi.spyOn(h5AccessApi, 'get').mockResolvedValue({ settings: { enabled: false } } as Awaited<ReturnType<typeof h5AccessApi.get>>)
    vi.spyOn(tracesApi, 'getSettings').mockResolvedValue({ enabled: true, storageDir: '' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  })

  it('upgrades a legacy fixture without modifying its mode, keys, or unknown fields', async () => {
    const legacy: UserSettings = {
      env: { FIXTURE_ENV: 'keep' },
      unknownFuturePreference: true,
      webSearch: { mode: 'anthropic', tavilyApiKey: 'tvly-fixture', braveApiKey: 'brave-fixture' },
    }
    const snapshot = structuredClone(legacy)
    vi.mocked(settingsApi.getUser).mockResolvedValue(legacy)
    await useSettingsStore.getState().fetchAll()
    expect(useSettingsStore.getState().webSearch).toEqual({
      ...legacy.webSearch,
      deepseekApiKey: '',
    })
    expect(legacy).toEqual(snapshot)
    expect(settingsApi.updateUser).not.toHaveBeenCalled()
  })

  it('persists and reloads an independent DeepSeek key while preserving the old keys', async () => {
    const persisted: UserSettings = {
      env: { FIXTURE_ENV: 'keep' },
      unknownFuturePreference: true,
      webSearch: { mode: 'auto', tavilyApiKey: 'tvly-fixture', braveApiKey: 'brave-fixture' },
    }
    vi.mocked(settingsApi.getUser).mockImplementation(async () => structuredClone(persisted))
    vi.mocked(settingsApi.updateUser).mockImplementation(async patch => {
      Object.assign(persisted, patch)
      return { ok: true }
    })
    await useSettingsStore.getState().fetchAll()
    await useSettingsStore.getState().setWebSearch({
      ...useSettingsStore.getState().webSearch,
      mode: 'deepseek',
      deepseekApiKey: 'sk-fixture',
    })
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
    await useSettingsStore.getState().fetchAll()
    expect(useSettingsStore.getState().webSearch).toEqual({
      mode: 'deepseek', deepseekApiKey: 'sk-fixture',
      tavilyApiKey: 'tvly-fixture', braveApiKey: 'brave-fixture',
    })
    expect(persisted.env).toEqual({ FIXTURE_ENV: 'keep' })
    expect(persisted.unknownFuturePreference).toBe(true)
    expect(settingsApi.updateUser).toHaveBeenCalledWith({ webSearch: persisted.webSearch })
  })

  it('restores existing search settings when saving fails', async () => {
    const previous = { mode: 'auto' as const, tavilyApiKey: 'tvly-fixture' }
    useSettingsStore.setState({ webSearch: previous })
    vi.mocked(settingsApi.updateUser).mockRejectedValueOnce(new Error('fixture write failed'))
    await useSettingsStore.getState().setWebSearch({
      mode: 'deepseek', deepseekApiKey: 'sk-fixture',
    })
    expect(useSettingsStore.getState().webSearch).toEqual(previous)
  })
})
