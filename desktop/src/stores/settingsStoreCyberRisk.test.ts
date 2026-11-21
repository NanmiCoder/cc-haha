import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('settingsStore cyber-risk instruction preference', () => {
  function installSettingsFixture(user: Record<string, unknown>, updateUser = vi.fn().mockResolvedValue({ ok: true })) {
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn(async () => ({ ...user })),
        updateUser,
        getPermissionMode: vi.fn().mockResolvedValue({ mode: 'default' }),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn().mockResolvedValue({ models: [] }),
        getCurrent: vi.fn().mockResolvedValue({ model: null }),
        getEffort: vi.fn().mockResolvedValue({ level: 'medium' }),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: { get: vi.fn().mockResolvedValue({ settings: { enabled: false } }) },
    }))
    return updateUser
  }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  it('defaults to true for legacy settings without rewriting user settings', async () => {
    const updateUser = installSettingsFixture({ unknownFuturePreference: { keep: true } })
    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().includeCyberRiskInstruction).toBe(true)
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('persists false and true and restores after restart while keeping unknown fields', async () => {
    const user: Record<string, unknown> = { unknownFuturePreference: { keep: true } }
    const updateUser = vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(user, patch)
      return { ok: true }
    })
    installSettingsFixture(user, updateUser)
    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().setIncludeCyberRiskInstruction(false)
    expect(useSettingsStore.getState().includeCyberRiskInstruction).toBe(false)
    expect(updateUser).toHaveBeenCalledWith({ includeCyberRiskInstruction: false })

    vi.resetModules()
    const restarted = await import('./settingsStore')
    await restarted.useSettingsStore.getState().fetchAll()
    expect(restarted.useSettingsStore.getState().includeCyberRiskInstruction).toBe(false)
    expect(user).toEqual({ unknownFuturePreference: { keep: true }, includeCyberRiskInstruction: false })

    await restarted.useSettingsStore.getState().setIncludeCyberRiskInstruction(true)
    expect(restarted.useSettingsStore.getState().includeCyberRiskInstruction).toBe(true)
    expect(updateUser).toHaveBeenLastCalledWith({ includeCyberRiskInstruction: true })
  })

  it('ignores a stale fetchAll response that started before a save', async () => {
    let resolveRead!: (value: Record<string, unknown>) => void
    const updateUser = vi.fn().mockResolvedValue({ ok: true })
    installSettingsFixture({ includeCyberRiskInstruction: true }, updateUser)
    const { useSettingsStore } = await import('./settingsStore')
    const { settingsApi } = await import('../api/settings')
    vi.mocked(settingsApi.getUser).mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve }))

    const loading = useSettingsStore.getState().fetchAll()
    await useSettingsStore.getState().setIncludeCyberRiskInstruction(false)
    resolveRead({ includeCyberRiskInstruction: true })
    await loading

    expect(useSettingsStore.getState().includeCyberRiskInstruction).toBe(false)
  })

  it('keeps the previous value when saving fails', async () => {
    installSettingsFixture({ includeCyberRiskInstruction: true }, vi.fn().mockRejectedValue(new Error('fixture failure')))
    const { useSettingsStore } = await import('./settingsStore')
    await useSettingsStore.getState().fetchAll()

    await expect(useSettingsStore.getState().setIncludeCyberRiskInstruction(false)).rejects.toThrow('fixture failure')
    expect(useSettingsStore.getState().includeCyberRiskInstruction).toBe(true)
  })
})
