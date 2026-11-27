import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Terminal, Users, Zap } from 'lucide-react'
import { useAnchoredPosition } from '@/hooks/useAnchoredPosition'
import { useDismissable } from '@/hooks/useDismissable'
import { useTranslation } from '@/i18n'
import { listRunningBackgroundTasks } from '@/lib/backgroundTasks'
import {
  isSubagentBackgroundTask,
  resolveBackgroundTaskTitle,
} from '@/lib/backgroundTaskOutput'
import { workspaceOpen } from '@/lib/workspace/openTarget'
import { useActivityPanelStore } from '@/stores/activityPanelStore'
import { useTabStore } from '@/stores/tabStore'
import type { BackgroundAgentTask, UIMessage } from '@/types/chat'

const HOVER_CLOSE_DELAY_MS = 160

export type BackgroundTaskAgentOpenPayload = {
  sessionId: string
  taskId?: string
  toolUseId: string
  title: string
}

export type BackgroundTasksIndicatorProps = {
  sessionId: string
  backgroundTasks?: Record<string, BackgroundAgentTask>
  messages: readonly UIMessage[]
  onOpenAgentRun?: (payload: BackgroundTaskAgentOpenPayload) => void
}

function getTaskRowIcon(task: BackgroundAgentTask) {
  if (isSubagentBackgroundTask(task)) return Users
  if (task.taskType === 'local_workflow') return Zap
  return Terminal
}

export function BackgroundTasksIndicator({
  sessionId,
  backgroundTasks,
  messages,
  onOpenAgentRun,
}: BackgroundTasksIndicatorProps) {
  const t = useTranslation()
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const closeTimerRef = useRef<number | null>(null)
  const [open, setOpen] = useState(false)

  const runningTasks = useMemo(
    () => listRunningBackgroundTasks(backgroundTasks).sort((a, b) => a.startedAt - b.startedAt),
    [backgroundTasks],
  )

  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const scheduleClose = useCallback(() => {
    cancelScheduledClose()
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setOpen(false)
    }, HOVER_CLOSE_DELAY_MS)
  }, [cancelScheduledClose])

  const openNow = useCallback(() => {
    cancelScheduledClose()
    setOpen(true)
  }, [cancelScheduledClose])

  const closeNow = useCallback(() => {
    cancelScheduledClose()
    setOpen(false)
  }, [cancelScheduledClose])

  useEffect(() => () => cancelScheduledClose(), [cancelScheduledClose])

  useEffect(() => {
    if (runningTasks.length === 0) setOpen(false)
  }, [runningTasks.length])

  useDismissable({
    open,
    refs: [triggerRef, popoverRef],
    onDismiss: closeNow,
  })

  const position = useAnchoredPosition({
    open,
    anchorRef: triggerRef,
    floatingRef: popoverRef,
    placement: 'top-start',
    offset: 8,
    clampHeight: true,
  })

  const handleOpenTask = useCallback((task: BackgroundAgentTask, title: string) => {
    closeNow()
    if (isSubagentBackgroundTask(task)) {
      if (task.toolUseId) {
        if (onOpenAgentRun) {
          onOpenAgentRun({
            sessionId,
            taskId: task.taskId,
            toolUseId: task.toolUseId,
            title,
          })
        } else {
          const targetSessionId = useTabStore.getState().openSubagentTab(
            sessionId,
            task.toolUseId,
            title,
            task.taskId,
          )
          useActivityPanelStore.getState().open(targetSessionId)
        }
        return
      }
      useActivityPanelStore.getState().open(sessionId)
      return
    }

    if (task.taskType === 'local_workflow') {
      useActivityPanelStore.getState().open(sessionId)
      return
    }

    workspaceOpen.backgroundTask(sessionId, task.taskId, {
      title,
      toolUseId: task.toolUseId,
    })
  }, [closeNow, onOpenAgentRun, sessionId])

  if (runningTasks.length === 0) return null

  const label = runningTasks.length === 1
    ? t('chat.backgroundTasks.runningOne')
    : t('chat.backgroundTasks.runningMany', { count: runningTasks.length })

  const popover = open ? (
    <div
      ref={popoverRef}
      id={menuId}
      role="menu"
      aria-label={t('session.activity.section.backgroundTasks')}
      data-testid="background-tasks-popover"
      onMouseEnter={openNow}
      onMouseLeave={scheduleClose}
      style={position.style}
      className="popover-motion z-[var(--z-dropdown)] w-[320px] max-w-[min(360px,calc(100vw-32px))] rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-2 shadow-[var(--shadow-overlay)]"
    >
      <div className="px-2 pb-1.5 pt-0.5 text-[12px] font-medium text-[var(--color-text-tertiary)]">
        {t('session.activity.section.backgroundTasks')}
      </div>
      <div className="max-h-[240px] space-y-0.5 overflow-y-auto">
        {runningTasks.map((task) => {
          const Icon = getTaskRowIcon(task)
          const title = resolveBackgroundTaskTitle(messages, task)
          return (
            <button
              key={task.taskId}
              type="button"
              role="menuitem"
              data-testid={`background-tasks-popover-item-${task.taskId}`}
              title={title}
              onClick={() => handleOpenTask(task, title)}
              className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-left text-[13px] font-normal text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
            >
              <Icon size={15} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
              <span className="min-w-0 flex-1 truncate">{title}</span>
            </button>
          )
        })}
      </div>
    </div>
  ) : null

  return (
    <div className="mt-2 mb-1 flex items-center" data-testid="background-tasks-indicator-row">
      <button
        ref={triggerRef}
        type="button"
        data-testid="background-tasks-indicator"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onMouseEnter={openNow}
        onMouseLeave={scheduleClose}
        onFocus={openNow}
        onClick={() => {
          cancelScheduledClose()
          setOpen((current) => !current)
        }}
        className="inline-flex items-center rounded-[var(--radius-sm)] py-0.5 text-[13px] font-normal leading-5 text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
      >
        {label}
      </button>
      {popover && typeof document !== 'undefined' ? createPortal(popover, document.body) : popover}
    </div>
  )
}
