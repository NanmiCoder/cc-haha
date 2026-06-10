import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

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

vi.mock('../lib/desktopNotifications', () => ({
  getDesktopNotificationPermission: vi.fn().mockResolvedValue('unsupported'),
  notifyDesktop: vi.fn(),
  openDesktopNotificationSettings: vi.fn(),
  requestDesktopNotificationPermission: vi.fn().mockResolvedValue('unsupported'),
}))

vi.mock('../lib/desktopRuntime', () => ({
  isDesktopRuntime: () => false,
}))

import { GeneralSettings } from './Settings'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'

describe('GeneralSettings output style', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
    useSessionStore.setState(useSessionStore.getInitialState(), true)
    useSettingsStore.setState({ locale: 'en' })
    useSessionStore.setState({
      activeSessionId: 'session-1',
      sessions: [
        {
          id: 'session-1',
          title: 'Project session',
          createdAt: '2026-06-09T00:00:00.000Z',
          modifiedAt: '2026-06-09T00:00:00.000Z',
          messageCount: 0,
          projectPath: '/repo',
          projectRoot: '/repo',
          workDir: '/repo',
          workDirExists: true,
        },
      ],
    })
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
        {
          value: 'Learning',
          label: 'Learning',
          description: 'Hands-on practice',
          source: 'built-in',
        },
      ],
    })
    settingsApiMock.setOutputStyle.mockResolvedValue({
      ok: true,
      outputStyle: 'Learning',
      scope: 'localSettings',
      workDir: '/repo',
    })
  })

  it('renders project output styles and saves the selected style', async () => {
    render(<GeneralSettings />)

    expect(await screen.findByText('Project Style')).toBeInTheDocument()
    expect(settingsApiMock.getOutputStyles).toHaveBeenCalledWith('/repo')
    expect(screen.getByText('Saved to .claude/settings.local.json for the active project.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Select output style' }))
    fireEvent.click(screen.getByText('Learning'))

    await waitFor(() => {
      expect(settingsApiMock.setOutputStyle).toHaveBeenCalledWith('Learning', '/repo')
    })

    await act(async () => {
      await Promise.resolve()
    })
    expect(useSettingsStore.getState().outputStyle).toBe('Learning')
  })
})
