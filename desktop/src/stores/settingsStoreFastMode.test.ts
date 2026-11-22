import { afterEach, describe, expect, it, vi } from 'vitest'
import { settingsApi } from '../api/settings'
import { useChatStore } from './chatStore'
import { useSettingsStore } from './settingsStore'
import { useUIStore } from './uiStore'

afterEach(() => {
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useChatStore.setState(useChatStore.getInitialState(), true)
  useUIStore.setState(useUIStore.getInitialState(), true)
  vi.restoreAllMocks()
})

describe('settingsStore fastMode', () => {
  it('persists fastMode=true and clears with null on disable', async () => {
    const updateUser = vi.spyOn(settingsApi, 'updateUser').mockResolvedValue({ ok: true })

    await useSettingsStore.getState().setFastMode(true)
    expect(useSettingsStore.getState().fastMode).toBe(true)
    expect(updateUser).toHaveBeenLastCalledWith({ fastMode: true })

    await useSettingsStore.getState().setFastMode(false)
    expect(useSettingsStore.getState().fastMode).toBe(false)
    expect(updateUser).toHaveBeenLastCalledWith({ fastMode: null })
  })

  it('rolls back fastMode state when persistence fails', async () => {
    vi.spyOn(settingsApi, 'updateUser').mockRejectedValue(new Error('disk full'))

    await expect(useSettingsStore.getState().setFastMode(true)).rejects.toThrow('disk full')
    expect(useSettingsStore.getState().fastMode).toBe(false)
  })

  it('serializes rapid toggles and does not roll back newer intent on earlier failure', async () => {
    let rejectFirst!: (err: Error) => void
    let resolveSecond!: (val: { ok: true }) => void
    const updateUser = vi
      .spyOn(settingsApi, 'updateUser')
      .mockImplementationOnce(
        () => new Promise((_res, rej) => { rejectFirst = rej }),
      )
      .mockImplementationOnce(
        () => new Promise((res) => { resolveSecond = res }),
      )

    const p1 = useSettingsStore.getState().setFastMode(true)
    const p2 = useSettingsStore.getState().setFastMode(false)
    expect(useSettingsStore.getState().fastMode).toBe(false)

    await Promise.resolve()
    await Promise.resolve()
    rejectFirst(new Error('transient'))
    await expect(p1).rejects.toThrow('transient')
    // Second write is still in flight / newer saveVersion, so UI stays false.
    expect(useSettingsStore.getState().fastMode).toBe(false)

    await Promise.resolve()
    await Promise.resolve()
    resolveSecond({ ok: true })
    await p2
    expect(useSettingsStore.getState().fastMode).toBe(false)
    expect(updateUser).toHaveBeenNthCalledWith(1, { fastMode: true })
    expect(updateUser).toHaveBeenNthCalledWith(2, { fastMode: null })
  })

  it('disables fastMode and warns when chatStore receives org_disabled or overage_rejected fast_mode_status', () => {
    useSettingsStore.setState({ fastMode: true })
    useChatStore.getState().handleServerMessage('sess-fm', {
      type: 'system_notification',
      subtype: 'fast_mode_status',
      message: 'Fast mode has been disabled by your organization',
      data: { fastModeState: 'off', reason: 'org_disabled' },
    })

    expect(useSettingsStore.getState().fastMode).toBe(false)
    expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
      type: 'warning',
      message: 'Fast mode has been disabled by your organization',
    })

    // Cooldown shows an info toast without clearing the user preference
    useSettingsStore.setState({ fastMode: true })
    useChatStore.getState().handleServerMessage('sess-fm', {
      type: 'system_notification',
      subtype: 'fast_mode_status',
      message: 'Fast mode rate limited (resuming in ~30s)',
      data: { fastModeState: 'cooldown', reason: 'rate_limit', resetAt: Date.now() + 30_000 },
    })
    expect(useSettingsStore.getState().fastMode).toBe(true)
    expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
      type: 'info',
      message: 'Fast mode rate limited (resuming in ~30s)',
    })
  })
})
