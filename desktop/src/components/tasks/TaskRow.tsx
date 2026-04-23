import { useState, useRef, useEffect } from 'react'
import type { CronTask } from '../../types/task'
import { useTaskStore } from '../../stores/taskStore'
import { useTranslation } from '../../i18n'
import { describeCron } from '../../lib/cronDescribe'
import { TaskRunsPanel } from './TaskRunsPanel'
import { NewTaskModal } from './NewTaskModal'

type Props = {
  task: CronTask
  showLogs: boolean
  onToggleLogs: () => void
}

type ConfirmAction = 'run' | 'toggle' | 'delete' | null

export function TaskRow({ task, showLogs, onToggleLogs }: Props) {
  const { deleteTask, updateTask, runTask } = useTaskStore()
  const t = useTranslation()
  const [showEdit, setShowEdit] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null)
  const [logsRefreshKey, setLogsRefreshKey] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLDivElement>(null)

  // Close menu / confirm on outside click
  useEffect(() => {
    if (!showMenu && !confirmAction) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (showMenu && menuRef.current && !menuRef.current.contains(target)) {
        setShowMenu(false)
      }
      if (confirmAction && confirmRef.current && !confirmRef.current.contains(target)) {
        setConfirmAction(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showMenu, confirmAction])

  const handleRunNow = async () => {
    setConfirmAction(null)
    setIsRunning(true)
    if (!showLogs) onToggleLogs() // open logs panel (accordion will close others)
    try {
      await runTask(task.id)
      setLogsRefreshKey((k) => k + 1)
    } catch (err) {
      console.error('Failed to run task:', err)
    } finally {
      setIsRunning(false)
    }
  }

  const handleToggle = () => {
    setConfirmAction(null)
    setShowMenu(false)
    updateTask(task.id, { enabled: !task.enabled })
  }

  const handleDelete = () => {
    setConfirmAction(null)
    setShowMenu(false)
    deleteTask(task.id)
  }

  const iconBtn = 'p-1.5 rounded-[var(--radius-sm)] transition-colors'
  const menuItem = 'flex items-center gap-2.5 w-full px-3 py-2 text-xs text-left rounded-[var(--radius-sm)] transition-colors'

  return (
    <div className="border-b border-[var(--color-border-separator)]">
      <div className="flex items-center justify-between px-4 py-3 hover:bg-[var(--color-surface-hover)] transition-colors group">
        {/* Left: status + info */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${task.enabled ? 'bg-[var(--color-success)]' : 'bg-[var(--color-text-tertiary)]'}`} />
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--color-text-primary)] truncate">{task.name}</div>
            {task.description && (
              <div className="text-xs text-[var(--color-text-secondary)] truncate">{task.description}</div>
            )}
            <div className="flex items-center gap-3 text-[11px] text-[var(--color-text-tertiary)] mt-0.5">
              <span>{t('tasks.createdAt')}{new Date(task.createdAt).toLocaleDateString()}</span>
              {task.lastFiredAt && (
                <span>{t('tasks.lastRunAt')}{new Date(task.lastFiredAt).toLocaleDateString()}</span>
              )}
            </div>
          </div>
        </div>

        {/* Right: cron + actions */}
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className="text-xs text-[var(--color-text-tertiary)]" title={task.cron}>
            {describeCron(task.cron, t)}
          </span>

          <div className="flex items-center gap-0.5">
            {/* Run Now */}
            <div className="relative" ref={confirmAction === 'run' ? confirmRef : undefined}>
              <button
                onClick={() => isRunning || !task.enabled ? undefined : setConfirmAction(confirmAction === 'run' ? null : 'run')}
                disabled={isRunning || !task.enabled}
                className={`${iconBtn} ${task.enabled ? 'text-[var(--color-brand)] hover:bg-[var(--color-surface-selected)]' : 'text-[var(--color-text-tertiary)] cursor-not-allowed'} disabled:opacity-50`}
                title={task.enabled ? t('tasks.runNow') : undefined}
              >
                <span className={`material-symbols-outlined text-[18px] ${isRunning ? 'animate-spin' : ''}`}>
                  {isRunning ? 'sync' : 'play_arrow'}
                </span>
              </button>
              {confirmAction === 'run' && (
                <ConfirmPopover
                  message={t('tasks.confirmRun')}
                  confirmLabel={t('tasks.runNow')}
                  onConfirm={handleRunNow}
                  onCancel={() => setConfirmAction(null)}
                  cancelLabel={t('common.cancel')}
                />
              )}
            </div>

            {/* View Logs */}
            <button
              onClick={onToggleLogs}
              className={`${iconBtn} ${showLogs ? 'text-[var(--color-brand)] bg-[var(--color-surface-selected)]' : 'text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-selected)]'}`}
              title={t('tasks.viewLogs')}
            >
              <span className="material-symbols-outlined text-[18px]">receipt_long</span>
            </button>

            {/* More menu */}
            <div className="relative" ref={menuRef}>
              <button
                onClick={() => { setShowMenu(!showMenu); setConfirmAction(null) }}
                className={`${iconBtn} text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-selected)]`}
              >
                <span className="material-symbols-outlined text-[18px]">more_vert</span>
              </button>

              {showMenu && !confirmAction && (
                <div className="absolute right-0 top-full mt-1 z-50 w-44 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg py-1">
                  {/* Edit */}
                  <button
                    onClick={() => { setShowMenu(false); setShowEdit(true) }}
                    className={`${menuItem} text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]`}
                  >
                    <span className="material-symbols-outlined text-[16px] text-[var(--color-text-secondary)]">edit</span>
                    {t('tasks.edit')}
                  </button>

                  {/* Toggle */}
                  <button
                    onClick={() => setConfirmAction('toggle')}
                    className={`${menuItem} text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]`}
                  >
                    <span className="material-symbols-outlined text-[16px] text-[var(--color-text-secondary)]">
                      {task.enabled ? 'pause_circle' : 'play_circle'}
                    </span>
                    {task.enabled ? t('common.disable') : t('common.enable')}
                  </button>

                  <div className="my-1 h-px bg-[var(--color-border-separator)]" />

                  {/* Delete */}
                  <button
                    onClick={() => setConfirmAction('delete')}
                    className={`${menuItem} text-[var(--color-error)] hover:bg-[var(--color-error-container)]/18`}
                  >
                    <span className="material-symbols-outlined text-[16px]">delete</span>
                    {t('common.delete')}
                  </button>
                </div>
              )}

              {/* Confirm popovers for menu actions */}
              {confirmAction === 'toggle' && (
                <div ref={confirmRef}>
                  <ConfirmPopover
                    message={task.enabled ? t('tasks.confirmDisable') : t('tasks.confirmEnable')}
                    confirmLabel={task.enabled ? t('common.disable') : t('common.enable')}
                    onConfirm={handleToggle}
                    onCancel={() => { setConfirmAction(null); setShowMenu(false) }}
                    cancelLabel={t('common.cancel')}
                  />
                </div>
              )}
              {confirmAction === 'delete' && (
                <div ref={confirmRef}>
                  <ConfirmPopover
                    message={t('tasks.confirmDelete')}
                    confirmLabel={t('common.delete')}
                    onConfirm={handleDelete}
                    onCancel={() => { setConfirmAction(null); setShowMenu(false) }}
                    cancelLabel={t('common.cancel')}
                    variant="error"
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Runs panel */}
      {showLogs && (
        <div className="px-4 pb-3">
          <TaskRunsPanel taskId={task.id} onClose={onToggleLogs} refreshKey={logsRefreshKey} />
        </div>
      )}

      {/* Edit modal */}
      {showEdit && (
        <NewTaskModal open editTask={task} onClose={() => setShowEdit(false)} />
      )}
    </div>
  )
}

// ─── Confirm Popover ─────────────────────────────────────────────────────────

function ConfirmPopover({ message, confirmLabel, onConfirm, onCancel, cancelLabel, variant = 'brand' }: {
  message: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  cancelLabel: string
  variant?: 'brand' | 'error'
}) {
  return (
    <div className="absolute right-0 top-full mt-1.5 z-50 w-52 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg p-3">
      <p className="text-xs text-[var(--color-text-secondary)] mb-2.5">{message}</p>
      <div className="flex justify-end gap-1.5">
        <button
          onClick={onCancel}
          className="px-2.5 py-1 text-xs rounded-[var(--radius-sm)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] transition-colors"
        >
          {cancelLabel}
        </button>
        <button
          onClick={onConfirm}
          className={`px-2.5 py-1 text-xs rounded-[var(--radius-sm)] hover:opacity-90 transition-opacity ${
            variant === 'error'
              ? 'bg-[var(--color-error-container)] text-[var(--color-on-error-container)]'
              : 'bg-[image:var(--gradient-btn-primary)] text-[var(--color-btn-primary-fg)]'
          }`}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  )
}
