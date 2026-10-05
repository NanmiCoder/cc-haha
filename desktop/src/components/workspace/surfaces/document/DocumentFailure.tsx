import { CircleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'
import { isRootedLocalPath } from '@/lib/handlePreviewLink'
import { OpenInSystemButton } from '../OpenInSystemButton'
import { PanelMessage } from '../PanelMessage'

/**
 * A document that could not be shown, with what a reader can do about it: try
 * again (the file may have been mid-write when it was read), do something the
 * viewer knows of, or open it in the application that made it.
 */
export function DocumentFailure({
  message,
  absolutePath,
  onRetry,
  extraActions,
}: {
  message: string
  absolutePath: string
  /** Omit when trying again cannot help (the file is outside the workspace). */
  onRetry?: () => void
  /** Actions specific to the kind of document, shown between "try again" and the system app. */
  extraActions?: ReactNode
}) {
  const t = useTranslation()
  const canOpenInSystem = isRootedLocalPath(absolutePath)
  return (
    <PanelMessage
      icon={CircleAlert}
      tone="error"
      message={message}
      action={onRetry || extraActions || canOpenInSystem ? (
        <>
          {onRetry ? <Button variant="secondary" size="sm" onClick={onRetry}>{t('workspace.document.retry')}</Button> : null}
          {extraActions}
          {canOpenInSystem ? <OpenInSystemButton absolutePath={absolutePath} /> : null}
        </>
      ) : undefined}
    />
  )
}
