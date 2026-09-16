import { Modal } from '@/components/ui/Modal'
import { useTranslation } from '@/i18n'
import { safeMentionIcon, type ComposerMention } from '@/lib/composerMentions'

export function ComposerReferenceDetail({ mention, onClose }: { mention: ComposerMention | null, onClose: () => void }) {
  const t = useTranslation()
  const icon = safeMentionIcon(mention?.icon)
  return <Modal open={!!mention} onClose={onClose} title={mention?.label || t('chat.referenceDetails')} width={440}>
    {mention && <div className="space-y-4 pb-1">
      <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
        {icon ? <img src={`${import.meta.env.BASE_URL}${icon.slice(1)}`} alt="" className="h-6 w-6 object-contain" /> : <span aria-hidden="true" className="material-symbols-outlined text-xl">{mention.kind === 'plugin' ? 'extension' : 'deployed_code'}</span>}
        <span>{t(mention.kind === 'plugin' ? 'chat.referencePlugins' : 'chat.referenceSkills')}</span>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-6 text-[var(--color-text-primary)]">{mention.description || mention.label}</p>
      {mention.id && <p className="break-words text-xs text-[var(--color-text-tertiary)]">{mention.id}</p>}
    </div>}
  </Modal>
}
