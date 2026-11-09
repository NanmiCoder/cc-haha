import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WechatConnectionStatus } from './WechatConnectionStatus'

const mocks = vi.hoisted(() => ({ get: vi.fn(), restart: vi.fn() }))
vi.mock('../../api/adapters', () => ({ adaptersApi: { getWechatRuntime: mocks.get } }))
vi.mock('../../lib/desktopHost', () => ({ getDesktopHost: () => ({ isDesktop: true, adapters: { restartSidecar: mocks.restart } }) }))
vi.mock('../../i18n', () => ({ useTranslation: () => (key: string) => key }))

beforeEach(() => { vi.resetAllMocks(); mocks.restart.mockResolvedValue(undefined) })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('WeChat connection status', () => {
  it('shows pairing separately from a live channel and never infers online from binding', async () => {
    mocks.get.mockResolvedValue({ state: 'stopped', serverReachable: false })
    render(<WechatConnectionStatus paired />)
    await screen.findByText('settings.adapters.wechatHealthStopped')
    expect(screen.queryByText('settings.adapters.wechatHealthOnline')).toBeNull()
    expect(screen.getByText('settings.adapters.wechatHealthPaired')).toBeTruthy()
  })

  it('replaces a previously online status when the local server becomes unreachable', async () => {
    vi.useFakeTimers()
    mocks.get.mockResolvedValueOnce({ state: 'online', serverReachable: true }).mockRejectedValue(new Error('offline'))
    render(<WechatConnectionStatus paired={false} />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('settings.adapters.wechatHealthOnline')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(screen.getByText('settings.adapters.wechatHealthServerOffline')).toBeTruthy()
    expect(screen.queryByText('settings.adapters.wechatHealthOnline')).toBeNull()
  })

  it('targets WeChat reconnect and waits for actual health instead of displaying online optimistically', async () => {
    mocks.get.mockResolvedValue({ state: 'stale', serverReachable: false })
    render(<WechatConnectionStatus paired />)
    await screen.findByText('settings.adapters.wechatHealthStale')
    mocks.get.mockResolvedValue({ state: 'starting', serverReachable: true })
    fireEvent.click(screen.getByRole('button', { name: 'settings.adapters.wechatHealthReconnect' }))
    await waitFor(() => expect(mocks.restart).toHaveBeenCalledWith('wechat'))
    await screen.findByText('settings.adapters.wechatHealthStarting')
    expect(screen.queryByText('settings.adapters.wechatHealthOnline')).toBeNull()
  })

  it('shows a reconnect failure instead of reporting success', async () => {
    mocks.get.mockResolvedValue({ state: 'stopped', serverReachable: false })
    mocks.restart.mockRejectedValue(new Error('process has not stopped'))
    render(<WechatConnectionStatus paired />)
    await screen.findByText('settings.adapters.wechatHealthStopped')
    fireEvent.click(screen.getByRole('button', { name: 'settings.adapters.wechatHealthReconnect' }))
    expect((await screen.findByRole('alert')).textContent).toBe('settings.adapters.wechatHealthRestartFailed')
  })
})
