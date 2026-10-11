import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsApi } from '../api/settings'
import { modelsApi } from '../api/models'
import { h5AccessApi } from '../api/h5Access'
import { tracesApi } from '../api/traces'
import type { UserSettings } from '../types/settings'
import { useSettingsStore } from './settingsStore'

const invalidLimits = [0, -1, 1.5, '3', Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true, {}]

describe('settingsStore ordinary SubAgent concurrency', () => {
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

  it('upgrades old settings to unlimited without writing or changing unknown fields or env', async () => {
    const oldSettings = { env: { FIXTURE_ENV: 'keep' }, unknownFuturePreference: { keep: true } }
    vi.mocked(settingsApi.getUser).mockResolvedValue(oldSettings)
    expect(useSettingsStore.getState().maxConcurrentSubagents).toBeNull()
    useSettingsStore.setState({ maxConcurrentSubagents: 4 })

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().maxConcurrentSubagents).toBeNull()
    expect(settingsApi.updateUser).not.toHaveBeenCalled()
    expect(oldSettings).toEqual({ env: { FIXTURE_ENV: 'keep' }, unknownFuturePreference: { keep: true } })
  })

  it.each([null, 1, 7, Number.MAX_SAFE_INTEGER])('hydrates a valid saved limit %s', async limit => {
    vi.mocked(settingsApi.getUser).mockResolvedValue({ maxConcurrentSubagents: limit })
    await useSettingsStore.getState().fetchAll()
    expect(useSettingsStore.getState().maxConcurrentSubagents).toBe(limit)
  })

  it.each(invalidLimits)('normalizes an invalid saved limit %s to unlimited', async limit => {
    vi.mocked(settingsApi.getUser).mockResolvedValue({ maxConcurrentSubagents: limit } as UserSettings)
    await useSettingsStore.getState().fetchAll()
    expect(useSettingsStore.getState().maxConcurrentSubagents).toBeNull()
    expect(settingsApi.updateUser).not.toHaveBeenCalled()
  })

  it('persists a custom N, reloads it, and restores unlimited using only the independent field', async () => {
    const persisted: UserSettings = { env: { FIXTURE_ENV: 'keep' }, unknownFuturePreference: true }
    vi.mocked(settingsApi.getUser).mockImplementation(async () => ({ ...persisted }))
    vi.mocked(settingsApi.updateUser).mockImplementation(async patch => {
      Object.assign(persisted, patch)
      return { ok: true }
    })

    await useSettingsStore.getState().setMaxConcurrentSubagents(37)
    expect(useSettingsStore.getState().maxConcurrentSubagents).toBe(37)
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
    await useSettingsStore.getState().fetchAll()
    expect(useSettingsStore.getState().maxConcurrentSubagents).toBe(37)

    await useSettingsStore.getState().setMaxConcurrentSubagents(null)
    expect(useSettingsStore.getState().maxConcurrentSubagents).toBeNull()
    useSettingsStore.setState({ maxConcurrentSubagents: 3 })
    await useSettingsStore.getState().fetchAll()
    expect(useSettingsStore.getState().maxConcurrentSubagents).toBeNull()
    expect(vi.mocked(settingsApi.updateUser).mock.calls).toEqual([
      [{ maxConcurrentSubagents: 37 }], [{ maxConcurrentSubagents: null }],
    ])
    expect(persisted).toEqual({ env: { FIXTURE_ENV: 'keep' }, unknownFuturePreference: true, maxConcurrentSubagents: null })
  })

  it.each([null, 5])('rolls back and rethrows when saving from %s fails', async previous => {
    const failure = new Error('fixture disk unavailable')
    vi.mocked(settingsApi.updateUser).mockRejectedValueOnce(failure)
    useSettingsStore.setState({ maxConcurrentSubagents: previous })
    const next = previous === null ? 5 : null
    const saving = useSettingsStore.getState().setMaxConcurrentSubagents(next)
    expect(useSettingsStore.getState().maxConcurrentSubagents).toBe(next)
    await expect(saving).rejects.toBe(failure)
    expect(useSettingsStore.getState().maxConcurrentSubagents).toBe(previous)
  })

  it.each([...invalidLimits, undefined])('rejects invalid setter input %s without submitting or mutating state', async limit => {
    useSettingsStore.setState({ maxConcurrentSubagents: 8 })
    await expect(useSettingsStore.getState().setMaxConcurrentSubagents(limit as number)).rejects.toThrow()
    expect(settingsApi.updateUser).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().maxConcurrentSubagents).toBe(8)
  })
})
