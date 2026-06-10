import { beforeEach, describe, expect, it, vi } from 'vitest'

const { settingsApiMock } = vi.hoisted(() => ({
  settingsApiMock: {
    getPermissionMode: vi.fn(),
    getUser: vi.fn(),
    updateUser: vi.fn(),
    getOutputStyles: vi.fn(),
    setOutputStyle: vi.fn(),
  },
}))

vi.mock('../api/settings', () => ({
  settingsApi: settingsApiMock,
}))

vi.mock('../api/models', () => ({
  modelsApi: {
    list: vi.fn(),
    getCurrent: vi.fn(),
    getEffort: vi.fn(),
    setCurrent: vi.fn(),
    setEffort: vi.fn(),
  },
}))

vi.mock('../api/h5Access', () => ({
  h5AccessApi: {
    get: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    regenerate: vi.fn(),
    update: vi.fn(),
  },
}))

import { useSettingsStore } from './settingsStore'

describe('settingsStore output styles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  })

  it('loads output styles for the active workdir', async () => {
    settingsApiMock.getOutputStyles.mockResolvedValue({
      outputStyle: 'Project Style',
      scope: 'localSettings',
      workDir: '/repo',
      styles: [
        {
          value: 'default',
          label: 'Default',
          description: 'Default style',
          source: 'built-in',
        },
        {
          value: 'Project Style',
          label: 'Project Style',
          description: 'Project custom voice',
          source: 'projectSettings',
        },
      ],
    })

    await useSettingsStore.getState().fetchOutputStyles('/repo')

    expect(settingsApiMock.getOutputStyles).toHaveBeenCalledWith('/repo')
    expect(useSettingsStore.getState().outputStyle).toBe('Project Style')
    expect(useSettingsStore.getState().outputStyleScope).toBe('localSettings')
    expect(useSettingsStore.getState().outputStyleWorkDir).toBe('/repo')
    expect(useSettingsStore.getState().outputStyles).toContainEqual(
      expect.objectContaining({
        value: 'Project Style',
        source: 'projectSettings',
      }),
    )
  })

  it('saves output style and rolls back on failure', async () => {
    useSettingsStore.setState({
      outputStyle: 'default',
      outputStyleScope: 'localSettings',
      outputStyleWorkDir: '/repo',
      outputStyleError: null,
    })
    settingsApiMock.setOutputStyle.mockRejectedValueOnce(new Error('save failed'))

    await expect(
      useSettingsStore.getState().setOutputStyle('Learning', '/repo'),
    ).rejects.toThrow('save failed')

    expect(settingsApiMock.setOutputStyle).toHaveBeenCalledWith('Learning', '/repo')
    expect(useSettingsStore.getState().outputStyle).toBe('default')
    expect(useSettingsStore.getState().outputStyleError).toBe('save failed')

    settingsApiMock.setOutputStyle.mockResolvedValueOnce({
      ok: true,
      outputStyle: 'Learning',
      scope: 'localSettings',
      workDir: '/repo',
    })

    await useSettingsStore.getState().setOutputStyle('Learning', '/repo')

    expect(useSettingsStore.getState().outputStyle).toBe('Learning')
    expect(useSettingsStore.getState().outputStyleError).toBeNull()
  })
})
