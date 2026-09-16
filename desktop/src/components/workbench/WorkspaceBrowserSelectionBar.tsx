import { Send, Trash2, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '@/i18n'
import { usePreviewSelectionStore } from '@/stores/previewSelectionStore'
import { discardBrowserSelections, sendBrowserSelections, undoBrowserSelection } from '@/lib/workspace/browserSelections'

export function WorkspaceBrowserSelectionBar({ sessionId, browserTabId }: { sessionId: string, browserTabId: string }) {
  const t = useTranslation()
  const draft = usePreviewSelectionStore(state => state.bySession[browserTabId])
  if (!draft?.items.length) return null
  return (
    <div role="region" aria-label={t('browser.selection.draftCount', { count: draft.items.length })} aria-live="polite" className="flex shrink-0 items-center gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-primary)]">{t('browser.selection.draftCount', { count: draft.items.length })}</span>
      <IconButton icon={<Undo2 size={14} />} label={t('browser.selection.undo')} size="xs" onClick={() => { void undoBrowserSelection(browserTabId) }} />
      <IconButton icon={<Trash2 size={14} />} label={t('browser.selection.clear')} size="xs" onClick={() => { void discardBrowserSelections(browserTabId) }} />
      <Button size="sm" icon={<Send size={13} />} onClick={() => { void sendBrowserSelections(sessionId, browserTabId) }}>{t('browser.selection.sendBatch', { count: draft.items.length })}</Button>
    </div>
  )
}
