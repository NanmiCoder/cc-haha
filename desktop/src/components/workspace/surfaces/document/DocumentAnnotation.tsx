import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { TextArea } from '@/components/ui/TextArea'
import { useTranslation } from '@/i18n'

/** Locations are document positions (pages/cells), never source-code line numbers. */
export type DocumentAnnotationSelection = {
  text: string
  location: string
}

export function DocumentAnnotation({ selection, onClose, onAdd }: {
  selection: DocumentAnnotationSelection
  onClose: () => void
  onAdd: (note: string) => void
}) {
  const t = useTranslation()
  const [note, setNote] = useState('')
  const submit = () => {
    if (note.trim()) onAdd(note.trim())
  }
  return (
    <Modal open onClose={onClose} title={t('workspace.localComment')} width={440}
      footer={<>
        <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
        <Button disabled={!note.trim()} onClick={submit}>{t('workspace.addCommentToChat')}</Button>
      </>}
    >
      <p className="mb-2 text-xs text-[var(--color-text-secondary)]">{selection.location}</p>
      {selection.text ? <blockquote className="mb-3 max-h-36 overflow-auto whitespace-pre-wrap border-l-2 border-[var(--color-border)] pl-3 text-sm text-[var(--color-text-secondary)]">{selection.text}</blockquote> : null}
      <TextArea autoFocus label={t('workspace.localComment')} placeholder={t('workspace.commentPlaceholder')}
        value={note} maxLength={8000} onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
            event.preventDefault()
            submit()
          }
        }}
      />
    </Modal>
  )
}
