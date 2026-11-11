import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import type { VoiceCorrectionTarget, VoiceHistorySuggestions } from '@/api/voice'
import type { SavedProvider } from '@/types/provider'

vi.mock('@/api/voice', () => ({
  voiceApi: {
    historySources: vi.fn(),
    suggestFromHistory: vi.fn(),
    addVocabulary: vi.fn(),
    vocabulary: vi.fn(() => Promise.resolve({ terms: [], suggestions: [], history: null, maxTerms: 500 })),
  },
}))

import { voiceApi } from '@/api/voice'
import { useProviderStore } from '@/stores/providerStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useVoiceVocabularyStore } from '@/stores/voiceVocabularyStore'
import { VoiceHistoryVocabularyDialog } from './VoiceHistoryVocabularyDialog'

const api = vi.mocked(voiceApi)
const DEFAULT_TARGET: VoiceCorrectionTarget = { providerId: 'deepseek', providerName: 'DeepSeek', modelId: 'deepseek-flash' }
const KIMI: SavedProvider = {
  id: 'kimi',
  presetId: 'custom',
  name: 'Kimi',
  apiKey: 'fixture',
  baseUrl: 'http://127.0.0.1:1',
  apiFormat: 'anthropic',
  models: { main: 'kimi-k2', haiku: '', sonnet: '', opus: '' },
}

const RESULT: VoiceHistorySuggestions = {
  groups: [
    { category: 'tool', terms: [{ term: 'worktree', sessions: 69, doubtful: false, inVocabulary: false }] },
    {
      category: 'project',
      terms: [
        { term: 'cc-haha', sessions: 34, doubtful: false, inVocabulary: false },
        { term: 'Harness', sessions: 12, doubtful: false, inVocabulary: true },
      ],
    },
    { category: 'other', terms: [{ term: 'e.g', sessions: 40, doubtful: true, inVocabulary: false }] },
  ],
  sessions: 1231,
  messages: 4623,
  candidates: 391,
  target: DEFAULT_TARGET,
  seconds: 2.2,
}

const onClose = vi.fn()

function renderDialog() {
  render(
    <VoiceHistoryVocabularyDialog
      open
      onClose={onClose}
      initialModel={{ providerId: null, modelId: null }}
      defaultTarget={DEFAULT_TARGET}
    />,
  )
  return screen.getByRole('dialog', { name: 'Build vocabulary from chat history' })
}

const checkbox = (name: string) => screen.getByRole('checkbox', { name: new RegExp(`^${name.replace('.', '\\.')}`) })

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.setState({ locale: 'en' })
  useProviderStore.setState({ providers: [KIMI], activeId: 'kimi', hasLoadedProviders: true, isLoading: false })
  useVoiceVocabularyStore.setState({ vocabulary: null, loading: false, error: null })
  api.historySources.mockResolvedValue({
    sources: [
      { id: 'claude-code', available: true, sessions: 907 },
      { id: 'codex', available: false, sessions: 0 },
    ],
    days: 14,
  })
})

afterEach(() => {
  cleanup()
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useProviderStore.setState(useProviderStore.getInitialState(), true)
})

describe('VoiceHistoryVocabularyDialog', () => {
  it('explains what is read and sent before anything runs', async () => {
    const dialog = renderDialog()

    expect(await within(dialog).findByText('Includes cc-haha sessions · 907 sessions in the last 14 days')).toBeInTheDocument()
    expect(checkbox('Claude Code')).toBeChecked()
    // A source with no history in the analyzed days cannot be chosen.
    expect(within(dialog).getByText('No history in the last 14 days')).toBeInTheDocument()
    expect(checkbox('Codex')).toBeDisabled()
    expect(checkbox('Codex')).not.toBeChecked()
    expect(dialog).toHaveTextContent('only messages you wrote, skipping AI replies, tool output and pasted logs')
    expect(dialog).toHaveTextContent('No message text is sent.')
    expect(within(dialog).getByRole('button', { name: 'Model used to pick' })).toHaveTextContent('Follow default provider')
    expect(api.suggestFromHistory).not.toHaveBeenCalled()

    fireEvent.click(checkbox('Claude Code'))
    expect(within(dialog).getByRole('button', { name: 'Start analysis' })).toBeDisabled()
  })

  it('runs with the chosen sources and model, and can be cancelled while it runs', async () => {
    const dialog = renderDialog()
    await within(dialog).findByText('Includes cc-haha sessions · 907 sessions in the last 14 days')
    let signal: AbortSignal | undefined
    api.suggestFromHistory.mockImplementation((_sources, _model, options) => {
      signal = options?.signal
      return new Promise(() => {})
    })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Model used to pick' }))
    fireEvent.click(within(screen.getByTestId('model-selector-dropdown')).getByRole('button', { name: /^kimi-k2/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start analysis' }))

    expect(api.suggestFromHistory).toHaveBeenCalledWith(['claude-code'], { providerId: 'kimi', modelId: 'kimi-k2' }, { signal: expect.any(AbortSignal) })
    expect(screen.getByTestId('voice-history-running')).toHaveTextContent('then letting kimi-k2 pick')

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(signal?.aborted).toBe(true)
    expect(screen.getByTestId('voice-history-intro')).toBeInTheDocument()
  })

  it('groups the picks by category, leaves doubtful ones unticked, and adds the ticked ones', async () => {
    api.suggestFromHistory.mockResolvedValue(RESULT)
    api.addVocabulary.mockResolvedValue({ vocabulary: { terms: [], suggestions: [], history: null, maxTerms: 500 }, added: 2, merged: 0, skipped: 0 })
    const dialog = renderDialog()
    await within(dialog).findByText('Includes cc-haha sessions · 907 sessions in the last 14 days')

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Start analysis' }))
    })

    const results = await screen.findByTestId('voice-history-results')
    expect(screen.getByRole('dialog', { name: '4 suggested words' })).toBeInTheDocument()
    // Fixed category order, whatever order the model answered in.
    expect(within(results).getAllByRole('heading', { level: 3 }).map(heading => heading.textContent))
      .toEqual(['Projects and products', 'Code, commands and tools', 'Other'])
    expect(checkbox('cc-haha')).toBeChecked()
    expect(checkbox('worktree')).toBeChecked()
    expect(checkbox('e.g')).not.toBeChecked()
    expect(checkbox('Harness')).toBeDisabled()
    expect(checkbox('Harness')).toBeChecked()
    expect(results).toHaveTextContent('1 of them do not look like proper names')
    expect(screen.getByText('deepseek-flash · 2.2 s')).toBeInTheDocument()

    fireEvent.click(checkbox('worktree'))
    fireEvent.click(screen.getByRole('button', { name: 'Add 1' }))

    await waitFor(() => expect(api.addVocabulary).toHaveBeenCalledWith(
      [{ term: 'cc-haha' }],
      { source: 'history', dismiss: ['worktree', 'e.g'] },
    ))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('reloads the vocabulary once results arrive, so the analysis date shows even if nothing is added', async () => {
    api.suggestFromHistory.mockResolvedValue(RESULT)
    api.vocabulary.mockResolvedValue({
      terms: [], suggestions: [], history: { lastRunAt: '2026-11-01T08:00:00.000Z', addedCount: 0 }, maxTerms: 500,
    })
    const dialog = renderDialog()
    await within(dialog).findByText('Includes cc-haha sessions · 907 sessions in the last 14 days')
    api.vocabulary.mockClear()

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Start analysis' }))
    })
    await screen.findByTestId('voice-history-results')

    await waitFor(() => expect(api.vocabulary).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(useVoiceVocabularyStore.getState().vocabulary?.history?.lastRunAt).toBe('2026-11-01T08:00:00.000Z'))
  })

  it('ticks everything selectable or nothing at once', async () => {
    api.suggestFromHistory.mockResolvedValue(RESULT)
    const dialog = renderDialog()
    await within(dialog).findByText('Includes cc-haha sessions · 907 sessions in the last 14 days')
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Start analysis' }))
    })
    await screen.findByTestId('voice-history-results')

    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getByRole('button', { name: 'Add 3' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Select none' }))
    expect(screen.getByRole('button', { name: 'Add 0' })).toBeDisabled()
    // Already in the vocabulary stays shown as such either way.
    expect(checkbox('Harness')).toBeChecked()
  })

  it('says when no model is available, and offers a retry after a failure', async () => {
    api.suggestFromHistory.mockRejectedValueOnce(new ApiError(409, { error: 'voice/correction-unavailable', message: 'x' }))
    const dialog = renderDialog()
    await within(dialog).findByText('Includes cc-haha sessions · 907 sessions in the last 14 days')

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Start analysis' }))
    })
    expect(await screen.findByText(/No model is available\./)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    api.suggestFromHistory.mockRejectedValueOnce(new ApiError(502, { error: 'voice/correction-failed', reason: 'upstream', message: 'x' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start analysis' }))
    })
    expect(await screen.findByText('The analysis failed. You can try again.')).toBeInTheDocument()

    api.suggestFromHistory.mockResolvedValueOnce({ ...RESULT, groups: [] })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })
    expect(await screen.findByTestId('voice-history-empty')).toHaveTextContent('No new words found.')
  })
})
