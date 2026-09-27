import { beforeEach, describe, expect, it, vi } from 'vitest'

const { updateUser } = vi.hoisted(() => ({ updateUser: vi.fn() }))
vi.mock('../api/settings', () => ({ settingsApi: { updateUser } }))

import { useSettingsStore } from './settingsStore'

describe('settingsStore automatic question answers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  })

  it('starts disabled and persists a configured wait', async () => {
    updateUser.mockResolvedValue(undefined)
    expect(useSettingsStore.getState().autoQuestion).toEqual({
      enabled: false,
      timeoutMinutes: 5,
    })

    await useSettingsStore.getState().setAutoQuestion({ enabled: true, timeoutMinutes: 10 })

    expect(updateUser).toHaveBeenCalledWith({
      autoQuestion: { enabled: true, timeoutMinutes: 10 },
    })
    expect(useSettingsStore.getState().autoQuestion).toEqual({ enabled: true, timeoutMinutes: 10 })
  })

  it('restores the previous value when saving fails', async () => {
    updateUser.mockRejectedValueOnce(new Error('disk unavailable'))

    await expect(useSettingsStore.getState().setAutoQuestion({
      enabled: true,
      timeoutMinutes: 5,
    })).rejects.toThrow('disk unavailable')

    expect(useSettingsStore.getState().autoQuestion.enabled).toBe(false)
  })

  it('keeps a newer choice when an earlier save fails', async () => {
    let rejectFirst!: (reason: Error) => void
    updateUser.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectFirst = reject
    })).mockResolvedValueOnce({ ok: true })

    const first = useSettingsStore.getState().setAutoQuestion({ enabled: true, timeoutMinutes: 5 })
    const second = useSettingsStore.getState().setAutoQuestion({ enabled: true, timeoutMinutes: 10 })
    await Promise.resolve()
    rejectFirst(new Error('first save failed'))
    await expect(first).rejects.toThrow('first save failed')
    await second

    expect(useSettingsStore.getState().autoQuestion).toEqual({ enabled: true, timeoutMinutes: 10 })
    expect(updateUser.mock.calls.map(([body]) => body.autoQuestion.timeoutMinutes)).toEqual([5, 10])
  })
})
