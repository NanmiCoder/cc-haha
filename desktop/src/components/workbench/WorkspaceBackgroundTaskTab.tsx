import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, Check, Copy, Square, WrapText } from 'lucide-react'
import { sessionsApi, type SessionBackgroundTaskOutputResult } from '@/api/sessions'
import { ApiError } from '@/api/client'
import { StatusDot } from '@/components/ui/Badge'
import { CopyButton } from '@/components/ui/CopyButton'
import { ErrorState } from '@/components/ui/ErrorState'
import { IconButton } from '@/components/ui/IconButton'
import { LoadingState } from '@/components/ui/LoadingState'
import { useTranslation } from '@/i18n'
import {
  normalizeBackgroundTaskOutputLines,
  resolveBackgroundTaskCommand,
  tokenizeShellCommand,
  type ShellCommandSegment,
} from '@/lib/backgroundTaskOutput'
import type { WorkspaceBackgroundTaskTab as WorkspaceBackgroundTaskTabModel } from '@/lib/workspace/types'
import { useChatStore } from '@/stores/chatStore'

const POLL_INTERVAL_MS = 1000
const SCROLL_BOTTOM_THRESHOLD_PX = 32
const EMPTY_MESSAGES: never[] = []

export type WorkspaceBackgroundTaskTabProps = {
  sessionId: string
  tab: WorkspaceBackgroundTaskTabModel
  active: boolean
}

function commandSegmentClassName(tone: ShellCommandSegment['tone']): string {
  switch (tone) {
    case 'arg':
      return 'text-[var(--color-code-property)]'
    case 'operator':
      return 'text-[var(--color-text-secondary)]'
    case 'command':
    case 'plain':
      return 'text-[var(--color-text-primary)]'
  }
}

export function WorkspaceBackgroundTaskTab({
  sessionId,
  tab,
  active,
}: WorkspaceBackgroundTaskTabProps) {
  const t = useTranslation()
  const task = useChatStore((state) => state.sessions[sessionId]?.backgroundAgentTasks?.[tab.taskId])
  const messages = useChatStore((state) => state.sessions[sessionId]?.messages ?? EMPTY_MESSAGES)
  const stopping = useChatStore((state) => Boolean(state.sessions[sessionId]?.stoppingBackgroundTaskIds?.[tab.taskId]))
  const stopBackgroundTask = useChatStore((state) => state.stopBackgroundTask)

  const [output, setOutput] = useState<SessionBackgroundTaskOutputResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [wrapLines, setWrapLines] = useState(true)
  const [awayFromBottom, setAwayFromBottom] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const shouldFollowRef = useRef(true)
  const inFlightRef = useRef(false)
  const wasRunningRef = useRef(false)

  const isRunning = task?.status === 'running'
  const effectiveToolUseId = task?.toolUseId ?? tab.toolUseId
  const isRunningRef = useRef(isRunning)
  isRunningRef.current = isRunning
  const tRef = useRef(t)
  tRef.current = t

  const command = useMemo(
    () => resolveBackgroundTaskCommand(messages, {
      toolUseId: effectiveToolUseId,
      description: task?.description ?? tab.title,
      prompt: task?.prompt,
    }),
    [effectiveToolUseId, messages, tab.title, task?.description, task?.prompt],
  )

  const commandSegments = useMemo(
    () => (command ? tokenizeShellCommand(command) : []),
    [command],
  )

  const fetchOutput = useCallback(async (signal?: AbortSignal, options?: { silent?: boolean }) => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    if (!options?.silent) setLoading(true)
    try {
      const next = await sessionsApi.getBackgroundTaskOutput(sessionId, tab.taskId, signal)
      if (signal?.aborted) return
      setOutput(next)
      setError(null)
      setLoading(false)
    } catch (err) {
      if (signal?.aborted) return
      // Right after `task_started` arrives, the CLI transcript may not have flushed
      // the tool_result metadata yet. Treat 404 while running as "waiting for output".
      const isTransientNotFound =
        isRunningRef.current &&
        ((err instanceof ApiError && err.status === 404) ||
          (typeof err === 'object' && err !== null && 'status' in err && (err as { status?: unknown }).status === 404))
      if (isTransientNotFound) {
        setOutput((current) => current ?? {
          taskId: tab.taskId,
          state: 'empty',
          text: '',
          totalBytes: 0,
          truncated: false,
        })
        setError(null)
      } else {
        setError(err instanceof Error ? err.message : tRef.current('workspace.backgroundTask.loadFailed'))
      }
      setLoading(false)
    } finally {
      inFlightRef.current = false
    }
  }, [sessionId, tab.taskId])

  useEffect(() => {
    setOutput(null)
    setError(null)
    setLoading(true)
    shouldFollowRef.current = true
    setAwayFromBottom(false)
  }, [sessionId, tab.taskId])

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    void fetchOutput(controller.signal)
    return () => {
      controller.abort()
    }
  }, [active, fetchOutput])

  useEffect(() => {
    if (!active || !isRunning) return
    const controller = new AbortController()
    const timer = window.setInterval(() => {
      void fetchOutput(controller.signal, { silent: true })
    }, POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [active, fetchOutput, isRunning])

  useEffect(() => {
    if (wasRunningRef.current && !isRunning && active) {
      const controller = new AbortController()
      void fetchOutput(controller.signal, { silent: true })
      wasRunningRef.current = false
      return () => controller.abort()
    }
    wasRunningRef.current = isRunning
  }, [active, fetchOutput, isRunning])

  const fallbackText = !output || output.state !== 'available'
    ? (task?.result?.trim() || task?.summary?.trim() || '')
    : ''

  const displayedRawText = output?.state === 'available' ? output.text : fallbackText
  const lines = useMemo(
    () => normalizeBackgroundTaskOutputLines(displayedRawText),
    [displayedRawText],
  )

  const handleScroll = useCallback(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    const nearBottom = distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD_PX
    shouldFollowRef.current = nearBottom
    setAwayFromBottom(!nearBottom)
  }, [])

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller || !shouldFollowRef.current) return
    scroller.scrollTop = scroller.scrollHeight
  }, [lines])

  const scrollToBottom = useCallback(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    shouldFollowRef.current = true
    setAwayFromBottom(false)
    scroller.scrollTop = scroller.scrollHeight
  }, [])

  const gutterDigits = Math.max(2, String(Math.max(1, lines.length)).length)
  const stopLabel = stopping
    ? t('session.activity.stoppingBackgroundTask', { name: tab.title ?? tab.taskId })
    : t('session.activity.stopBackgroundTask', { name: tab.title ?? tab.taskId })

  return (
    <div
      data-testid={`workspace-background-task-${tab.taskId}`}
      className="flex min-h-0 flex-1 flex-col bg-[var(--color-surface-container-lowest)]"
    >
      {/* Top sub-header: matches reference "Background Task Output" bar */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-[var(--color-border)] px-4">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-[13px] font-medium text-[var(--color-text-primary)]">
            {t('workspace.backgroundTask.header')}
          </h2>
          {isRunning ? (
            <StatusDot tone="info" pulse />
          ) : task?.status === 'failed' ? (
            <StatusDot tone="danger" />
          ) : task?.status === 'completed' ? (
            <StatusDot tone="success" />
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isRunning ? (
            <IconButton
              icon={<Square size={12} strokeWidth={1.75} aria-hidden="true" />}
              label={stopLabel}
              size="sm"
              tone="muted"
              loading={stopping}
              data-testid="background-task-stop"
              onClick={() => stopBackgroundTask(sessionId, tab.taskId)}
            />
          ) : null}
          <IconButton
            icon={<WrapText size={15} strokeWidth={1.75} aria-hidden="true" />}
            label={t('workspace.backgroundTask.toggleWrap')}
            size="sm"
            tone="muted"
            pressed={wrapLines}
            data-testid="background-task-wrap-toggle"
            onClick={() => setWrapLines((current) => !current)}
          />
        </div>
      </div>

      {/* Command block with copy button */}
      {command ? (
        <div
          data-testid="background-task-command"
          className="flex shrink-0 items-start gap-2.5 border-b border-[var(--color-border)] px-4 py-3"
        >
          <pre className="m-0 min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[13px] leading-[1.55]">
            <code>
              {commandSegments.map((segment, index) => (
                <span key={index} className={commandSegmentClassName(segment.tone)}>
                  {segment.text}
                </span>
              ))}
            </code>
          </pre>
          <CopyButton
            text={command}
            label={t('workspace.backgroundTask.copyCommand')}
            copiedLabel={t('common.copied')}
            displayLabel={<Copy size={14} strokeWidth={1.75} aria-hidden="true" />}
            displayCopiedLabel={<Check size={14} strokeWidth={1.75} aria-hidden="true" />}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          />
        </div>
      ) : null}

      {output?.truncated ? (
        <div
          role="status"
          data-testid="background-task-truncated"
          className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface-container)] px-4 py-1.5 text-[11px] text-[var(--color-text-tertiary)]"
        >
          {t('workspace.backgroundTask.truncatedNotice')}
        </div>
      ) : null}

      {/* Line-numbered output body */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          data-workspace-autofocus
          data-testid="background-task-output-scroll"
          tabIndex={-1}
          onScroll={handleScroll}
          className="scrollbar-autohide h-full overflow-auto py-2.5 font-mono text-[12px] leading-[1.65] outline-none"
        >
          {loading && lines.length === 0 ? (
            <div className="flex items-center justify-center py-10">
              <LoadingState variant="inline" size="sm" label={t('workspace.backgroundTask.loading')} />
            </div>
          ) : error && lines.length === 0 ? (
            <div className="px-4 py-6 font-sans">
              <ErrorState
                size="sm"
                title={t('workspace.backgroundTask.loadFailed')}
                detail={error !== t('workspace.backgroundTask.loadFailed') ? error : undefined}
                onRetry={() => void fetchOutput()}
                retryLabel={t('common.retry')}
              />
            </div>
          ) : lines.length === 0 ? (
            <div
              data-testid="background-task-output-empty"
              className="px-4 py-6 font-sans text-[13px] text-[var(--color-text-tertiary)]"
            >
              {isRunning
                ? t('workspace.backgroundTask.waitingForOutput')
                : t('workspace.backgroundTask.noOutput')}
            </div>
          ) : (
            <div data-testid="background-task-output-lines" className="px-2">
              {lines.map((line, index) => (
                <div
                  key={index}
                  className="flex items-start gap-3 rounded-[var(--radius-xs)] px-2 hover:bg-[var(--color-surface-hover)]"
                >
                  <span
                    aria-hidden="true"
                    style={{ minWidth: `${gutterDigits}ch` }}
                    className="shrink-0 select-none text-right tabular-nums text-[var(--color-text-tertiary)]"
                  >
                    {index + 1}
                  </span>
                  <span
                    className={`min-w-0 flex-1 text-[var(--color-text-primary)] ${wrapLines ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre'}`}
                  >
                    {line.length > 0 ? line : '\u200b'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {awayFromBottom && lines.length > 0 ? (
          <IconButton
            icon={<ArrowDown size={15} strokeWidth={1.75} aria-hidden="true" />}
            label={t('workspace.backgroundTask.scrollToBottom')}
            size="md"
            tone="secondary"
            data-testid="background-task-scroll-bottom"
            onClick={scrollToBottom}
            className="dropdown-glass popover-motion absolute bottom-4 right-4 z-[var(--z-sticky)] rounded-[var(--radius-control)]"
          />
        ) : null}
      </div>
    </div>
  )
}
