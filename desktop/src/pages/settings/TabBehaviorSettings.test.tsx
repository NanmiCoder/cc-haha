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
      locale: 'zh',
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

    const limit = screen.getByLabelText('最多保留的会话标签')
    const restore = screen.getByRole('switch', { name: '启动时恢复上次打开的标签' })
    expect(limit).toHaveValue('unlimited')
    expect(restore).toBeChecked()
    expect(screen.getByText(/关闭标签不会删除会话/)).toBeInTheDocument()

    fireEvent.change(limit, { target: { value: '8' } })
    expect(useTabBehaviorStore.getState().behavior.sessionTabLimit).toBe(8)
    expect(storedBehavior()).toMatchObject({ sessionTabLimit: 8, restoreOnLaunch: true })

    fireEvent.click(restore)
    expect(restore).not.toBeChecked()
    expect(screen.getByText('重新打开应用时标签栏为空，会话仍在左侧列表里。')).toBeInTheDocument()
    expect(storedBehavior()).toMatchObject({ sessionTabLimit: 8, restoreOnLaunch: false })

    fireEvent.change(limit, { target: { value: 'unlimited' } })
    expect(storedBehavior()).toMatchObject({ sessionTabLimit: null, restoreOnLaunch: false })
  })
})
