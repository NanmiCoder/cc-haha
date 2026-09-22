import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '@/i18n'
import { TransferVerificationStatus } from './TransferVerificationStatus'
import type { RemoteTransferTask } from './useRemoteTransfers'

const ROTATION_MS = 3000
const formatBytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`

/** A bounded current-batch carousel. Rendering/rotation never launches a transfer. */
export function RemoteTransferHeader({ tasks, onCancel }: { tasks: RemoteTransferTask[]; onCancel: (id: string) => Promise<void> }) {
  const t = useTranslation()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [paused, setPaused] = useState<boolean | null>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(false)
  const currentTasks = useRef(tasks)
  currentTasks.current = tasks
  const sequence = tasks.map(task => task.id).join('|')
  const isPaused = paused ?? reducedMotion
  const rotating = tasks.length > 1 && !isPaused && !hovered && !focused
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!media) return
    const update = () => setReducedMotion(media.matches)
    update()
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [])
  useEffect(() => {
    if (!rotating) return
    const timer = setInterval(() => setSelectedId(previous => {
      const list = currentTasks.current
      const index = Math.max(0, list.findIndex(task => task.id === previous))
      return list[(index + 1) % list.length]?.id ?? null
    }), ROTATION_MS)
    return () => clearInterval(timer)
    // Byte-progress updates must not restart the carousel clock.
  }, [sequence, rotating])
  if (tasks.length === 0) return null
  const index = Math.max(0, tasks.findIndex(task => task.id === selectedId))
  const task = tasks[index]!
  const job = task.job
  const name = task.remotePath.split('/').filter(Boolean).at(-1) || '/'
  const terminal = ['completed', 'failed', 'cancelled'].includes(task.state)
  const status = task.state === 'completed' ? t('managedResources.files.transferCompleted')
    : task.state === 'cancelled' ? t('managedResources.transfer.cancelled')
    : task.state === 'failed' ? t('managedResources.files.operationFailed')
    : task.state === 'verifying' ? t('managedResources.transfer.verifying')
    : task.state === 'in_progress' ? t('managedResources.files.transferring') : t('managedResources.transfer.preparing')
  const move = (step: number) => setSelectedId(tasks[(index + step + tasks.length) % tasks.length]!.id)
  return <div className="min-w-0 flex-1 basis-[260px]" data-testid="remote-transfer-header"
    role="group" aria-label={t('managedResources.transfer.activity')}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}>
    <div className="flex min-w-0 items-center gap-2">
      <div role="status" aria-live={rotating ? 'off' : 'polite'} aria-atomic="true" className="min-w-0 flex-1 text-[11px] text-[var(--color-text-secondary)]"
        data-transfer-id={task.id} data-transfer-state={task.state}>
        <div className="flex min-w-0 items-center gap-1">
          {task.direction === 'upload' ? <ArrowUpFromLine size={12} aria-hidden="true" /> : <ArrowDownToLine size={12} aria-hidden="true" />}
          <span className="shrink-0">{t(task.direction === 'upload' ? 'managedResources.files.upload' : 'managedResources.files.download')}</span>
          <span className="truncate font-mono" title={task.remotePath}>{task.picking ? status : name}</span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          {!task.picking && <span>{status}</span>}
          {job && <span className="tabular-nums">{formatBytes(job.transferred)} / {formatBytes(job.size)}</span>}
          {job && (task.state === 'in_progress' || task.state === 'completed') && <>
            <progress className="h-1.5 w-16" aria-label={t('managedResources.files.transferring')} max={Math.max(1, job.size)} value={Math.min(job.size, job.transferred)} />
            <span className="tabular-nums">{job.size ? Math.min(100, job.transferred / job.size * 100).toFixed(1) : task.state === 'completed' ? '100.0' : '0.0'}%</span>
          </>}
          {job?.folder && <span>{job.entriesCompleted ?? 0} / {job.entriesTotal ?? 0}</span>}
          <TransferVerificationStatus job={task.state === 'verifying' ? job : null} />
          {task.error && <span role="alert" className="text-[var(--color-error)]">{task.error === 'TARGET_EXISTS' ? t('managedResources.transfer.targetExists') : task.error}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {tasks.length > 1 && <>
          <IconButton size="2xs" icon={<ChevronLeft />} label={t('managedResources.transfer.previous')} onClick={() => move(-1)} />
          <span className="text-[10px] tabular-nums text-[var(--color-text-tertiary)]" aria-label={t('managedResources.transfer.position', { current: index + 1, total: tasks.length })}>{index + 1}/{tasks.length}</span>
          <IconButton size="2xs" icon={<ChevronRight />} label={t('managedResources.transfer.next')} onClick={() => move(1)} />
          <IconButton size="2xs" icon={isPaused ? <Play /> : <Pause />} label={t(isPaused ? 'managedResources.transfer.resumeRotation' : 'managedResources.transfer.pauseRotation')} pressed={isPaused} onClick={() => setPaused(!isPaused)} />
        </>}
        {task.active && !terminal && <Button size="xs" variant="secondary" disabled={task.cancelling} onClick={() => void onCancel(task.id)}>{t('managedResources.files.cancelTransfer')}</Button>}
      </div>
    </div>
  </div>
}
