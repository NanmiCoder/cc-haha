import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { AgentSdkImportDialog } from './AgentSdkImportDialog'
import { MessageActionBar } from './MessageActionBar'
import { useProviderStore } from '@/stores/providerStore'
import { useSettingsStore } from '@/stores/settingsStore'
import type { SavedProvider } from '@/types/provider'

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  useProviderStore.setState({ providers: [], activeId: null })
})

it('requires a configured SDK provider and never imports just by opening the dialog', () => {
  const onImport = vi.fn()
  render(<AgentSdkImportDialog loading={false} onClose={vi.fn()} onImport={onImport} />)
  expect(screen.getByRole('button', { name: 'Create copy' })).toBeDisabled()
  expect(screen.getByRole('status')).toHaveTextContent('Agent SDK')
  expect(onImport).not.toHaveBeenCalled()
})

it('offers only SDK providers and sends the explicitly chosen Haiku model to import', () => {
  useProviderStore.setState({ activeId: 'sdk', providers: [
    { id: 'legacy', name: 'Old endpoint', runtime: 'claude-code', models: { main: 'old-model' } },
    { id: 'sdk', name: 'Official API', runtime: 'agent-sdk', models: { main: 'claude-opus-5-5', haiku: 'claude-haiku-5-5' } },
  ] as SavedProvider[] })
  const onImport = vi.fn(async () => {})
  render(<AgentSdkImportDialog loading={false} onClose={vi.fn()} onImport={onImport} />)
  expect(screen.queryByRole('option', { name: 'Old endpoint' })).not.toBeInTheDocument()
  fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'claude-haiku-5-5' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create copy' }))
  expect(onImport).toHaveBeenCalledWith({ providerId: 'sdk', modelId: 'claude-haiku-5-5' })
})

it('exposes import separately from the existing branch action', () => {
  const onImport = vi.fn()
  const onBranch = vi.fn()
  render(<MessageActionBar copyLabel="Copy" branchAction={{ label: 'Branch', onBranch, sdkImport: { label: 'Copy to Agent SDK', onImport } }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Copy to Agent SDK' }))
  expect(onImport).toHaveBeenCalledOnce()
  expect(onBranch).not.toHaveBeenCalled()
})
