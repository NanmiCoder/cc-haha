import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsApi } from '@/api/settings'
import * as desktopNotifications from '@/lib/desktopNotifications'
import { useOpenTargetStore } from '@/stores/openTargetStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { GeneralSettings } from './GeneralSettings'

function controls() {
  const input = screen.getByRole('spinbutton', { name: '普通 SubAgent 并发上限' })
  const row = input.closest('[data-testid="subagent-concurrency-setting"]') as HTMLElement
  return { input, save: within(row).getByRole('button', { name: '保存' }) }
}

describe('General settings ordinary SubAgent concurrency', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      locale: 'zh',
      maxConcurrentSubagents: null,
      fetchOutputStyles: async () => {},
      fetchAppMode: async () => {},
    })
    useOpenTargetStore.setState({ ensureTargets: async () => {} })
    vi.spyOn(settingsApi, 'updateUser').mockResolvedValue({ ok: true })
    vi.spyOn(desktopNotifications, 'getDesktopNotificationPermission').mockResolvedValue('default')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
    useOpenTargetStore.setState(useOpenTargetStore.getInitialState(), true)
  })

  it('defaults to unlimited, explains the per-session scope, and saves custom N then unlimited', async () => {
    render(<GeneralSettings />)
    const { input, save } = controls()
    expect(input).toHaveValue(null)
    expect(input).toHaveAttribute('placeholder', '不限（默认）')
    expect(screen.getByText(/限制同一会话的普通前台和后台 SubAgent/)).toHaveTextContent('达到上限时拒绝新启动，等已有任务完成后再启动')
    expect(screen.getByText(/主 Agent、Agent Teams、Workflow 不计入/)).toHaveTextContent('运行中的会话也会生效，无需重启')

    fireEvent.change(input, { target: { value: '37' } })
    expect(settingsApi.updateUser).not.toHaveBeenCalled()
    fireEvent.click(save)
    await waitFor(() => expect(save).not.toBeDisabled())
    expect(settingsApi.updateUser).toHaveBeenLastCalledWith({ maxConcurrentSubagents: 37 })
    expect(useSettingsStore.getState().maxConcurrentSubagents).toBe(37)
    expect(input).toHaveValue(37)

    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(save)
    await waitFor(() => expect(save).not.toBeDisabled())
    expect(settingsApi.updateUser).toHaveBeenLastCalledWith({ maxConcurrentSubagents: null })
    expect(useSettingsStore.getState().maxConcurrentSubagents).toBeNull()
    expect(input).toHaveValue(null)
    expect(settingsApi.updateUser).toHaveBeenCalledTimes(2)
  })

  it('hydrates the field when settings arrive after mount', async () => {
    render(<GeneralSettings />)
    await act(async () => {
      useSettingsStore.setState({ maxConcurrentSubagents: 13 })
    })
    expect(controls().input).toHaveValue(13)
  })

  it.each(['0', '-2', '1.5', '9007199254740992', '1e3'])('shows a validation error and does not submit %s', async invalid => {
    useSettingsStore.setState({ maxConcurrentSubagents: 6 })
    await act(async () => { render(<GeneralSettings />) })
    const { input, save } = controls()
    fireEvent.change(input, { target: { value: invalid } })
    fireEvent.click(save)

    expect(screen.getByRole('alert')).toHaveTextContent('请输入正安全整数，或留空表示不限。')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('请输入正安全整数，或留空表示不限。')
    expect(settingsApi.updateUser).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().maxConcurrentSubagents).toBe(6)

    fireEvent.change(input, { target: { value: '9' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not mistake browser badInput with an empty numeric value for unlimited', async () => {
    useSettingsStore.setState({ maxConcurrentSubagents: 6 })
    await act(async () => { render(<GeneralSettings />) })
    const { input, save } = controls()
    // 真实浏览器将未完成的数字输入（例如「1e」）暴露为 value=""。
    // jsdom 无法模拟这种键入状态，因此显式提供有效性标记。
    Object.defineProperty(input, 'validity', { configurable: true, value: { badInput: true } })
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(save)
    expect(screen.getByRole('alert')).toHaveTextContent('请输入正安全整数，或留空表示不限。')
    expect(settingsApi.updateUser).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().maxConcurrentSubagents).toBe(6)

    // 清空「1e」仍然暴露 value=""，React onChange 不一定再次触发；
    // input 事件必须清除过期的有效性标记，允许恢复不限。
    Object.defineProperty(input, 'validity', { configurable: true, value: { badInput: false } })
    fireEvent.input(input, { target: { value: '' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(save)
    await waitFor(() => expect(save).not.toBeDisabled())
    expect(settingsApi.updateUser).toHaveBeenCalledExactlyOnceWith({ maxConcurrentSubagents: null })
    expect(useSettingsStore.getState().maxConcurrentSubagents).toBeNull()
  })

  it('disables editing during save, shows failure, rolls back, and allows retry', async () => {
    let reject!: (error: Error) => void
    vi.mocked(settingsApi.updateUser).mockImplementationOnce(() => new Promise((_resolve, rejectSave) => { reject = rejectSave }))
    useSettingsStore.setState({ maxConcurrentSubagents: 4 })
    render(<GeneralSettings />)
    const { input, save } = controls()
    fireEvent.change(input, { target: { value: '12' } })
    fireEvent.click(save)
    expect(input).toBeDisabled()
    expect(save).toBeDisabled()
    reject(new Error('fixture write failed'))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('SubAgent 并发上限保存失败，请重试。'))
    expect(useSettingsStore.getState().maxConcurrentSubagents).toBe(4)
    expect(input).not.toBeDisabled()
    expect(save).not.toBeDisabled()
    fireEvent.change(input, { target: { value: '12' } })
    fireEvent.click(save)
    await waitFor(() => expect(save).not.toBeDisabled())
    expect(useSettingsStore.getState().maxConcurrentSubagents).toBe(12)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
