import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import {
  isAgentIdRef,
  readAgentIdRef,
  subagentsApi,
  toAgentIdRef,
  type SubagentRunResponse,
  type SubagentRunStatus,
} from '../api/subagents'
import { MessageList } from '../components/chat/MessageList'
import type { AgentActivityTarget } from '../components/chat/ToolCallGroup'
import { ChatInput } from '../components/chat/ChatInput'
import { SessionChatHeader, SessionChatSurface } from '@/components/chat/SessionChatSurface'
import { SessionActivityButton } from '../components/activity/SessionActivityButton'
import { SessionActivityPanel, type OpenSubagentPayload } from '../components/activity/SessionActivityPanel'
import {
  buildSessionActivityModel,
  hasVisibleSessionActivity,
} from '../components/activity/sessionActivityModel'
import { taskOwnedByMember } from '../components/agentTeams/agentTeamsModel'
import type { TeamTaskAnchor } from '../api/teams'
import { Badge, type Tone as BadgeTone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '../i18n'
import {
  createDefaultSessionState,
  mapHistoryMessagesToUiMessages,
  mergeReconstructedRunActivity,
  registerAgentRunSession,
  reconstructRunActivityFromTranscript,
  useChatStore,
} from '../stores/chatStore'
import { SUBAGENT_TAB_PREFIX, useTabStore } from '../stores/tabStore'
import { teamIdentityKey, useTeamStore } from '../stores/teamStore'
import { useActivityPanelStore } from '../stores/activityPanelStore'
import { runsForOwner, runsForSession, useWorkflowStore } from '../stores/workflowStore'
import { useMobileViewport } from '../hooks/useMobileViewport'
import { isDesktopRuntime } from '../lib/desktopRuntime'
import type { UIMessage } from '../types/chat'
import type { CLITask } from '../types/cliTask'

type TranslationFn = ReturnType<typeof useTranslation>
const LIVE_RUN_REFRESH_MS = 2000
const EMPTY_DISMISSED_BACKGROUND_TASK_KEYS: string[] = []
const EMPTY_RUN_TASKS: CLITask[] = []
const EMPTY_OWNER_AGENT_IDS: string[] = []
const EMPTY_TASK_ANCHORS: TeamTaskAnchor[] = []

function teamStreamScopeId(team: {
  name: string
  leadSessionId?: string
  createdAt?: string
} | undefined): string | undefined {
  if (!team?.createdAt) return undefined
  const createdAt = Number(team.createdAt)
  if (!Number.isFinite(createdAt)) return undefined
  return JSON.stringify([team.name, team.leadSessionId ?? '', createdAt])
}

export function SubagentRunPage({
  sourceSessionId,
  toolUseId,
  taskId,
  title,
}: {
  sourceSessionId: string
  toolUseId: string
  taskId?: string
  title: string
}) {
  const t = useTranslation()
  const [data, setData] = useState<SubagentRunResponse | null>(null)
  const [responseActivityEpoch, setResponseActivityEpoch] = useState(0)
  const [responseStreamRevision, setResponseStreamRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)
  const tabId = useTabStore((state) => {
    const activeTab = state.tabs.find((tab) => tab.sessionId === state.activeTabId)
    return activeTab?.type === 'subagent' && activeTab.subagentToolUseId === toolUseId
      ? activeTab.sessionId
      : `${SUBAGENT_TAB_PREFIX}${sourceSessionId}__${toolUseId}`
  })
  const discoveredTaskId = useChatStore((state) => {
    const session = state.sessions[sourceSessionId]
    const liveTask = Object.values(session?.backgroundAgentTasks ?? {})
      .find((candidate) => candidate.toolUseId === toolUseId)
    return liveTask?.taskId ?? session?.agentTaskNotifications?.[toolUseId]?.taskId
  })
  const resolvedTaskId = taskId ?? discoveredTaskId
  const workflowAgentStatus = useWorkflowStore((state): SubagentRunStatus | undefined => {
    if (!isAgentIdRef(toolUseId)) return undefined
    const agentId = readAgentIdRef(toolUseId)
    const runs = Object.values(state.runs)
      .filter((run) => run.sourceSessionId === sourceSessionId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
    for (const run of runs) {
      const event = [...run.progress].reverse().find((candidate) => (
        candidate.type === 'workflow_agent' && candidate.agentId === agentId
      ))
      if (!event || event.type !== 'workflow_agent') continue
      if (event.state === 'error') return 'failed'
      if (event.state === 'done') return 'completed'
      return 'running'
    }
    return undefined
  })
  const effectiveStatus = workflowAgentStatus ?? data?.status
  const teamSnapshot = useTeamStore((state) => (
    state.workbenchesBySession[sourceSessionId]?.snapshots.at(-1)
  ))
  const teamAgentName = useChatStore((state) => {
    const launch = state.sessions[sourceSessionId]?.messages?.find((message) => (
      message.type === 'tool_use' &&
      message.toolName === 'Agent' &&
      message.toolUseId === toolUseId
    ))
    if (!launch || launch.type !== 'tool_use' || typeof launch.input !== 'object' || !launch.input) {
      return undefined
    }
    const input = launch.input as Record<string, unknown>
    return typeof input.team_name === 'string' && typeof input.name === 'string'
      ? `${input.team_name}\u0000${input.name}`
      : undefined
  })
  const teamMember = useMemo(() => {
    if (!teamSnapshot || (!data?.agentId && !teamAgentName)) return undefined
    const [launchTeamName, launchMemberName] = teamAgentName?.split('\u0000') ?? []
    return teamSnapshot.team.members.find((member) => (
      member.agentId === data?.agentId ||
      member.sessionId === data?.agentId ||
      (
        launchTeamName === teamSnapshot.team.name &&
        member.name === launchMemberName
      )
    ))
  }, [data?.agentId, teamAgentName, teamSnapshot])
  const runTasks = useMemo(
    () => teamMember && teamSnapshot
      ? teamSnapshot.tasks.filter((task) => taskOwnedByMember(task, teamMember))
      : EMPTY_RUN_TASKS,
    [teamMember, teamSnapshot],
  )
  const workflowOwnerAliases = useMemo(() => [...new Set([
    data?.agentId,
    teamMember?.agentId,
    teamMember?.name,
    teamMember?.sessionId,
  ].filter((value): value is string => Boolean(value)))], [data?.agentId, teamMember])
  const activityProjectionMessages = useMemo(() => {
    // The server only sends `activityMessages` when it differs from `messages`
    // (truncation); below that threshold `messages` is the same projection.
    const projection = data?.activityMessages ?? data?.messages
    if (!projection || data?.activityComplete === false) return undefined
    return mapHistoryMessagesToUiMessages(projection, {
      includeTeammateMessages: true,
    })
  }, [data?.activityMessages, data?.messages, data?.activityComplete])

  const handleReturn = () => {
    const store = useTabStore.getState()
    const activeTab = store.tabs.find((tab) => tab.sessionId === store.activeTabId)
    const returningTabId = activeTab?.type === 'subagent' && activeTab.subagentToolUseId === toolUseId
      ? activeTab.sessionId
      : `${SUBAGENT_TAB_PREFIX}${sourceSessionId}__${toolUseId}`
    if (useActivityPanelStore.getState().isOpen(returningTabId)) {
      useActivityPanelStore.getState().open(activeTab?.returnTabId ?? sourceSessionId)
    }
    store.returnFromSubagent(returningTabId)
  }

  const load = useCallback(async (options?: { resetData?: boolean }) => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    const requestedSession = useChatStore.getState().sessions[tabId]
    const requestedActivityEpoch = requestedSession?.historyMutationEpoch ?? 0
    const requestedStreamRevision = requestedSession?.agentStreamRevision ?? 0
    setLoading(true)
    setError(null)
    if (options?.resetData) setData(null)
    try {
      // A workflow agent has no parent Agent tool call, so it is addressed by
      // agent id. Everything downstream of this line is identical.
      const nextData = isAgentIdRef(toolUseId)
        ? await subagentsApi.getRunByAgent(sourceSessionId, readAgentIdRef(toolUseId))
        : await subagentsApi.getRunByTool(sourceSessionId, toolUseId, resolvedTaskId)
      if (requestIdRef.current !== requestId) return
      setData(nextData)
      setResponseActivityEpoch(requestedActivityEpoch)
      setResponseStreamRevision(requestedStreamRevision)
    } catch (err) {
      if (requestIdRef.current !== requestId) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (requestIdRef.current !== requestId) return
      setLoading(false)
    }
  }, [resolvedTaskId, sourceSessionId, tabId, toolUseId])

  useEffect(() => {
    void load({ resetData: true })
  }, [load])

  useEffect(() => {
    if (loading) return
    const timer = window.setTimeout(() => void load(), LIVE_RUN_REFRESH_MS)
    return () => window.clearTimeout(timer)
  }, [data?.updatedAt, load, loading])

  useEffect(() => {
    if (!data) return
    const transcriptMessages = buildSubagentConversationMessages(data)
    const runActivity = reconstructRunActivityFromTranscript(
      data.activityMessages ?? data.messages,
      data.activityTaskNotifications ?? data.taskNotifications ?? [],
    )
    useChatStore.getState().applyBoundedUpdate((state) => {
      const existing = state.sessions[tabId] ?? createDefaultSessionState()
      const localMessages = existing.messages.filter((message) => {
        if (message.type === 'error' && message.code === 'SUBAGENT_MESSAGE_FAILED') {
          return true
        }
        return message.type === 'user_text' && !transcriptMessages.some((candidate) => (
          candidate.type === 'user_text' && candidate.content === message.content
        ))
      })
      const hasPendingMessage = localMessages.some((message) => (
        message.type === 'user_text' && message.pending === true
      ))
      const mergedActivity = data.activityComplete === false ? {
        agentTaskNotifications: existing.agentTaskNotifications ?? {},
        backgroundAgentTasks: existing.backgroundAgentTasks ?? {},
      } : mergeReconstructedRunActivity({
        agentTaskNotifications: existing.agentTaskNotifications ?? {},
        backgroundAgentTasks: existing.backgroundAgentTasks ?? {},
      }, runActivity, {
        preferCurrent: (existing.historyMutationEpoch ?? 0) !== responseActivityEpoch,
      })
      const currentStreamRevision = existing.agentStreamRevision ?? 0
      const preserveLiveConversation = currentStreamRevision > 0 && (
        existing.chatState !== 'idle' ||
        currentStreamRevision !== responseStreamRevision
      )
      return {
        sessions: {
          ...state.sessions,
          [tabId]: {
            ...existing,
            messages: preserveLiveConversation || (data.historyComplete === false && transcriptMessages.length === 0)
              ? existing.messages
              : [...transcriptMessages, ...localMessages],
            agentTaskNotifications: mergedActivity.agentTaskNotifications,
            backgroundAgentTasks: mergedActivity.backgroundAgentTasks,
            connectionState: 'connected',
            chatState: preserveLiveConversation
              ? existing.chatState
              : effectiveStatus === 'running' || hasPendingMessage
                ? 'thinking'
                : 'idle',
            ...(!preserveLiveConversation ? {
              agentStreamRevision: 0,
              streamingText: '',
              streamingToolInput: '',
              activeToolUseId: null,
              activeToolName: null,
              activeThinkingId: null,
            } : {}),
          },
        },
      }
    })
  }, [data, effectiveStatus, responseActivityEpoch, responseStreamRevision, tabId])

  useEffect(() => {
    if (!data?.agentId) return
    const streamScopeId = teamStreamScopeId(teamSnapshot?.team)
    const usesTeamFragmentIds = Boolean(teamMember || teamAgentName)
    const unregisterUnscoped = registerAgentRunSession(
      sourceSessionId,
      tabId,
      [data.agentId],
      usesTeamFragmentIds ? { eventIdPrefix: data.agentId } : {},
    )
    const unregisterScoped = streamScopeId
      ? registerAgentRunSession(sourceSessionId, tabId, [data.agentId], {
          streamScopeId,
          ...(usesTeamFragmentIds
            ? {
                eventIdPrefix: data.agentId,
                streamEventIdPrefix: data.agentId,
              }
            : {}),
        })
      : () => undefined
    return () => {
      unregisterScoped()
      unregisterUnscoped()
    }
  }, [data?.agentId, sourceSessionId, tabId, teamAgentName, teamMember, teamSnapshot?.team])

  useEffect(() => {
    if (workflowOwnerAliases.length === 0) return
    void useWorkflowStore.getState().hydrateOwnerSession(
      sourceSessionId,
      workflowOwnerAliases,
      tabId,
    )
  }, [sourceSessionId, tabId, workflowOwnerAliases])

  return (
    <AgentSessionView
      kind="subagent"
      sessionId={tabId}
      sourceSessionId={sourceSessionId}
      runToolUseId={toolUseId}
      runAgentId={data?.agentId ?? undefined}
      tasks={runTasks}
      taskScope={teamMember || teamAgentName ? 'team' : 'run'}
      workflowOwnerAliases={workflowOwnerAliases}
      activityMessages={activityProjectionMessages}
      title={title}
      status={effectiveStatus}
      identity={`${sourceSessionId} / ${toolUseId}`}
      details={data ? (
        <>
          <span>{t('subagentRun.agent')}: {data.agentId ?? t('subagentRun.unknown')}</span>
          {data.description ? <span>{data.description}</span> : null}
          {data.outputFile ? <span>{t('subagentRun.output')}: {data.outputFile}</span> : null}
          {data.historyComplete === false ? <span role="status">{t('subagentRun.incompleteHistory')}</span> : null}
        </>
      ) : null}
      backLabel={t('subagentRun.backToParent')}
      onBack={handleReturn}
      refreshLabel={t('subagentRun.refresh')}
      onRefresh={() => void load()}
      loading={loading}
      loadingLabel={t('subagentRun.loading')}
      error={error}
      ready={Boolean(data)}
      canSendMessage={data?.canSendMessage === true}
      readOnlyLabel={t('subagentRun.readOnly')}
      conversationTestId="subagent-conversation"
      readOnlyTestId="subagent-readonly-note"
    />
  )
}

/**
 * Agent Teams members use the exact same run desktop as SubAgents. Only the
 * transcript adapter, return target and inbox capability differ.
 */
export function TeamMemberRunPage({
  tabId,
  leadSessionId,
  agentId,
  title,
}: {
  tabId: string
  leadSessionId: string
  agentId: string
  title: string
}) {
  const t = useTranslation()
  const member = useTeamStore((state) => state.getMemberBySessionId(tabId))
  const memberSnapshot = useTeamStore((state) => state.memberSnapshotBySession[tabId])
  const timelineSnapshots = useTeamStore(
    (state) => state.workbenchesBySession[leadSessionId]?.snapshots,
  )
  const memberOwnerAgentIds = useTeamStore(
    (state) => state.memberOwnerAgentIdsBySession[tabId] ?? EMPTY_OWNER_AGENT_IDS,
  )
  const memberTaskAnchors = useTeamStore(
    (state) => state.memberTaskAnchorsBySession[tabId] ?? EMPTY_TASK_ANCHORS,
  )
  const memberOwnerAgentIdsKnown = useTeamStore((state) => (
    Object.prototype.hasOwnProperty.call(state.memberOwnerAgentIdsBySession, tabId)
  ))
  const tabIncarnationId = useTabStore((state) => (
    state.tabs.find((tab) => tab.sessionId === tabId)?.teamIncarnationId
  ))
  const snapshot = useMemo(() => {
    if (memberSnapshot) return memberSnapshot
    if (!tabIncarnationId) return timelineSnapshots?.at(-1)
    return [...(timelineSnapshots ?? [])].reverse().find((candidate) => (
      teamIdentityKey(candidate.team) === tabIncarnationId
    ))
  }, [memberSnapshot, tabIncarnationId, timelineSnapshots])
  const refreshMemberSession = useTeamStore((state) => state.refreshMemberSession)
  const ensureMemberSession = useTeamStore((state) => state.ensureMemberSession)
  const startMemberPolling = useTeamStore((state) => state.startMemberPolling)
  const stopMemberPolling = useTeamStore((state) => state.stopMemberPolling)
  // openMemberSession/openTeamMemberTab already resolved the lifecycle-scoped
  // synthetic id. Re-deriving it from the reusable agent id would read the
  // previous incarnation's transcript and activity.
  const runSessionId = tabId
  const hasConversationSnapshot = useChatStore((state) => Boolean(state.sessions[runSessionId]))
  const [loading, setLoading] = useState(!hasConversationSnapshot)

  useEffect(() => {
    if (!member) return
    const memberTeam = snapshot?.team ?? useTeamStore.getState().getTeamByMemberSessionId(tabId)
    const streamScopeId = teamStreamScopeId(memberTeam ?? undefined)
    const unregisterLogicalOwners = registerAgentRunSession(leadSessionId, runSessionId, [
      member.agentId,
      member.name,
    ], {
      ownerScopeId: memberTeam ? teamIdentityKey(memberTeam) : undefined,
      ...(streamScopeId ? { streamScopeId } : {}),
      streamEventIdPrefix: 'runAgentId',
    })
    // Until the first transcript response identifies the concrete fragments,
    // a configured session id might itself be that physical owner. Leave its
    // events pending so the first replay uses the same fragment namespace as
    // durable history instead of creating a second raw activity row.
    const unregisterPhysicalOwners = memberOwnerAgentIdsKnown
      ? memberOwnerAgentIds
      .map(ownerAgentId => registerAgentRunSession(
        leadSessionId,
        runSessionId,
        [ownerAgentId],
        {
          eventIdPrefix: ownerAgentId,
          ...(streamScopeId ? { streamScopeId } : {}),
          streamEventIdPrefix: ownerAgentId,
        },
      ))
      : []
    const unregisterMemberSession = memberOwnerAgentIdsKnown &&
      !memberOwnerAgentIds.includes(member.sessionId ?? '')
      ? registerAgentRunSession(
          leadSessionId,
          runSessionId,
          [member.sessionId],
          streamScopeId ? { streamScopeId } : undefined,
        )
      : () => undefined
    return () => {
      unregisterLogicalOwners()
      unregisterMemberSession()
      for (const unregister of unregisterPhysicalOwners) unregister()
    }
  }, [
    leadSessionId,
    member,
    memberOwnerAgentIds,
    memberOwnerAgentIdsKnown,
    runSessionId,
    snapshot?.team,
    tabId,
  ])

  const workflowOwnerAliases = useMemo(() => member
    ? [...new Set([member.agentId, member.name, member.sessionId, ...memberOwnerAgentIds]
        .filter((value): value is string => Boolean(value)))]
    : [agentId], [agentId, member, memberOwnerAgentIds])
  const memberWorkflowSourceSessionId = member?.sessionId ?? leadSessionId
  const memberWorkflowIncludesRoot = Boolean(member?.sessionId)

  useEffect(() => {
    if (workflowOwnerAliases.length === 0) return
    void useWorkflowStore.getState().hydrateOwnerSession(
      memberWorkflowSourceSessionId,
      workflowOwnerAliases,
      runSessionId,
      { includeRoot: memberWorkflowIncludesRoot },
    )
  }, [memberWorkflowIncludesRoot, memberWorkflowSourceSessionId, runSessionId, workflowOwnerAliases])

  const refresh = useCallback(async (initial = false) => {
    setLoading(true)
    if (initial) await ensureMemberSession(tabId)
    else await refreshMemberSession(tabId)
    setLoading(false)
  }, [ensureMemberSession, refreshMemberSession, tabId])

  useEffect(() => {
    void refresh(true)
    if (member?.status === 'running' || member?.status === 'idle') {
      startMemberPolling(tabId)
    }
    return () => stopMemberPolling()
  }, [member?.agentId, member?.status, refresh, startMemberPolling, stopMemberPolling, tabId])

  const status: SubagentRunStatus = snapshot?.deletedAt || member?.status === 'completed'
    ? 'completed'
    : member?.status === 'error'
      ? 'failed'
      : member?.status === 'running'
        ? 'running'
        : 'unknown'
  const teamName = snapshot?.team.name ?? useTeamStore.getState().getTeamByMemberSessionId(tabId)?.name
  const canSendMessage = Boolean(member && !snapshot?.deletedAt && member.status !== 'completed')
  // The member's own `TaskUpdate` calls are the only record of the order it
  // actually worked in. Task ids record the order the tasks were written down,
  // which for a teammate that plans its work up front is close to the reverse.
  const memberTasks = useMemo(() => {
    if (!member || !snapshot) return []
    const owned = snapshot.tasks.filter((task) => taskOwnedByMember(task, member))
    const workOrder = new Map<string, number>()
    memberTaskAnchors.forEach((anchor, index) => {
      if (!workOrder.has(anchor.taskId)) workOrder.set(anchor.taskId, index)
    })
    if (workOrder.size === 0) return owned
    return [...owned].sort((left, right) => (
      (workOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (workOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    ))
  }, [member, memberTaskAnchors, snapshot])
  const currentTaskSubject = useMemo(() => {
    const resolved = new Set(
      memberTaskAnchors.filter((anchor) => anchor.status === 'completed').map((a) => a.taskId),
    )
    const openAnchor = [...memberTaskAnchors]
      .reverse()
      .find((anchor) => anchor.status === 'in_progress' && !resolved.has(anchor.taskId))
    return openAnchor
      ? snapshot?.tasks.find((task) => task.id === openAnchor.taskId)?.subject
      : undefined
  }, [memberTaskAnchors, snapshot])
  const handleReturn = useCallback(() => {
    if (useActivityPanelStore.getState().isOpen(tabId)) {
      useActivityPanelStore.getState().open(leadSessionId)
    }
    useTabStore.getState().returnFromTeamMember(tabId)
  }, [leadSessionId, tabId])

  return (
    <AgentSessionView
      kind="team-member"
      sessionId={runSessionId}
      sourceSessionId={member?.sessionId ?? leadSessionId}
      workflowSourceSessionId={memberWorkflowSourceSessionId}
      workflowIncludeRoot={memberWorkflowIncludesRoot}
      runToolUseId={member?.sessionId ? undefined : toAgentIdRef(agentId)}
      runAgentId={member?.sessionId ? undefined : agentId}
      tasks={memberTasks}
      taskScope="team"
      workflowOwnerAliases={workflowOwnerAliases}
      title={member?.name || member?.role || title}
      status={status}
      identity={`${teamName ?? leadSessionId} / ${agentId}`}
      details={member ? (
        <>
          <span>{t('subagentRun.agent')}: {member.agentId}</span>
          <span>{member.role}</span>
          {currentTaskSubject ?? member.currentTask
            ? <span>{currentTaskSubject ?? member.currentTask}</span>
            : null}
        </>
      ) : null}
      backLabel={t('agentTeams.backToOverview')}
      onBack={handleReturn}
      refreshLabel={t('subagentRun.refresh')}
      onRefresh={() => void refresh()}
      loading={loading}
      loadingLabel={t('agentTeams.memberTranscriptLoading')}
      error={member ? null : t('agentTeams.loading')}
      ready={Boolean(member) && (hasConversationSnapshot || !loading)}
      canSendMessage={canSendMessage}
      readOnlyLabel={t('teams.archivedMemberReadOnly')}
      conversationTestId="team-member-conversation"
      readOnlyTestId="team-member-readonly-note"
    />
  )
}

function AgentSessionView({
  kind,
  sessionId,
  sourceSessionId,
  workflowSourceSessionId,
  workflowIncludeRoot,
  runToolUseId,
  runAgentId,
  tasks,
  taskScope,
  workflowOwnerAliases,
  activityMessages,
  title,
  status,
  identity,
  details,
  backLabel,
  onBack,
  refreshLabel,
  onRefresh,
  loading,
  loadingLabel,
  error,
  ready,
  canSendMessage,
  readOnlyLabel,
  conversationTestId,
  readOnlyTestId,
}: {
  kind: 'subagent' | 'team-member'
  sessionId: string
  sourceSessionId: string
  workflowSourceSessionId?: string
  workflowIncludeRoot?: boolean
  runToolUseId?: string
  runAgentId?: string
  tasks: CLITask[]
  taskScope: 'run' | 'team'
  workflowOwnerAliases?: string[]
  activityMessages?: UIMessage[]
  title: string
  status?: SubagentRunStatus
  identity: string
  details?: ReactNode
  backLabel: string
  onBack: () => void
  refreshLabel: string
  onRefresh: () => void
  loading: boolean
  loadingLabel: string
  error: string | null
  ready: boolean
  canSendMessage: boolean
  readOnlyLabel: string
  conversationTestId: string
  readOnlyTestId: string
}) {
  const t = useTranslation()
  const isMobileLayout = useMobileViewport() && !isDesktopRuntime()
  const sessionState = useChatStore((state) => state.sessions[sessionId])
  const runModel = useMemo(() => latestRunModel(sessionState?.messages), [sessionState?.messages])
  const isActivityPanelOpen = useActivityPanelStore((state) => state.isOpen(sessionId))
  const closeActivityPanel = useActivityPanelStore((state) => state.close)
  const dismissBackgroundTaskKeys = useActivityPanelStore((state) => state.dismissBackgroundTaskKeys)
  const dismissedBackgroundTaskKeyList = useActivityPanelStore((state) => (
    state.dismissedBackgroundTaskKeysBySession[sessionId] ?? EMPTY_DISMISSED_BACKGROUND_TASK_KEYS
  ))
  const dismissedBackgroundTaskKeys = useMemo(
    () => new Set(dismissedBackgroundTaskKeyList),
    [dismissedBackgroundTaskKeyList],
  )
  const backgroundTasks = useMemo(
    () => Object.values(sessionState?.backgroundAgentTasks ?? {}),
    [sessionState?.backgroundAgentTasks],
  )
  const agentNotifications = useMemo(
    () => Object.values(sessionState?.agentTaskNotifications ?? {}),
    [sessionState?.agentTaskNotifications],
  )
  const allWorkflowRuns = useWorkflowStore((state) => state.runs)
  const workflowSource = workflowSourceSessionId ?? sourceSessionId
  const workflowRuns = useMemo(
    () => {
      const ownerAliases = workflowOwnerAliases ?? []
      const hasOwnerScope = ownerAliases.length > 0
      const owned = hasOwnerScope
        ? runsForOwner({ runs: allWorkflowRuns }, workflowSource, ownerAliases)
        : []
      return workflowIncludeRoot
        ? [...owned, ...runsForSession({ runs: allWorkflowRuns }, workflowSource)]
        : hasOwnerScope
          ? owned
          : runsForSession({ runs: allWorkflowRuns }, workflowSource)
    },
    [allWorkflowRuns, workflowIncludeRoot, workflowOwnerAliases, workflowSource],
  )
  const activityModel = useMemo(() => buildSessionActivityModel({
    sessionId,
    runScope: 'agent',
    taskScope,
    messages: activityMessages ?? sessionState?.messages ?? [],
    tasks,
    completedAndDismissed: false,
    isForegroundTurnActive: sessionState?.chatState !== 'idle',
    backgroundTasks,
    dismissedBackgroundTaskKeys,
    agentNotifications,
    workflowRuns,
  }), [
    agentNotifications,
    activityMessages,
    backgroundTasks,
    dismissedBackgroundTaskKeys,
    sessionId,
    sessionState?.chatState,
    sessionState?.messages,
    taskScope,
    tasks,
    workflowRuns,
  ])
  const hasVisibleActivity = hasVisibleSessionActivity(activityModel)
  const openActivityPanel = useActivityPanelStore((state) => state.open)
  const autoOpenedActivitySessionRef = useRef<string | null>(null)
  useEffect(() => {
    if (!hasVisibleActivity) {
      if (isActivityPanelOpen && autoOpenedActivitySessionRef.current === sessionId) {
        closeActivityPanel(sessionId)
      }
      return
    }
    if (isActivityPanelOpen) {
      autoOpenedActivitySessionRef.current = sessionId
      return
    }
    if (autoOpenedActivitySessionRef.current === sessionId) return
    autoOpenedActivitySessionRef.current = sessionId
    openActivityPanel(sessionId)
  }, [closeActivityPanel, hasVisibleActivity, isActivityPanelOpen, openActivityPanel, sessionId])
  const showActivityRail = hasVisibleActivity && !isMobileLayout
  const isActivityRailOpen = showActivityRail && isActivityPanelOpen
  const handleOpenSubagent = useCallback((payload: OpenSubagentPayload) => {
    const nestedToolUseId = runAgentId && runToolUseId
      ? payload.toolUseId.includes('/')
        // Resumed transcripts scope nested Agent ids as
        // `<physical-fragment-agent>/<leaf-tool-id>`. Preserve that
        // authoritative parent instead of substituting the newest fragment.
        ? `${runToolUseId}/${payload.toolUseId}`
        : `${runToolUseId}/${runAgentId}/${payload.toolUseId}`
      : payload.toolUseId
    const targetSessionId = useTabStore.getState().openSubagentTab(
      sourceSessionId,
      nestedToolUseId,
      payload.title,
      payload.taskId,
      sessionId,
    )
    if (useActivityPanelStore.getState().isOpen(sessionId)) {
      useActivityPanelStore.getState().open(targetSessionId)
    }
  }, [runAgentId, runToolUseId, sessionId, sourceSessionId])
  // Cards rendered inside this page address their runs through the source
  // session, not this tab's `subagent:*` id — and a nested card needs the same
  // canonical parent prefix the "open" button uses.
  const resolveAgentActivityTarget = useCallback(({ toolUseId, taskId }: AgentActivityTarget) => ({
    sessionId: sourceSessionId,
    toolUseId: runAgentId && runToolUseId
      ? (toolUseId.includes('/') ? `${runToolUseId}/${toolUseId}` : `${runToolUseId}/${runAgentId}/${toolUseId}`)
      : toolUseId,
    taskId,
  }), [runAgentId, runToolUseId, sourceSessionId])
  const handleClearFinishedBackgroundTasks = useCallback((taskKeys: string[]) => {
    dismissBackgroundTaskKeys(sessionId, taskKeys)
  }, [dismissBackgroundTaskKeys, sessionId])

  return (
    <SessionChatSurface
      surfaceKind="agent"
      agentRunKind={kind}
      isMobileLayout={isMobileLayout}
      activityRailOpen={isActivityRailOpen}
      contentRowTestId="agent-run-content-row"
      chatColumnTestId="agent-run-conversation-column"
      activityRail={showActivityRail ? (
        <SessionActivityPanel
          model={activityModel}
          open={isActivityPanelOpen}
          onClose={() => closeActivityPanel(sessionId)}
          onOpenSubagent={handleOpenSubagent}
          onClearFinishedBackgroundTasks={handleClearFinishedBackgroundTasks}
          placement="rail"
        />
      ) : null}
      overlay={hasVisibleActivity && isMobileLayout ? (
        <SessionActivityPanel
          model={activityModel}
          open={isActivityPanelOpen}
          onClose={() => closeActivityPanel(sessionId)}
          onOpenSubagent={handleOpenSubagent}
          onClearFinishedBackgroundTasks={handleClearFinishedBackgroundTasks}
          placement="overlay"
        />
      ) : null}
    >
      <SessionChatHeader
        title={title}
        compact={isMobileLayout}
        leading={(
          <Button
            variant="ghost"
            size="base"
            onClick={onBack}
            icon={<ArrowLeft size={15} strokeWidth={2} aria-hidden="true" />}
            className="shrink-0"
          >
            {backLabel}
          </Button>
        )}
        titleAddon={(
          <>
            {status ? <StatusBadge status={status} t={t} /> : null}
            {runModel ? (
              <Badge
                tone="neutral"
                size="xs"
                bordered
                mono
                title={t('subagentRun.model')}
                aria-label={`${t('subagentRun.model')}: ${runModel}`}
              >
                {runModel}
              </Badge>
            ) : null}
          </>
        )}
        actions={(
          <>
            {hasVisibleActivity ? <SessionActivityButton sessionId={sessionId} /> : null}
            <IconButton
              icon={<RefreshCw size={15} strokeWidth={2.2} aria-hidden="true" className={loading ? 'animate-spin' : undefined} />}
              label={refreshLabel}
              showTooltip={false}
              size="md"
              tone="muted"
              onClick={onRefresh}
              disabled={loading}
            />
          </>
        )}
        metadata={[{
          key: 'identity',
          content: <span className="truncate font-mono">{identity}</span>,
        }]}
      >
        {details ? (
          <p className="mt-1 flex min-w-0 flex-wrap gap-x-2 text-[11px] text-[var(--color-text-tertiary)]">
            {details}
          </p>
        ) : null}
      </SessionChatHeader>

      {loading && !ready ? (
        <div role="status" className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-tertiary)]">{loadingLabel}</div>
      ) : null}
      {error ? (
        <div role="alert" className="mx-5 mt-4 rounded-[var(--radius-md)] border border-[var(--color-error)] bg-[var(--color-error-container)] px-3 py-2 text-sm text-[var(--color-on-error-container)]">
          {error}
        </div>
      ) : null}
      {ready ? (
        <div data-testid={conversationTestId} className="flex min-h-0 flex-1 flex-col">
          <MessageList
            sessionId={sessionId}
            mobileLayout={isMobileLayout}
            onOpenAgentRun={handleOpenSubagent}
            resolveAgentActivityTarget={resolveAgentActivityTarget}
          />
        </div>
      ) : null}
      {ready && canSendMessage ? <ChatInput /> : null}
      {ready && !canSendMessage ? (
        <p
          data-testid={readOnlyTestId}
          className="shrink-0 border-t border-[var(--color-border)] px-5 py-3 text-center text-[11.5px] text-[var(--color-text-tertiary)]"
        >
          {readOnlyLabel}
        </p>
      ) : null}
    </SessionChatSurface>
  )
}

/**
 * The model a run executed on, read from the newest transcript turn that
 * reported one. Assistant messages carry whatever the provider actually
 * served, which is the only place the resolved model survives: the Agent tool
 * input records an override only, and the runtime discards the model it
 * resolved for an inheriting run. A run that has not answered yet has nothing
 * to show, so the header renders no badge rather than guessing.
 */
function latestRunModel(messages: UIMessage[] | undefined): string | undefined {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages?.[index]
    if (message?.type === 'assistant_text' && message.model) return message.model
  }
  return undefined
}

function StatusBadge({ status, t }: { status: SubagentRunStatus; t: TranslationFn }) {
  return (
    <Badge tone={statusTone(status)} size="xs" bordered>
      {getSubagentStatusLabel(status, t)}
    </Badge>
  )
}

function statusTone(status: SubagentRunStatus): BadgeTone {
  if (status === 'completed') return 'success'
  if (status === 'failed' || status === 'stopped') return 'danger'
  if (status === 'running') return 'brand'
  return 'neutral'
}

function getSubagentStatusLabel(status: SubagentRunStatus, t: TranslationFn) {
  switch (status) {
    case 'completed':
      return t('subagentRun.status.completed')
    case 'failed':
      return t('subagentRun.status.failed')
    case 'stopped':
      return t('subagentRun.status.stopped')
    case 'running':
      return t('subagentRun.status.running')
    case 'unknown':
      return t('subagentRun.status.unknown')
  }
}

function timestampMs(value: string | undefined) {
  if (!value) return Date.now()
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : Date.now()
}

function normalizedText(value: string | undefined) {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function hasPromptMessage(messages: UIMessage[], prompt: string) {
  const normalizedPrompt = normalizedText(prompt)
  if (!normalizedPrompt) return false

  return messages.some((message) => (
    message.type === 'user_text' &&
    normalizedText(message.content) === normalizedPrompt
  ))
}

function buildSubagentConversationMessages(data: SubagentRunResponse): UIMessage[] {
  const transcriptMessages = mapHistoryMessagesToUiMessages(data.messages, { includeTeammateMessages: true })
  const messages = [...transcriptMessages]
  const prompt = data.prompt?.trim()
  const baseTimestamp = timestampMs(data.updatedAt)

  if (prompt && !hasPromptMessage(transcriptMessages, prompt)) {
    messages.unshift({
      id: `subagent-prompt-${data.toolUseId}`,
      type: 'user_text',
      content: prompt,
      timestamp: baseTimestamp - 1,
    })
  }

  const resultText = (data.result || data.summary)?.trim()
  if (transcriptMessages.length === 0 && resultText) {
    messages.push({
      id: `subagent-result-message-${data.toolUseId}`,
      type: 'assistant_text',
      content: resultText,
      timestamp: baseTimestamp,
    })
  }

  return messages
}
