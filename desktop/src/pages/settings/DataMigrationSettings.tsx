import { useEffect, useRef, useState } from 'react'
import { FolderInput } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Modal } from '@/components/ui/Modal'
import { Progress } from '@/components/ui/Progress'
import { useTranslation, type TranslationKey } from '@/i18n'
import { getDesktopHost, type MigrationPreview, type MigrationStatus } from '@/lib/desktopHost'
import { formatBytes } from '@/lib/formatBytes'

const STAGE_LABELS = {
  preparing: 'settings.general.migration.stagePreparing',
  quiescing: 'settings.general.migration.stageQuiescing',
  copying: 'settings.general.migration.stageCopying',
  verifying: 'settings.general.migration.stageVerifying',
  committing: 'settings.general.migration.stageCommitting',
  restarting: 'settings.general.migration.stageRestarting',
  completed: 'settings.general.migration.completed',
  cancelled: 'settings.general.migration.cancelled',
  failed: 'settings.general.migration.failed',
} satisfies Record<MigrationStatus['stage'], TranslationKey>

function isActive(status: MigrationStatus | null): boolean {
  return status !== null && !['completed', 'cancelled', 'failed'].includes(status.stage)
}

type DataMigrationSettingsProps = {
  environmentControlled: boolean
  disabled?: boolean
  onBusyChange?: (busy: boolean) => void
}

export function DataMigrationSettings({ environmentControlled, disabled = false, onBusyChange }: DataMigrationSettingsProps) {
  const t = useTranslation()
  const host = getDesktopHost()
  const [preview, setPreview] = useState<MigrationPreview | null>(null)
  const [status, setStatus] = useState<MigrationStatus | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const statusRef = useRef(status)
  const revisionRef = useRef(0)
  statusRef.current = status
  const active = isActive(status)
  const busy = preparing || starting || active

  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])

  useEffect(() => {
    if (!host.isDesktop || !host.capabilities.appMode) return
    let disposed = false
    let polling = false
    let unlisten: (() => void) | undefined
    const accept = (next: MigrationStatus | null) => {
      if (disposed) return
      setStatus(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
      setStatusError(null)
      if (next?.stage === 'completed') setError(null)
      if (!isActive(next)) setCancelling(false)
    }
    const poll = async () => {
      if (polling || disposed) return
      polling = true
      const before = revisionRef.current
      try {
        const next = await host.appMode.migration.status()
        // A late poll must not overwrite a newer progress event.
        if (before === revisionRef.current) accept(next)
      } catch {
        if (!disposed && isActive(statusRef.current)) {
          setStatusError(t('settings.general.migration.statusError'))
        }
      } finally {
        polling = false
      }
    }
    void host.appMode.migration.onProgress(next => {
      revisionRef.current += 1
      accept(next)
    }).then(stop => {
      if (disposed) stop()
      else unlisten = stop
    }).catch(() => { /* Polling also supports hosts whose event stream disconnected. */ })
    void poll()
    const timer = window.setInterval(() => void poll(), 1_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
      unlisten?.()
    }
  }, [host, t])

  if (!host.isDesktop || !host.capabilities.appMode) return null

  const chooseTarget = async () => {
    if (environmentControlled || disabled || busy) return
    setError(null)
    setPreparing(true)
    try {
      const selected = await host.dialogs.open({
        directory: true,
        multiple: false,
        title: t('settings.general.migration.chooseTitle'),
      })
      if (typeof selected !== 'string') return
      setPreview(await host.appMode.migration.prepare(selected))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('settings.general.migration.error'))
    } finally {
      setPreparing(false)
    }
  }

  const start = async () => {
    if (!preview || starting) return
    const selected = preview
    setStarting(true)
    setError(null)
    setPreview(null)
    revisionRef.current += 1
    setStatus({
      id: selected.id,
      sourceDir: selected.sourceDir,
      targetDir: selected.targetDir,
      stage: 'quiescing',
      files: 0,
      totalFiles: selected.files,
      bytes: 0,
      totalBytes: selected.bytes,
      cancellable: true,
    })
    try {
      await host.appMode.migration.start(selected.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('settings.general.migration.error'))
      try {
        setStatus(await host.appMode.migration.status())
      } catch {
        // The start request may have reached the host before IPC disconnected.
        // Keep the progress barrier until polling establishes the actual result.
        setStatusError(t('settings.general.migration.statusError'))
      }
    } finally {
      setStarting(false)
    }
  }

  const cancel = async () => {
    if (!status?.cancellable || cancelling) return
    setCancelling(true)
    setError(null)
    try {
      await host.appMode.migration.cancel(status.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('settings.general.migration.error'))
      setCancelling(false)
    }
  }

  const openPath = async (directory: string) => {
    try {
      await host.shell.openPath(directory)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('settings.general.migration.error'))
    }
  }

  const directories = (sourceDir: string, targetDir: string) => (
    <dl className="space-y-2 text-xs">
      <div>
        <dt className="text-[var(--color-text-tertiary)]">{t('settings.general.migration.source')}</dt>
        <dd className="mt-1 break-all font-mono text-[var(--color-text-secondary)]">{sourceDir}</dd>
      </div>
      <div>
        <dt className="text-[var(--color-text-tertiary)]">{t('settings.general.migration.target')}</dt>
        <dd className="mt-1 break-all font-mono text-[var(--color-text-secondary)]">{targetDir}</dd>
      </div>
    </dl>
  )
  const progress = status && status.totalBytes > 0 ? status.bytes / status.totalBytes * 100 : 0

  // Rendered as one row of the storage section's settings group, so it carries
  // the row padding itself rather than a divider of its own.
  return (
    <div className="px-4 py-3">
      <div className="flex flex-col gap-x-6 gap-y-2.5 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium leading-5 text-[var(--color-text-primary)]">{t('settings.general.migration.title')}</div>
          <p className="mt-0.5 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">{t('settings.general.migration.description')}</p>
        </div>
        <Button
          type="button"
          size="base"
          variant="secondary"
          className="shrink-0 self-start sm:self-auto"
          disabled={environmentControlled || disabled || busy || !!preview}
          loading={preparing}
          icon={<FolderInput size={14} strokeWidth={1.75} aria-hidden="true" />}
          onClick={() => void chooseTarget()}
        >
          {t('settings.general.migration.choose')}
        </Button>
      </div>
      {environmentControlled && (
        <p className="mt-2 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">{t('settings.general.migration.environment')}</p>
      )}
      {error && !active && <p className="mt-2 text-xs text-[var(--color-error)]" role="alert">{error}</p>}
      {status && !active && (
        <div className="mt-3 space-y-3 rounded-[var(--radius-md)] bg-[var(--color-surface-container)] p-3" role="status">
          <p className="text-[13px] font-medium text-[var(--color-text-primary)]">{t(STAGE_LABELS[status.stage])}</p>
          {status.error && <p className="text-xs text-[var(--color-error)]" role="alert">{status.error}</p>}
          {directories(status.sourceDir, status.targetDir)}
          {status.stage === 'completed' && (
            <>
              <p className="text-xs leading-[1.5] text-[var(--color-text-secondary)]">{t('settings.general.migration.retained')}</p>
              <p className="text-xs leading-[1.5] text-[var(--color-text-tertiary)]">{t('settings.general.migration.cli')}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="base" variant="secondary" onClick={() => void openPath(status.sourceDir)}>{t('settings.general.migration.openSource')}</Button>
                <Button size="base" variant="secondary" onClick={() => void openPath(status.targetDir)}>{t('settings.general.migration.openTarget')}</Button>
              </div>
            </>
          )}
        </div>
      )}
      <ConfirmDialog
        open={!!preview}
        onClose={() => { if (!starting) setPreview(null) }}
        onConfirm={start}
        title={t('settings.general.migration.confirmTitle')}
        confirmLabel={t('settings.general.migration.confirm')}
        cancelLabel={t('common.cancel')}
        confirmVariant="primary"
        loading={starting}
        body={preview && (
          <div className="space-y-3 text-[13px] leading-6 text-[var(--color-text-secondary)]">
            {directories(preview.sourceDir, preview.targetDir)}
            <p>{t('settings.general.migration.preview', { files: preview.files, size: formatBytes(preview.bytes) })}</p>
            {preview.activeTasks > 0 && <p>{t('settings.general.migration.activeTasks', { count: preview.activeTasks })}</p>}
            <p>{t('settings.general.migration.stopWarning')}</p>
            <p>{t('settings.general.migration.externalWarning')}</p>
            <p>{t('settings.general.migration.retained')}</p>
          </div>
        )}
      />
      <Modal
        open={active}
        onClose={() => {}}
        title={t('settings.general.migration.running')}
        width={500}
        footer={(
          <Button variant="secondary" disabled={!status?.cancellable || cancelling} loading={cancelling} onClick={() => void cancel()}>
            {t('settings.general.migration.cancel')}
          </Button>
        )}
      >
        {status && (
          <div className="space-y-3 text-[13px] text-[var(--color-text-secondary)]" aria-live="polite">
            <p>{cancelling ? t('settings.general.migration.cancelling') : t(STAGE_LABELS[status.stage])}</p>
            <Progress
              label={t(STAGE_LABELS[status.stage])}
              value={['committing', 'restarting'].includes(status.stage) ? 100 : progress}
              indeterminate={['preparing', 'quiescing', 'verifying'].includes(status.stage)}
            />
            <p className="text-xs">{t('settings.general.migration.progress', {
              files: status.files,
              totalFiles: status.totalFiles,
              bytes: formatBytes(status.bytes),
              totalBytes: formatBytes(status.totalBytes),
            })}</p>
            {directories(status.sourceDir, status.targetDir)}
            {(error || statusError) && <p className="text-xs text-[var(--color-error)]" role="alert">{error || statusError}</p>}
          </div>
        )}
      </Modal>
    </div>
  )
}
