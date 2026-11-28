import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('settingsStore output token escalation preference', () => {
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

  it.each([undefined, 'bogus', true])('loads a missing or invalid value %s as Auto without rewriting settings', async value => {
    const user = value === undefined ? { unknownPreference: 'keep' } : { maxOutputTokensEscalationMode: value }
    const updateUser = installSettingsFixture(user)
    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().maxOutputTokensEscalationMode).toBe('auto')
    expect(updateUser).not.toHaveBeenCalled()
  })

  it.each(['auto', 'enabled', 'disabled'] as const)('persists %s and restores it after a restart', async mode => {
    const user: Record<string, unknown> = { unknownPreference: { keep: true } }
    const updateUser = vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(user, patch)
      return { ok: true }
    })
    installSettingsFixture(user, updateUser)
    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().setMaxOutputTokensEscalationMode(mode)
    expect(updateUser).toHaveBeenCalledWith({ maxOutputTokensEscalationMode: mode })

    vi.resetModules()
    const restarted = await import('./settingsStore')
    await restarted.useSettingsStore.getState().fetchAll()

    expect(restarted.useSettingsStore.getState().maxOutputTokensEscalationMode).toBe(mode)
    expect(user).toEqual({ unknownPreference: { keep: true }, maxOutputTokensEscalationMode: mode })
  })

  it.each(['auto', 'enabled', 'disabled'] as const)('restores the saved %s choice when a write fails', async previous => {
    let rejectSave!: (error: Error) => void
    const updateUser = vi.fn(() => new Promise<{ ok: boolean }>((_, reject) => { rejectSave = reject }))
    installSettingsFixture({ maxOutputTokensEscalationMode: previous }, updateUser)
    const { useSettingsStore } = await import('./settingsStore')
    await useSettingsStore.getState().fetchAll()
    const next = previous === 'enabled' ? 'disabled' : 'enabled'
    const saving = useSettingsStore.getState().setMaxOutputTokensEscalationMode(next)
    const rejected = expect(saving).rejects.toThrow('fixture save failed')

    expect(useSettingsStore.getState().maxOutputTokensEscalationMode).toBe(next)
    await vi.waitFor(() => expect(updateUser).toHaveBeenCalledTimes(1))
    rejectSave(new Error('fixture save failed'))
    await rejected

    expect(useSettingsStore.getState().maxOutputTokensEscalationMode).toBe(previous)
  })

  it.each([
    ['success', 'success', 'disabled'],
    ['failure', 'success', 'disabled'],
    ['success', 'failure', 'enabled'],
    ['failure', 'failure', 'auto'],
  ] as const)('orders overlapping saves ending in %s then %s and restores %s', async (firstOutcome, secondOutcome, expected) => {
    let resolveFirst!: () => void
    let rejectFirst!: (error: Error) => void
    let resolveSecond!: () => void
    let rejectSecond!: (error: Error) => void
    const user: Record<string, unknown> = { maxOutputTokensEscalationMode: 'auto' }
    const updateUser = vi.fn()
      .mockImplementationOnce(async (patch: Record<string, unknown>) => {
        await new Promise<void>((resolve, reject) => {
          resolveFirst = resolve
          rejectFirst = reject
        })
        Object.assign(user, patch)
        return { ok: true }
      })
      .mockImplementationOnce(async (patch: Record<string, unknown>) => {
        await new Promise<void>((resolve, reject) => {
          resolveSecond = resolve
          rejectSecond = reject
        })
        Object.assign(user, patch)
        return { ok: true }
      })
    installSettingsFixture(user, updateUser)
    const { useSettingsStore } = await import('./settingsStore')
    await useSettingsStore.getState().fetchAll()

    const first = useSettingsStore.getState().setMaxOutputTokensEscalationMode('enabled')
    const second = useSettingsStore.getState().setMaxOutputTokensEscalationMode('disabled')
    const settled = Promise.allSettled([first, second])
    await vi.waitFor(() => expect(updateUser).toHaveBeenCalled())
    const callsWhileFirstPending = updateUser.mock.calls.length
    if (firstOutcome === 'success') resolveFirst()
    else rejectFirst(new Error('fixture first save failed'))
    await vi.waitFor(() => expect(updateUser).toHaveBeenCalledTimes(2))
    const choiceWhileSecondPending = useSettingsStore.getState().maxOutputTokensEscalationMode
    if (secondOutcome === 'success') resolveSecond()
    else rejectSecond(new Error('fixture second save failed'))
    const results = await settled

    expect(callsWhileFirstPending).toBe(1)
    expect(choiceWhileSecondPending).toBe('disabled')
    expect(updateUser.mock.calls).toEqual([
      [{ maxOutputTokensEscalationMode: 'enabled' }],
      [{ maxOutputTokensEscalationMode: 'disabled' }],
    ])
    expect(results.map(result => result.status)).toEqual([
      firstOutcome === 'success' ? 'fulfilled' : 'rejected',
      secondOutcome === 'success' ? 'fulfilled' : 'rejected',
    ])
    expect(useSettingsStore.getState().maxOutputTokensEscalationMode).toBe(expected)
    expect(user.maxOutputTokensEscalationMode).toBe(expected)
  })

  describe.each(['success', 'failure'] as const)('settings reads around a save ending in %s', outcome => {
    it.each([
      ['before', 'before'],
      ['before', 'after'],
      ['during', 'before'],
      ['during', 'after'],
    ] as const)('ignores a stale read started %s the save and resolved %s settlement', async (readStart, readFinish) => {
      let resolveSave!: (value: { ok: boolean }) => void
      let rejectSave!: (error: Error) => void
      let resolveRead!: (value: Record<string, unknown>) => void
      const updateUser = vi.fn(() => new Promise<{ ok: boolean }>((resolve, reject) => {
        resolveSave = resolve
        rejectSave = reject
      }))
      installSettingsFixture({ maxOutputTokensEscalationMode: 'auto' }, updateUser)
      const { useSettingsStore } = await import('./settingsStore')
      const { settingsApi } = await import('../api/settings')
      await useSettingsStore.getState().fetchAll()
      vi.mocked(settingsApi.getUser).mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve }))

      let loading: Promise<void>
      let saving: Promise<void>
      if (readStart === 'before') {
        loading = useSettingsStore.getState().fetchAll()
        saving = useSettingsStore.getState().setMaxOutputTokensEscalationMode('enabled')
      } else {
        saving = useSettingsStore.getState().setMaxOutputTokensEscalationMode('enabled')
        loading = useSettingsStore.getState().fetchAll()
      }
      // Handle rejection immediately while controlling the two responses independently.
      const settledSave = outcome === 'failure'
        ? expect(saving).rejects.toThrow('fixture save failed')
        : saving
      await vi.waitFor(() => expect(updateUser).toHaveBeenCalledTimes(1))

      if (readFinish === 'before') {
        resolveRead({ maxOutputTokensEscalationMode: 'auto' })
        await loading
        expect(useSettingsStore.getState().maxOutputTokensEscalationMode).toBe('enabled')
      }

      if (outcome === 'failure') rejectSave(new Error('fixture save failed'))
      else resolveSave({ ok: true })
      await settledSave

      if (readFinish === 'after') {
        resolveRead({ maxOutputTokensEscalationMode: 'auto' })
        await loading
      }
      expect(useSettingsStore.getState().maxOutputTokensEscalationMode).toBe(outcome === 'success' ? 'enabled' : 'auto')

      // A fresh fetch after settlement can still hydrate a later server-side change.
      vi.mocked(settingsApi.getUser).mockResolvedValueOnce({ maxOutputTokensEscalationMode: 'disabled' })
      await useSettingsStore.getState().fetchAll()
      expect(useSettingsStore.getState().maxOutputTokensEscalationMode).toBe('disabled')
    })
  })
})
