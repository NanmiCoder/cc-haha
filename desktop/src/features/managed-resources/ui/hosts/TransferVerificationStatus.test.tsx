import { act, cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import type { ManagedTransferJob } from '../../api/hostManagementApi'
import { TransferVerificationStatus } from './TransferVerificationStatus'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100000); useSettingsStore.setState({ locale: 'en' }) })
afterEach(() => { cleanup(); vi.useRealTimers() })
const job = { id: 'fixture', size: 1024 ** 3, transferred: 1024 ** 3, verifiedBytes: 0, state: 'verifying', verificationStartedAt: 100000, verificationMethod: 'remote-sha256' } as ManagedTransferJob

describe('verification is separate from transferred bytes', () => {
  it('uses indeterminate remote hashing with elapsed time instead of a false completed percentage', () => {
    const view = render(<TransferVerificationStatus job={job} />)
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('value')
    act(() => vi.advanceTimersByTime(7000))
    expect(screen.getByTestId('transfer-verification-status')).toHaveTextContent('7s elapsed')
    view.rerender(<TransferVerificationStatus job={{ ...job, state: 'completed' }} />)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('shows actual read-back bytes when remote SHA-256 is unavailable', () => {
    const view = render(<TransferVerificationStatus job={{ ...job, verificationMethod: 'stream-sha256', verifiedBytes: 512 * 1024 ** 2 }} />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', String(512 * 1024 ** 2))
    expect(screen.getByTestId('transfer-verification-status')).toHaveTextContent('512.0 / 1024.0 MiB')
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
