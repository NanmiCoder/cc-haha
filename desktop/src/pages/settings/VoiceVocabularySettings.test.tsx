import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import type { VoiceCatalog, VoiceVocabulary, VoiceVocabularyEntry } from '@/api/voice'

vi.mock('@/api/voice', () => ({
  voiceApi: {
    vocabulary: vi.fn(),
    addVocabulary: vi.fn(),
    updateVocabulary: vi.fn(),
    removeVocabulary: vi.fn(),
    dismissSuggestion: vi.fn(),
    historySources: vi.fn(),
    suggestFromHistory: vi.fn(),
  },
}))

import { voiceApi } from '@/api/voice'
import { useProviderStore } from '@/stores/providerStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useVoiceVocabularyStore } from '@/stores/voiceVocabularyStore'
import { VOCABULARY_VISIBLE_ROWS, VoiceVocabularySettings } from './VoiceVocabularySettings'

const api = vi.mocked(voiceApi)

function entry(term: string, aliases: string[] = []): VoiceVocabularyEntry {
  return { term, aliases, source: 'manual', addedAt: '2026-11-01T00:00:00.000Z' }
}

function vocabulary(patch: Partial<VoiceVocabulary> = {}): VoiceVocabulary {
  return { terms: [], suggestions: [], history: null, maxTerms: 500, ...patch }
}

function catalog(correctionEnabled = true): VoiceCatalog {
  return {
    supported: true,
    providers: [],
    preferences: {
      enabled: true,
      providerId: 'sensevoice-local',
      language: 'auto',
      downloadSource: 'auto',
      correctionEnabled,
      correctionProviderId: null,
      correctionModelId: null,
    },
    limits: { maxAudioSeconds: 60, maxAudioBytes: 1 },
    correction: { defaultTarget: { providerId: 'd', providerName: 'DeepSeek', modelId: 'deepseek-flash' }, target: null },
  }
}

async function renderSection(current: VoiceVocabulary, correctionEnabled = true) {
  api.vocabulary.mockResolvedValue(current)
  render(<VoiceVocabularySettings catalog={catalog(correctionEnabled)} />)
  await waitFor(() => expect(useVoiceVocabularyStore.getState().vocabulary).not.toBeNull())
}

const rows = () => screen.queryAllByTestId('voice-vocabulary-row')
const title = () => screen.getByRole('heading', { level: 3 })

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.setState({ locale: 'en' })
  useVoiceVocabularyStore.setState({ vocabulary: null, loading: false, error: null })
  useProviderStore.setState({ providers: [], hasLoadedProviders: true, isLoading: false })
})

afterEach(() => {
  cleanup()
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useProviderStore.setState(useProviderStore.getInitialState(), true)
})

describe('VoiceVocabularySettings', () => {
  it('starts empty with an explanation, the count, and a note while correction is off', async () => {
    await renderSection(vocabulary(), false)

    expect(title()).toHaveTextContent('Personal vocabulary · 0')
    expect(title()).toHaveTextContent('Takes effect once AI correction is on')
    expect(screen.getByText('No words yet')).toBeInTheDocument()
    expect(screen.getByText(/such as a project name like cc-haha/)).toBeInTheDocument()
    // The actions stay available before correction is on.
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Paste list' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Build from chat history' })).toBeEnabled()
  })

  it('does not show the note once correction is on', async () => {
    await renderSection(vocabulary({ terms: [entry('cc-haha')] }))
    expect(title()).not.toHaveTextContent('Takes effect once AI correction is on')
  })

  it('lists words with what they are heard as, the first rows first, and expands', async () => {
    const terms = Array.from({ length: VOCABULARY_VISIBLE_ROWS + 2 }, (_, index) => entry(`term-${index}`))
    terms[0] = entry('cc-haha', ['CC杠哈哈', '西西哈哈'])
    await renderSection(vocabulary({ terms }))

    expect(title()).toHaveTextContent(`Personal vocabulary · ${terms.length}`)
    expect(rows()).toHaveLength(VOCABULARY_VISIBLE_ROWS)
    expect(rows()[0]).toHaveTextContent('cc-haha')
    expect(rows()[0]).toHaveTextContent('CC杠哈哈、西西哈哈')
    expect(rows()[1]).toHaveTextContent('—')
    expect(screen.getByText(`Showing ${VOCABULARY_VISIBLE_ROWS} of ${terms.length}`)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(rows()).toHaveLength(terms.length)
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(rows()).toHaveLength(VOCABULARY_VISIBLE_ROWS)
  })

  it('searches terms and what they are heard as', async () => {
    await renderSection(vocabulary({ terms: [entry('cc-haha', ['西西哈哈']), entry('Agent Browser', ['agent brother']), entry('JSVMP')] }))

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search vocabulary' }), { target: { value: 'BROTHER' } })
    expect(rows().map(row => row.textContent)).toEqual([expect.stringContaining('Agent Browser')])

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search vocabulary' }), { target: { value: 'nothing-like-this' } })
    expect(rows()).toHaveLength(0)
    expect(screen.getByText('No matching words.')).toBeInTheDocument()
  })

  it('adds a word inline with comma-separated readings, saving on Enter', async () => {
    await renderSection(vocabulary())
    const saved = vocabulary({ terms: [entry('OpenRouter', ['open router', '欧喷路由'])] })
    api.addVocabulary.mockResolvedValue({ vocabulary: saved, added: 1, merged: 0, skipped: 0 })

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.change(screen.getByLabelText('Word'), { target: { value: '  OpenRouter ' } })
    fireEvent.change(screen.getByLabelText('Often heard as (optional, separate with commas)'), { target: { value: 'open router、欧喷路由, open router' } })
    fireEvent.keyDown(screen.getByLabelText('Word'), { key: 'Enter' })

    await waitFor(() => expect(api.addVocabulary).toHaveBeenCalledWith(
      [{ term: 'OpenRouter', aliases: ['open router', '欧喷路由'] }],
      { source: 'manual' },
    ))
    await waitFor(() => expect(screen.queryByTestId('voice-vocabulary-draft')).toBeNull())
    expect(rows()[0]).toHaveTextContent('OpenRouter')
  })

  it('cancels the inline row with Esc or Cancel without saving', async () => {
    await renderSection(vocabulary({ terms: [entry('JSVMP')] }))

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.keyDown(screen.getByLabelText('Word'), { key: 'Escape' })
    expect(screen.queryByTestId('voice-vocabulary-draft')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.click(within(screen.getByTestId('voice-vocabulary-draft')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('voice-vocabulary-draft')).toBeNull()
    expect(api.addVocabulary).not.toHaveBeenCalled()
  })

  it('edits a word from its row menu and explains a clash with another word', async () => {
    await renderSection(vocabulary({ terms: [entry('JSVMP', ['GSVMP']), entry('Codex')] }))

    fireEvent.click(screen.getByRole('button', { name: 'Actions for JSVMP' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.getByLabelText('Word')).toHaveValue('JSVMP')
    expect(screen.getByLabelText('Often heard as (optional, separate with commas)')).toHaveValue('GSVMP')

    api.updateVocabulary.mockRejectedValueOnce(new ApiError(409, { error: 'conflict' }))
    fireEvent.change(screen.getByLabelText('Word'), { target: { value: 'Codex' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save ↵' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This word is already in the vocabulary.')

    api.updateVocabulary.mockResolvedValueOnce({ vocabulary: vocabulary({ terms: [entry('JSVMP', ['GSVMP', 'J S V M P']), entry('Codex')] }) })
    fireEvent.change(screen.getByLabelText('Word'), { target: { value: 'JSVMP' } })
    fireEvent.change(screen.getByLabelText('Often heard as (optional, separate with commas)'), { target: { value: 'GSVMP, J S V M P' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save ↵' }))

    await waitFor(() => expect(api.updateVocabulary).toHaveBeenLastCalledWith('JSVMP', { term: 'JSVMP', aliases: ['GSVMP', 'J S V M P'] }))
    await waitFor(() => expect(screen.queryByTestId('voice-vocabulary-draft')).toBeNull())
  })

  it('deletes a word from its row menu', async () => {
    await renderSection(vocabulary({ terms: [entry('JSVMP'), entry('Codex')] }))
    api.removeVocabulary.mockResolvedValue({ vocabulary: vocabulary({ terms: [entry('Codex')] }) })

    fireEvent.click(screen.getByRole('button', { name: 'Actions for JSVMP' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))

    await waitFor(() => expect(api.removeVocabulary).toHaveBeenCalledWith('JSVMP'))
    await waitFor(() => expect(rows()).toHaveLength(1))
  })

  it('suggests words AI correction keeps fixing, adding them with what they were heard as', async () => {
    const suggestions = [
      { term: 'Codex', heardAs: ['coded', 'CodeX'], count: 5, lastSeenAt: '2026-11-01T00:00:00.000Z' },
      { term: 'Vercel', heardAs: ['versal'], count: 2, lastSeenAt: '2026-11-01T00:00:00.000Z' },
    ]
    await renderSection(vocabulary({ suggestions }))
    const items = screen.getAllByTestId('voice-vocabulary-suggestion')
    expect(screen.getByText('Recently fixed by AI')).toBeInTheDocument()
    expect(items[0]).toHaveTextContent('Heard as coded、CodeX · 5×')

    api.addVocabulary.mockResolvedValue({ vocabulary: vocabulary({ terms: [entry('Codex', ['coded', 'CodeX'])], suggestions: [suggestions[1]!] }), added: 1, merged: 0, skipped: 0 })
    fireEvent.click(within(items[0]!).getByRole('button', { name: 'Add to vocabulary' }))
    await waitFor(() => expect(api.addVocabulary).toHaveBeenCalledWith([{ term: 'Codex', aliases: ['coded', 'CodeX'] }], { source: 'correction' }))
    await waitFor(() => expect(screen.getAllByTestId('voice-vocabulary-suggestion')).toHaveLength(1))

    api.dismissSuggestion.mockResolvedValue({ vocabulary: vocabulary({ terms: [entry('Codex')] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Ignore Vercel' }))
    await waitFor(() => expect(api.dismissSuggestion).toHaveBeenCalledWith('Vercel'))
    await waitFor(() => expect(screen.queryByTestId('voice-vocabulary-suggestion')).toBeNull())
  })

  it('says when words were last added from history and offers to analyze again', async () => {
    api.historySources.mockResolvedValue({ sources: [] })
    await renderSection(vocabulary({ terms: [entry('cc-haha')], history: { lastRunAt: '2026-11-01T08:00:00.000Z', addedCount: 91 } }))

    expect(screen.getByTestId('voice-vocabulary-history')).toHaveTextContent(/Added 91 words from chat history on November 1\./)
    fireEvent.click(screen.getByRole('button', { name: 'Analyze again' }))
    expect(await screen.findByRole('dialog', { name: 'Build vocabulary from chat history' })).toBeInTheDocument()
  })

  it('does not claim "added 0 words" after an analysis the user closed without adding anything', async () => {
    api.historySources.mockResolvedValue({ sources: [] })
    await renderSection(vocabulary({ terms: [entry('cc-haha')], history: { lastRunAt: '2026-11-01T08:00:00.000Z', addedCount: 0 } }))

    const footer = screen.getByTestId('voice-vocabulary-history')
    expect(footer).toHaveTextContent(/Chat history last analyzed on November 1; no words were added\./)
    expect(footer).not.toHaveTextContent(/Added 0 words/)
  })

  it('shows a retryable error when the vocabulary cannot be read', async () => {
    api.vocabulary.mockRejectedValueOnce(new Error('offline'))
    render(<VoiceVocabularySettings catalog={catalog()} />)

    expect(await screen.findByText('Could not load the personal vocabulary.')).toBeInTheDocument()
    api.vocabulary.mockResolvedValue(vocabulary())
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No words yet')).toBeInTheDocument()
  })
})

describe('VoiceVocabularyBulkDialog', () => {
  it('previews what a paste will do and adds it in one call', async () => {
    await renderSection(vocabulary({ terms: [entry('JSVMP')] }))
    fireEvent.click(screen.getByRole('button', { name: 'Paste list' }))
    const dialog = screen.getByRole('dialog', { name: 'Paste a vocabulary list' })
    expect(within(dialog).getByRole('button', { name: 'Add 0' })).toBeDisabled()

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Vocabulary list' }), {
      target: { value: 'cc-haha = CC杠哈哈, 西西哈哈\nJSVMP ＝ GSVMP\nModelDial\ncc-haha' },
    })

    expect(screen.getByTestId('voice-vocabulary-bulk-summary')).toHaveTextContent(
      '2 to add · 1 already there, readings merged · duplicate lines ignored: 1',
    )
    api.addVocabulary.mockResolvedValue({ vocabulary: vocabulary(), added: 2, merged: 1, skipped: 0 })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 2' }))

    await waitFor(() => expect(api.addVocabulary).toHaveBeenCalledWith([
      { term: 'cc-haha', aliases: ['CC杠哈哈', '西西哈哈'] },
      { term: 'JSVMP', aliases: ['GSVMP'] },
      { term: 'ModelDial', aliases: [] },
    ], { source: 'manual' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('only merges when every line is already there, and warns past the size limit', async () => {
    await renderSection(vocabulary({ terms: [entry('JSVMP')], maxTerms: 2 }))
    fireEvent.click(screen.getByRole('button', { name: 'Paste list' }))
    const box = screen.getByRole('textbox', { name: 'Vocabulary list' })

    fireEvent.change(box, { target: { value: 'jsvmp = GSVMP' } })
    expect(screen.getByRole('button', { name: 'Merge 1' })).toBeEnabled()

    fireEvent.change(box, { target: { value: 'a\nb\nc' } })
    expect(screen.getByText('The vocabulary holds at most 2 words; 2 will not be added.')).toBeInTheDocument()
  })
})
