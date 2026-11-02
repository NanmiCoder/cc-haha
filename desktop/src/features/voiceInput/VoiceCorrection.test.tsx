import { useEffect, useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { ApiError } from '@/api/client'
import type { VoiceCatalog, VoiceCorrection, VoiceCorrectionChange, VoiceCorrectionTarget } from '@/api/voice'
import {
  getComposerViewForTesting,
  MentionComposer,
  type MentionComposerHandle,
} from '@/components/chat/MentionComposer'
import { translate } from '@/i18n'
import type { TranslationKey } from '@/i18n/locales/en'
import { browserHost } from '@/lib/desktopHost/browserHost'
import { useSettingsStore } from '@/stores/settingsStore'
import { SETTINGS_TAB_ID, useTabStore } from '@/stores/tabStore'
import { useUIStore } from '@/stores/uiStore'
import { useVoiceInputStore } from '@/stores/voiceInputStore'
import { useVoiceVocabularyStore } from '@/stores/voiceVocabularyStore'
import type { StartRecordingOptions } from './recorder'
import { useVoiceShortcutStore } from './shortcutPreference'
import { CORRECTION_BUDGET_MS, useComposerDictation } from './useComposerDictation'
import { CORRECTION_NOTICE_MS } from './VoiceCorrectionNotice'
import { VoiceInputButton } from './VoiceInputButton'
import { VoiceRecordingBar } from './VoiceRecordingBar'

const mocks = vi.hoisted(() => ({
  transcribe: vi.fn(),
  correct: vi.fn(),
  catalog: vi.fn(),
  addVocabulary: vi.fn(),
  startRecording: vi.fn(),
}))

vi.mock('@/api/voice', () => ({
  voiceApi: {
    transcribe: mocks.transcribe,
    correct: mocks.correct,
    catalog: mocks.catalog,
    addVocabulary: mocks.addVocabulary,
    providerStatus: vi.fn(),
    updatePreferences: vi.fn(),
    prepare: vi.fn(),
    cancelPrepare: vi.fn(),
    removeAssets: vi.fn(),
  },
}))

vi.mock('./recorder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./recorder')>()),
  startRecording: mocks.startRecording,
  isVoiceCaptureSupported: () => true,
}))

const en = (key: TranslationKey, params?: Record<string, string | number>) => translate('en', key, params)

const TARGET: VoiceCorrectionTarget = { providerId: 'deepseek', providerName: 'DeepSeek', modelId: 'deepseek-flash' }
const HEARD = '开源的这一个 agent brother skills，后来在 coded 里面去用'
const CORRECTED = '开源的这一个 Agent Browser skills，后来在 Codex 里面去用'

function change(from: string, to: string, inVocabulary = false, text = CORRECTED): VoiceCorrectionChange {
  const start = text.indexOf(to)
  return { from, to, start, end: start + to.length, inVocabulary }
}

const CHANGES = [change('agent brother', 'Agent Browser', true), change('coded', 'Codex')]

function correction(text = CORRECTED, changes = CHANGES): VoiceCorrection {
  return { text, changes, target: TARGET, seconds: 0.84 }
}

function catalogFixture({ enabled = true, target = TARGET as VoiceCorrectionTarget | null } = {}): VoiceCatalog {
  return {
    supported: true,
    providers: [{
      info: { id: 'sensevoice-local', name: 'SenseVoice', location: 'local', languages: ['auto', 'zh'] },
      preparation: { phase: 'ready' },
    }],
    preferences: {
      enabled: true,
      providerId: 'sensevoice-local',
      language: 'zh',
      downloadSource: 'auto',
      correctionEnabled: enabled,
      correctionProviderId: null,
      correctionModelId: null,
    },
    limits: { maxAudioSeconds: 60, maxAudioBytes: 10_000_000 },
    correction: { defaultTarget: TARGET, target },
  }
}

let handle: MentionComposerHandle | null
let finishCorrection: (value: VoiceCorrection) => void
let failCorrection: (error: unknown) => void
let correctionSignal: AbortSignal | undefined

function Harness({ initial = '', onSubmit, blocked = false }: { initial?: string; onSubmit?: (draft: string) => void; blocked?: boolean }) {
  const [input, setInput] = useState(initial)
  const ref = useRef<MentionComposerHandle>(null)
  const dictation = useComposerDictation({
    composerRef: ref,
    draft: input,
    blocked,
    contextKey: 'session-a',
    onSubmit: onSubmit ? () => onSubmit(input) : undefined,
  })
  useEffect(() => {
    handle = ref.current
  })
  const live = dictation.phase !== 'idle'
  return (
    <div>
      <MentionComposer
        ref={ref}
        value={input}
        mentions={[]}
        onChange={(text) => setInput(text)}
        onCompositionStart={dictation.compositionHandlers.onCompositionStart}
        onCompositionEnd={dictation.compositionHandlers.onCompositionEnd}
      />
      <div data-testid="toolbar">
        {live && <VoiceRecordingBar dictation={dictation} />}
        <div hidden={live}>
          <VoiceInputButton dictation={dictation} />
        </div>
      </div>
      <output data-testid="draft">{input}</output>
    </div>
  )
}

const draft = () => screen.getByTestId('draft').textContent
const notice = () => screen.queryByTestId('voice-correction-notice')

function typeText(text: string, offset: number) {
  const editor = document.querySelector<HTMLElement>('[data-composer-editor]')
  const view = getComposerViewForTesting(editor)!
  act(() => {
    view.dispatch(view.state.tr.insertText(text, offset + 1))
  })
}

/** Records, stops, and lets recognition return `heard`; correction is left in flight. */
async function dictate(heard = HEARD) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: en('voice.composer.start') }))
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: en('voice.composer.stop') }))
  })
  expect(mocks.transcribe).toHaveBeenCalled()
  await act(async () => {
    finishTranscription(heard)
  })
}

let finishTranscription: (text: string) => void

beforeEach(() => {
  vi.clearAllMocks()
  handle = null
  correctionSignal = undefined
  mocks.startRecording.mockImplementation(async (_options: StartRecordingOptions) => ({
    getLevel: () => 0.4,
    stop: async () => ({ wav: new Blob(['wav']), seconds: 2 }),
    cancel: vi.fn(),
  }))
  mocks.transcribe.mockImplementation(() => new Promise((resolve) => {
    finishTranscription = (text) => resolve({ text, audioSeconds: 2, inferenceSeconds: 0.1 })
  }))
  mocks.correct.mockImplementation((_text: string, options: { signal?: AbortSignal } = {}) => {
    correctionSignal = options.signal
    return new Promise((resolve, reject) => {
      finishCorrection = resolve
      failCorrection = reject
      options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
  })
  mocks.catalog.mockResolvedValue(catalogFixture())
  useSettingsStore.setState({ locale: 'en' })
  useVoiceInputStore.setState({ catalog: catalogFixture(), loading: false, error: null })
  useVoiceVocabularyStore.setState({ vocabulary: null, loading: false, error: null })
  useVoiceShortcutStore.setState({ enabled: false, shortcut: null, platform: 'mac' })
  window.desktopHost = { ...browserHost, kind: 'electron', isDesktop: true }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  })
})

afterEach(() => {
  Reflect.deleteProperty(Range.prototype, 'getClientRects')
  Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
  Reflect.deleteProperty(window, 'desktopHost')
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  useTabStore.setState(useTabStore.getInitialState(), true)
  useUIStore.setState(useUIStore.getInitialState(), true)
})

describe('the correcting phase', () => {
  it('shows what was heard and offers to skip while correction runs, then writes the corrected text', async () => {
    render(<Harness />)
    await dictate()

    const bar = screen.getByTestId('voice-recording-bar')
    expect(bar).toHaveAttribute('data-phase', 'correcting')
    expect(within(bar).getByTestId('voice-correcting-text')).toHaveTextContent(HEARD)
    expect(within(bar).getByText(en('voice.composer.correcting'))).toBeInTheDocument()
    expect(within(bar).getByRole('button', { name: en('voice.composer.skipCorrection') })).toBeInTheDocument()
    // Nothing is written until correction answers: the text goes in once.
    expect(draft()).toBe('')
    expect(mocks.correct).toHaveBeenCalledWith(HEARD, expect.objectContaining({ signal: expect.any(AbortSignal) }))

    await act(async () => { finishCorrection(correction()) })

    expect(draft()).toBe(CORRECTED)
    expect(screen.queryByTestId('voice-recording-bar')).toBeNull()
    expect(notice()).toHaveAttribute('data-kind', 'changes')
    expect(within(notice()!).getByRole('status')).toHaveTextContent(en('voice.correction.notice.changed', { count: 2 }))
  })

  it('does not call correction while it is switched off', async () => {
    useVoiceInputStore.setState({ catalog: catalogFixture({ enabled: false }) })
    render(<Harness />)
    await dictate()

    expect(mocks.correct).not.toHaveBeenCalled()
    expect(draft()).toBe(HEARD)
    expect(notice()).toBeNull()
  })

  it('writes what was heard silently when correction changed nothing', async () => {
    render(<Harness />)
    await dictate()
    await act(async () => { finishCorrection(correction(HEARD, [])) })

    expect(draft()).toBe(HEARD)
    expect(notice()).toBeNull()
  })

  it('skips to what was heard on the button, cancelling the request', async () => {
    render(<Harness />)
    await dictate()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en('voice.composer.skipCorrection') }))
    })

    expect(draft()).toBe(HEARD)
    expect(correctionSignal?.aborted).toBe(true)
    // The user chose this; there is nothing to report.
    expect(notice()).toBeNull()
  })

  it('treats Esc during correction as skip, keeping the words instead of discarding them', async () => {
    render(<Harness />)
    await dictate()

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })

    expect(draft()).toBe(HEARD)
    expect(correctionSignal?.aborted).toBe(true)
    expect(screen.queryByTestId('voice-recording-bar')).toBeNull()
  })

  it('uses the corrected text for held text, without a notice', async () => {
    render(<Harness />)
    await dictate()
    // The user typed while correction ran: the result is held, not written.
    typeText('draft', 0)

    await act(async () => { finishCorrection(correction()) })

    expect(draft()).toBe('draft')
    expect(screen.getByTestId('voice-input-pending-text')).toHaveTextContent(CORRECTED)
    expect(notice()).toBeNull()
  })

  it('corrects before sending when asked to send, and shows no notice', async () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en('voice.composer.start') }))
    })
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: en('voice.composer.sendNow') }))
    })
    await act(async () => { finishTranscription(HEARD) })
    expect(screen.getByTestId('voice-recording-bar')).toHaveTextContent(en('voice.composer.correctingThenSend'))
    expect(onSubmit).not.toHaveBeenCalled()

    await act(async () => { finishCorrection(correction()) })

    expect(onSubmit).toHaveBeenCalledWith(CORRECTED)
    expect(notice()).toBeNull()
  })

  async function correctingBeforeSend(onSubmit: (draft: string) => void) {
    render(<Harness onSubmit={onSubmit} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en('voice.composer.start') }))
    })
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: en('voice.composer.sendNow') }))
    })
    await act(async () => { finishTranscription(HEARD) })
    expect(screen.getByTestId('voice-recording-bar')).toHaveTextContent(en('voice.composer.correctingThenSend'))
  }

  it('backs out of the send on Esc while correcting: the words go into the draft and nothing is sent', async () => {
    // Before correction existed, Esc during "transcribe, then send" sent nothing;
    // backing out must not turn into sending the uncorrected text.
    const onSubmit = vi.fn()
    await correctingBeforeSend(onSubmit)

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })

    expect(correctionSignal?.aborted).toBe(true)
    expect(draft()).toBe(HEARD)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.queryByTestId('voice-recording-bar')).toBeNull()
  })

  it('still sends the original when the user skips correction before a send', async () => {
    const onSubmit = vi.fn()
    await correctingBeforeSend(onSubmit)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en('voice.composer.skipCorrection') }))
    })

    expect(onSubmit).toHaveBeenCalledWith(HEARD)
  })

  it('ignores changes whose offsets do not match, writing what was heard', async () => {
    render(<Harness />)
    await dictate()
    const shifted = CHANGES.map(item => ({ ...item, start: item.start + 2, end: item.end + 2 }))

    await act(async () => { finishCorrection(correction(CORRECTED, shifted)) })

    expect(draft()).toBe(HEARD)
    expect(notice()).toBeNull()
  })
})

describe('fallbacks', () => {
  it(`writes what was heard after ${CORRECTION_BUDGET_MS} ms and offers to correct again in place`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    render(<Harness initial="前文" />)
    await dictate()

    await act(async () => { vi.advanceTimersByTime(CORRECTION_BUDGET_MS - 1) })
    expect(draft()).toBe('前文')
    await act(async () => { vi.advanceTimersByTime(1) })

    expect(correctionSignal?.aborted).toBe(true)
    expect(draft()).toBe(`前文${HEARD}`)
    expect(notice()).toHaveAttribute('data-kind', 'timeout')
    expect(notice()).toHaveTextContent(en('voice.correction.notice.timeout'))
    // Information, not an error: no alert role and no error colors.
    expect(within(notice()!).queryByRole('alert')).toBeNull()
    expect(notice()!.outerHTML).not.toMatch(/--color-error/)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en('voice.correction.notice.retry') }))
    })
    expect(notice()).toHaveAttribute('data-kind', 'retrying')
    expect(mocks.correct).toHaveBeenLastCalledWith(HEARD, expect.anything())

    await act(async () => { finishCorrection(correction()) })

    // Rewritten where it was inserted, not appended.
    expect(draft()).toBe(`前文${CORRECTED}`)
    expect(notice()).toHaveAttribute('data-kind', 'changes')
  })

  it('says a rejected API key plainly and opens voice settings from the notice', async () => {
    render(<Harness />)
    await dictate()
    await act(async () => {
      failCorrection(new ApiError(502, { error: 'voice/correction-failed', reason: 'auth', message: 'bad key' }))
    })

    expect(draft()).toBe(HEARD)
    expect(notice()).toHaveAttribute('data-kind', 'auth')
    expect(notice()).toHaveTextContent(en('voice.correction.notice.auth'))

    fireEvent.click(screen.getByRole('button', { name: en('voice.correction.notice.openSettings') }))
    expect(useUIStore.getState().pendingSettingsTab).toBe('voice')
    expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
  })

  it.each([
    ['rate-limit', 'failed'],
    ['upstream', 'failed'],
    ['invalid-output', 'failed'],
  ])('reports a %s failure as a quiet failed notice', async (reason, kind) => {
    render(<Harness />)
    await dictate()
    await act(async () => {
      failCorrection(new ApiError(502, { error: 'voice/correction-failed', reason, message: 'x' }))
    })

    expect(draft()).toBe(HEARD)
    expect(notice()).toHaveAttribute('data-kind', kind)
    expect(notice()).toHaveTextContent(en('voice.correction.notice.failed'))
  })

  it('reports an unavailable model and refreshes the catalog that promised one', async () => {
    render(<Harness />)
    await dictate()
    await act(async () => {
      failCorrection(new ApiError(409, { error: 'voice/correction-unavailable', message: 'x' }))
    })

    expect(draft()).toBe(HEARD)
    expect(notice()).toHaveAttribute('data-kind', 'unavailable')
    expect(mocks.catalog).toHaveBeenCalled()
  })

  it('asks the server even when the cached catalog had no model, so a default fixed elsewhere works at once', async () => {
    // The catalog was loaded while the default provider had no usable model;
    // the user then fixed it in another settings tab. The server resolves the
    // target on every request, so the next dictation is corrected.
    useVoiceInputStore.setState({ catalog: catalogFixture({ target: null }) })
    render(<Harness />)
    await dictate()

    expect(mocks.correct).toHaveBeenCalledWith(HEARD, expect.anything())
    await act(async () => { finishCorrection(correction()) })
    expect(draft()).toBe(CORRECTED)
    expect(notice()).toHaveAttribute('data-kind', 'changes')
  })

  it('offers "correct again" once more when the composer could not take the result', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const view = render(<Harness initial="前文" />)
    await dictate()
    await act(async () => { vi.advanceTimersByTime(CORRECTION_BUDGET_MS) })
    expect(notice()).toHaveAttribute('data-kind', 'timeout')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en('voice.correction.notice.retry') }))
    })
    expect(notice()).toHaveAttribute('data-kind', 'retrying')
    // A pending question disables the composer before the answer arrives.
    view.rerender(<Harness initial="前文" blocked />)
    await act(async () => { finishCorrection(correction()) })

    // Not a spinner that never ends: the retry is offered again, text untouched.
    expect(notice()).toHaveAttribute('data-kind', 'timeout')
    expect(draft()).toBe(`前文${HEARD}`)
  })
})

describe('the change notice', () => {
  async function corrected(initial = '') {
    render(<Harness initial={initial} />)
    await dictate()
    await act(async () => { finishCorrection(correction()) })
  }

  const openPanel = () => fireEvent.click(screen.getByRole('button', { name: en('voice.correction.notice.view') }))
  const rows = () => screen.getAllByTestId('voice-correction-change')
  // Each revert button is named by the change it undoes, not just "Revert".
  const revertName = (from: string, to: string) => en('voice.correction.panel.revertOne', { from, to })

  it('lists each change with where it came from, the model and time', async () => {
    await corrected()
    openPanel()

    const panel = screen.getByRole('dialog', { name: en('voice.correction.panel.title') })
    expect(panel).toHaveTextContent('deepseek-flash')
    expect(panel).toHaveTextContent('0.84 s')
    expect(rows()).toHaveLength(2)
    expect(rows()[0]).toHaveTextContent('agent brother')
    expect(rows()[0]).toHaveTextContent('Agent Browser')
    expect(rows()[0]).toHaveTextContent(en('voice.correction.panel.fromVocabulary'))
    // A word already in the vocabulary has nothing to add.
    expect(within(rows()[0]!).queryByRole('button', { name: en('voice.correction.panel.addToVocabulary') })).toBeNull()
    expect(rows()[1]).toHaveTextContent(en('voice.correction.panel.notInVocabulary'))
  })

  it('offers to add a term to the vocabulary, but not a fixed homophone', async () => {
    // Seen with real DeepSeek output: 除悉 → 熟悉 came back next to the term fixes.
    const text = CORRECTED.replace('去用', '去拥')
    const changes = [
      change('agent brother', 'Agent Browser', true, text),
      change('coded', 'Codex', false, text),
      change('用', '拥', false, text),
    ]
    render(<Harness />)
    await dictate()
    await act(async () => { finishCorrection(correction(text, changes)) })
    openPanel()

    const add = en('voice.correction.panel.addToVocabulary')
    expect(rows()).toHaveLength(3)
    expect(within(rows()[1]!).getByRole('button', { name: add })).toBeInTheDocument()
    expect(within(rows()[2]!).queryByRole('button', { name: add })).toBeNull()
    expect(rows()[2]).not.toHaveTextContent(en('voice.correction.panel.notInVocabulary'))
  })

  it('reverts one change at a time, keeping the other one\'s position right', async () => {
    await corrected('前文 ')
    openPanel()

    // Revert the first: the second shifts left by the length difference.
    fireEvent.click(screen.getByRole('button', { name: revertName('agent brother', 'Agent Browser') }))
    expect(draft()).toBe('前文 开源的这一个 agent brother skills，后来在 Codex 里面去用')
    expect(rows()).toHaveLength(1)
    expect(notice()).toHaveTextContent(en('voice.correction.notice.changed', { count: 1 }))

    fireEvent.click(screen.getByRole('button', { name: revertName('coded', 'Codex') }))
    expect(draft()).toBe(`前文 ${HEARD}`)
    // Nothing left to revert.
    expect(notice()).toBeNull()
  })

  it('reverts the last change first just as well', async () => {
    await corrected()
    openPanel()

    fireEvent.click(screen.getByRole('button', { name: revertName('coded', 'Codex') }))
    expect(draft()).toBe('开源的这一个 Agent Browser skills，后来在 coded 里面去用')
    fireEvent.click(screen.getByRole('button', { name: revertName('agent brother', 'Agent Browser') }))
    expect(draft()).toBe(HEARD)
  })

  it('restores the whole original from the pill or the panel, as one undo step', async () => {
    await corrected('hello')
    fireEvent.click(screen.getByRole('button', { name: en('voice.correction.notice.restore') }))

    expect(draft()).toBe(`hello${HEARD}`)
    expect(notice()).toBeNull()
  })

  it('stops offering to revert once the user edits the draft', async () => {
    await corrected()
    typeText('!', CORRECTED.length)

    expect(notice()).toBeNull()
    expect(draft()).toBe(`${CORRECTED}!`)
  })

  it('adds a corrected word to the vocabulary with what it was heard as', async () => {
    mocks.addVocabulary.mockResolvedValue({
      vocabulary: { terms: [], suggestions: [], history: null, maxTerms: 500 },
      added: 1,
      merged: 0,
      skipped: 0,
    })
    await corrected()
    openPanel()

    fireEvent.click(within(rows()[1]!).getByRole('button', { name: en('voice.correction.panel.addToVocabulary') }))

    await waitFor(() => expect(rows()[1]).toHaveTextContent(en('voice.correction.panel.fromVocabulary')))
    expect(mocks.addVocabulary).toHaveBeenCalledWith([{ term: 'Codex', aliases: ['coded'] }], { source: 'correction' })
    expect(within(rows()[1]!).queryByRole('button', { name: en('voice.correction.panel.addToVocabulary') })).toBeNull()
  })

  it('says so when the vocabulary did not take the word, instead of showing it as added', async () => {
    // The server answers 200 with `skipped` when the vocabulary is full or the word too long.
    mocks.addVocabulary.mockResolvedValue({
      vocabulary: { terms: [], suggestions: [], history: null, maxTerms: 500 },
      added: 0,
      merged: 0,
      skipped: 1,
    })
    await corrected()
    openPanel()

    fireEvent.click(within(rows()[1]!).getByRole('button', { name: en('voice.correction.panel.addToVocabulary') }))

    expect(await screen.findByText(en('voice.correction.panel.addSkipped'))).toBeInTheDocument()
    expect(rows()[1]).toHaveTextContent(en('voice.correction.panel.notInVocabulary'))
  })

  it(`hides after ${CORRECTION_NOTICE_MS} ms, but not while its panel is open`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await corrected()

    openPanel()
    await act(async () => { vi.advanceTimersByTime(CORRECTION_NOTICE_MS + 1_000) })
    expect(notice()).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en('voice.correction.notice.view') }))
    await act(async () => { vi.advanceTimersByTime(CORRECTION_NOTICE_MS) })
    expect(notice()).toBeNull()
    // Hiding the notice does not touch the text.
    expect(draft()).toBe(CORRECTED)
  })

  it('goes away when a new dictation starts', async () => {
    await corrected()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en('voice.composer.start') }))
    })
    expect(notice()).toBeNull()
    expect(handle).not.toBeNull()
  })
})
