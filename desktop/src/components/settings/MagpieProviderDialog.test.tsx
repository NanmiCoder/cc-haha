import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { providersApi } from '../../api/providers'
import { useMagpieStore } from '../../stores/magpieStore'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import type { MagpieState, SavedProvider } from '../../types/provider'
import { MagpieProviderDialog } from './MagpieProviderDialog'

const RUNNING: MagpieState = {
  status: { installed: true, running: true, baseUrl: 'http://127.0.0.1:4100' },
  models: [
    {
      id: 'kimi/kimi-k3', runtimeId: 'kimi/kimi-k3', displayName: 'Kimi K3', provider: 'kimi', providerName: 'Kimi Coding',
      isGroup: false, contextWindow: 262_144, maxOutputTokens: 32_768, reasoningEfforts: ['low', 'high'],
    },
    {
      id: 'claude/claude-opus-5-5', runtimeId: 'claude/claude-opus-5-5[1m]', displayName: 'Claude Opus 5.5', provider: 'claude',
      isGroup: false, contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoningEfforts: [], images: true,
    },
    {
      id: 'ollama/qwen3.6:27b', runtimeId: 'ollama/qwen3.6:27b', displayName: 'Qwen3.6 27B', provider: 'ollama',
      isGroup: false, reasoningEfforts: [],
    },
  ],
}

const savedMagpie: SavedProvider = {
  id: 'magpie-1',
  presetId: 'magpie',
  name: 'Magpie',
  apiKey: '',
  baseUrl: 'http://127.0.0.1:4100',
  apiFormat: 'anthropic',
  models: { main: 'kimi/kimi-k3', haiku: 'kimi/kimi-k3', sonnet: 'kimi/kimi-k3', opus: 'kimi/kimi-k3' },
}

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  vi.spyOn(useSettingsStore.getState(), 'fetchAll').mockResolvedValue()
  vi.spyOn(useSettingsStore.getState(), 'setModel').mockResolvedValue()
  vi.spyOn(providersApi, 'list').mockResolvedValue({ providers: [], activeId: null })
  useMagpieStore.setState({ state: null, loading: false })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('connecting Magpie', () => {
  it('creates it with the picked model, lets the catalog limits land, then makes it the default', async () => {
    const magpie = vi.spyOn(providersApi, 'magpie').mockResolvedValue(RUNNING)
    const create = vi.spyOn(providersApi, 'create').mockImplementation(async (input) => ({
      provider: { ...savedMagpie, ...input, id: 'magpie-new', apiFormat: 'anthropic' },
    }))
    const activate = vi.spyOn(providersApi, 'activate').mockResolvedValue({ ok: true })
    const onClose = vi.fn()

    render(<MagpieProviderDialog open onClose={onClose} />)
    const list = await screen.findByRole('radiogroup', { name: 'Main Model' })
    expect(within(list).getByText('Kimi Coding')).toBeInTheDocument()
    expect(within(list).getByRole('radio', { name: /Kimi K3/ })).toHaveTextContent('Context 256K')
    expect(screen.getByRole('button', { name: 'Connect and make default' })).toBeDisabled()

    fireEvent.click(within(list).getByRole('radio', { name: /Kimi K3/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Connect and make default' }))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      presetId: 'magpie',
      name: 'Magpie',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:4100',
      apiFormat: 'anthropic',
      models: { main: 'kimi/kimi-k3', haiku: 'kimi/kimi-k3', sonnet: 'kimi/kimi-k3', opus: 'kimi/kimi-k3' },
    }))
    expect(activate).toHaveBeenCalledWith('magpie-new')
    // The server writes the catalog's windows onto the provider when it reads
    // the catalog; that has to happen before activation syncs its settings.
    const lastRefresh = Math.max(...magpie.mock.invocationCallOrder)
    expect(lastRefresh).toBeGreaterThan(create.mock.invocationCallOrder[0]!)
    expect(lastRefresh).toBeLessThan(activate.mock.invocationCallOrder[0]!)
  })

  it('runs a 1M Claude model as [1m] and keeps a separate background model', async () => {
    vi.spyOn(providersApi, 'magpie').mockResolvedValue(RUNNING)
    const create = vi.spyOn(providersApi, 'create').mockImplementation(async (input) => ({
      provider: { ...savedMagpie, ...input, id: 'magpie-new', apiFormat: 'anthropic' },
    }))
    vi.spyOn(providersApi, 'activate').mockResolvedValue({ ok: true })

    render(<MagpieProviderDialog open onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('radio', { name: /Claude Opus 5.5/ }))
    fireEvent.change(screen.getByLabelText('Background tasks such as titles and summaries'), { target: { value: 'kimi/kimi-k3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect and make default' }))

    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0]![0].models).toEqual({
      main: 'claude/claude-opus-5-5[1m]', haiku: 'kimi/kimi-k3', sonnet: 'claude/claude-opus-5-5[1m]', opus: 'claude/claude-opus-5-5[1m]',
    })
  })

  it('warns before a model Magpie gives no context length for', async () => {
    vi.spyOn(providersApi, 'magpie').mockResolvedValue(RUNNING)
    render(<MagpieProviderDialog open onClose={vi.fn()} />)

    const qwen = await screen.findByRole('radio', { name: /Qwen3.6 27B/ })
    expect(qwen).toHaveTextContent('Context unknown')
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    fireEvent.click(qwen)
    expect(screen.getByRole('note')).toHaveTextContent('cc-haha assumes 200K')
  })

  it('offers to open Magpie when it is not running, and says so plainly where it cannot', async () => {
    vi.spyOn(providersApi, 'magpie').mockResolvedValue({
      status: { installed: true, running: false, baseUrl: 'http://127.0.0.1:3425' },
      models: null,
    })
    const open = vi.spyOn(providersApi, 'openMagpie').mockResolvedValue({ ok: false, unsupported: true })
    render(<MagpieProviderDialog open onClose={vi.fn()} />)

    expect(await screen.findByText("Magpie isn't running")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect and make default' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Open Magpie' }))

    await waitFor(() => expect(open).toHaveBeenCalled())
    expect(await screen.findByText(/Open Magpie yourself/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open Magpie' })).not.toBeInTheDocument()
  })
})

describe('editing Magpie', () => {
  it('saves when to compact and lists the models whose context is unknown', async () => {
    vi.spyOn(providersApi, 'magpie').mockResolvedValue(RUNNING)
    const update = vi.spyOn(providersApi, 'update').mockImplementation(async (_id, input) => ({
      provider: { ...savedMagpie, ...input } as SavedProvider,
    }))
    useProviderStore.setState({ providers: [savedMagpie], activeId: null })

    render(<MagpieProviderDialog open onClose={vi.fn()} provider={savedMagpie} />)
    expect(await screen.findByRole('radio', { name: /Kimi K3/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'When nearly full' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Models with unknown context').parentElement).toHaveTextContent('ollama/qwen3.6:27b')
    expect(screen.getByText('1 · counted as 200K')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'At 272K' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('magpie-1', expect.objectContaining({ autoCompactWindow: 272_000 })))
  })

  it('goes back to compacting when nearly full by clearing the window', async () => {
    vi.spyOn(providersApi, 'magpie').mockResolvedValue(RUNNING)
    const update = vi.spyOn(providersApi, 'update').mockImplementation(async (_id, input) => ({
      provider: { ...savedMagpie, ...input } as SavedProvider,
    }))
    const provider = { ...savedMagpie, autoCompactWindow: 272_000 }

    render(<MagpieProviderDialog open onClose={vi.fn()} provider={provider} />)
    fireEvent.click(await screen.findByRole('radio', { name: 'When nearly full' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('magpie-1', expect.objectContaining({ autoCompactWindow: null })))
  })
})
