import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUpdateStore } from '@/stores/updateStore'
import { settingsApi } from '@/api/settings'
import { AboutSettings } from './AboutSettings'

const initialSettingsState = useSettingsStore.getState()
const initialUpdateState = useUpdateStore.getState()

async function renderAboutSettings() {
  render(<AboutSettings />)
  await screen.findByText((_, node) => node?.tagName === 'SPAN' && node.textContent === '版本 0.1.0')
}

beforeEach(async () => {
  useSettingsStore.setState({ locale: 'zh', autoUpdateEnabled: true })
  useUpdateStore.setState({
    status: 'idle',
    availableVersion: null,
    error: null,
    initialize: vi.fn().mockResolvedValue(undefined),
    checkForUpdates: vi.fn().mockResolvedValue(null),
    installUpdate: vi.fn().mockResolvedValue(undefined),
  })
  vi.spyOn(settingsApi, 'updateUser').mockResolvedValue({ ok: true })
  // Establish the persisted fixture as well as the optimistic store value;
  // failed saves must roll back to a successful save, not an arbitrary setState.
  await useSettingsStore.getState().setAutoUpdateEnabled(true)
  vi.mocked(settingsApi.updateUser).mockClear()
})

afterEach(() => {
  cleanup()
  useSettingsStore.setState(initialSettingsState)
  useUpdateStore.setState(initialUpdateState)
  vi.restoreAllMocks()
})

it('shows automatic updates enabled by default with the scope of the setting', async () => {
  await renderAboutSettings()
  expect(screen.getByRole('switch', { name: '自动更新' })).toBeChecked()
  expect(screen.getByText('自动检查新版本并在后台下载；关闭后仍可手动检查与安装。')).toBeInTheDocument()
  await screen.findByText((_, node) => node?.tagName === 'SPAN' && node.textContent === '版本 0.1.0')
})

it('saves automatic updates off and back on through the settings API', async () => {
  await renderAboutSettings()
  const toggle = screen.getByRole('switch', { name: '自动更新' })
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).not.toBeChecked())
  await waitFor(() => expect(toggle).toBeEnabled())
  expect(settingsApi.updateUser).toHaveBeenCalledWith({ autoUpdateEnabled: false })

  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).toBeChecked())
  await waitFor(() => expect(toggle).toBeEnabled())
  expect(settingsApi.updateUser).toHaveBeenLastCalledWith({ autoUpdateEnabled: true })
})

it('disables the switch until saving finishes', async () => {
  let finishSave: (result: { ok: true }) => void = () => {}
  vi.mocked(settingsApi.updateUser).mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve }))
  await renderAboutSettings()
  const toggle = screen.getByRole('switch', { name: '自动更新' })
  fireEvent.click(toggle)
  expect(toggle).toBeDisabled()
  await waitFor(() => expect(settingsApi.updateUser).toHaveBeenCalledOnce())
  await act(async () => { finishSave({ ok: true }) })
  expect(toggle).toBeEnabled()
  expect(toggle).not.toBeChecked()
})

it('surfaces a failed save and restores the previous automatic update setting', async () => {
  vi.mocked(settingsApi.updateUser).mockRejectedValueOnce(new Error('fixture save failed'))
  await renderAboutSettings()
  const toggle = screen.getByRole('switch', { name: '自动更新' })
  fireEvent.click(toggle)
  expect(await screen.findByRole('alert')).toHaveTextContent('自动更新设置保存失败：fixture save failed')
  expect(toggle).toBeChecked()
  expect(toggle).toBeEnabled()
})

it('keeps manual checking and installing available while automatic updates are off', async () => {
  useSettingsStore.setState({ autoUpdateEnabled: false })
  useUpdateStore.setState({ status: 'downloaded', availableVersion: '0.2.0' })
  await renderAboutSettings()
  expect(screen.getByRole('switch', { name: '自动更新' })).not.toBeChecked()
  expect(useUpdateStore.getState().initialize).not.toHaveBeenCalled()
  const check = screen.getByRole('button', { name: '检查更新' })
  const install = screen.getByRole('button', { name: '安装并重启' })
  expect(check).toBeEnabled()
  expect(install).toBeEnabled()
  fireEvent.click(check)
  fireEvent.click(install)
  expect(useUpdateStore.getState().checkForUpdates).toHaveBeenCalledOnce()
  expect(useUpdateStore.getState().installUpdate).toHaveBeenCalledOnce()
  expect(screen.getByText('更新已下载。点击「安装并重启」后应用新版。')).toBeInTheDocument()
  await screen.findByText((_, node) => node?.tagName === 'SPAN' && node.textContent === '版本 0.1.0')
})

it('opens the group QR in a dialog instead of pushing it below the fold', async () => {
  await renderAboutSettings()
  // The version arrives from an async host call; let it settle so the assertion
  // is not racing a state update.
  await screen.findByText((_, node) => node?.tagName === 'SPAN' && node.textContent === '版本 0.1.0')

  const entry = screen.getByRole('button', { name: /加入 cc-haha 交流群/ })
  expect(entry.compareDocumentPosition(screen.getByRole('button', { name: /反馈问题/ })) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  expect(entry).toHaveAttribute('aria-haspopup', 'dialog')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

  fireEvent.click(entry)

  const dialog = screen.getByRole('dialog', { name: '加入 cc-haha 交流群' })
  const qr = screen.getByRole('img', { name: 'cc-haha 企业微信用户群二维码' })
  expect(dialog).toContainElement(qr)
  expect(qr).toHaveAttribute('src', expect.stringContaining('icons/wechat-group-qr.png'))

  fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
