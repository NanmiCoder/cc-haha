import { useTranslation } from '@/i18n'
import { PanelMessage } from './PanelMessage'

export function ImagePreview({ dataUrl, path, error }: { dataUrl?: string; path: string; error?: string }) {
  const t = useTranslation()

  if (!dataUrl) {
    return (
      <PanelMessage
        icon="image_not_supported"
        message={error || t('workspace.imagePreviewUnavailable')}
      />
    )
  }

  return (
    <div data-workspace-scroll-surface="" className="min-h-0 flex-1 overflow-auto bg-[var(--color-surface)] p-4">
      <div className="flex min-h-full items-center justify-center">
        <img
          src={dataUrl}
          alt={path}
          className="max-h-full max-w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] object-contain shadow-[var(--shadow-card)]"
        />
      </div>
    </div>
  )
}
