import { serializeComposer, type ComposerReference } from '../../core/composerReferences'
import { KeyboardViewport } from '../../ui/KeyboardViewport'
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { AppState, FlatList, Platform, View, type NativeScrollEvent } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import { getRandomValues } from 'expo-crypto'
import { Text } from '../../ui/Text'
import { useApp, useConnection } from '../../state/AppContext'
import { isH5, reconnectH5 } from '../../state/h5'
import { useDashboard } from '../../state/DashboardContext'
import { createChatState } from '../../core/chat'
import { ChatRecovery } from '../../core/chatRecovery'
import {
  buildComposerMessage,
  persistedMessageId,
  validateMessageSize,
  visibleMessageText,
  type ComposerAttachment,
} from '../../core/chatComposer'
import { notificationPermissionResponse, runtimeMatches } from '../../core/chatActions'
import { clearPendingTask, peekPendingTask, pendingTaskDraft } from '../../core/pendingTask'
import { SessionTransport, type ConnectionState, type SocketLike } from '../../core/sessionTransport'
import { sessionHistory } from '../../core/historyCache'
import { isAppForeground } from '../../core/appVisibility'
import { foregroundGate } from '../../core/foregroundGate'
import { newStreamId } from '../../core/resumableStream'
import type { LinkPath } from '../../core/hostLink'
import { hostLinkFor, nativeSocketFactory, watchDeviceNetwork } from '../../state/api'
import { takeSessionStale } from '../../core/sessionStale'
import {
  listCheckpoints,
  sessionPath,
  type BackgroundSnapshot,
  type BackgroundTask,
  type Checkpoint,
} from '../../core/operations'
import type { ChatItem, ChatState, ClientMessage, PermissionMode, Session } from '../../core/types'
import { Approval } from '../../ui/Approval'
import { teamLaunchNotice, teamPlanSurface, teamRuntime } from '../../core/teamPlan'
import { useTeamPlan } from '../../ui/team/useTeamPlan'
import { TeamPlanCard } from '../../ui/team/TeamPlanCard'
import { TeamPlanSheet } from '../../ui/team/TeamPlanSheet'
import { ChatComposer } from '../../ui/ChatComposer'
import { Message, type BubbleLayout } from '../../ui/Message'
import { type Model } from '../../ui/RuntimePicker'
import { RunSheet } from '../../ui/compose/RunSheet'
import { nextChosenModel, runCapsule } from '../../ui/compose/runLogic'
import { useComputerUse } from '../../core/useComputerUse'
import { teamMembersAllStopped, useSessionActivity } from '../../core/sessionActivity'
import { registerSessionSender } from '../../core/sessionSender'
import { ActivityCapsule } from '../../ui/activity/ActivityCapsule'
import { ActivitySheet } from '../../ui/activity/ActivitySheet'
import { useNow } from '../../ui/activity/useNow'
import { StatusCaption } from '../../ui/chat/StatusCaption'
import { ContextMenuHeader, ContextSheet, useContextInspection } from '../../ui/chat/ContextSheet'
import { contextSummary } from '../../ui/chat/contextUsage'
import { turnOutputTokens } from '../../core/streamRate'
import { currentStepLabel, pendingStepLabel } from '../../ui/chat/captionModel'
import { elapsedLabel } from '../../core/dashboard'
import { SessionChangesCard } from '../../ui/SessionChangesCard'
import {
  ActionMenu,
  Button,
  Callout,
  Card,
  FloatingButton,
  InlineError,
  Mono,
  NavBar,
  ScreenView,
  Spinner,
  Toast,
  goBack,
  useColors,
  type ActionMenuItem,
} from '../../ui/kit'
import { errorText } from '../../ui/theme'
import { buildChatRows, toggleGroupOpen, visibleChatRows, type ChatRow } from '../../ui/chat/steps'
import { StepGroup, TurnFold, type StepContext, type StepUi } from '../../ui/chat/StepGroup'
import { ToolImageLoaderContext } from '../../ui/chat/toolImageContext'
import { createToolImageLoader } from '../../core/toolImages'
import { QueuedMessages } from '../../ui/chat/QueuedMessages'
import { OlderHistoryStatus } from '../../ui/chat/OlderHistoryStatus'
import { shouldPrefetchOlder } from '../../ui/chat/olderHistory'
import {
  canFlushQueue,
  clearParkedComposer,
  parkedComposer,
  queuePauseReason,
  withdrawQueuedComposer,
  type ComposerQueueState,
  type QueuedMessage,
  type QueueGate,
} from '../../ui/chat/queue'
import { MessageMenu, type MessageAction } from '../../ui/chat/MessageMenu'
import {
  ConfirmSheet,
  EditResendSheet,
  RenameSheet,
  SelectTextSheet,
} from '../../ui/chat/sheets'
import {
  connectionLabels,
  linkPathLabels,
  contextWindow,
  displayPath,
  latestTurnCheckpoint,
  nextTurnStart,
  sessionSubtitle,
  turnMeta,
} from '../../ui/chat/session'
import { showsReconnectBanner, useConnectionNotice } from '../../ui/chat/connectionNotice'
import { simulatedPhoneChrome } from '../../ui/webChrome'

type Panel = 'menu' | 'rename' | 'delete' | 'run' | 'stop' | 'select' | 'edit' | 'activity' | 'context' | null
type RewindPreview = {
  target: { targetUserMessageId: string }
  conversation: { messagesRemoved: number }
}
/** Within this distance of the newest position (start of the inverted list) counts as staying at the newest. */
const LATEST_SLOP = 120

const toggle = (set: ReadonlySet<string>, key: string) => {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

export default function Chat() {
  const { id, host, notificationAction, requestId } = useLocalSearchParams<{
    id: string
    host?: string
    notificationAction?: string
    requestId?: string
  }>()
  // Links without host (cchaha://chat/<id>) open on the current computer, consistent with other pages that take a host param; 
  // otherwise draft, history cache and home snapshot are all read with undefined, and a cold start reads an empty snapshot and crashes.
  const { registry } = useApp()
  const hostId = host ?? registry.selectedId ?? ''
  return (
    <ChatSession
      key={`${hostId}:${id}`}
      id={id}
      hostId={hostId}
      notificationAction={notificationAction}
      notificationRequestId={requestId}
    />
  )
}

function ChatSession({
  id,
  hostId,
  notificationAction,
  notificationRequestId,
}: {
  id: string
  hostId: string
  notificationAction?: string
  notificationRequestId?: string
}) {
  const { client, host, credential, error: connectionError } = useConnection(hostId)
  // Images in tool results are downloaded by reference; the cache follows this computer connection.
  const toolImages = useMemo(() => (client ? createToolImageLoader(client) : null), [client])
  const { drafts } = useApp()
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const draftKey = `${hostId}:${id}`
  const [initialTask] = useState(() => peekPendingTask(hostId, id))
  const handoff = useRef<{
    task: typeof initialTask
    phase: 'initial' | 'config' | 'done' | 'failed'
    /** Content in the input that was not sent before edit-and-resend is restored after sending succeeds. */
    restore?: { text: string; attachments: ComposerAttachment[]; references?: ComposerReference[] }
  }>({
    task: initialTask,
    phase: 'initial',
  })
  // Content handed over by a new task may carry a team marker: the input shows only the user text, and the team toggle replaces the marker.
  const [initialDraft] = useState(() => (initialTask ? pendingTaskDraft(initialTask) : null))
  const [draft, setDraft] = useState(initialDraft?.text ?? drafts.get(draftKey) ?? '')
  // Materials and team toggle from queued messages when last leaving (the text is already in the draft).
  const [parked] = useState(() => (initialTask ? undefined : parkedComposer(draftKey)))
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(
    initialTask?.attachments ?? parked?.attachments ?? []
  )
  const [references, setReferences] = useState<ComposerReference[]>(initialTask?.references ?? parked?.references ?? [])
  const [team, setTeam] = useState(initialDraft?.team ?? parked?.team ?? false)
  // Messages added while running queue on the phone first and send in order after this turn ends.
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  const queueSeq = useRef(0)
  const leaving = useRef<ComposerQueueState>({ queue, draft, attachments, team, references })
  const focused = useRef(false)
  // Model chosen in the model sheet: use its display name and context size; otherwise only the model id is known.
  const [chosenModel, setChosenModel] = useState<Model | null>(null)
  const [state, setState] = useState<ChatState>(() => createChatState(id))
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  // Number of real syncs with the computer (history read): resume and reroute keep it unchanged; branches and checkpoints only reread on it.
  const [syncEpoch, setSyncEpoch] = useState(0)
  // Consecutive failed connection attempts: after two, warn without waiting the full ten seconds.
  const [failures, setFailures] = useState(0)
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState('')
  const [recoveryError, setRecoveryError] = useState('')
  const [notice, setNotice] = useState('')
  const [panel, setPanel] = useState<Panel>(null)
  const [sheetError, setSheetError] = useState('')
  const [titleDraft, setTitleDraft] = useState('')
  const [working, setWorking] = useState(false)
  const [selected, setSelected] = useState<{ item: ChatItem; layout: BubbleLayout } | null>(null)
  const [menuBusy, setMenuBusy] = useState<'edit' | 'fork' | null>(null)
  const [selectText, setSelectText] = useState('')
  const [editText, setEditText] = useState('')
  const [rewindPreview, setRewindPreview] = useState<RewindPreview | null>(null)
  const [revision, setRevision] = useState(0)
  const [hasOlder, setHasOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderFailed, setOlderFailed] = useState(false)
  const [awayFromLatest, setAwayFromLatest] = useState(false)
  // Near the newest position: do not enable keep-reading-position; new content sticks to the bottom via the inverted list.
  const [atLatest, setAtLatest] = useState(true)
  const [branch, setBranch] = useState<string | null>(null)
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([])
  const [ui, setUi] = useState<StepUi>(() => ({ expanded: new Set(), open: new Set(), closed: new Set(), revealed: new Set() }))
  const [turnClock, setTurnClock] = useState<{ startedAt?: number; endedAt?: number; live?: boolean }>({})
  // A turn already running when entering the page uses the start time from the computer, consistent with home.
  const { snapshot: dashboard, holdActivityScope } = useDashboard()
  // The chat page only needs run state; do not repeatedly fetch the full session list while focused, leaving the tunnel to chat.
  useFocusEffect(useCallback(() => holdActivityScope(), [holdActivityScope]))
  const liveActivity =
    dashboard?.hostId === hostId ? dashboard.activity.find((item) => item.id === id) : undefined
  const serverTurnStart =
    liveActivity && ['running', 'waiting'].includes(liveActivity.activityState)
      ? liveActivity.startedAt
      : undefined
  const clockRef = useRef<{ active: boolean; startedAt?: number; live: boolean } | undefined>(undefined)
  const connectionRef = useRef<ConnectionState>('connecting')
  // Connection path for a remote computer: through Cloudflare, or upgraded to direct.
  const [linkPath, setLinkPath] = useState<LinkPath | null>(null)
  const transport = useRef<SessionTransport | null>(null)
  // The message stream is an inverted list: offset 0 is the newest. When opening a session, keyboard opening, input growing, or streaming output growing,
  // native keeps it at the bottom; no JS position math or scroll correction is needed (that would race native size changes and fail to reach the bottom).
  const list = useRef<FlatList<ChatRow>>(null)
  // Distance from the newest, plus list viewport and content height: decide when to page back early.
  const scrollMetrics = useRef({ offset: 0 })
  const listSize = useRef({ viewport: 0, content: 0 })
  const olderInFlight = useRef(false)
  const olderFailedRef = useRef(false)
  // How many batches were auto-paged in one drag; see shouldPrefetchOlder.
  const autoBatches = useRef(0)
  const notificationSeen = useRef(new Set<string>())
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      clearTimeout(noticeTimer.current)
    }
  }, [])

  useEffect(() => {
    // An H5 page authenticated by its cookie or loopback address has credential ''.
    if (!client || credential === undefined) return
    let alive = true
    /** Turn start and end are only recorded on status: use local time when the start was seen, otherwise message time. */
    function trackTurn(value: ChatState) {
      const previous = clockRef.current
      const now = Date.now()
      const lastUser = value.items.findLast((item) => item.type === 'user')
      const startedAt = nextTurnStart({
        previous,
        active: value.turnActive,
        lastUserTimestamp: lastUser?.timestamp,
        now,
      })
      clockRef.current = {
        active: value.turnActive,
        startedAt,
        live: connectionRef.current === 'ready',
      }
      if (previous?.active === value.turnActive && previous?.startedAt === startedAt) return
      // Local time is most accurate when this page saw the turn start (connected, idle to running); 
      // only a turn already running on page entry borrows the start time from the computer.
      if (value.turnActive)
        setTurnClock({ startedAt, live: !!previous && !previous.active && previous.live })
      else if (previous?.active)
        setTurnClock({ startedAt: previous.startedAt, endedAt: now })
    }
    const recovery = new ChatRecovery({
      loadSummary: (signal) =>
        client.get<Session>(`/api/sessions/${encodeURIComponent(id)}/summary`, { signal }),
      onSummary: (value) => {
        if (alive) setSession(value)
      },
      onConnectionError: (message) => {
        if (alive) setRecoveryError(message)
      },
      onBusinessError: (value) => {
        if (alive) setError(value.message)
      },
    })
    const link = credential ? hostLinkFor(client.host, credential) : undefined
    const channel = new SessionTransport({
      client,
      credential,
      sessionId: id,
      platform: Platform.OS === 'web' ? 'web' : 'native',
      history: sessionHistory.store(hostId, id),
      gate: foregroundGate,
      // After a disconnect, resume the original stream: only resend missed parts, no history reread (falls back to the old way if the computer does not support it).
      newStreamId: () =>
        newStreamId(Platform.OS === 'web' ? globalThis.crypto : { getRandomValues }),
      socketFactory: (options) =>
        Platform.OS === 'web'
          ? (new WebSocket(options.url) as unknown as SocketLike)
          : (link?.socketFactory ?? nativeSocketFactory)(options),
      onState: (value) => {
        if (alive) {
          setState(value)
          setHasOlder(Boolean(channel.historyPage?.page?.nextCursor))
          trackTurn(value)
        }
      },
      onConnection: (value) => {
        if (alive) {
          connectionRef.current = value
          setConnection(value)
          setSyncEpoch(channel.syncEpoch)
          setFailures(channel.failures)
          // After reconnecting, paging that failed due to the disconnect can auto-page again.
          if (value === 'ready') {
            olderFailedRef.current = false
            setOlderFailed(false)
          }
          recovery.onConnection(value)
          if (value !== 'ready' && value !== 'syncing' && handoff.current.phase === 'config')
            handoff.current.phase = 'failed'
        }
      },
      onError: (value) => {
        if (alive) {
          handoff.current.phase = 'failed'
          recovery.onTransportError(value)
        }
      },
    })
    transport.current = channel
    recovery.start()
    channel.start()
    let hiddenAt: number | undefined
    const listener = AppState.addEventListener('change', (value) => {
      if (!isAppForeground(value)) {
        hiddenAt ??= Date.now()
        return
      }
      if (value !== 'active') return
      // Probe liveness regardless of how long we were away; if the connection is still alive keep using it instead of tearing down.
      channel.resume(hiddenAt)
      hiddenAt = undefined
    })
    // Direct connection established: the session moves to the new path with the frames already seen; if direct drops, resume reconnects through Cloudflare.
    queueMicrotask(() => {
      if (alive) setLinkPath(link?.path ?? null)
    })
    const stopPath = link?.onPathChange((path) => {
      if (alive) setLinkPath(path)
      if (path !== 'cf') channel.migrate()
    })
    // Network changed: probe right away instead of waiting for a missed heartbeat.
    const stopNetwork = watchDeviceNetwork(() => channel.resume())
    return () => {
      alive = false
      recovery.dispose()
      listener.remove()
      stopNetwork()
      stopPath?.()
      channel.dispose()
      if (transport.current === channel) transport.current = null
    }
  }, [client, credential, hostId, id, revision])

  const ready = connection === 'ready'
  const connectionNotice = useConnectionNotice(connection, failures)
  const busy =
    state.turnActive ||
    state.permissions.length > 0 ||
    state.computerUsePermissions.length > 0 ||
    state.items.some((item) => item.type === 'user' && item.pending)
  const workspaceMissing =
    session?.workspaceState === 'missing' ||
    session?.workspaceState === 'worktree_removed' ||
    session?.workDirExists === false
  const lean = session?.agentProfile === 'lean'
  const approval = state.permissions[0]
  const pendingUser = state.items.some((item) => item.type === 'user' && item.pending)
  const waitingForDecision =
    state.permissions.length > 0 || state.computerUsePermissions.length > 0
  // After this turn ends, send queued messages in order. If sending fails (disconnected, computer has not confirmed the previous one)
  // keep them queued and retry when conditions change; the transport also refuses to send while the previous one is unconfirmed.
  const lastUser = state.items.findLast((item) => item.type === 'user')
  const queueGate: QueueGate = {
    ready,
    turnActive: state.turnActive,
    waitingForDecision,
    pendingUser,
    configPending: state.configPending,
    workspaceMissing,
    lastTurnFailed: !!state.error,
    deliveryUncertain: lastUser?.delivery === 'uncertain',
  }
  const queuePaused = queue.length ? queuePauseReason(queueGate) : ''
  const flushQueue = useEffectEvent(() => {
    const next = queue[0]
    if (!next || !canFlushQueue(queueGate, focused.current)) return
    if (dispatch(next.message, () => {})) {
      setQueue((items) => items.filter((item) => item.id !== next.id))
      showLatest()
    }
  })
  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) flushQueue()
    })
    return () => {
      active = false
    }
  }, [
    queue,
    ready,
    state.turnActive,
    waitingForDecision,
    pendingUser,
    state.configPending,
    workspaceMissing,
    state.error,
    lastUser?.delivery,
  ])
  useEffect(() => {
    leaving.current = { queue, draft, attachments, team, references }
  }, [queue, draft, attachments, team, references])
  useEffect(() => {
    clearParkedComposer(draftKey)
  }, [draftKey])
  const restoreQueue = useCallback((current: ComposerQueueState, ids?: string[]) => {
    const restored = withdrawQueuedComposer(draftKey, current, drafts, ids)
    // Sync the ref and in-memory draft first so leaving right after stopping neither loses the draft nor returns attachments twice.
    leaving.current = restored
    if (restored !== current && mounted.current) {
      setQueue(restored.queue)
      setDraft(restored.draft)
      setAttachments(restored.attachments)
      setTeam(restored.team)
      setReferences(restored.references ?? [])
    }
  }, [draftKey, drafts])
  useFocusEffect(
    useCallback(() => {
      focused.current = true
      return () => {
        // push Chat stays mounted under pages like workspace; on blur stop auto-sending and return to the input.
        focused.current = false
        restoreQueue(leaving.current)
      }
    }, [restoreQueue])
  )
  function sendQueuedNow(itemId: string) {
    const item = queue.find((value) => value.id === itemId)
    if (!item || !ready || state.turnActive || waitingForDecision || pendingUser) return
    if (dispatch(item.message)) {
      setQueue((items) => items.filter((value) => value.id !== itemId))
      showLatest()
    }
  }
  /** Insert queued messages into the running turn immediately; if the turn just ended, fall back to a normal send. */
  function guideQueued(itemId: string) {
    const item = queue.find((value) => value.id === itemId)
    if (!item) return
    if (transport.current?.steer(item.message)) {
      setQueue((items) => items.filter((value) => value.id !== itemId))
      showLatest()
      return
    }
    if (!state.turnActive && dispatch(item.message)) {
      setQueue((items) => items.filter((value) => value.id !== itemId))
      showLatest()
      return
    }
    showNotice('Cannot steer yet; try again after the previous message is confirmed or the current decision is handled.', true)
  }
  function withdrawQueued(ids?: string[]) {
    restoreQueue({ queue, draft, attachments, team, references }, ids)
  }
  const runtime =
    state.runtime ??
    (session?.runtimeModelId
      ? {
          providerId: session.runtimeProviderId ?? null,
          modelId: session.runtimeModelId,
          effortLevel: session.effortLevel,
        }
      : undefined)
  const knownModel = chosenModel && chosenModel.id === runtime?.modelId ? chosenModel : null
  const modelLabel = runtime ? knownModel?.name || runtime.modelId : 'Choose model'
  const permissionMode = state.permissionMode ?? session?.permissionMode
  const backgroundCount = state.backgroundTaskIds.length
  const title = state.title || session?.title || 'Session'
  const computer = useComputerUse(client)
  const sendRaw = useCallback((message: ClientMessage) => transport.current?.send(message) ?? false, [])
  useEffect(() => registerSessionSender(id, sendRaw), [id, sendRaw])
  // After the lead submits a team, work starts only after a human approves: this must work on mobile too. Like desktop, it sits above the input, 
  // not taking over the input — while adding members, existing members are still running and the user must still be able to stop and talk to the lead.
  const teamPlan = useTeamPlan({
    client,
    sessionId: id,
    ready,
    signal: state.teamPlanSignal,
    turnActive: state.turnActive,
  })
  const teamSurface = teamPlanSurface(teamPlan.plan)
  // Each newly submitted plan pops up from the bottom once; after closing, reopen from the card. The toggle lives on the page, 
  // so remounting the card when switching between input and approval neither closes it nor pops it twice.
  const reviewPlanId = teamSurface === 'review' ? teamPlan.plan?.planId : undefined
  const [teamSheet, setTeamSheet] = useState<{ planId?: string; open: boolean }>({ open: false })
  if (reviewPlanId && teamSheet.planId !== reviewPlanId) setTeamSheet({ planId: reviewPlanId, open: true })
  const teamSheetOpen = !!reviewPlanId && teamSheet.planId === reviewPlanId && teamSheet.open
  // After approval the review card disappears: show "starting" below the header, and the top capsule shows progress.
  const [seenPlan, setSeenPlan] = useState(teamPlan.plan)
  const [teamToast, setTeamToast] = useState('')
  if (seenPlan !== teamPlan.plan) {
    const text = teamLaunchNotice(seenPlan, teamPlan.plan)
    setSeenPlan(teamPlan.plan)
    if (text) setTeamToast(text)
  }
  useEffect(() => {
    if (!teamToast) return
    const timer = setTimeout(() => setTeamToast(''), 2600)
    return () => clearTimeout(timer)
  }, [teamToast])
  const teamLaunching =
    teamPlan.plan?.state === 'launching'
      ? (teamPlan.plan.approvedSnapshot?.members ?? teamPlan.plan.members).length
      : undefined
  const activity = useSessionActivity({
    client,
    host: { id: hostId },
    sessionId: id,
    turnActive: state.turnActive,
    backgroundTaskIds: state.backgroundTaskIds,
    live: state.subagents,
    pendingApprovals: state.permissions.length,
    workDir: session?.workDir ?? undefined,
    send: sendRaw,
    teamPlan: teamPlan.plan,
  })
  // Lead turn ended while approved members are still running: still offer stop (same as desktop background stop).
  const teamWorking =
    !state.turnActive &&
    (teamPlan.plan?.state === 'launching' || teamPlan.plan?.state === 'running') &&
    !teamMembersAllStopped(activity.team)

  // Branch is only for the subtitle and menu; if unavailable show only the project name. Reread only after truly resyncing with the computer: 
  // reconnects like resume or switching to direct do not read history, and returning to foreground should not fire an extra request.
  useEffect(() => {
    if (!client || !syncEpoch) return
    const controller = new AbortController()
    client
      .get<{ branch: string | null }>(`${sessionPath(id)}/git-info`, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setBranch(value.branch ?? null)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [client, id, syncEpoch])

  // File counts in this turn's changes card and the menu come from the latest checkpoint; not read while running, read after the turn ends or a resync.
  const hasItems = state.items.length > 0
  useEffect(() => {
    if (!client || !syncEpoch || state.turnActive || !hasItems) return
    const controller = new AbortController()
    listCheckpoints(client, id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setCheckpoints(value.checkpoints)
      })
      .catch(() => {
        if (!controller.signal.aborted) setCheckpoints([])
      })
    return () => controller.abort()
  }, [client, id, syncEpoch, state.turnActive, hasItems, revision])
  const latest = useMemo(() => latestTurnCheckpoint(checkpoints), [checkpoints])

  // The background task list is only used to map "running in background" to specific subagent steps.
  const backgroundKey = state.backgroundTaskIds.join('\n')
  useEffect(() => {
    if (!client || !backgroundKey) return
    const controller = new AbortController()
    client
      .get<BackgroundSnapshot>(`${sessionPath(id)}/background-tasks`, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setBackgroundTasks(value.tasks ?? [])
      })
      .catch(() => {})
    return () => controller.abort()
  }, [client, id, backgroundKey])

  const deliverPendingTask = useEffectEvent(() => {
    const value = handoff.current
    if (
      !value.task ||
      value.phase === 'done' ||
      value.phase === 'failed' ||
      !ready ||
      !session ||
      state.configPending
    )
      return
    if (busy || workspaceMissing) {
      value.phase = 'failed'
      setNotice('The first task stayed in the input; check the session state before sending.')
      return
    }
    try {
      const desired = value.task.runtime
      if (desired && !runtimeMatches(state.runtime, desired)) {
        if (value.phase === 'config') {
          value.phase = 'failed'
          setError('The computer did not switch to the selected model; the first task stayed in the input.')
          return
        }
        value.phase = 'config'
        if (!transport.current?.send({ type: 'set_runtime_config', ...desired })) {
          value.phase = 'failed'
          setError('The model is not ready yet; the first task stayed in the input.')
        }
        return
      }
      const message = buildComposerMessage(value.task.content, value.task.attachments, false)
      validateMessageSize(message, host?.auth ?? 'lan')
      value.phase = 'done'
      if (transport.current?.send(message)) {
        clearPendingTask(hostId, id)
        // Team applies only to the first message; on edit-and-resend restore the previously unsent input content.
        setTeam(false)
        const restore = value.restore
        setDraft(restore?.text ?? '')
        setReferences(restore?.references ?? [])
        setAttachments(restore?.attachments ?? [])
        if (restore?.text) drafts.set(draftKey, restore.text)
        else drafts.delete(draftKey)
      } else {
        value.phase = 'failed'
        setError('The first task was not sent; send manually after checking the connection.')
      }
    } catch (e) {
      value.phase = 'failed'
      setError(errorText(e))
    }
  })
  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) deliverPendingTask()
    })
    return () => {
      active = false
    }
  }, [ready, session, busy, workspaceMissing, state.configPending, state.runtime])

  const respondToNotification = useEffectEvent(() => {
    if (!ready || !notificationAction || !notificationRequestId) return
    const key = `${notificationRequestId}:${notificationAction}`
    if (notificationSeen.current.has(key)) return
    notificationSeen.current.add(key)
    const response = notificationPermissionResponse(state, notificationAction, notificationRequestId)
    if (!response) {
      setNotice('This approval was already handled or must be answered in the session; please check the current state.')
      return
    }
    if (transport.current?.send(response))
      setNotice(
        notificationAction === 'allow'
          ? 'Allow submitted for this time, waiting for the computer to confirm.'
          : 'Deny submitted for this time, waiting for the computer to confirm.'
      )
    else setError('The notification action was not sent; retry in the current approval.')
  })
  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) respondToNotification()
    })
    return () => {
      active = false
    }
  }, [ready, notificationAction, notificationRequestId, state])

  /** Send a command; failure reasons go to the slot given by the caller, and the same error is shown only once. */
  function dispatch(message: ClientMessage, report: (message: string) => void = setError) {
    report('')
    try {
      const sent = transport.current?.send(message) ?? false
      if (!sent) report('Action not sent yet. Wait for the session to finish syncing, or check the current task state.')
      return sent
    } catch (e) {
      report(errorText(e))
      return false
    }
  }
  const send = (message: ClientMessage) => dispatch(message)
  /** Page back one batch (two pages); in-flight only trusts the ref to avoid duplicate requests. Older content is appended to the end of the inverted list (top of the screen) without moving the reading position. */
  function loadOlderBatch() {
    if (olderInFlight.current) return
    const channel = transport.current
    if (!channel) return
    olderInFlight.current = true
    olderFailedRef.current = false
    setLoadingOlder(true)
    setOlderFailed(false)
    channel
      .loadOlder(2)
      .then((result) => {
        if (!mounted.current) return
        if (result === 'end') setHasOlder(false)
        else if (result === 'unavailable') {
          olderFailedRef.current = true
          setOlderFailed(true)
        }
      })
      .catch(() => {
        olderFailedRef.current = true
        if (mounted.current) setOlderFailed(true)
      })
      .finally(() => {
        olderInFlight.current = false
        if (!mounted.current) return
        setLoadingOlder(false)
        // When the whole batch merges into existing collapsed rows the content height does not change and no layout callback fires, so check once here.
        requestAnimationFrame(() => {
          if (mounted.current) maybeLoadOlder()
        })
      })
  }
  /** Page back early when scrolling near the top (earliest loaded content). Reads only the ref and transport so calling it from a load-finished callback does not see stale state. */
  function maybeLoadOlder() {
    const { viewport, content } = listSize.current
    if (
      olderInFlight.current ||
      olderFailedRef.current ||
      connectionRef.current !== 'ready' ||
      !transport.current?.historyPage?.page?.nextCursor ||
      !shouldPrefetchOlder({
        viewport,
        content,
        toOldest: Math.max(0, content - viewport - scrollMetrics.current.offset),
        batches: autoBatches.current,
      })
    )
      return
    autoBatches.current++
    loadOlderBatch()
  }
  function trackScroll(value: NativeScrollEvent) {
    const offset = value.contentOffset.y
    scrollMetrics.current = { offset }
    listSize.current = { viewport: value.layoutMeasurement.height, content: value.contentSize.height }
    const near = offset < LATEST_SLOP
    if (near !== atLatest) setAtLatest(near)
    const away = offset > value.layoutMeasurement.height
    if (away !== awayFromLatest) setAwayFromLatest(away)
    maybeLoadOlder()
  }
  function retryOlder() {
    olderFailedRef.current = false
    autoBatches.current = 0
    loadOlderBatch()
  }
  /** Back to the newest (start of the inverted list): used when sending a message or tapping Back to latest. */
  function showLatest(animated = true) {
    list.current?.scrollToOffset({ offset: 0, animated })
  }
  function jumpToLatest() {
    setAwayFromLatest(false)
    showLatest()
  }
  // The list is often measured before connecting to the computer; after connecting there are no new layout or scroll events, so check once more, 
  // otherwise sessions shorter than one screen get stuck on "Load earlier messages".
  const prefetchWhenReady = useEffectEvent(() => maybeLoadOlder())
  useEffect(() => {
    if (!ready) return
    const frame = requestAnimationFrame(() => prefetchWhenReady())
    return () => cancelAnimationFrame(frame)
  }, [ready])
  function showNotice(text: string, transient = false) {
    clearTimeout(noticeTimer.current)
    setNotice(text)
    if (transient)
      noticeTimer.current = setTimeout(() => {
        if (mounted.current) setNotice((value) => (value === text ? '' : value))
      }, 2000)
  }
  /** iOS Cannot open one sheet while another is closing; close first, then open. */
  function openPanel(next: Exclude<Panel, null>) {
    setSheetError('')
    const covered = panel !== null || selected !== null
    setSelected(null)
    if (Platform.OS === 'ios' && covered) {
      setPanel(null)
      setTimeout(() => {
        if (mounted.current) setPanel(next)
      }, 350)
    } else setPanel(next)
  }
  const closePanel = () => {
    if (!working) setPanel(null)
  }
  const openRoute = (pathname: '/changes') =>
    router.push({ pathname, params: { id, host: hostId } })
  const openFiles = (tab: 'changed' | 'all') =>
    router.push({ pathname: '/files', params: { id, host: hostId, tab } })

  /** Returns true when the draft was sent or queued (and is being cleared). */
  function submit(): boolean {
    if (workspaceMissing) return false
    try {
      const message = buildComposerMessage(serializeComposer(draft, references), attachments, team)
      validateMessageSize(message, host?.auth ?? 'lan')
      if (busy) {
        if (approval) return false
        setQueue((items) => [
          ...items,
          {
            id: `queued-${++queueSeq.current}`,
            text: draft.trim(),
            attachments,
            team,
            references,
            message,
          },
        ])
        setDraft('')
        setReferences([])
        setAttachments([])
        setTeam(false)
        drafts.delete(draftKey)
        setError('')
        return true
      }
      if (dispatch(message)) {
        setDraft('')
        setReferences([])
        setAttachments([])
        setTeam(false)
        drafts.delete(draftKey)
        clearPendingTask(hostId, id)
        handoff.current.phase = 'done'
        showLatest()
        setNotice('')
        return true
      }
    } catch (e) {
      setError(errorText(e))
    }
    return false
  }
  async function rename() {
    const nextTitle = titleDraft.trim()
    if (!client || !nextTitle || working) return
    setWorking(true)
    setSheetError('')
    try {
      await client.request(`/api/sessions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { title: nextTitle },
      })
      if (!mounted.current) return
      transport.current?.confirmTitle(nextTitle)
      setSession((value) => (value ? { ...value, title: nextTitle } : null))
      setPanel(null)
    } catch (e) {
      if (mounted.current) setSheetError(errorText(e))
    } finally {
      if (mounted.current) setWorking(false)
    }
  }
  async function remove() {
    if (!client || working) return
    setWorking(true)
    setSheetError('')
    try {
      await client.delete(`/api/sessions/${encodeURIComponent(id)}`)
      if (mounted.current) {
        setPanel(null)
        goBack()
      }
    } catch (e) {
      if (mounted.current) setSheetError(errorText(e))
    } finally {
      if (mounted.current) setWorking(false)
    }
  }
  async function fork(item: ChatItem) {
    const targetMessageId = persistedMessageId(item)
    if (!client || !targetMessageId || working || menuBusy) return
    setMenuBusy('fork')
    try {
      const result = await client.post<{ sessionId: string }>(
        `/api/sessions/${encodeURIComponent(id)}/branch`,
        { targetMessageId }
      )
      if (mounted.current) {
        setSelected(null)
        router.push({ pathname: '/chat/[id]', params: { id: result.sessionId, host: hostId } })
      }
    } catch (e) {
      if (mounted.current) {
        setSelected(null)
        setError(errorText(e))
      }
    } finally {
      if (mounted.current) setMenuBusy(null)
    }
  }
  async function previewEdit(item: ChatItem) {
    const targetUserMessageId = persistedMessageId(item)
    if (!client || !targetUserMessageId || busy || working || menuBusy) return
    setMenuBusy('edit')
    try {
      const preview = await client.post<RewindPreview>(
        `/api/sessions/${encodeURIComponent(id)}/rewind`,
        { targetUserMessageId, dryRun: true, mode: 'conversation' }
      )
      if (mounted.current) {
        setRewindPreview(preview)
        setEditText(visibleMessageText(item.editableText ?? item.text))
        openPanel('edit')
      }
    } catch (e) {
      if (mounted.current) {
        setSelected(null)
        setError(errorText(e))
      }
    } finally {
      if (mounted.current) setMenuBusy(null)
    }
  }
  async function resendEdit() {
    if (!client || !rewindPreview || !editText.trim() || busy || working) return
    setWorking(true)
    setSheetError('')
    try {
      await client.post(`/api/sessions/${encodeURIComponent(id)}/rewind`, {
        targetUserMessageId: rewindPreview.target.targetUserMessageId,
        mode: 'conversation',
      })
      if (!mounted.current) return
      // A new controller must hydrate the truncated transcript before this intentional resend.
      handoff.current = {
        task: { content: editText.trim(), attachments: [] },
        phase: 'initial',
        ...(draft.trim() || attachments.length || references.length ? { restore: { text: draft, attachments, references } } : {}),
      }
      setReferences([])
      setDraft(editText.trim())
      setAttachments([])
      drafts.set(draftKey, editText.trim())
      setPanel(null)
      reloadSession()
      setNotice('Conversation rewound; resyncing and sending the edited message.')
    } catch (e) {
      if (mounted.current) setSheetError(errorText(e))
    } finally {
      if (mounted.current) setWorking(false)
    }
  }
  /** After the transcript is rewritten elsewhere (rewind), drop local state, reconnect and reread history. */
  const reloadSession = useCallback(() => {
    sessionHistory.forget(hostId, id)
    setState(createChatState(id))
    setUi({ expanded: new Set(), open: new Set(), closed: new Set(), revealed: new Set() })
    setConnection('connecting')
    connectionRef.current = 'connecting'
    clockRef.current = undefined
    setTurnClock({})
    setCheckpoints([])
    setRevision((value) => value + 1)
  }, [hostId, id])
  useFocusEffect(
    useCallback(() => {
      if (!takeSessionStale(hostId, id)) return
      reloadSession()
      setNotice('Rewound; rereading this session.')
    }, [hostId, id, reloadSession])
  )
  function copy(text: string) {
    void Clipboard.setStringAsync(text)
      .then((ok) => {
        if (!ok) throw new Error('Copying is not allowed by the system; use Select text to select it manually.')
        if (mounted.current) showNotice('Copied.', true)
      })
      .catch((e) => {
        if (mounted.current) setError(errorText(e))
      })
  }

  // Message stream: consecutive tool calls are merged into a group; expansion state stays on the page so it survives list row recycling.
  // Tool steps inside a subagent are only shown on its own page, not mixed into the main conversation.
  const rows = useMemo(
    () =>
      visibleChatRows(
        buildChatRows(
          state.items.filter((item) => !item.parentToolUseId),
          state.turnActive,
          { clock: turnClock }
        ),
        ui.open
      ),
    [state.items, state.turnActive, turnClock, ui.open]
  )
  // The inverted list starts from the newest row.
  const latestFirst = useMemo(() => [...rows].reverse(), [rows])
  const waitingKey = state.permissions.map((request) => request.toolUseId ?? '').join('\n')
  const runningBackgroundKey = backgroundCount
    ? backgroundTasks
        .filter((task) => task.status === 'running' && task.toolUseId)
        .map((task) => task.toolUseId)
        .join('\n')
    : ''
  const stepContext = useMemo<StepContext>(
    () => ({
      workDir: session?.workDir,
      waiting: new Set(waitingKey.split('\n').filter(Boolean)),
      background: new Set(runningBackgroundKey.split('\n').filter(Boolean)),
      activeThinkingId: state.activeThinkingId,
      turnActive: state.turnActive,
    }),
    [session?.workDir, waitingKey, runningBackgroundKey, state.activeThinkingId, state.turnActive]
  )
  const toggleStep = useCallback(
    (key: string) => setUi((value) => ({ ...value, expanded: toggle(value.expanded, key) })),
    []
  )
  const toggleOpen = useCallback(
    (key: string, live = false) => setUi((value) => toggleGroupOpen(value, key, live)),
    []
  )
  const reveal = useCallback(
    (key: string) => setUi((value) => ({ ...value, revealed: toggle(value.revealed, key) })),
    []
  )
  const longPress = useCallback((item: ChatItem, layout: BubbleLayout) => setSelected({ item, layout }), [])
  const renderRow = useCallback(
    ({ item: row }: { item: ChatRow }) =>
      row.kind === 'message' ? (
        <Message item={row.item} onLongPress={longPress} />
      ) : row.kind === 'turn' ? (
        <TurnFold label={row.label} images={row.images} open={ui.open.has(row.key)} onToggle={() => toggleOpen(row.key)} />
      ) : (
        <StepGroup
          row={row}
          context={stepContext}
          ui={ui}
          onToggleStep={toggleStep}
          onToggleOpen={toggleOpen}
          onReveal={reveal}
        />
      ),
    [longPress, stepContext, ui, toggleStep, toggleOpen, reveal]
  )

  // Turn ended: not running, and the last message is not from the user (in a long turn the user message may be on an earlier page).
  const turnSettled = !busy && hasItems && state.items.at(-1)?.type !== 'user'
  const meta = turnSettled
    ? turnMeta({ items: state.items, checkpoint: latest, local: turnClock, modelId: runtime?.modelId })
    : ''

  // Connection problems are explained only here with a retry; the nav bar subtitle only shows the status.
  // Brief disconnects like returning to foreground or switching networks usually recover on their own; only warn if not recovered after a while.
  const reconnect = () => transport.current?.reconnect()
  const connectionProblem: {
    tone: 'attention' | 'error'
    text: string
    action: 'retry' | 'hosts'
  } | null = connectionError
    ? { tone: 'error', text: connectionError, action: 'hosts' }
    : connection === 'pairing_required'
      ? {
          tone: 'error',
          text: recoveryError || 'Pairing with this computer has expired; pair again to continue.',
          action: 'hosts',
        }
      : !connectionNotice.banner && connection !== 'ready'
        ? null
      : showsReconnectBanner(connection)
        ? {
            tone: 'attention',
            text: recoveryError || 'Disconnected from the computer, reconnecting automatically.',
            action: 'retry',
          }
        : recoveryError
          ? { tone: 'error', text: recoveryError, action: 'retry' }
          : null
  const noticeArea = [
    connectionProblem ? (
      <Callout key="connection" tone={connectionProblem.tone}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Text
            selectable
            style={{
              flex: 1,
              fontSize: 13,
              lineHeight: 19,
              color: connectionProblem.tone === 'error' ? colors.err : colors.attnInk,
            }}
          >
            {connectionProblem.text}
          </Text>
          <Button
            title={connectionProblem.action === 'hosts' ? (isH5 ? 'Reconnect' : 'Manage computers') : 'Retry'}
            size="sm"
            variant="outline"
            pill
            onPress={() => {
              if (connectionProblem.action !== 'hosts') reconnect()
              else if (isH5) reconnectH5(host?.auth === 'remote')
              else router.push('/hosts')
            }}
          />
        </View>
      </Callout>
    ) : null,
    workspaceMissing ? (
      <Callout key="workspace" tone="error">
        This session’s working directory is no longer available. Restore the directory on the computer to continue.
      </Callout>
    ) : null,
    error ? <InlineError key="error" text={error} /> : null,
    notice ? (
      <Callout key="notice" tone="info">
        {notice}
      </Callout>
    ) : null,
    state.configPending ? (
      <Callout key="config" tone="info">
        Waiting for the computer to confirm the new run configuration…
      </Callout>
    ) : null,
    teamPlan.plan && teamSurface ? (
      <TeamPlanCard
        key={`team:${teamPlan.plan.planId}`}
        plan={teamPlan.plan}
        surface={teamSurface}
        team={teamPlan}
        ready={ready}
        onOpen={() => setTeamSheet({ planId: teamPlan.plan?.planId, open: true })}
      />
    ) : null,
  ].filter(Boolean)
  const runStartedAt = state.turnActive
    ? turnClock.live
      ? turnClock.startedAt
      : (serverTurnStart ?? turnClock.startedAt)
    : undefined
  const approvalToolUseId = approval?.toolUseId
  const captionStep = useMemo(
    () =>
      pendingStepLabel(state.items, approvalToolUseId, session?.workDir) ??
      currentStepLabel(state.items, session?.workDir),
    [state.items, approvalToolUseId, session?.workDir]
  )
  const outputTokens = useMemo(() => turnOutputTokens({ items: state.items }).tokens, [state.items])
  // The "…" menu header and the context sheet share one usage figure: prefer the live context reported by the computer, otherwise approximate with this turn's usage.
  const insight = useContextInspection({
    client,
    sessionId: id,
    active: panel === 'menu' || panel === 'context',
    refreshKey: state.usage,
  })
  const usageSummary = contextSummary({
    snapshot: insight.snapshot,
    usage: state.usage,
    window: contextWindow(runtime?.modelId, knownModel?.context),
  })
  // The single run hint above the input; turns amber on the same line while waiting for approval.
  const caption = busy ? (
    <StatusCaption
      step={captionStep}
      waiting={waitingForDecision}
      compacting={state.status === 'compacting'}
      startedAt={runStartedAt}
      tokens={outputTokens}
    />
  ) : undefined
  const queued = queue.length ? (
    <QueuedMessages
      items={queue}
      paused={queuePaused}
      onWithdraw={(itemId) => withdrawQueued([itemId])}
      onSendNow={sendQueuedNow}
      onGuide={guideQueued}
      guiding={state.turnActive}
      guideDisabled={
        !ready ||
        queueGate.pendingUser ||
        waitingForDecision ||
        state.configPending ||
        workspaceMissing ||
        queueGate.deliveryUncertain
      }
    />
  ) : null
  const above =
    noticeArea.length || queued ? (
      <>
        {noticeArea}
        {queued}
      </>
    ) : undefined
  const sheetNow = useNow(panel === 'activity' && state.turnActive)
  const elapsed = runStartedAt && state.turnActive ? elapsedLabel(runStartedAt, sheetNow) : undefined

  // The menu anchors to the bottom edge of the nav bar (kit Menu does not cover the status bar on Android).
  const menuTop = (simulatedPhoneChrome ? 54 : insets.top) + 46
  const changedCount = latest?.code.filesChanged.length ?? 0
  const menuItems: ActionMenuItem[] = [
    {
      key: 'rename',
      label: 'Rename',
      icon: 'pencil',
      onPress: () => {
        setTitleDraft(title === 'Session' ? '' : title)
        openPanel('rename')
      },
    },
    {
      key: 'copy-id',
      label: 'Copy session ID',
      icon: 'copy',
      onPress: () => {
        setPanel(null)
        copy(id)
      },
    },
    { key: 'sync', label: 'Resync', icon: 'refresh-cw', onPress: reconnect },
    {
      key: 'delete',
      label: 'Delete session…',
      icon: 'trash',
      destructive: true,
      onPress: () => openPanel('delete'),
    },
    'separator',
    {
      key: 'changes',
      label: 'Changes',
      icon: 'git-branch',
      count: changedCount || undefined,
      onPress: () => openFiles('changed'),
    },
    { key: 'files', label: 'Files', icon: 'folder', onPress: () => openFiles('all') },
    {
      key: 'activity',
      label: 'Running',
      icon: 'activity',
      count: activity.runningCount || undefined,
      onPress: () => openPanel('activity'),
    },
  ]

  const messageActions = (item: ChatItem): MessageAction[] => {
    const persisted = persistedMessageId(item)
    const text = visibleMessageText(item.text)
    const actions: MessageAction[] = [
      { key: 'copy', label: 'Copy', icon: 'copy', disabled: !text },
      { key: 'select', label: 'Select text', icon: 'text-cursor', disabled: !text },
    ]
    if (item.type === 'user')
      actions.push({
        key: 'edit',
        group: true,
        label: 'Edit and resend',
        icon: 'pencil',
        detail: busy
          ? 'Available after this turn ends'
          : !persisted
            ? 'Available once the computer saves this message'
            : item.editableText === undefined
              ? 'For messages with materials, copy the text and re-add the materials'
              : 'Rewind to this message; files on the computer are untouched',
        disabled: busy || working || !persisted || item.editableText === undefined || menuBusy === 'fork',
        busy: menuBusy === 'edit',
      })
    actions.push({
      key: 'fork',
      group: item.type !== 'user',
      label: 'Fork from here',
      icon: 'git-fork',
      detail: lean
        ? 'The light tier does not support forking'
        : !persisted
          ? 'Available once the computer saves this message'
          : 'Keep up to this message and start a new session',
      disabled: lean || !persisted || working || menuBusy === 'edit',
      busy: menuBusy === 'fork',
    })
    return actions
  }
  function runMessageAction(key: MessageAction['key']) {
    const item = selected?.item
    if (!item) return
    const text = visibleMessageText(item.text)
    if (key === 'copy') {
      setSelected(null)
      copy(text)
    } else if (key === 'select') {
      setSelectText(text)
      openPanel('select')
    } else if (key === 'edit') void previewEdit(item)
    else void fork(item)
  }

  const modeUnavailable = busy
    ? 'Can switch only after this turn ends.'
    : state.configPending
      ? 'Waiting for the computer to confirm the previous change.'
      : !ready
        ? 'Can switch only after connecting to the computer.'
        : undefined

  return (
    <ToolImageLoaderContext.Provider value={toolImages}>
    <ScreenView>
      <NavBar
        floating
        back
        title={title}
        subtitle={connectionNotice.label ? connectionLabels[connection] : sessionSubtitle(session, branch) || host?.name}
        right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ActivityCapsule
              progress={activity.progress}
              runningCount={activity.runningCount}
              tone={activity.tone}
              active={activity.active}
              visible={activity.capsuleVisible}
              launching={teamLaunching !== undefined}
              onPress={() => openPanel('activity')}
            />
            <FloatingButton
              icon="more"
              label="Session actions"
              active={panel === 'menu'}
              onPress={() => openPanel('menu')}
            />
          </View>
        }
      />
      <Toast text={teamToast} top={menuTop + 8} />
      <KeyboardViewport style={{ flex: 1 }}>
        <View style={{ flex: 1 }}>
          <FlatList
            ref={list}
            inverted
            // Android's native clipping can detach transformed cells during
            // entry/layout and only reattach them on scroll. A two-message
            // conversation must show its first message without that gesture.
            // Keep FlatList virtualization, without the extra native clipping.
            removeClippedSubviews={false}
            data={latestFirst}
            extraData={ui}
            keyExtractor={(row) => row.key}
            renderItem={renderRow}
            style={{ flex: 1 }}
            // When inverted, paddingTop is at the bottom of the screen and paddingBottom at the top.
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingTop: 16,
              paddingBottom: 12,
              gap: 16,
              flexGrow: 1,
              // Inversion flips the main axis: put spare space below the
              // oldest message on screen, keeping short conversations at top.
              justifyContent: 'flex-end',
              width: '100%',
              maxWidth: 800,
              alignSelf: 'center',
            }}
            keyboardShouldPersistTaps="handled"
            // while scrolled up reading, the newest message still growing (streaming, collapsing after the turn) does not move the content being read; 
            // the anchor skips the changing newest row (the list header is counted separately by VirtualizedList). Not enabled when at the newest, 
            // new content naturally sticks to the bottom.
            maintainVisibleContentPosition={atLatest ? undefined : { minIndexForVisible: 1 }}
            onLayout={({ nativeEvent }) => {
              listSize.current.viewport = nativeEvent.layout.height
              maybeLoadOlder()
            }}
            onScrollBeginDrag={() => {
              autoBatches.current = 0
            }}
            onScroll={({ nativeEvent }) => trackScroll(nativeEvent)}
            // Scroll events are throttled; a fast fling to the top may miss the final position, so check once more using the final position when it stops.
            onScrollEndDrag={({ nativeEvent }) => trackScroll(nativeEvent)}
            onMomentumScrollEnd={({ nativeEvent }) => trackScroll(nativeEvent)}
            scrollEventThrottle={100}
            onContentSizeChange={(_, height) => {
              listSize.current.content = height
              maybeLoadOlder()
            }}
            // The tail of the inverted list is at the top of the screen. Header and footer are always mounted and only hidden when empty, so indices used for position keeping stay stable.
            ListFooterComponentStyle={hasOlder ? undefined : { display: 'none' }}
            ListFooterComponent={
              <OlderHistoryStatus
                loading={loadingOlder}
                failed={olderFailed}
                ready={ready}
                onLoad={retryOlder}
              />
            }
            ListEmptyComponent={
              ready ? (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 8 }}>
                  <Text style={{ fontSize: 16, lineHeight: 22, fontWeight: '600', color: colors.ink, textAlign: 'center' }}>
                    Start here
                  </Text>
                  <Text style={{ fontSize: 14, lineHeight: 21, color: colors.ink3, textAlign: 'center' }}>
                    {`Describe what you want to do; the task runs on ${host?.name ?? 'computer'} . You can change the model and permission mode below.`}
                  </Text>
                </View>
              ) : connectionProblem ? undefined : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                  <Spinner size={20} />
                </View>
              )
            }
            // The header is at the bottom of the screen next to the newest message: computer-use confirmation, this turn's changes and duration.
            ListHeaderComponentStyle={
              state.computerUsePermissions.length || (turnSettled && (latest || meta)) ? undefined : { display: 'none' }
            }
            ListHeaderComponent={
              <View style={{ gap: 14 }}>
                {state.computerUsePermissions.map((request) => (
                  <Card key={request.requestId}>
                    <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ink }}>
                      Computer use must be confirmed on the computer
                    </Text>
                    {request.request.reason ? (
                      <Text style={{ fontSize: 14, lineHeight: 20, color: colors.ink2 }}>
                        {request.request.reason}
                      </Text>
                    ) : null}
                    <Callout>Finish global enabling and system permission grants in the computer settings.</Callout>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <Button
                        title="Refresh authorization status"
                        variant="secondary"
                        style={{ flex: 1 }}
                        onPress={reconnect}
                      />
                      <Button
                        title="Deny this request"
                        variant="danger"
                        disabled={!ready}
                        style={{ flex: 1 }}
                        onPress={() =>
                          send({
                            type: 'computer_use_permission_response',
                            requestId: request.requestId,
                            response: {
                              granted: [],
                              denied: request.request.apps.map((app) => ({
                                bundleId: app.resolved?.bundleId ?? app.requestedName,
                                reason: 'user_denied',
                              })),
                              flags: {
                                clipboardRead: false,
                                clipboardWrite: false,
                                systemKeyCombos: false,
                              },
                              userConsented: false,
                            },
                          })
                          }
                        />
                      </View>
                    </Card>
                  ))}
                  {turnSettled ? (
                    <SessionChangesCard
                      checkpoint={latest}
                      onOpen={() => openFiles('changed')}
                      onUndo={() => openRoute('/changes')}
                    />
                  ) : null}
                  {meta ? <Mono style={{ fontSize: 12, color: colors.ink3 }}>{meta}</Mono> : null}
                </View>
            }
          />
          {awayFromLatest ? (
            <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: 12, alignItems: 'center' }}>
              <FloatingButton icon="arrow-down" label="Back to latest" onPress={jumpToLatest} />
            </View>
          ) : null}
        </View>
        {approval ? (
          <>
            {above || caption ? (
              <View style={{ paddingHorizontal: 12, paddingTop: 10, gap: 8 }}>
                {above}
                {caption}
              </View>
            ) : null}
            <Approval
              key={approval.requestId}
              request={approval}
              client={client}
              runtime={runtime}
              ready={ready}
              send={send}
              serverError={state.error}
              position={{ index: 1, total: state.permissions.length }}
              onStop={() => openPanel('stop')}
              workDir={session?.workDir ?? undefined}
            />
          </>
        ) : (
          <ChatComposer
            client={client}
            sessionId={id}
            workDir={session?.workDir ?? undefined}
            runtime={runtime}
            references={references}
            onReferences={setReferences}
            draft={draft}
            onDraft={(value) => {
              setDraft(value)
              drafts.set(draftKey, value)
            }}
            attachments={attachments}
            onAttachments={(value) => {
              // Materials changed, so earlier material errors are stale.
              setAttachments(value)
              setError('')
            }}
            team={team}
            onTeam={setTeam}
            computer={computer}
            lean={lean}
            empty={!hasItems}
            busy={busy}
            background={teamWorking}
            queueing={busy}
            disabled={!ready || state.configPending || workspaceMissing || working}
            run={runCapsule({
              mode: permissionMode,
              model: runtime ? modelLabel : undefined,
              effort: runtime?.effortLevel,
              disabled: !ready || state.configPending || workspaceMissing,
              locked: busy,
            })}
            onOpenRun={() => openPanel('run')}
            onSend={submit}
            onStop={() => openPanel('stop')}
            onError={setError}
            above={above}
            caption={caption}
          />
        )}
      </KeyboardViewport>
      {teamPlan.plan && teamSurface === 'review' ? (
        <TeamPlanSheet
          key={teamPlan.plan.planId}
          visible={teamSheetOpen}
          onClose={() => setTeamSheet((value) => ({ ...value, open: false }))}
          plan={teamPlan.plan}
          team={teamPlan}
          client={client}
          ready={ready}
          leaderRuntime={runtime ? teamRuntime(runtime) : undefined}
        />
      ) : null}
      <ActionMenu
        visible={panel === 'menu'}
        onClose={() => setPanel(null)}
        anchor={{ top: menuTop, right: 16 }}
        items={menuItems}
        header={
          <>
            <Mono numberOfLines={1} ellipsizeMode="middle" style={{ fontSize: 12.5, color: colors.ink3 }}>
              {[displayPath(session?.workDir) || 'Default directory', branch].filter(Boolean).join(' · ')}
            </Mono>
            {linkPath ? (
              <Text style={{ fontSize: 12, color: colors.ink3 }}>
                {`Connection: ${linkPathLabels[linkPath]}`}
              </Text>
            ) : null}
            <ContextMenuHeader
              modelLabel={runtime ? modelLabel : undefined}
              summary={usageSummary}
              onPress={() => openPanel('context')}
            />
          </>
        }
      />
      <ContextSheet
        visible={panel === 'context'}
        onClose={closePanel}
        summary={usageSummary}
        modelLabel={runtime ? modelLabel : undefined}
        usage={state.usage}
        snapshot={insight.snapshot}
        stats={insight.stats}
        loading={insight.loading}
        failed={insight.failed}
        onRetry={insight.reload}
      />
      <ActivitySheet
        visible={panel === 'activity'}
        onClose={() => setPanel(null)}
        activity={activity}
        elapsed={elapsed}
        host={{ id: hostId }}
        sessionId={id}
        onOpenAgent={(task) => {
          setPanel(null)
          router.push({
            pathname: '/subagent',
            params: { host: hostId, id, taskId: task.taskId, toolUseId: task.toolUseId ?? '' },
          })
        }}
        onStopTurn={() => {
          // Same as "stop this session": once stopped there is no auto follow-up; queued content returns to the input for the user to decide whether to send.
          if (state.turnActive && dispatch({ type: 'stop_generation' })) withdrawQueued()
        }}
        launching={teamLaunching}
        onOpenMember={(_team, member) => {
          setPanel(null)
          router.push({ pathname: '/member', params: { host: hostId, id, agent: member.id } })
        }}
      />
      <MessageMenu
        item={selected?.item ?? null}
        layout={selected?.layout ?? null}
        actions={selected ? messageActions(selected.item) : []}
        onAction={runMessageAction}
        onClose={() => {
          if (!menuBusy) setSelected(null)
        }}
      />
      <RenameSheet
        visible={panel === 'rename'}
        onClose={closePanel}
        value={titleDraft}
        onChange={setTitleDraft}
        busy={working}
        error={sheetError}
        onSave={() => void rename()}
      />
      <ConfirmSheet
        visible={panel === 'delete'}
        onClose={closePanel}
        title="Delete this session?"
        message="This deletes the session saved on the computer and stops its tasks."
        confirmLabel="Delete"
        destructive
        busy={working}
        disabled={!client}
        error={sheetError}
        onConfirm={() => void remove()}
      />
      <ConfirmSheet
        visible={panel === 'stop'}
        onClose={closePanel}
        title={teamWorking ? 'Stop the team?' : 'Stop this session?'}
        message={
          teamWorking
            ? 'Members stop at their current step and files already changed are kept. Send a message later and the team continues from here.'
            : 'The current generation and background tasks stop; files already changed are kept.'
        }
        confirmLabel="Stop"
        destructive
        disabled={!ready}
        error={sheetError || (!ready ? 'Can stop only after connecting to the computer.' : '')}
        onConfirm={() => {
          if (dispatch({ type: 'stop_generation' }, setSheetError)) {
            setPanel(null)
            // Once stopped there is no auto follow-up: queued content returns to the input for the user to decide whether to send.
            withdrawQueued()
          }
        }}
      />
      <RunSheet
        visible={panel === 'run'}
        onClose={closePanel}
        client={client}
        mode={permissionMode as PermissionMode | undefined}
        onMode={(mode: PermissionMode) => {
          dispatch({ type: 'set_permission_mode', mode }, setSheetError)
        }}
        runtime={runtime}
        onRuntime={(value, model) => {
          if (dispatch({ type: 'set_runtime_config', ...value }, setSheetError))
            setChosenModel(
              nextChosenModel({ picked: model, appliedModelId: value.modelId, currentModelId: runtime?.modelId, chosen: chosenModel })
            )
        }}
        lean={lean}
        disabled={{
          ...(modeUnavailable ? { mode: modeUnavailable } : {}),
          ...(busy || state.configPending || !ready
            ? { runtime: modeUnavailable ?? 'Can switch only after this turn ends.' }
            : {}),
        }}
        warning={
          backgroundCount
            ? `Changing models restarts the runtime; the ${backgroundCount} running background tasks will stop.`
            : undefined
        }
        error={sheetError}
        workDir={session?.workDir ?? undefined}
      />
      <SelectTextSheet
        visible={panel === 'select'}
        onClose={closePanel}
        text={selectText}
        onCopy={() => {
          setPanel(null)
          copy(selectText)
        }}
      />
      <EditResendSheet
        visible={panel === 'edit' && !!rewindPreview}
        onClose={closePanel}
        value={editText}
        onChange={setEditText}
        removed={rewindPreview?.conversation.messagesRemoved ?? 0}
        busy={working}
        disabled={busy}
        disabledReason={busy ? 'Can rewind only after this turn ends.' : undefined}
        error={sheetError}
        onConfirm={() => void resendEdit()}
      />
    </ScreenView>
    </ToolImageLoaderContext.Provider>
  )
}
