import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { useSettingsStore } from '../stores/settingsStore'
import { ErrorBoundary } from './ErrorBoundary'
import { reportReactError } from '../lib/diagnosticsCapture'

vi.mock('../lib/diagnosticsCapture', () => ({
  reportReactError: vi.fn(),
}))

vi.mock('./doctor/DoctorPanel', () => ({
  DoctorPanel: ({ compact }: { compact?: boolean }) => (
    <div data-testid="doctor-panel">{compact ? 'compact doctor' : 'doctor'}</div>
  ),
}))

function CrashingChild(): never {
  throw new Error('boom')
}

describe('ErrorBoundary', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    vi.clearAllMocks()
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  it('shows retry and compact Doctor fallback when a child crashes', () => {
    render(
      <ErrorBoundary>
        <CrashingChild />
      </ErrorBoundary>,
    )

    expect(screen.getByText('Something went wrong.')).toBeInTheDocument()
    expect(screen.getByText('The error was recorded in Diagnostics.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.getByTestId('doctor-panel')).toHaveTextContent('compact doctor')
    expect(reportReactError).toHaveBeenCalled()
  })
})
