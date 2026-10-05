import { Box, Puzzle } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { useTranslation } from '@/i18n'
import { safeMentionIcon, type ComposerMention } from '@/lib/composerMentions'

export function ComposerReferenceDetail({ mention, onClose }: { mention: ComposerMention | null, onClose: () => void }) {
  const t = useTranslation()
  const icon = safeMentionIcon(mention?.icon)
  const KindIcon = mention?.kind === 'plugin' ? Puzzle : Box
  return <Modal open={!!mention} onClose={onClose} title={mention?.label || t('chat.referenceDetails')} width={440}>
    {mention && <div className="space-y-4 pb-1">
      <div className="flex items-center gap-2 text-xs text-[var(--color-text-tertiary)]">
        {icon
          ? <img src={`${import.meta.env.BASE_URL}${icon.slice(1)}`} alt="" className="h-5 w-5 object-contain" />
          : <KindIcon aria-hidden="true" size={16} strokeWidth={1.75} />}
        <span>{t(mention.kind === 'plugin' ? 'chat.referencePlugins' : 'chat.referenceSkills')}</span>
      </div>
      <p className="whitespace-pre-wrap text-[13px] leading-6 text-[var(--color-text-primary)]">{mention.description || mention.label}</p>
      {mention.id && <p className="break-words font-mono text-[11px] text-[var(--color-text-tertiary)]">{mention.id}</p>}
    </div>}
  </Modal>
}
