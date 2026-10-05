import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Pause, Play, Radio, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation, type TranslationKey } from '../../i18n'
import { useChatStore } from '../../stores/chatStore'
import { useTeamStore } from '../../stores/teamStore'
import { useTabStore } from '../../stores/tabStore'
import type {
  TeamMember,
  TeamWorkbenchSnapshot,
  TeamWorkbenchTask,
} from '../../types/team'
import { AgentTeamsCanvas } from './AgentTeamsCanvas'
import { AgentTeamsCommunicationFeed } from './AgentTeamsCommunicationFeed'
import { AgentTeamsMemberInspector } from './AgentTeamsMemberInspector'
import {
  getMemberWorkState,
  getWorkbenchPhase,
  getWorkbenchTaskState,
  inferTaskOwner,
  resolveTeamMemberIdentity,
  snapshotWithHistoricalMembers,
  type WorkbenchPhase,
  type WorkbenchTaskState,
} from './agentTeamsModel'

type TranslationFn = ReturnType<typeof useTranslation>

const REPLAY_SPEEDS = [0.5, 1, 2, 4] as const
const REPLAY_FALLBACK_FRAME_MS = 720
const MESSAGE_FLIGHT_MS = 1500

function timestamp(value: string | undefined): number | null {
  if (!value) return null
  const numeric = /^\d+$/.test(value) ? Number(value) : Number.NaN
  const parsed = Number.isFinite(numeric) ? numeric : Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function formatDuration(valueMs: number): string {
  const seconds = Math.max(0, Math.round(valueMs / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (hours > 0) {
    return [hours, minutes, rest].map((part) => String(part).padStart(2, '0')).join(':')
  }
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

function formatClock(value: string | undefined): string {
  const time = timestamp(value)
  if (time === null) return '--:--:--'
  return new Date(time).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function replayFrameDelay(
  snapshots: TeamWorkbenchSnapshot[],
  selectedIndex: number,
  speed: number,
): number {
  const currentTime = timestamp(snapshots[selectedIndex]?.generatedAt)
  const nextTime = timestamp(snapshots[selectedIndex + 1]?.generatedAt)
  const sourceDelay = currentTime !== null && nextTime !== null && nextTime > currentTime
    ? nextTime - currentTime
    : REPLAY_FALLBACK_FRAME_MS
  return Math.max(16, sourceDelay / speed)
}

function phaseLabel(phase: WorkbenchPhase, t: TranslationFn): string {
  return t(`agentTeams.phase.${phase}` as TranslationKey)
}

function stateCounts(snapshot: TeamWorkbenchSnapshot) {
  const tasksById = new Map(snapshot.tasks.map((task) => [task.id, task]))
  const counts: Record<WorkbenchTaskState, number> = {
    blocked: 0,
    open: 0,
    running: 0,
    completed: 0,
  }
  for (const task of snapshot.tasks) counts[getWorkbenchTaskState(task, tasksById)] += 1
  return counts
}

function TimelineStat({ label, value, tone }: {
  label: string
  value: string | number
  tone?: 'info' | 'muted'
}) {
  return (
    <div className="min-w-[52px]">
      <div className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">{label}</div>
      <div
        className={[
          'whitespace-nowrap font-mono text-[14px] font-medium tabular-nums',
          tone === 'info'
            ? 'text-[var(--color-info)]'
            : tone === 'muted'
              ? 'text-[var(--color-text-tertiary)]'
              : 'text-[var(--color-text-primary)]',
        ].join(' ')}
      >
        {value}
      </div>
    </div>
  )
}

/**
 * The full Agent Teams surface. The snapshot stream is the only source of
 * truth for both live mode and replay; replay merely moves the cursor through
 * that same stream, so the canvas, counters, member history and communication
 * feed cannot drift into different stories.
 */
export function AgentTeamsWorkbench({ sessionId }: { sessionId: string }) {
  const t = useTranslation()
  const timeline = useTeamStore((state) => state.workbenchesBySession[sessionId])
  const historyIndex = useTeamStore(
    (state) => state.workbenchHistoryIndexBySession[sessionId] ?? null,
  )
  const setHistoryIndex = useTeamStore((state) => state.setWorkbenchHistoryIndex)
  const openMemberSession = useTeamStore((state) => state.openMemberSession)
  const leadIsStreaming = useChatStore(
    (state) => (state.sessions[sessionId]?.chatState ?? 'idle') !== 'idle',
  )
  const [communicationOpen, setCommunicationOpen] = useState(false)
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null)
  const [selectedTask, setSelectedTask] = useState<TeamWorkbenchTask | null>(null)
  const [replaySpeed, setReplaySpeed] = useState<(typeof REPLAY_SPEEDS)[number]>(1)
  const [playing, setPlaying] = useState(false)
  const [messageFlightQueue, setMessageFlightQueue] = useState<string[]>([])
  const [feedFocusedTaskId, setFeedFocusedTaskId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const seenMessageIdsRef = useRef<Set<string> | null>(null)

  const snapshots = timeline?.snapshots ?? []
  const latestIndex = snapshots.length - 1
  const latestSnapshot = snapshots[latestIndex]
  const followingLive = historyIndex === null && !latestSnapshot?.deletedAt
  const selectedIndex = historyIndex === null
    ? latestIndex
    : Math.max(0, Math.min(latestIndex, historyIndex))
  const snapshot = useMemo(
    () => snapshotWithHistoricalMembers(snapshots, selectedIndex),
    [selectedIndex, snapshots],
  )
  const previousSnapshot = useMemo(
    () => snapshotWithHistoricalMembers(snapshots, selectedIndex - 1),
    [selectedIndex, snapshots],
  )

  useEffect(() => {
    if (!followingLive) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [followingLive])

  const visibleMessageIds = useMemo(
    () => snapshot?.messages.map(message => message.id) ?? [],
    [snapshot?.messages],
  )
  useEffect(() => {
    const current = new Set(visibleMessageIds)
    const previous = seenMessageIdsRef.current
    seenMessageIdsRef.current = current
    if (previous === null) return

    const movedBackward = Array.from(previous).some(id => !current.has(id))
    const added = visibleMessageIds.filter(id => !previous.has(id))
    setMessageFlightQueue(queue => {
      const retained = movedBackward ? [] : queue.filter(id => current.has(id))
      const known = new Set(retained)
      return [...retained, ...added.filter(id => !known.has(id))]
    })
  }, [visibleMessageIds])

  const activeMessageId = messageFlightQueue[0] ?? null
  useEffect(() => {
    if (!activeMessageId) return
    const timer = window.setTimeout(() => {
      setMessageFlightQueue(queue => (
        queue[0] === activeMessageId ? queue.slice(1) : queue.filter(id => id !== activeMessageId)
      ))
    }, MESSAGE_FLIGHT_MS)
    return () => window.clearTimeout(timer)
  }, [activeMessageId])

  useEffect(() => {
    if (!playing) return
    if (latestIndex <= 0 || selectedIndex >= latestIndex) {
      setPlaying(false)
      return
    }
    const timer = window.setTimeout(() => {
      setHistoryIndex(sessionId, selectedIndex + 1)
    }, replayFrameDelay(snapshots, selectedIndex, replaySpeed))
    return () => window.clearTimeout(timer)
  }, [latestIndex, playing, replaySpeed, selectedIndex, sessionId, setHistoryIndex, snapshots])

  useEffect(() => {
    if (followingLive) setPlaying(false)
  }, [followingLive])

  if (!snapshot) {
    return (
      <section
        aria-label={t('agentTeams.title')}
        className="flex h-full min-h-0 items-center justify-center bg-[var(--color-surface)] p-8 text-sm text-[var(--color-text-tertiary)]"
      >
        {timeline?.error || t('agentTeams.loading')}
      </section>
    )
  }

  const phase = getWorkbenchPhase(snapshot)
  const counts = stateCounts(snapshot)
  const startTime = timestamp(snapshot.team.createdAt) ?? timestamp(snapshots[0]?.generatedAt) ?? now
  const cursorTime = timestamp(snapshot.generatedAt) ?? startTime
  const endTime = timestamp(latestSnapshot?.deletedAt) ?? timestamp(latestSnapshot?.generatedAt) ?? now
  const elapsed = followingLive ? now - startTime : cursorTime - startTime
  const totalElapsed = Math.max(0, endTime - startTime)
  const workerMembers = snapshot.team.members.filter(
    (member) => member.agentId !== snapshot.team.leadAgentId,
  )
  const workingCount = workerMembers.filter((member) => (
    getMemberWorkState(member) === 'working'
  )).length
  const liveHint = phase === 'forming'
    ? t('agentTeams.live.formingHint')
    : workingCount > 0
      ? t('agentTeams.live.runningHint', { count: workingCount })
      : t('agentTeams.live.waitingHint')
  const selectedMember = selectedMemberId
    ? snapshot.team.members.find((member) => member.agentId === selectedMemberId)
    : undefined
  const selectedMemberIsLead = Boolean(
    selectedMember && selectedMember.agentId === snapshot.team.leadAgentId,
  )
  const timelineTickPositions = snapshots.map((entry, index) => {
    const at = timestamp(entry.generatedAt)
    const position = totalElapsed > 0 && at !== null
      ? ((at - startTime) / totalElapsed) * 100
      : latestIndex > 0
        ? (index / latestIndex) * 100
        : 0
    return Math.max(0, Math.min(100, position))
  })
  const timelineExtent = totalElapsed > 0 ? totalElapsed : Math.max(1, latestIndex)
  const timelineValue = totalElapsed > 0
    ? Math.max(0, Math.min(totalElapsed, cursorTime - startTime))
    : Math.max(0, selectedIndex)
  const timelinePosition = latestIndex <= 0
    ? 100
    : Math.max(0, Math.min(100, (timelineValue / timelineExtent) * 100))

  const enterReplay = () => {
    setPlaying(false)
    setHistoryIndex(sessionId, Math.max(0, selectedIndex))
  }
  const returnToLive = () => {
    setPlaying(false)
    setHistoryIndex(sessionId, null)
  }
  const togglePlayback = () => {
    if (selectedIndex >= latestIndex) {
      setHistoryIndex(sessionId, 0)
      setPlaying(latestIndex > 0)
      return
    }
    setPlaying((current) => !current)
  }
  const closeCommunication = () => {
    setCommunicationOpen(false)
    setSelectedMemberId(null)
    setFeedFocusedTaskId(null)
  }
  const selectMember = (member: TeamMember) => {
    if (communicationOpen && selectedMemberId === member.agentId) {
      closeCommunication()
      return
    }
    setFeedFocusedTaskId(null)
    setSelectedMemberId(member.agentId)
    setCommunicationOpen(true)
  }
  const seekTimeline = (value: number) => {
    setPlaying(false)
    if (totalElapsed <= 0) {
      setHistoryIndex(sessionId, Math.max(0, Math.min(latestIndex, Math.round(value))))
      return
    }
    const targetTime = startTime + value
    let targetIndex = 0
    snapshots.forEach((entry, index) => {
      const at = timestamp(entry.generatedAt)
      if (at !== null && at <= targetTime) targetIndex = index
    })
    setHistoryIndex(sessionId, targetIndex)
  }
  const openSelectedExecution = () => {
    if (!selectedMember) return
    if (selectedMemberIsLead) {
      useTabStore.getState().openTab(
        snapshot.team.leadSessionId ?? sessionId,
        selectedMember.name || selectedMember.role,
        'session',
      )
      return
    }
    openMemberSession(selectedMember, snapshot.team, snapshot)
  }

  return (
    <section
      aria-label={t('agentTeams.title')}
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--color-surface)] text-[var(--color-text-primary)]"
    >
      <header className="shrink-0 overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]">
        <div className="flex min-w-[1180px] items-center gap-5 px-[18px] py-2.5">
          <div className="min-w-[260px]">
            <div className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">
              Agent Teams · {t('agentTeams.sharedTaskList')}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2">
              <span
                className="max-w-[300px] truncate text-[15px] font-semibold"
                title={snapshot.team.name}
              >
                {snapshot.team.name}
              </span>
              <span className="shrink-0 rounded-full bg-[var(--color-surface-container)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-text-secondary)]">
                {t('agentTeams.experimental')}
              </span>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-[18px] border-x border-[var(--color-border)] px-[18px]">
            <div className="min-w-[74px]">
              <div className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">
                {t('agentTeams.stats.phase')}
              </div>
              <div className="whitespace-nowrap text-[14px] font-semibold">
                {phaseLabel(phase, t)}
              </div>
            </div>
            <TimelineStat
              label={t('agentTeams.stats.completed')}
              value={`${counts.completed}/${snapshot.tasks.length}`}
            />
            <TimelineStat label={t('agentTeams.stats.running')} value={counts.running} tone="info" />
            <TimelineStat label={t('agentTeams.stats.available')} value={counts.open} />
            <TimelineStat label={t('agentTeams.stats.blocked')} value={counts.blocked} tone="muted" />
          </div>

          {followingLive ? (
            <div data-testid="agent-teams-live-controls" className="flex min-w-0 flex-1 items-center gap-3.5">
              <div className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--color-info-container)] px-2.5 py-1">
                <span className="agent-teams-live-dot h-1.5 w-1.5 rounded-full bg-[var(--color-info)]" aria-hidden="true" />
                <span className="whitespace-nowrap text-xs font-medium text-[var(--color-on-info-container)]">
                  {t('agentTeams.live.following')}
                </span>
              </div>
              <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-secondary)]">
                {liveHint}
              </span>
              <Button variant="secondary" size="sm" onClick={enterReplay}>
                {t('agentTeams.reviewHistory')}
              </Button>
              <div className="shrink-0 border-l border-[var(--color-border)] pl-3.5">
                <TimelineStat label={t('agentTeams.live.elapsed')} value={formatDuration(elapsed)} />
              </div>
              <div className="shrink-0 border-l border-[var(--color-border)] pl-3.5">
                <TimelineStat label={t('agentTeams.live.sessionClock')} value={formatClock(snapshot.generatedAt)} />
              </div>
            </div>
          ) : (
            <div data-testid="agent-teams-replay-controls" className="flex min-w-0 flex-1 items-center gap-3.5">
              <Button
                variant="primary"
                size="base"
                className="w-[86px]"
                icon={playing ? <Pause size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
                onClick={togglePlayback}
              >
                {playing
                  ? t('agentTeams.replay.pause')
                  : selectedIndex >= latestIndex
                    ? t('agentTeams.replay.replay')
                    : t('agentTeams.replay.play')}
              </Button>
              <div
                role="group"
                aria-label={t('agentTeams.replay.speed')}
                className="flex shrink-0 overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]"
              >
                {REPLAY_SPEEDS.map((speed) => {
                  const selected = replaySpeed === speed
                  return (
                    <button
                      key={speed}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setReplaySpeed(speed)}
                      className={[
                        'h-7 border-r border-[var(--color-border)] px-2.5 font-mono text-[11px] font-medium outline-none transition-colors last:border-r-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]',
                        selected
                          ? 'bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                          : 'bg-[var(--color-surface-container-lowest)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]',
                      ].join(' ')}
                    >
                      {speed}×
                    </button>
                  )
                })}
              </div>
              <div className="min-w-[200px] flex-1">
                <div className="mb-1 flex justify-between text-[11px] font-semibold text-[var(--color-text-tertiary)]">
                  <span>{t('agentTeams.replay.timeline')}</span>
                  <span className="font-mono tabular-nums">
                    {formatDuration(cursorTime - startTime)} / {formatDuration(totalElapsed)}
                  </span>
                </div>
                <div className="relative h-[18px]">
                  <div className="absolute inset-x-0 top-2 h-1 rounded-full bg-[var(--color-surface-container-high)]" />
                  <div
                    data-testid="agent-teams-replay-progress"
                    className="absolute left-0 top-2 h-1 rounded-full bg-[var(--color-brand)]"
                    style={{ width: `${timelinePosition}%` }}
                  />
                  {timelineTickPositions.map((position, index) => (
                    <span
                      key={`${snapshots[index]?.version ?? index}-${index}`}
                      aria-hidden="true"
                      className="absolute top-[5px] h-[10px] w-px bg-[var(--color-text-tertiary)] opacity-30"
                      style={{ left: `${position}%` }}
                    />
                  ))}
                  <span
                    aria-hidden="true"
                    data-testid="agent-teams-replay-thumb"
                    className="absolute top-1 h-3 w-3 -translate-x-1/2 rounded-full border-[3px] border-[var(--color-brand)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-card)]"
                    style={{ left: `${timelinePosition}%` }}
                  />
                  <input
                    type="range"
                    min={0}
                    max={timelineExtent}
                    step={1}
                    value={timelineValue}
                    aria-label={t('agentTeams.replay.timeline')}
                    onChange={event => seekTimeline(Number(event.target.value))}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                      event.preventDefault()
                      setPlaying(false)
                      setHistoryIndex(
                        sessionId,
                        Math.max(0, Math.min(latestIndex, selectedIndex + (event.key === 'ArrowRight' ? 1 : -1))),
                      )
                    }}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0 focus-visible:opacity-100 focus-visible:accent-[var(--color-brand)]"
                  />
                </div>
              </div>
              {!latestSnapshot?.deletedAt ? (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Radio size={12} aria-hidden="true" />}
                  onClick={returnToLive}
                >
                  {t('agentTeams.backToLive')}
                </Button>
              ) : null}
              <div className="shrink-0 border-l border-[var(--color-border)] pl-3.5">
                <TimelineStat label={t('agentTeams.live.sessionClock')} value={formatClock(snapshot.generatedAt)} />
              </div>
            </div>
          )}
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <div
          data-testid="agent-teams-office-viewport"
          className="min-h-0 min-w-0 flex-1 overflow-auto bg-[var(--color-surface)]"
        >
          <AgentTeamsCanvas
            snapshots={snapshots}
            selectedIndex={selectedIndex}
            snapshot={snapshot}
            previousSnapshot={previousSnapshot}
            leadIsStreaming={leadIsStreaming}
            activeMessageId={activeMessageId}
            focusedTaskId={feedFocusedTaskId}
            selectedMemberId={selectedMemberId}
            onSelectMember={(member) => selectMember(member)}
            onSelectTask={setSelectedTask}
          />
        </div>

        {communicationOpen ? (
          <aside
            data-testid="agent-teams-communication-pane"
            className="h-full w-[400px] shrink-0 border-l border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]"
          >
            {selectedMember ? (
              <AgentTeamsMemberInspector
                snapshots={snapshots}
                selectedIndex={selectedIndex}
                snapshot={snapshot}
                member={selectedMember}
                isLead={selectedMemberIsLead}
                leadIsStreaming={leadIsStreaming}
                now={followingLive ? now : undefined}
                onBack={() => setSelectedMemberId(null)}
                onClose={closeCommunication}
                onOpenExecution={openSelectedExecution}
              />
            ) : (
              <div className="relative h-full min-h-0">
                <AgentTeamsCommunicationFeed
                  snapshot={snapshot}
                  fill
                  onFocusTask={setFeedFocusedTaskId}
                />
                <div className="absolute right-3 top-2.5 z-[var(--z-raised)]">
                  <IconButton
                    icon={<ChevronRight aria-hidden="true" />}
                    label={t('agentTeams.communication.close')}
                    size="sm"
                    tone="muted"
                    bordered
                    onClick={closeCommunication}
                  />
                </div>
              </div>
            )}
          </aside>
        ) : (
          <button
            type="button"
            data-testid="agent-teams-communication-rail"
            aria-label={t('agentTeams.communication.open')}
            onClick={() => setCommunicationOpen(true)}
            className="flex h-full w-14 shrink-0 flex-col items-center gap-3 border-l border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-3 outline-none transition-colors hover:bg-[var(--color-surface-container-low)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
          >
            <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-outline)] text-[var(--color-text-secondary)]">
              <ChevronLeft size={14} strokeWidth={2.4} aria-hidden="true" />
            </span>
            <span className="text-[11px] font-semibold text-[var(--color-text-secondary)] [writing-mode:vertical-rl]">
              {t('agentTeams.communication.title')}
            </span>
            <span className="rounded-full bg-[var(--color-surface-container)] px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-[var(--color-text-secondary)]">
              {snapshot.messages.length}
            </span>
            <span
              className={[
                'h-2 w-2 rounded-full',
                activeMessageId
                  ? 'agent-teams-live-dot bg-[var(--color-info)]'
                  : 'bg-[var(--color-outline)]',
              ].join(' ')}
              aria-hidden="true"
            />
          </button>
        )}

        {selectedTask && snapshot.tasks.some(task => task.id === selectedTask.id) ? (
          <TaskDetailPanel
            task={snapshot.tasks.find(task => task.id === selectedTask.id)!}
            snapshot={snapshot}
            communicationOpen={communicationOpen}
            onClose={() => setSelectedTask(null)}
            t={t}
          />
        ) : null}
      </div>
    </section>
  )
}

function TaskDetailPanel({
  task,
  snapshot,
  communicationOpen,
  onClose,
  t,
}: {
  task: TeamWorkbenchTask
  snapshot: TeamWorkbenchSnapshot
  communicationOpen: boolean
  onClose: () => void
  t: TranslationFn
}) {
  const owner = inferTaskOwner(task, snapshot)
  const ownerMember = owner
    ? resolveTeamMemberIdentity(snapshot.team, owner.identity).member
    : undefined
  return (
    <aside
      data-testid="agent-teams-task-detail"
      data-task-id={task.id}
      className="agent-teams-drawer absolute bottom-4 z-[var(--z-drawer)] w-[360px] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-4 shadow-[var(--shadow-dropdown)]"
      style={{ right: communicationOpen ? 416 : 72 }}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[11px] font-medium text-[var(--color-text-tertiary)]">
            #{task.id}
          </div>
          <h3 className="mt-1 text-[13px] font-semibold leading-snug">{task.subject}</h3>
        </div>
        <IconButton
          icon={<X aria-hidden="true" />}
          label={t('agentTeams.task.closeDetail')}
          size="sm"
          tone="muted"
          onClick={onClose}
        />
      </div>
      {task.description ? (
        <p className="mt-3 whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
          {task.description}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--color-border)] pt-3 text-[11px] text-[var(--color-text-secondary)]">
        <span>{t('agentTeams.task.ownerLabel')}: {ownerMember?.name ?? owner?.identity ?? '—'}</span>
        <span>{t('agentTeams.task.dependsOn')}: {task.blockedBy.map((id) => `#${id}`).join(', ') || '—'}</span>
        <span>{t('agentTeams.task.unblocks')}: {task.blocks.map((id) => `#${id}`).join(', ') || '—'}</span>
      </div>
    </aside>
  )
}
