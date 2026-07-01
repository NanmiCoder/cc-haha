import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { LspStatusIndicator } from './LspStatusIndicator'
import type { LspDiagnostic, LegacyWorkspaceLspState } from '../../types/lsp'

const READY: LegacyWorkspaceLspState = { state: 'ready', workspaceId: 'w1', errorCount: 0 }
const READY_ERRORS: LegacyWorkspaceLspState = { state: 'ready', workspaceId: 'w1', errorCount: 3 }
const STARTING: LegacyWorkspaceLspState = { state: 'starting', workspaceId: 'w1', errorCount: 0 }
const UNAVAILABLE_PREREQ: LegacyWorkspaceLspState = {
  state: 'unavailable',
  workspaceId: 'w1',
  reason: 'prereq-missing',
  errorCount: 0,
}
const UNAVAILABLE_CRASHED: LegacyWorkspaceLspState = {
  state: 'unavailable',
  workspaceId: 'w1',
  reason: 'crashed',
  errorCount: 0,
}

const sampleDiagnostic = (overrides: Partial<LspDiagnostic> = {}): LspDiagnostic => ({
  path: 'src/a.ts',
  line: 1,
  column: 1,
  severity: 'error',
  message: 'type mismatch',
  ...overrides,
})

describe('LspStatusIndicator', () => {
  it('renders "Ready" when state is ready with zero errors', () => {
    render(<LspStatusIndicator state={READY} diagnostics={[]} />)
    expect(screen.getByTestId('lsp-status-label').textContent).toBe('Ready')
    expect(screen.queryByTestId('lsp-status-install')).toBeNull()
    expect(screen.queryByTestId('lsp-status-retry')).toBeNull()
  })

  it('renders "N errors detected" when state is ready with N>0 errors', () => {
    render(<LspStatusIndicator state={READY_ERRORS} diagnostics={[]} />)
    expect(screen.getByTestId('lsp-status-label').textContent).toBe('3 errors detected')
  })

  it('caps the error count display at 9999+', () => {
    render(
      <LspStatusIndicator
        state={{ state: 'ready', workspaceId: 'w1', errorCount: 50_000 }}
        diagnostics={[]}
      />,
    )
    expect(screen.getByTestId('lsp-status-label').textContent).toBe('9999+ errors detected')
  })

  it('renders "Starting language server…" when state is starting', () => {
    render(<LspStatusIndicator state={STARTING} diagnostics={[]} />)
    expect(screen.getByTestId('lsp-status-label').textContent).toBe('Starting language server…')
  })

  it('shows the Install... action only for prereq-missing unavailable', () => {
    render(<LspStatusIndicator state={UNAVAILABLE_PREREQ} diagnostics={[]} />)
    expect(screen.getByTestId('lsp-status-install')).toBeTruthy()
    expect(screen.queryByTestId('lsp-status-retry')).toBeNull()
  })

  it('shows the Retry action for non-prereq unavailable reasons', () => {
    render(<LspStatusIndicator state={UNAVAILABLE_CRASHED} diagnostics={[]} />)
    expect(screen.getByTestId('lsp-status-retry')).toBeTruthy()
    expect(screen.queryByTestId('lsp-status-install')).toBeNull()
  })

  it('opens the dropdown on trigger click and shows "No diagnostics" when empty', () => {
    render(<LspStatusIndicator state={READY} diagnostics={[]} />)
    fireEvent.click(screen.getByTestId('lsp-status-trigger'))
    expect(screen.getByTestId('lsp-status-empty')).toBeTruthy()
  })

  it('lists diagnostics with truncated long messages', () => {
    const long = 'A'.repeat(500)
    const diagnostics = [sampleDiagnostic({ message: long })]
    render(<LspStatusIndicator state={READY_ERRORS} diagnostics={diagnostics} />)
    fireEvent.click(screen.getByTestId('lsp-status-trigger'))
    const entry = screen.getByTestId('lsp-status-diagnostic')
    // 200-char cap with ellipsis -> 199 chars + '…'
    expect(entry.textContent).toContain('A'.repeat(199) + '…')
  })

  it('fires onDiagnosticOpen when a diagnostic entry is clicked', () => {
    const diag = sampleDiagnostic()
    const onDiagnosticOpen = vi.fn()
    render(
      <LspStatusIndicator
        state={READY_ERRORS}
        diagnostics={[diag]}
        onDiagnosticOpen={onDiagnosticOpen}
      />,
    )
    fireEvent.click(screen.getByTestId('lsp-status-trigger'))
    fireEvent.click(screen.getByTestId('lsp-status-diagnostic'))
    expect(onDiagnosticOpen).toHaveBeenCalledWith(diag)
  })

  it('fires onInstallClick from the prereq-missing action button', () => {
    const onInstallClick = vi.fn()
    render(
      <LspStatusIndicator
        state={UNAVAILABLE_PREREQ}
        diagnostics={[]}
        onInstallClick={onInstallClick}
      />,
    )
    fireEvent.click(screen.getByTestId('lsp-status-install'))
    expect(onInstallClick).toHaveBeenCalledTimes(1)
  })

  it('exposes an aria-live mirror of the current label for screen readers', () => {
    render(<LspStatusIndicator state={READY} diagnostics={[]} />)
    const sr = screen.getByTestId('lsp-status-sr')
    expect(sr.textContent).toBe('Ready')
    expect(sr.getAttribute('aria-live')).toBe('polite')
  })
})
