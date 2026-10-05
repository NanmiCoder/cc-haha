import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'
import { openLocalFileWithSystem, reportOpenFailure } from '@/lib/systemFileOpen'

/**
 * The way out of every state the workspace cannot render — too large, damaged,
 * a format it has no viewer for: hand the file to the operating system.
 *
 * It says why it failed if it does (`reportOpenFailure` names the file); a click
 * that does nothing reads as a broken button.
 */
export function OpenInSystemButton({ absolutePath }: { absolutePath: string }) {
  const t = useTranslation()
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={<ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />}
      onClick={() => {
        void openLocalFileWithSystem(absolutePath).catch(() => reportOpenFailure(absolutePath))
      }}
    >
      {t('workspace.openInSystemApp')}
    </Button>
  )
}
