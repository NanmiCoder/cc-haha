import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Ellipsis, History, Pencil, Plus, Trash2 } from 'lucide-react'
import { ApiError } from '@/api/client'
import type { VoiceCatalog, VoiceVocabularyEntry, VoiceVocabularySuggestion } from '@/api/voice'
import { SettingsGroup, SettingsSection } from '@/components/settings/SettingsSection'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { IconButton } from '@/components/ui/IconButton'
import { Input } from '@/components/ui/Input'
import { LoadingState } from '@/components/ui/LoadingState'
import { SearchField } from '@/components/ui/SearchField'
import { DATE_LOCALES } from '@/features/tokenUsage/heatmapModel'
import { useDismissable } from '@/hooks/useDismissable'
import { useTranslation } from '@/i18n'
import type { TranslationKey } from '@/i18n/locales/en'
import { useSettingsStore } from '@/stores/settingsStore'
import { useVoiceVocabularyStore, VoiceVocabularySkippedError } from '@/stores/voiceVocabularyStore'
import { VoiceHistoryVocabularyDialog } from './VoiceHistoryVocabularyDialog'
import { VoiceVocabularyBulkDialog } from './VoiceVocabularyBulkDialog'
import { cleanVocabularyTerm, parseVocabularyAliases } from './voiceVocabularyText'

/** Rows shown before "Show all"; a long vocabulary should not push the rest of the page away. */
export const VOCABULARY_VISIBLE_ROWS = 8
/** Suggestions are a nudge, not a second list to manage. */
const MAX_SUGGESTIONS = 5

const GRID = 'grid grid-cols-[minmax(0,200px)_minmax(0,1fr)_28px] items-center gap-x-4'

type Draft = {
  /** The term being edited, or null while adding a new one. */
  from: string | null
  term: string
  aliases: string
}

function saveErrorKey(error: unknown): TranslationKey {
  if (error instanceof VoiceVocabularySkippedError) return 'voice.settings.vocabulary.skipped'
  return error instanceof ApiError && error.status === 409
    ? 'voice.settings.vocabulary.exists'
    : 'voice.settings.vocabulary.saveFailed'
}

/**
 * Settings → Voice input → Personal vocabulary: the words AI correction should
 * prefer, each with what it tends to be misheard as. Filled by hand, by
 * pasting a list, from words correction keeps fixing, or from chat history.
 */
export function VoiceVocabularySettings({ catalog }: { catalog: VoiceCatalog }) {
  const t = useTranslation()
  const locale = useSettingsStore(state => state.locale)
  const vocabulary = useVoiceVocabularyStore(state => state.vocabulary)
  const loadError = useVoiceVocabularyStore(state => state.error)
  const load = useVoiceVocabularyStore(state => state.load)
  const add = useVoiceVocabularyStore(state => state.add)
  const update = useVoiceVocabularyStore(state => state.update)
  const remove = useVoiceVocabularyStore(state => state.remove)
  const dismissSuggestion = useVoiceVocabularyStore(state => state.dismissSuggestion)

  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [draftError, setDraftError] = useState<TranslationKey | null>(null)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionFailed, setActionFailed] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)

  useEffect(() => {
    // Correction keeps adding suggestions in the background; re-read on entry.
    void load({ force: true })
  }, [load])

  const terms = useMemo(() => vocabulary?.terms ?? [], [vocabulary])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return terms
    return terms.filter(entry => entry.term.toLowerCase().includes(needle)
      || entry.aliases.some(alias => alias.toLowerCase().includes(needle)))
  }, [query, terms])
  const collapsible = !query.trim() && filtered.length > VOCABULARY_VISIBLE_ROWS
  const visible = collapsible && !expanded ? filtered.slice(0, VOCABULARY_VISIBLE_ROWS) : filtered
  const suggestions = (vocabulary?.suggestions ?? []).slice(0, MAX_SUGGESTIONS)

  const startAdding = () => {
    setDraft({ from: null, term: '', aliases: '' })
    setDraftError(null)
  }

  const saveDraft = async () => {
    if (!draft) return
    const term = cleanVocabularyTerm(draft.term)
    if (!term) {
      setDraftError('voice.settings.vocabulary.invalidTerm')
      return
    }
    const aliases = parseVocabularyAliases(draft.aliases, term)
    setSaving(true)
    setDraftError(null)
    try {
      if (draft.from === null) await add([{ term, aliases }], { source: 'manual' })
      else await update(draft.from, { term, aliases })
      setDraft(null)
    } catch (error) {
      setDraftError(saveErrorKey(error))
    } finally {
      setSaving(false)
    }
  }

  const act = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key)
    setActionFailed(false)
    try {
      await action()
    } catch {
      setActionFailed(true)
    } finally {
      setBusy(null)
    }
  }

  const history = vocabulary?.history ?? null
  const historyDate = history ? new Date(history.lastRunAt) : null
  const correctionOn = catalog.preferences.correctionEnabled

  const title = (
    <>
      {t('voice.settings.vocabulary.title')}
      {vocabulary ? (
        <span className="font-normal text-[var(--color-text-tertiary)]">
          {' · '}{t('voice.settings.vocabulary.count', { count: terms.length })}
        </span>
      ) : null}
      {!correctionOn ? (
        <span className="ml-2 text-xs font-normal text-[var(--color-text-tertiary)]">
          {t('voice.settings.vocabulary.needsCorrection')}
        </span>
      ) : null}
    </>
  )

  const actions = (
    <>
      <Button
        variant="secondary"
        size="sm"
        icon={<History size={13} strokeWidth={1.75} aria-hidden="true" />}
        onClick={() => setHistoryOpen(true)}
        disabled={!vocabulary}
      >
        {t('voice.settings.vocabulary.fromHistory')}
      </Button>
      <Button variant="secondary" size="sm" onClick={() => setBulkOpen(true)} disabled={!vocabulary}>
        {t('voice.settings.vocabulary.bulkPaste')}
      </Button>
      <Button
        variant="primary"
        size="sm"
        icon={<Plus size={13} strokeWidth={1.75} aria-hidden="true" />}
        onClick={startAdding}
        disabled={!vocabulary || draft !== null}
      >
        {t('voice.settings.vocabulary.add')}
      </Button>
    </>
  )

  const draftRow = (key: string) => draft ? (
    <VocabularyDraftRow
      key={key}
      draft={draft}
      saving={saving}
      errorKey={draftError}
      onChange={setDraft}
      onSave={() => { void saveDraft() }}
      onCancel={() => { setDraft(null); setDraftError(null) }}
    />
  ) : null

  return (
    <SettingsSection title={title} description={t('voice.settings.vocabulary.description')} action={actions}>
      {!vocabulary ? (
        loadError ? (
          <ErrorState
            size="md"
            title={t('voice.settings.vocabulary.loadFailed')}
            detail={loadError}
            retryLabel={t('common.retry')}
            onRetry={() => { void load({ force: true }) }}
          />
        ) : (
          <LoadingState size="sm" label={t('common.loading')} />
        )
      ) : terms.length === 0 && draft === null ? (
        <EmptyState
          variant="dashed"
          size="sm"
          // Under the section's own h3.
          headingLevel={4}
          title={t('voice.settings.vocabulary.emptyTitle')}
          description={t('voice.settings.vocabulary.emptyDescription')}
        />
      ) : (
        <SettingsGroup data-testid="voice-vocabulary-list">
          {terms.length > 0 ? (
            <div className="px-4 py-2.5">
              <SearchField
                size="sm"
                value={query}
                onChange={setQuery}
                label={t('voice.settings.vocabulary.search')}
                placeholder={t('voice.settings.vocabulary.search')}
                clearLabel={t('voice.settings.vocabulary.clearSearch')}
              />
            </div>
          ) : null}
          <div className="px-4">
            <div aria-hidden="true" className={`${GRID} py-2 text-[11px] text-[var(--color-text-tertiary)]`}>
              <span>{t('voice.settings.vocabulary.column.term')}</span>
              <span>{t('voice.settings.vocabulary.column.aliases')}</span>
              <span />
            </div>
            <ul aria-label={t('voice.settings.vocabulary.title')}>
              {draft?.from === null ? draftRow('new') : null}
              {visible.map(entry => draft?.from === entry.term ? draftRow(entry.term) : (
                <VocabularyRow
                  key={entry.term}
                  entry={entry}
                  busy={busy === `remove:${entry.term}`}
                  onEdit={() => {
                    setDraft({ from: entry.term, term: entry.term, aliases: entry.aliases.join(', ') })
                    setDraftError(null)
                  }}
                  onRemove={() => { void act(`remove:${entry.term}`, () => remove(entry.term)) }}
                />
              ))}
            </ul>
            {query.trim() && filtered.length === 0 ? (
              <p className="border-t border-[var(--color-border)] py-3 text-xs text-[var(--color-text-tertiary)]">
                {t('voice.settings.vocabulary.noMatches')}
              </p>
            ) : null}
          </div>
          {collapsible ? (
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-xs text-[var(--color-text-tertiary)]">
              <span>{t('voice.settings.vocabulary.showing', { shown: visible.length, total: filtered.length })}</span>
              <Button variant="link" size="sm" onClick={() => setExpanded(open => !open)}>
                {expanded ? t('voice.settings.vocabulary.collapse') : t('voice.settings.vocabulary.showAll')}
              </Button>
            </div>
          ) : null}
        </SettingsGroup>
      )}

      {actionFailed ? (
        <p role="alert" className="mt-2 px-0.5 text-xs text-[var(--color-error)]">{t('voice.settings.vocabulary.saveFailed')}</p>
      ) : null}

      {suggestions.length > 0 ? (
        <SettingsGroup className="mt-2" aria-label={t('voice.settings.vocabulary.suggestions.title')}>
          <p className="px-4 pb-1 pt-3 text-xs font-medium text-[var(--color-text-secondary)]">
            {t('voice.settings.vocabulary.suggestions.title')}
          </p>
          <ul className="divide-y divide-[var(--color-border)]">
            {suggestions.map(suggestion => (
              <SuggestionRow
                key={suggestion.term}
                suggestion={suggestion}
                busy={busy === `suggest:${suggestion.term}`}
                onAdd={() => {
                  void act(`suggest:${suggestion.term}`, () => add(
                    [{ term: suggestion.term, aliases: suggestion.heardAs }],
                    { source: 'correction' },
                  ))
                }}
                onDismiss={() => { void act(`suggest:${suggestion.term}`, () => dismissSuggestion(suggestion.term)) }}
              />
            ))}
          </ul>
        </SettingsGroup>
      ) : null}

      {history ? (
        <p data-testid="voice-vocabulary-history" className="mt-2 flex flex-wrap items-center gap-x-2 px-0.5 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
          <span>
            {(() => {
              const dated = historyDate && !Number.isNaN(historyDate.getTime())
              const date = dated ? historyDate.toLocaleDateString(DATE_LOCALES[locale], { month: 'long', day: 'numeric' }) : ''
              // An analysis the user closed without adding anything is not "added 0 words".
              if (history.addedCount === 0) {
                return dated
                  ? t('voice.settings.vocabulary.historyFooterNone', { date })
                  : t('voice.settings.vocabulary.historyFooterNoneUndated')
              }
              return dated
                ? t('voice.settings.vocabulary.historyFooter', { date, count: history.addedCount })
                : t('voice.settings.vocabulary.historyFooterUndated', { count: history.addedCount })
            })()}
          </span>
          <Button variant="link" size="sm" onClick={() => setHistoryOpen(true)}>
            {t('voice.settings.vocabulary.historyAgain')}
          </Button>
        </p>
      ) : null}

      {vocabulary ? (
        <VoiceVocabularyBulkDialog open={bulkOpen} onClose={() => setBulkOpen(false)} vocabulary={vocabulary} />
      ) : null}
      <VoiceHistoryVocabularyDialog
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        initialModel={{ providerId: catalog.preferences.correctionProviderId, modelId: catalog.preferences.correctionModelId }}
        defaultTarget={(catalog.correction as VoiceCatalog['correction'] | undefined)?.defaultTarget ?? null}
      />
    </SettingsSection>
  )
}

function VocabularyRow({ entry, busy, onEdit, onRemove }: {
  entry: VoiceVocabularyEntry
  busy: boolean
  onEdit: () => void
  onRemove: () => void
}) {
  return (
    <li data-testid="voice-vocabulary-row" className={`${GRID} border-t border-[var(--color-border)] py-2.5`}>
      <span className="min-w-0 break-words font-mono text-[13px] text-[var(--color-text-primary)]">{entry.term}</span>
      <span className="min-w-0 break-words text-xs text-[var(--color-text-secondary)]">
        {entry.aliases.length > 0 ? entry.aliases.join('、') : <span className="text-[var(--color-text-tertiary)]">—</span>}
      </span>
      <VocabularyRowMenu term={entry.term} busy={busy} onEdit={onEdit} onRemove={onRemove} />
    </li>
  )
}

function VocabularyRowMenu({ term, busy, onEdit, onRemove }: {
  term: string
  busy: boolean
  onEdit: () => void
  onRemove: () => void
}) {
  const t = useTranslation()
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  useDismissable({ open, refs: [menuRef], triggerRef, onDismiss: () => setOpen(false) })

  const item = 'flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]'
  return (
    <div className="relative flex justify-end">
      <IconButton
        ref={triggerRef}
        icon={<Ellipsis size={15} strokeWidth={1.75} aria-hidden="true" />}
        label={t('voice.settings.vocabulary.rowActions', { term })}
        size="xs"
        tone="muted"
        loading={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      />
      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('voice.settings.vocabulary.rowActions', { term })}
          className="glass-panel absolute right-0 top-full z-[var(--z-dropdown)] mt-1 w-32 rounded-[var(--radius-lg)] p-1"
        >
          <button
            type="button"
            role="menuitem"
            className={`${item} text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]`}
            onClick={() => { setOpen(false); onEdit() }}
          >
            <Pencil size={14} strokeWidth={1.75} aria-hidden="true" className="text-[var(--color-text-tertiary)]" />
            {t('voice.settings.vocabulary.edit')}
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${item} text-[var(--color-error)] hover:bg-[var(--color-error-soft)]`}
            onClick={() => { setOpen(false); onRemove() }}
          >
            <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
            {t('common.delete')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function VocabularyDraftRow({ draft, saving, errorKey, onChange, onSave, onCancel }: {
  draft: Draft
  saving: boolean
  errorKey: TranslationKey | null
  onChange: (draft: Draft) => void
  onSave: () => void
  onCancel: () => void
}) {
  const t = useTranslation()
  const termId = useId()
  const aliasesId = useId()
  const errorId = useId()

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      onSave()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
  }

  return (
    <li data-testid="voice-vocabulary-draft" className="space-y-2 border-t border-[var(--color-border)] py-3">
      <div className="grid grid-cols-[minmax(0,200px)_minmax(0,1fr)] gap-x-4 gap-y-1">
        <label htmlFor={termId} className="text-[11px] text-[var(--color-text-tertiary)]">
          {t('voice.settings.vocabulary.column.term')}
        </label>
        <label htmlFor={aliasesId} className="text-[11px] text-[var(--color-text-tertiary)]">
          {t('voice.settings.vocabulary.aliasesLabel')}
        </label>
        <Input
          id={termId}
          size="md"
          autoFocus
          value={draft.term}
          maxLength={64}
          className="font-mono"
          aria-describedby={errorKey ? errorId : undefined}
          aria-invalid={errorKey ? true : undefined}
          onChange={(event) => onChange({ ...draft, term: event.target.value })}
          onKeyDown={onKeyDown}
        />
        <Input
          id={aliasesId}
          size="md"
          value={draft.aliases}
          placeholder={t('voice.settings.vocabulary.aliasesPlaceholder')}
          onChange={(event) => onChange({ ...draft, aliases: event.target.value })}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {errorKey ? (
          <p id={errorId} role="alert" className="mr-auto text-xs text-[var(--color-error)]">{t(errorKey)}</p>
        ) : null}
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={saving}>{t('common.cancel')}</Button>
        <Button variant="primary" size="sm" loading={saving} disabled={!draft.term.trim()} onClick={onSave}>
          {t('voice.settings.vocabulary.save')}
        </Button>
      </div>
    </li>
  )
}

function SuggestionRow({ suggestion, busy, onAdd, onDismiss }: {
  suggestion: VoiceVocabularySuggestion
  busy: boolean
  onAdd: () => void
  onDismiss: () => void
}) {
  const t = useTranslation()
  return (
    <li data-testid="voice-vocabulary-suggestion" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
      <span className="font-mono text-[13px] text-[var(--color-text-primary)]">{suggestion.term}</span>
      <span className="min-w-0 flex-1 text-xs text-[var(--color-text-tertiary)]">
        {suggestion.heardAs.length > 0
          ? t('voice.settings.vocabulary.suggestions.heardAs', {
            heard: suggestion.heardAs.join('、'),
            count: suggestion.count,
          })
          : t('voice.settings.vocabulary.suggestions.count', { count: suggestion.count })}
      </span>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button variant="secondary" size="sm" loading={busy} onClick={onAdd}>
          {t('voice.settings.vocabulary.suggestions.add')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          aria-label={t('voice.settings.vocabulary.suggestions.dismissNamed', { term: suggestion.term })}
          onClick={onDismiss}
        >
          {t('voice.settings.vocabulary.suggestions.dismiss')}
        </Button>
      </div>
    </li>
  )
}
