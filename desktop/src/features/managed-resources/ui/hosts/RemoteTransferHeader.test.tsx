import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { useSettingsStore } from '@/stores/settingsStore'
import { RemoteTransferHeader } from './RemoteTransferHeader'
import type { RemoteTransferTask } from './useRemoteTransfers'

function task(id: string, direction: 'upload' | 'download' = 'upload'): RemoteTransferTask {
  const remotePath = `/srv/${id}.bin`
  return { id, direction, remotePath, folder: false, state: 'in_progress', active: true, picking: false, cancelling: false, error: null,
    job: { id, direction, remotePath, connectionId: 'connection', generation: 1, size: 1573 * 1024 ** 2, transferred: 39.6 * 1024 ** 2,
      state: 'in_progress', checksum: null, error: null, startedAt: 1, finishedAt: null } }
}
beforeEach(() => { useSettingsStore.setState({ locale: 'en' }); vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })

describe('remote transfer header carousel', () => {
  it('is absent when idle and shows a named upload with actual byte progress', () => {
    const onCancel = vi.fn(async () => {})
    const view = render(<RemoteTransferHeader tasks={[]} onCancel={onCancel} />)
    expect(screen.queryByRole('status')).toBeNull()
    view.rerender(<RemoteTransferHeader tasks={[task('archive')]} onCancel={onCancel} />)
    expect(screen.getByRole('status')).toHaveTextContent('Uploadarchive.bin')
    expect(screen.getByRole('status')).toHaveTextContent('39.6 MiB / 1573.0 MiB')
    expect(screen.queryByRole('button', { name: 'Next transfer' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel transfer' }))
    expect(onCancel).toHaveBeenCalledExactlyOnceWith('archive')
  })
  it('rotates every three seconds even while progress is updated every 300ms', () => {
    const onCancel = vi.fn(async () => {})
    const first = task('first')
    const second = task('second', 'download')
    const view = render(<RemoteTransferHeader tasks={[first, second]} onCancel={onCancel} />)
    for (let i = 0; i < 9; i++) {
      tick(300)
      view.rerender(<RemoteTransferHeader tasks={[{ ...first, job: { ...first.job!, transferred: i } }, second]} onCancel={onCancel} />)
    }
    expect(screen.getByRole('status')).toHaveTextContent('first.bin')
    tick(300)
    expect(screen.getByRole('status')).toHaveTextContent('Downloadsecond.bin')
    tick(3000)
    expect(screen.getByRole('status')).toHaveTextContent('first.bin')
    expect(onCancel).not.toHaveBeenCalled()
  })
  it('pauses on hover/focus and explicit pause, with manual controls and exact cancellation target', () => {
    const onCancel = vi.fn(async () => {})
    render(<RemoteTransferHeader tasks={[task('first'), task('second')]} onCancel={onCancel} />)
    const group = screen.getByRole('group')
    fireEvent.mouseEnter(group)
    tick(6000)
    expect(screen.getByRole('status')).toHaveTextContent('first.bin')
    fireEvent.click(screen.getByRole('button', { name: 'Next transfer' }))
    fireEvent.focus(screen.getByRole('button', { name: 'Cancel transfer' }))
    fireEvent.mouseLeave(group)
    tick(6000)
    expect(screen.getByRole('status')).toHaveTextContent('second.bin')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel transfer' }))
    expect(onCancel).toHaveBeenCalledExactlyOnceWith('second')
    fireEvent.blur(screen.getByRole('button', { name: 'Cancel transfer' }), { relatedTarget: document.body })
    fireEvent.click(screen.getByRole('button', { name: 'Pause transfer rotation' }))
    tick(6000)
    expect(screen.getByRole('status')).toHaveTextContent('second.bin')
    fireEvent.click(screen.getByRole('button', { name: 'Previous transfer' }))
    expect(screen.getByRole('status')).toHaveTextContent('first.bin')
    fireEvent.click(screen.getByRole('button', { name: 'Resume transfer rotation' }))
    tick(3000)
    expect(screen.getByRole('status')).toHaveTextContent('second.bin')
  })
  it('retains an indeterminate remote checksum phase instead of presenting upload 100% as completed', () => {
    const value = task('verify')
    value.state = 'verifying'
    Object.assign(value.job!, { state: 'verifying', transferred: value.job!.size, verificationMethod: 'remote-sha256', verificationStartedAt: Date.now() })
    const view = render(<RemoteTransferHeader tasks={[value]} onCancel={vi.fn()} />)
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('value')
    expect(screen.getByRole('status')).toHaveTextContent('Remote SHA-256')
    expect(screen.getByRole('status')).not.toHaveTextContent('100.0%')
    tick(3000)
    expect(screen.getByRole('status')).toHaveTextContent('3s elapsed')
    expect(screen.queryByText('Transfer completed.')).toBeNull()
    view.rerender(<RemoteTransferHeader tasks={[{ ...value, state: 'failed', active: false, error: 'VERIFY_TIMEOUT' }]} onCancel={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('VERIFY_TIMEOUT')
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel transfer' })).toBeNull()
  })
  it('handles completed/failed/removed tasks without stale cancel buttons', () => {
    const onCancel = vi.fn()
    const first = task('first')
    const second = task('second')
    const view = render(<RemoteTransferHeader tasks={[first, second]} onCancel={onCancel} />)
    tick(3000)
    view.rerender(<RemoteTransferHeader tasks={[{ ...first, active: false, state: 'failed', error: 'NO_SPACE' }]} onCancel={onCancel} />)
    expect(screen.getByRole('status')).toHaveTextContent('NO_SPACE')
    expect(screen.queryByRole('button', { name: 'Cancel transfer' })).toBeNull()
    view.rerender(<RemoteTransferHeader tasks={[]} onCancel={onCancel} />)
    tick(6000)
    expect(screen.queryByRole('status')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('respects reduced-motion preference while keeping manual switching available', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
    render(<RemoteTransferHeader tasks={[task('first'), task('second')]} onCancel={vi.fn()} />)
    tick(9000)
    expect(screen.getByRole('status')).toHaveTextContent('first.bin')
    fireEvent.click(screen.getByRole('button', { name: 'Next transfer' }))
    expect(screen.getByRole('status')).toHaveTextContent('second.bin')
    fireEvent.click(screen.getByRole('button', { name: 'Resume transfer rotation' }))
    tick(3000)
    expect(screen.getByRole('status')).toHaveTextContent('first.bin')
  })
})
