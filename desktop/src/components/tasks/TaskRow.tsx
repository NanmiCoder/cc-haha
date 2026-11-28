import { describeTaskSchedule } from '@/lib/scheduledTask'
import { Fragment, useCallback, useState, useRef } from 'react'
import { CirclePause, CirclePlay, Clock, Ellipsis, LoaderCircle, Pencil, Play, ScrollText, Trash2 } from 'lucide-react'
import type { CronTask } from '../../types/task'
import { useTaskStore } from '../../stores/taskStore'
import { useTranslation } from '../../i18n'
import { TaskRunsPanel } from './TaskRunsPanel'
import { ConfirmPopover } from '@/components/tasks/ConfirmPopover'
import { Badge, StatusDot } from '@/components/ui/Badge'
import { IconButton } from '@/components/ui/IconButton'
import { useDismissable } from '@/hooks/useDismissable'

type Props = {
  task: CronTask
  showLogs: boolean
  onToggleLogs: () => void
}

type ConfirmAction = 'run' | 'toggle' | 'delete' | null

export function TaskRow({ task, showLogs, onToggleLogs }: Props) {
  const { deleteTask, updateTask, runTask } = useTaskStore()
  const t = useTranslation()
  const openTaskEditor = useTaskStore(state => state.openTaskEditor)
  const [showMenu, setShowMenu] = useState(false)
  const [activeMenuItem, setActiveMenuItem] = useState<'edit' | 'toggle' | 'delete' | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null)
  const [logsRefreshKey, setLogsRefreshKey] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLDivElement>(null)

  // Two overlays with independent open states, so two subscriptions rather
  // than one handler branching on both. The hand-rolled version listened on
  // `mousedown`, which does not fire reliably for touch — on the H5 build
  // tapping outside left this menu open. Escape now closes them too; neither
  // overlay lives inside a dialog, so no propagation guard is needed.
  const closeMenu = useCallback(() => {
    setShowMenu(false)
    setActiveMenuItem(null)
  }, [])
  const closeConfirm = useCallback(() => setConfirmAction(null), [])

  useDismissable({ open: showMenu, refs: [menuRef], onDismiss: closeMenu })
  useDismissable({ open: confirmAction !== null, refs: [confirmRef], onDismiss: closeConfirm })

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

  // A finished one-time task has no future run to resume; it is not "disabled".
  const finished = task.scheduleState === 'completed'

  const handleToggle = async () => {
    setConfirmAction(null)
    setShowMenu(false)
    try {
      await updateTask(task.id, { enabled: !task.enabled })
    } catch (err) {
      console.error('Failed to update task:', err)
    }
  }

  const handleDelete = async () => {
    setConfirmAction(null)
    setShowMenu(false)
    try {
      await deleteTask(task.id)
    } catch (err) {
      console.error('Failed to delete task:', err)
    }
  }

  const menuItem = 'flex h-8 w-full items-center gap-2 rounded-[var(--radius-control)] px-2.5 text-left text-[13px] transition-[background-color,box-shadow] duration-150 ease-out focus-visible:outline-none'

  // One meta line rather than three stacked fragments, per the handoff: the
  // row is scanned for its name and its schedule, and the rest reads as a
  // single caption. Dates sit in tabular mono so they line up down the list;
  // the labels and the free-text description stay in the UI face.
  const meta: Array<{ key: string; label?: string; value: string; mono: boolean }> = [
    { key: 'created', label: t('tasks.createdAt'), value: new Date(task.createdAt).toLocaleDateString(), mono: true },
    ...(task.lastFiredAt
      ? [{ key: 'last', label: t('tasks.lastRunAt'), value: new Date(task.lastFiredAt).toLocaleDateString(), mono: true }]
      : []),
    ...(task.description ? [{ key: 'desc', value: task.description, mono: false }] : []),
  ]

  return (
    <div>
      <div className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--color-surface-hover)]">
        {/* Left: status + info */}
        <StatusDot
          tone={task.enabled ? 'success' : 'neutral'}
          size="md"
          label={finished ? t('scheduledChat.completed') : task.enabled ? t('tasks.active') : t('tasks.disabled')}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-[var(--color-text-primary)]">{task.name}</div>
          <div className="mt-0.5 truncate text-xs text-[var(--color-text-tertiary)]">
            {meta.map((part, index) => (
              <Fragment key={part.key}>
                {index > 0 && ' · '}
                {part.label}
                {part.mono
                  ? <span className="font-mono text-[11px] tabular-nums">{part.value}</span>
                  : part.value}
              </Fragment>
            ))}
          </div>
        </div>

        {/* Right: schedule + actions. The schedule is a sentence, not code, so
            it is not set in mono; the raw cron stays on hover. */}
        <Badge pill={false} tabularNums title={task.cron} icon={<Clock size={11} strokeWidth={1.75} aria-hidden="true" />}>
          {describeTaskSchedule(task, t)}
        </Badge>

        <div className="flex shrink-0 items-center gap-0.5">
          {/* Run Now */}
          <div className="relative" ref={confirmAction === 'run' ? confirmRef : undefined}>
            <IconButton
              icon={isRunning
                ? <LoaderCircle size={16} strokeWidth={1.75} aria-hidden="true" className="animate-spin text-[var(--color-info)]" />
                : <Play size={16} strokeWidth={1.75} aria-hidden="true" />}
              label={t('tasks.runNow')}
              showTooltip={task.enabled}
              size="sm"
              tone="secondary"
              disabled={isRunning || !task.enabled}
              onClick={() => setConfirmAction(confirmAction === 'run' ? null : 'run')}
            />
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

          {/* View Logs — `pressed` carries both the resting fill and the
              `aria-pressed` state the hand-rolled className could not. The
              tone is the same quiet `secondary` as its neighbours in both
              states; no className color override, since two `text-[…]` values
              would be resolved by stylesheet order. */}
          <IconButton
            icon={<ScrollText size={16} strokeWidth={1.75} aria-hidden="true" />}
            label={t('tasks.viewLogs')}
            size="sm"
            tone="secondary"
            pressed={showLogs}
            onClick={onToggleLogs}
          />

          {/* More menu */}
          <div className="relative" ref={menuRef}>
            <IconButton
              icon={<Ellipsis size={16} strokeWidth={1.75} aria-hidden="true" />}
              label={t('tasks.moreActions')}
              size="sm"
              tone="secondary"
              aria-haspopup="menu"
              aria-expanded={showMenu}
              onClick={() => { setShowMenu(!showMenu); setConfirmAction(null) }}
            />

            {showMenu && !confirmAction && (
              <div
                onMouseLeave={() => setActiveMenuItem(null)}
                className="dropdown-glass popover-motion absolute right-0 top-full z-[var(--z-dropdown)] mt-1.5 w-44 rounded-[var(--radius-xl)] p-[5px]"
              >
                {/* Edit */}
                <button
                  type="button"
                  onMouseEnter={() => setActiveMenuItem('edit')}
                  onFocus={() => setActiveMenuItem('edit')}
                  onBlur={() => setActiveMenuItem((cur) => (cur === 'edit' ? null : cur))}
                  onClick={() => { closeMenu(); openTaskEditor(task.id) }}
                  className={`${menuItem} text-[var(--color-text-primary)] ${activeMenuItem === 'edit' ? 'v6c-row-highlight' : ''}`}
                >
                  <Pencil size={14} strokeWidth={1.75} aria-hidden="true" className="text-[var(--color-text-tertiary)]" />
                  {t('tasks.edit')}
                </button>

                {/* Toggle */}
                {!finished && (
                  <button
                    type="button"
                    onMouseEnter={() => setActiveMenuItem('toggle')}
                    onFocus={() => setActiveMenuItem('toggle')}
                    onBlur={() => setActiveMenuItem((cur) => (cur === 'toggle' ? null : cur))}
                    onClick={() => { setActiveMenuItem(null); setConfirmAction('toggle') }}
                    className={`${menuItem} text-[var(--color-text-primary)] ${activeMenuItem === 'toggle' ? 'v6c-row-highlight' : ''}`}
                  >
                    {task.enabled
                      ? <CirclePause size={14} strokeWidth={1.75} aria-hidden="true" className="text-[var(--color-text-tertiary)]" />
                      : <CirclePlay size={14} strokeWidth={1.75} aria-hidden="true" className="text-[var(--color-text-tertiary)]" />}
                    {task.enabled ? t('common.disable') : t('common.enable')}
                  </button>
                )}

                <div className="mx-1 my-1 h-px bg-[var(--color-border)]" />

                {/* Delete — the hover fill was `--color-error-container` at `/18`
                    alpha, which Safari 15 WebView drops; `-soft` is the opaque
                    token for exactly this. */}
                <button
                  type="button"
                  onMouseEnter={() => setActiveMenuItem('delete')}
                  onFocus={() => setActiveMenuItem('delete')}
                  onBlur={() => setActiveMenuItem((cur) => (cur === 'delete' ? null : cur))}
                  onClick={() => { setActiveMenuItem(null); setConfirmAction('delete') }}
                  className={`${menuItem} text-[var(--color-error)] ${activeMenuItem === 'delete' ? 'bg-[var(--color-error-soft)]' : 'hover:bg-[var(--color-error-soft)]'}`}
                >
                  <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
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
                  confirmVariant="danger"
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Runs panel — full-bleed inside the list card, so it reads as a drawer
          under the row rather than a second card floating inside it. */}
      {showLogs && (
        <TaskRunsPanel taskId={task.id} onClose={onToggleLogs} refreshKey={logsRefreshKey} />
      )}

      {/* Edit modal */}

    </div>
  )
}
