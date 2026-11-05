import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '@/api/client'
import {
  voiceApi,
  type VoiceCorrectionModelChoice,
  type VoiceCorrectionTarget,
  type VoiceHistoryCategory,
  type VoiceHistorySource,
  type VoiceHistorySourceId,
  type VoiceHistorySuggestions,
} from '@/api/voice'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
import { Modal } from '@/components/ui/Modal'
import { Progress } from '@/components/ui/Progress'
import { useTranslation } from '@/i18n'
import type { TranslationKey } from '@/i18n/locales/en'
import { useVoiceVocabularyStore, vocabularyKey } from '@/stores/voiceVocabularyStore'
import { VoiceCorrectionModelField } from './VoiceCorrectionModelField'

/** Product names, the same in every language. */
const SOURCE_NAMES: Record<VoiceHistorySourceId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

const CATEGORY_KEYS: Record<VoiceHistoryCategory, TranslationKey> = {
  project: 'voice.settings.vocabulary.history.category.project',
  model: 'voice.settings.vocabulary.history.category.model',
  tool: 'voice.settings.vocabulary.history.category.tool',
  other: 'voice.settings.vocabulary.history.category.other',
}

const CATEGORY_ORDER: VoiceHistoryCategory[] = ['project', 'model', 'tool', 'other']

type Step =
  | { kind: 'intro' }
  | { kind: 'running' }
  | { kind: 'results'; result: VoiceHistorySuggestions }
  | { kind: 'error'; reason: 'unavailable' | 'failed' }

type Props = {
  open: boolean
  onClose: () => void
  /** The correction model choice, which the pick defaults to. */
  initialModel: VoiceCorrectionModelChoice
  defaultTarget: VoiceCorrectionTarget | null
}

/**
 * Builds vocabulary from the user's own chat history: counts terms locally,
 * then makes one model call with the top candidate words and their counts
 * (never message text), and lets the user tick which to add. Never runs on
 * its own — only from this dialog's "Start".
 */
export function VoiceHistoryVocabularyDialog({ open, onClose, initialModel, defaultTarget }: Props) {
  const t = useTranslation()
  const addVocabulary = useVoiceVocabularyStore(state => state.add)

  const [sources, setSources] = useState<VoiceHistorySource[] | null>(null)
  const [days, setDays] = useState(0)
  const [sourcesFailed, setSourcesFailed] = useState(false)
  const [chosenSources, setChosenSources] = useState<Set<VoiceHistorySourceId>>(new Set())
  const [model, setModel] = useState<VoiceCorrectionModelChoice>(initialModel)
  const [step, setStep] = useState<Step>({ kind: 'intro' })
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const runRef = useRef<AbortController | null>(null)

  // Every opening starts over: fresh counts, the current correction model.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setStep({ kind: 'intro' })
    setModel(initialModel)
    setSources(null)
    setSourcesFailed(false)
    setSaveFailed(false)
    voiceApi.historySources().then(
      ({ sources: found, days: window }) => {
        if (cancelled) return
        setSources(found)
        setDays(window)
        setChosenSources(new Set(found.filter(source => source.available).map(source => source.id)))
      },
      () => { if (!cancelled) setSourcesFailed(true) },
    )
    return () => { cancelled = true }
    // The initial model is read once per opening, not tracked while open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => () => runRef.current?.abort(), [])

  const modelName = model.modelId ?? defaultTarget?.modelId ?? null

  const start = async () => {
    const chosen = [...chosenSources]
    if (chosen.length === 0) return
    runRef.current?.abort()
    const controller = new AbortController()
    runRef.current = controller
    setStep({ kind: 'running' })
    try {
      const result = await voiceApi.suggestFromHistory(chosen, model, { signal: controller.signal })
      if (runRef.current !== controller) return
      setChecked(new Set(result.groups.flatMap(group => group.terms)
        .filter(term => !term.doubtful && !term.inVocabulary)
        .map(term => vocabularyKey(term.term))))
      setStep({ kind: 'results', result })
      // The server noted when this analysis ran; the settings footer shows that
      // date even if the user closes the results without adding anything.
      void useVoiceVocabularyStore.getState().load({ force: true })
    } catch (error) {
      if (runRef.current !== controller || controller.signal.aborted) return
      const code = error instanceof ApiError ? (error.body as { error?: unknown } | null)?.error : undefined
      setStep({ kind: 'error', reason: code === 'voice/correction-unavailable' ? 'unavailable' : 'failed' })
    } finally {
      if (runRef.current === controller) runRef.current = null
    }
  }

  const stopRun = () => {
    runRef.current?.abort()
    runRef.current = null
    setStep({ kind: 'intro' })
  }

  const close = () => {
    if (saving) return
    runRef.current?.abort()
    runRef.current = null
    onClose()
  }

  const results = step.kind === 'results' ? step.result : null
  const terms = useMemo(() => results?.groups.flatMap(group => group.terms) ?? [], [results])
  const selectable = terms.filter(term => !term.inVocabulary)
  const selected = selectable.filter(term => checked.has(vocabularyKey(term.term)))
  const doubtfulCount = terms.filter(term => term.doubtful && !term.inVocabulary).length

  const toggle = (term: string, on: boolean) => {
    setChecked((current) => {
      const next = new Set(current)
      if (on) next.add(vocabularyKey(term))
      else next.delete(vocabularyKey(term))
      return next
    })
  }

  const submit = async () => {
    if (selected.length === 0) return
    setSaving(true)
    setSaveFailed(false)
    try {
      await addVocabulary(
        selected.map(term => ({ term: term.term })),
        {
          source: 'history',
          // What the user saw and left unticked is not suggested again.
          dismiss: selectable.filter(term => !checked.has(vocabularyKey(term.term))).map(term => term.term),
        },
      )
      onClose()
    } catch {
      setSaveFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const footer = step.kind === 'intro' ? (
    <>
      <Button variant="secondary" size="base" onClick={close}>{t('common.cancel')}</Button>
      <Button
        variant="primary"
        size="base"
        disabled={chosenSources.size === 0}
        onClick={() => { void start() }}
      >
        {t('voice.settings.vocabulary.history.start')}
      </Button>
    </>
  ) : step.kind === 'running' ? (
    <Button variant="secondary" size="base" onClick={stopRun}>{t('common.cancel')}</Button>
  ) : step.kind === 'error' ? (
    <>
      <Button variant="secondary" size="base" onClick={() => setStep({ kind: 'intro' })}>{t('voice.settings.vocabulary.history.back')}</Button>
      {step.reason === 'failed' ? (
        <Button variant="primary" size="base" onClick={() => { void start() }}>{t('common.retry')}</Button>
      ) : null}
    </>
  ) : (
    <>
      {results ? (
        <p className="mr-auto self-center text-xs text-[var(--color-text-tertiary)]">
          {t('voice.settings.vocabulary.history.meta', {
            model: results.target.modelId,
            seconds: results.seconds.toFixed(1),
          })}
        </p>
      ) : null}
      <Button variant="secondary" size="base" onClick={close} disabled={saving}>{t('common.cancel')}</Button>
      <Button
        variant="primary"
        size="base"
        loading={saving}
        disabled={selected.length === 0}
        onClick={() => { void submit() }}
      >
        {t('voice.settings.vocabulary.history.add', { count: selected.length })}
      </Button>
    </>
  )

  return (
    <Modal
      open={open}
      onClose={close}
      title={step.kind === 'results' && terms.length > 0
        ? t('voice.settings.vocabulary.history.resultsTitle', { count: terms.length })
        : t('voice.settings.vocabulary.history.title')}
      width={600}
      typography="interface"
      footer={footer}
    >
      {step.kind === 'intro' ? (
        <div className="space-y-4" data-testid="voice-history-intro">
          <p className="text-[13px] leading-5 text-[var(--color-text-secondary)]">
            {t('voice.settings.vocabulary.history.description')}
          </p>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-xs font-medium text-[var(--color-text-secondary)]">
              {t('voice.settings.vocabulary.history.sources')}
            </legend>
            {sourcesFailed ? (
              <ErrorState size="sm" title={t('voice.settings.vocabulary.history.sourcesFailed')} />
            ) : !sources ? (
              <LoadingState size="sm" label={t('common.loading')} />
            ) : sources.map(source => (
              <Checkbox
                key={source.id}
                label={SOURCE_NAMES[source.id]}
                description={!source.available
                  ? t('voice.settings.vocabulary.history.sourceMissing', { days })
                  : source.id === 'claude-code'
                    ? t('voice.settings.vocabulary.history.sessionsWithHaha', { days, count: source.sessions.toLocaleString() })
                    : t('voice.settings.vocabulary.history.sessions', { days, count: source.sessions.toLocaleString() })}
                disabled={!source.available}
                checked={source.available && chosenSources.has(source.id)}
                onChange={(event) => {
                  const on = event.target.checked
                  setChosenSources((current) => {
                    const next = new Set(current)
                    if (on) next.add(source.id)
                    else next.delete(source.id)
                    return next
                  })
                }}
              />
            ))}
          </fieldset>
          <div className="space-y-1.5 rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2.5 text-xs leading-[1.6] text-[var(--color-text-secondary)]">
            <p>{t('voice.settings.vocabulary.history.privacyLocal')}</p>
            <p>{t('voice.settings.vocabulary.history.privacyModel')}</p>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-[var(--color-text-secondary)]">
              {t('voice.settings.vocabulary.history.model')}
            </p>
            <div className="flex">
              <VoiceCorrectionModelField
                label={t('voice.settings.vocabulary.history.model')}
                value={model}
                onChange={setModel}
                defaultTarget={defaultTarget}
              />
            </div>
          </div>
        </div>
      ) : null}

      {step.kind === 'running' ? (
        <div className="space-y-3 py-2" data-testid="voice-history-running">
          <Progress label={t('voice.settings.vocabulary.history.running')} indeterminate size="sm" />
          <p className="text-[13px] leading-5 text-[var(--color-text-secondary)]">
            {modelName
              ? t('voice.settings.vocabulary.history.runningWith', { model: modelName })
              : t('voice.settings.vocabulary.history.running')}
          </p>
        </div>
      ) : null}

      {step.kind === 'error' ? (
        <ErrorState
          size="sm"
          title={step.reason === 'unavailable'
            ? t('voice.settings.vocabulary.history.error.unavailable')
            : t('voice.settings.vocabulary.history.error.failed')}
        />
      ) : null}

      {results ? (
        terms.length === 0 ? (
          <p className="py-2 text-[13px] leading-5 text-[var(--color-text-secondary)]" data-testid="voice-history-empty">
            {t('voice.settings.vocabulary.history.empty')}
          </p>
        ) : (
          <div className="space-y-4" data-testid="voice-history-results">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-[var(--color-text-tertiary)]">{t('voice.settings.vocabulary.history.resultsHint')}</p>
              <div className="flex items-center gap-3">
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => setChecked(new Set(selectable.map(term => vocabularyKey(term.term))))}
                >
                  {t('voice.settings.vocabulary.history.selectAll')}
                </Button>
                <Button variant="link" size="sm" onClick={() => setChecked(new Set())}>
                  {t('voice.settings.vocabulary.history.selectNone')}
                </Button>
              </div>
            </div>
            {CATEGORY_ORDER.map((category) => {
              const groupTerms = results.groups.filter(group => group.category === category).flatMap(group => group.terms)
              if (groupTerms.length === 0) return null
              return (
                <section key={category} aria-label={t(CATEGORY_KEYS[category])} className="space-y-2">
                  <h3 className="text-xs font-medium text-[var(--color-text-secondary)]">{t(CATEGORY_KEYS[category])}</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {groupTerms.map(term => (
                      <Checkbox
                        key={term.term}
                        size="sm"
                        containerClassName="items-center rounded-[var(--radius-md)] border border-[var(--color-border)] px-2 py-1"
                        label={
                          <span className="inline-flex items-center gap-1.5">
                            <span className="font-mono text-xs text-[var(--color-text-primary)]">{term.term}</span>
                            <span className="text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
                              {term.inVocabulary ? t('voice.settings.vocabulary.history.inVocabulary') : term.sessions}
                            </span>
                          </span>
                        }
                        disabled={term.inVocabulary}
                        checked={term.inVocabulary || checked.has(vocabularyKey(term.term))}
                        onChange={(event) => toggle(term.term, event.target.checked)}
                      />
                    ))}
                  </div>
                </section>
              )
            })}
            {doubtfulCount > 0 ? (
              <p className="text-xs text-[var(--color-text-tertiary)]">
                {t('voice.settings.vocabulary.history.doubtful', { count: doubtfulCount })}
              </p>
            ) : null}
            {saveFailed ? (
              <p role="alert" className="text-xs text-[var(--color-error)]">{t('voice.settings.vocabulary.saveFailed')}</p>
            ) : null}
          </div>
        )
      ) : null}
    </Modal>
  )
}
