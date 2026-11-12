import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_TAB_BEHAVIOR, TAB_BEHAVIOR_STORAGE_KEY } from '@/lib/tabBehavior'
import { useOpenTargetStore } from '@/stores/openTargetStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useTabBehaviorStore } from '@/stores/tabBehaviorStore'
import { GeneralSettings } from './GeneralSettings'

const storedBehavior = () => JSON.parse(localStorage.getItem(TAB_BEHAVIOR_STORAGE_KEY) ?? 'null')

describe('tab settings in General', () => {
  beforeEach(() => {
    localStorage.clear()
    useSettingsStore.setState({
      locale: 'en',
      fetchOutputStyles: async () => {},
      fetchAppMode: async () => {},
    })
    useOpenTargetStore.setState({ ensureTargets: async () => {} })
    useTabBehaviorStore.setState({ behavior: { ...DEFAULT_TAB_BEHAVIOR } })
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
    useOpenTargetStore.setState(useOpenTargetStore.getInitialState(), true)
  })

  it('shows today\'s behavior by default and saves a limit and the launch choice', async () => {
    // Let the page's own startup reads (notification permission and the like) settle.
    await act(async () => {
      render(<GeneralSettings />)
    })

    const limit = screen.getByLabelText('Session tabs to keep')
    const restore = screen.getByRole('switch', { name: 'Restore tabs on launch' })
    expect(limit).toHaveValue('unlimited')
    expect(restore).toBeChecked()
    expect(screen.getByText(/Closing a tab never deletes the session/)).toBeInTheDocument()

    fireEvent.change(limit, { target: { value: '8' } })
    expect(useTabBehaviorStore.getState().behavior.sessionTabLimit).toBe(8)
    expect(storedBehavior()).toMatchObject({ sessionTabLimit: 8, restoreOnLaunch: true })

    fireEvent.click(restore)
    expect(restore).not.toBeChecked()
    expect(screen.getByText('The app starts with no tabs open. Your sessions stay in the sidebar.')).toBeInTheDocument()
    expect(storedBehavior()).toMatchObject({ sessionTabLimit: 8, restoreOnLaunch: false })

    fireEvent.change(limit, { target: { value: 'unlimited' } })
    expect(storedBehavior()).toMatchObject({ sessionTabLimit: null, restoreOnLaunch: false })
  })
})
