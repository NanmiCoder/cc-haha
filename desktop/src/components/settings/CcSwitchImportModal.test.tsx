import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'

const providerStoreState = vi.hoisted(() => ({
  scanCcSwitch: vi.fn(),
  importCcSwitch: vi.fn(),
}))

vi.mock('../../stores/providerStore', () => ({
  useProviderStore: () => providerStoreState,
}))

import { CcSwitchImportModal } from './CcSwitchImportModal'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import type { CcSwitchCandidate, CcSwitchScanResult } from '../../types/provider'

function makeCandidate(overrides: Partial<CcSwitchCandidate> = {}): CcSwitchCandidate {
  return {
    sourceId: 'source-1',
    appType: 'claude',
    name: 'Primary Relay',
    baseUrl: 'https://relay.example.invalid/anthropic',
    apiKeyPreview: 'sk-a***9f',
    hasApiKey: true,
    models: {
      main: 'relay-main',
      haiku: 'relay-haiku',
      sonnet: 'relay-sonnet',
      opus: 'relay-opus',
    },
    model1mSupport: { main: false, fable: false, haiku: false, sonnet: false, opus: false },
    apiFormat: 'anthropic',
    authStrategy: 'auth_token',
    presetId: 'custom',
    isCurrent: false,
    importable: true,
    ...overrides,
  }
}

function makeScan(overrides: Partial<CcSwitchScanResult> = {}): CcSwitchScanResult {
  return {
    available: true,
    source: 'json',
    configDir: '/Users/tester/.cc-switch',
    candidates: [makeCandidate()],
    ...overrides,
  }
}

function renderModal(onClose = vi.fn()) {
  render(<CcSwitchImportModal open onClose={onClose} />)
  return onClose
}

describe('CcSwitchImportModal', () => {
  beforeEach(() => {
    providerStoreState.scanCcSwitch.mockReset()
    providerStoreState.importCcSwitch.mockReset()
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ toasts: [] })
  })

  afterEach(() => {
    cleanup()
  })

  it('scans on open and shows a loading state until the scan resolves', async () => {
    let resolveScan!: (result: CcSwitchScanResult) => void
    providerStoreState.scanCcSwitch.mockReturnValue(new Promise<CcSwitchScanResult>((resolve) => {
      resolveScan = resolve
    }))

    renderModal()

    expect(providerStoreState.scanCcSwitch).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status')).toHaveTextContent(/Reading the cc-switch configuration/i)

    resolveScan(makeScan())

    expect(await screen.findByRole('checkbox', { name: /Primary Relay/i })).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it.each([
    ['not-found' as const, /No cc-switch configuration was found/i],
    ['unreadable' as const, /could not be read/i],
    ['sqlite-unavailable' as const, /database cannot be opened/i],
  ])('explains an unavailable config for reason=%s', async (reason, expected) => {
    providerStoreState.scanCcSwitch.mockResolvedValue({
      available: false,
      reason,
      configDir: '/Users/tester/.cc-switch',
      candidates: [],
    })

    renderModal()

    expect(await screen.findByText(expected)).toBeInTheDocument()
    // The resolved directory is the one thing that makes "not found" actionable.
    expect(screen.getByText(/\/Users\/tester\/\.cc-switch/)).toBeInTheDocument()
    // Nothing to import, so no import button is offered at all.
    expect(screen.queryByRole('button', { name: /^Import \(/i })).not.toBeInTheDocument()
  })

  it('preselects importable rows that are not already present', async () => {
    providerStoreState.scanCcSwitch.mockResolvedValue(makeScan({
      candidates: [
        makeCandidate({ sourceId: 'fresh', name: 'Fresh Relay' }),
        makeCandidate({
          sourceId: 'dupe',
          name: 'Duplicate Relay',
          duplicate: { id: 'provider-9', name: 'My Relay' },
        }),
        makeCandidate({
          sourceId: 'broken',
          name: 'Broken Relay',
          importable: false,
          skipReason: 'no-api-key',
        }),
      ],
    }))

    renderModal()

    const fresh = await screen.findByRole('checkbox', { name: /Fresh Relay/i })
    expect(fresh).toBeChecked()
    // Re-importing something we already have is the one outcome nobody wants.
    expect(screen.getByRole('checkbox', { name: /Duplicate Relay/i })).not.toBeChecked()
    expect(screen.getByText(/Looks like your existing provider "My Relay"/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Import \(1\)/i })).toBeEnabled()
  })

  it('disables a non-importable row and states the reason', async () => {
    providerStoreState.scanCcSwitch.mockResolvedValue(makeScan({
      candidates: [makeCandidate({
        sourceId: 'broken',
        name: 'Broken Relay',
        hasApiKey: false,
        importable: false,
        skipReason: 'no-api-key',
      })],
    }))

    renderModal()

    const checkbox = await screen.findByRole('checkbox', { name: /Broken Relay/i })
    // jsdom still fires change on a disabled input, so assert the attribute.
    expect(checkbox).toBeDisabled()
    expect(screen.getByText(/no API key stored/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Import \(0\)/i })).toBeDisabled()
  })

  it('badges the provider cc-switch is currently using', async () => {
    providerStoreState.scanCcSwitch.mockResolvedValue(makeScan({
      candidates: [makeCandidate({ isCurrent: true })],
    }))

    renderModal()

    const row = await screen.findByTestId('cc-switch-candidate-source-1')
    expect(within(row).getByText('In use')).toBeInTheDocument()
    expect(within(row).getByText('sk-a***9f')).toBeInTheDocument()
  })

  it('selects and clears every importable row on demand', async () => {
    providerStoreState.scanCcSwitch.mockResolvedValue(makeScan({
      candidates: [
        makeCandidate({ sourceId: 'fresh', name: 'Fresh Relay' }),
        makeCandidate({
          sourceId: 'dupe',
          name: 'Duplicate Relay',
          duplicate: { id: 'provider-9', name: 'My Relay' },
        }),
        makeCandidate({ sourceId: 'broken', name: 'Broken Relay', importable: false, skipReason: 'no-model' }),
      ],
    }))

    renderModal()

    fireEvent.click(await screen.findByRole('button', { name: /Select all/i }))
    // Select all reaches the duplicate but never the row that cannot be imported.
    expect(screen.getByRole('button', { name: /Import \(2\)/i })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: /Duplicate Relay/i })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Broken Relay/i })).not.toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: /Select none/i }))
    expect(screen.getByRole('button', { name: /Import \(0\)/i })).toBeDisabled()
  })

  it('carries a hand-toggled selection into the import call', async () => {
    providerStoreState.scanCcSwitch.mockResolvedValue(makeScan({
      candidates: [
        makeCandidate({ sourceId: 'fresh', name: 'Fresh Relay' }),
        makeCandidate({
          sourceId: 'dupe',
          name: 'Duplicate Relay',
          duplicate: { id: 'provider-9', name: 'My Relay' },
        }),
      ],
    }))
    providerStoreState.importCcSwitch.mockResolvedValue({ imported: [], skipped: [] })

    renderModal()

    const dupe = await screen.findByRole('checkbox', { name: /Duplicate Relay/i })
    const fresh = screen.getByRole('checkbox', { name: /Fresh Relay/i })
    expect(screen.getByText('1 of 2 selected')).toBeInTheDocument()

    // Overriding the preselection row by row is the point of the list, and the
    // select-all/none buttons reach it through a different code path.
    fireEvent.click(dupe)
    expect(dupe).toBeChecked()
    expect(screen.getByText('2 of 2 selected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Import \(2\)/i })).toBeEnabled()

    fireEvent.click(fresh)
    expect(fresh).not.toBeChecked()
    expect(screen.getByText('1 of 2 selected')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Import \(1\)/i }))

    await waitFor(() => {
      expect(providerStoreState.importCcSwitch).toHaveBeenCalledWith(['dupe'])
    })
  })

  it('imports the checked rows, reports the outcome and closes', async () => {
    providerStoreState.scanCcSwitch.mockResolvedValue(makeScan({
      candidates: [
        makeCandidate({ sourceId: 'fresh', name: 'Fresh Relay' }),
        makeCandidate({
          sourceId: 'dupe',
          name: 'Duplicate Relay',
          duplicate: { id: 'provider-9', name: 'My Relay' },
        }),
      ],
    }))
    providerStoreState.importCcSwitch.mockResolvedValue({
      imported: [{ id: 'provider-new' }],
      skipped: [{ sourceId: 'other', reason: 'no-api-key' }],
    })
    const onClose = vi.fn()

    renderModal(onClose)

    fireEvent.click(await screen.findByRole('button', { name: /Import \(1\)/i }))

    await waitFor(() => {
      expect(providerStoreState.importCcSwitch).toHaveBeenCalledWith(['fresh'])
    })
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled()
    })
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe('Imported 1, skipped 1.')
  })

  it('keeps the dialog open and shows why when the import fails', async () => {
    providerStoreState.scanCcSwitch.mockResolvedValue(makeScan())
    providerStoreState.importCcSwitch.mockRejectedValue(new Error('config locked'))
    const onClose = vi.fn()

    renderModal(onClose)

    fireEvent.click(await screen.findByRole('button', { name: /Import \(1\)/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/Import failed/i)
    expect(screen.getByRole('alert')).toHaveTextContent('config locked')
    expect(onClose).not.toHaveBeenCalled()
    // Still usable — the selection survives so the user can just retry.
    expect(screen.getByRole('button', { name: /Import \(1\)/i })).toBeEnabled()
  })

  it('offers a retry when the scan request itself fails', async () => {
    providerStoreState.scanCcSwitch.mockRejectedValueOnce(new Error('server unreachable'))
    providerStoreState.scanCcSwitch.mockResolvedValueOnce(makeScan())

    renderModal()

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not read the cc-switch configuration/i)
    expect(screen.getByRole('alert')).toHaveTextContent('server unreachable')

    fireEvent.click(screen.getByRole('button', { name: /Retry/i }))

    expect(await screen.findByRole('checkbox', { name: /Primary Relay/i })).toBeInTheDocument()
  })

  it('explains an installed cc-switch that has no providers', async () => {
    providerStoreState.scanCcSwitch.mockResolvedValue(makeScan({ candidates: [] }))

    renderModal()

    expect(await screen.findByText(/no providers configured/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Import \(/i })).not.toBeInTheDocument()
  })
})
