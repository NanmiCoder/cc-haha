import { useMemo, useState } from 'react'
import type { VoiceVocabulary } from '@/api/voice'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { TextArea } from '@/components/ui/TextArea'
import { useTranslation } from '@/i18n'
import { useVoiceVocabularyStore } from '@/stores/voiceVocabularyStore'
import { parseBulkVocabulary } from './voiceVocabularyText'

type Props = {
  open: boolean
  onClose: () => void
  vocabulary: VoiceVocabulary
}

/** Pastes many vocabulary lines at once, with a live count of what will happen. */
export function VoiceVocabularyBulkDialog({ open, onClose, vocabulary }: Props) {
  const t = useTranslation()
  const add = useVoiceVocabularyStore(state => state.add)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  const preview = useMemo(() => parseBulkVocabulary(text, vocabulary.terms), [text, vocabulary.terms])
  const room = Math.max(0, vocabulary.maxTerms - vocabulary.terms.length)
  const overflow = Math.max(0, preview.added - room)

  const close = () => {
    if (saving) return
    setText('')
    setFailed(false)
    onClose()
  }

  const submit = async () => {
    if (preview.entries.length === 0) return
    setSaving(true)
    setFailed(false)
    try {
      await add(preview.entries, { source: 'manual' })
      setText('')
      onClose()
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const summary = [
    t('voice.settings.vocabulary.bulk.added', { count: preview.added }),
    preview.merged > 0 ? t('voice.settings.vocabulary.bulk.merged', { count: preview.merged }) : null,
    preview.duplicates > 0 ? t('voice.settings.vocabulary.bulk.duplicates', { count: preview.duplicates }) : null,
    preview.invalid > 0 ? t('voice.settings.vocabulary.bulk.invalid', { count: preview.invalid }) : null,
  ].filter(Boolean).join(' · ')

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('voice.settings.vocabulary.bulk.title')}
      width={560}
      typography="interface"
      footer={
        <>
          <p
            data-testid="voice-vocabulary-bulk-summary"
            aria-live="polite"
            className="mr-auto self-center text-xs leading-[1.5] text-[var(--color-text-tertiary)]"
          >
            {preview.entries.length > 0 || preview.invalid > 0 ? summary : null}
          </p>
          <Button variant="secondary" size="base" onClick={close} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="base"
            loading={saving}
            disabled={preview.entries.length === 0}
            onClick={() => { void submit() }}
          >
            {/* Pasting only words that are already there still merges their readings. */}
            {preview.added === 0 && preview.merged > 0
              ? t('voice.settings.vocabulary.bulk.submitMerge', { count: preview.merged })
              : t('voice.settings.vocabulary.bulk.submit', { count: preview.added })}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[13px] leading-5 text-[var(--color-text-secondary)]">
          {t('voice.settings.vocabulary.bulk.description')}
        </p>
        <TextArea
          aria-label={t('voice.settings.vocabulary.bulk.label')}
          rows={9}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={t('voice.settings.vocabulary.bulk.placeholder')}
          className="font-mono"
          spellCheck={false}
        />
        {overflow > 0 ? (
          <p role="status" className="text-xs text-[var(--color-warning)]">
            {t('voice.settings.vocabulary.bulk.overflow', { max: vocabulary.maxTerms, count: overflow })}
          </p>
        ) : null}
        {failed ? (
          <p role="alert" className="text-xs text-[var(--color-error)]">{t('voice.settings.vocabulary.saveFailed')}</p>
        ) : null}
      </div>
    </Modal>
  )
}
