import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsApi } from '@/api/settings'
import { useOpenTargetStore } from '@/stores/openTargetStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { CyberRiskInstructionSettings } from './CyberRiskInstructionSettings'
import { GeneralSettings } from './GeneralSettings'

describe('CyberRiskInstructionSettings', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      locale: 'zh',
      includeCyberRiskInstruction: true,
      fetchOutputStyles: async () => {},
      fetchAppMode: async () => {},
    })
    useOpenTargetStore.setState({ ensureTargets: async () => {} })
    vi.spyOn(settingsApi, 'updateUser').mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
    useOpenTargetStore.setState(useOpenTargetStore.getInitialState(), true)
  })

  it('defaults off (keeping built-in prompts) and announces saving without an unconfirmed state', async () => {
    let resolve!: (value: { ok: true }) => void
    vi.mocked(settingsApi.updateUser).mockImplementation(() => new Promise(done => { resolve = done }))
    render(<CyberRiskInstructionSettings />)

    const toggle = screen.getByRole('switch', { name: '第三方模型跳过安全检查提示词' })
    expect(toggle).not.toBeChecked()
    expect(screen.getByRole('status')).toHaveTextContent('已关闭')
    expect(toggle).toHaveAccessibleDescription(/不影响 Claude 官方账号/)

    fireEvent.click(toggle)
    expect(toggle).toBeDisabled()
    expect(toggle).not.toBeChecked()
    expect(screen.getByRole('status')).toHaveTextContent('正在保存')
    await waitFor(() => expect(resolve).toBeTypeOf('function'))
    expect(settingsApi.updateUser).toHaveBeenCalledWith({ includeCyberRiskInstruction: false })

    await act(async () => resolve({ ok: true }))
    expect(toggle).toBeChecked()
    expect(toggle).not.toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('已开启')
  })

  it('associates inline error with the switch and clears it on retry', async () => {
    vi.mocked(settingsApi.updateUser).mockRejectedValueOnce(new Error('offline'))
    render(<CyberRiskInstructionSettings />)

    const toggle = screen.getByRole('switch', { name: '第三方模型跳过安全检查提示词' })
    fireEvent.click(toggle)
    expect(await screen.findByRole('alert')).toHaveTextContent('已保留原设置')
    expect(toggle).not.toBeChecked()
    expect(toggle).toHaveAccessibleDescription(/重新切换以重试/)

    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toBeChecked())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps omitted state when restoring defaults fails', async () => {
    useSettingsStore.setState({ includeCyberRiskInstruction: false })
    vi.mocked(settingsApi.updateUser).mockRejectedValueOnce(new Error('offline'))
    render(<CyberRiskInstructionSettings />)

    const toggle = screen.getByRole('switch', { name: '第三方模型跳过安全检查提示词' })
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)
    await screen.findByRole('alert')
    expect(toggle).toBeChecked()
    expect(toggle).not.toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('已开启')
  })

  it('renders in GeneralSettings and persists toggling both ways', async () => {
    render(<GeneralSettings />)
    const toggle = screen.getByRole('switch', { name: '第三方模型跳过安全检查提示词' })
    expect(toggle).not.toBeChecked()

    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toBeChecked())
    expect(settingsApi.updateUser).toHaveBeenCalledWith({ includeCyberRiskInstruction: false })

    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(settingsApi.updateUser).toHaveBeenLastCalledWith({ includeCyberRiskInstruction: true })
  })
})
