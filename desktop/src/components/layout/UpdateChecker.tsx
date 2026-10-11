import { useEffect } from 'react'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '../../i18n'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { isDesktopRuntime } from '../../lib/desktopRuntime'
import { useUpdateStore } from '../../stores/updateStore'
import { useSettingsStore } from '../../stores/settingsStore'

export function UpdateChecker() {
  const t = useTranslation()
  const autoUpdateEnabled = useSettingsStore((s) => s.autoUpdateEnabled)
  const status = useUpdateStore((s) => s.status)
  const availableVersion = useUpdateStore((s) => s.availableVersion)
  const releaseNotes = useUpdateStore((s) => s.releaseNotes)
  const error = useUpdateStore((s) => s.error)
  const shouldPrompt = useUpdateStore((s) => s.shouldPrompt)
  const initialize = useUpdateStore((s) => s.initialize)
  const installUpdate = useUpdateStore((s) => s.installUpdate)
  const dismissPrompt = useUpdateStore((s) => s.dismissPrompt)

  useEffect(() => {
    if (autoUpdateEnabled) void initialize()
  }, [autoUpdateEnabled, initialize])

  if (!isDesktopRuntime() || !autoUpdateEnabled) return null

  const showPopup = shouldPrompt && !!availableVersion && status === 'downloaded'

  if (!showPopup) return null

  const statusText = t('update.readyBody', { version: availableVersion })

  return (
    <div className="fixed bottom-4 left-1/2 z-[var(--z-toast)] w-[min(360px,calc(100vw-2rem))] -translate-x-1/2">
      <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-4 shadow-[var(--shadow-dropdown)]">
        <p className="text-[14px] font-semibold text-[var(--color-text-primary)]">
          {t('update.readyTitle')}
        </p>
        <p className="mt-1 text-[12px] leading-5 text-[var(--color-text-secondary)]">
          {statusText}
        </p>

        {releaseNotes && (
          <div className="mt-2.5 max-h-28 overflow-y-auto rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2">
            <MarkdownRenderer
              content={releaseNotes}
              className="text-xs leading-5 text-[var(--color-text-secondary)] [&_h1]:mb-2 [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:mb-1.5 [&_h2]:text-xs [&_h2]:font-semibold [&_p]:my-1.5 [&_p]:text-xs [&_p]:leading-5 [&_ul]:my-1.5 [&_ol]:my-1.5"
            />
          </div>
        )}

        {error && (
          <p className="mt-2 text-[12px] text-[var(--color-error)]" role="alert">
            {t('update.failed', { error })}
          </p>
        )}

        {status === 'downloaded' && (
          <div className="mt-3.5 flex gap-2">
            <Button variant="primary" size="base" onClick={() => void installUpdate()}>
              {t('update.installAndRestart')}
            </Button>
            <Button variant="ghost" size="base" onClick={dismissPrompt}>
              {t('update.later')}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
