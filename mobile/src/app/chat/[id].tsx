import { serializeComposer, type ComposerReference } from '../../core/composerReferences'
import { KeyboardViewport } from '../../ui/KeyboardViewport'
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { AppState, FlatList, Platform, View, type NativeScrollEvent } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import { Text } from '../../ui/Text'
import { useApp, useConnection } from '../../state/AppContext'
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
import { shouldReconnectOnResume } from '../../core/resume'
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
import { ChatComposer } from '../../ui/ChatComposer'
import { Message, type BubbleLayout } from '../../ui/Message'
import { type Model } from '../../ui/RuntimePicker'
import { RunSheet } from '../../ui/compose/RunSheet'
import { nextChosenModel, runCapsule } from '../../ui/compose/runLogic'
import { useComputerUse } from '../../core/useComputerUse'
import { useSessionActivity } from '../../core/sessionActivity'
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
  goBack,
  useColors,
  type ActionMenuItem,
} from '../../ui/kit'
import { errorText } from '../../ui/theme'
import { buildChatRows, visibleChatRows, type ChatRow } from '../../ui/chat/steps'
import { StepGroup, TurnFold, type StepContext, type StepUi } from '../../ui/chat/StepGroup'
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
  contextWindow,
  displayPath,
  latestTurnCheckpoint,
  nextTurnStart,
  sessionSubtitle,
  turnMeta,
} from '../../ui/chat/session'

const NativeSocket = WebSocket as unknown as new (
  url: string,
  protocols?: string[],
  options?: { headers?: Record<string, string> }
) => SocketLike
type Panel = 'menu' | 'rename' | 'delete' | 'run' | 'stop' | 'select' | 'edit' | 'activity' | 'context' | null
type RewindPreview = {
  target: { targetUserMessageId: string }
  conversation: { messagesRemoved: number }
}
/** 离最新处（倒置列表的起点）不到这么远就算停在最新处。 */
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
    host: string
    notificationAction?: string
    requestId?: string
  }>()
  return (
    <ChatSession
      key={`${host}:${id}`}
      id={id}
      hostId={host}
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
  const { drafts } = useApp()
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const draftKey = `${hostId}:${id}`
  const [initialTask] = useState(() => peekPendingTask(hostId, id))
  const handoff = useRef<{
    task: typeof initialTask
    phase: 'initial' | 'config' | 'done' | 'failed'
    /** 编辑重发前输入框里没发出的内容，发送成功后还回去。 */
    restore?: { text: string; attachments: ComposerAttachment[]; references?: ComposerReference[] }
  }>({
    task: initialTask,
    phase: 'initial',
  })
  // 新任务移交的内容可能带团队标记：输入框只显示用户的话，团队开关替代标记。
  const [initialDraft] = useState(() => (initialTask ? pendingTaskDraft(initialTask) : null))
  const [draft, setDraft] = useState(initialDraft?.text ?? drafts.get(draftKey) ?? '')
  // 上次离开时排队消息里的材料和团队开关（文字已经在草稿里）。
  const [parked] = useState(() => (initialTask ? undefined : parkedComposer(draftKey)))
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(
    initialTask?.attachments ?? parked?.attachments ?? []
  )
  const [references, setReferences] = useState<ComposerReference[]>(initialTask?.references ?? parked?.references ?? [])
  const [team, setTeam] = useState(initialDraft?.team ?? parked?.team ?? false)
  // 运行中追加的消息先在手机上排队，这一轮结束后按顺序发出。
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  const queueSeq = useRef(0)
  const leaving = useRef<ComposerQueueState>({ queue, draft, attachments, team, references })
  const focused = useRef(false)
  // 在模型弹层里选过的模型：用它的显示名和上下文大小，其余时候只有模型 id。
  const [chosenModel, setChosenModel] = useState<Model | null>(null)
  const [state, setState] = useState<ChatState>(() => createChatState(id))
  const [connection, setConnection] = useState<ConnectionState>('connecting')
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
  // 停在最新处附近：这时不开「保持阅读位置」，新内容由倒置列表自然贴底。
  const [atLatest, setAtLatest] = useState(true)
  const [branch, setBranch] = useState<string | null>(null)
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([])
  const [ui, setUi] = useState<StepUi>(() => ({ expanded: new Set(), open: new Set(), revealed: new Set() }))
  const [turnClock, setTurnClock] = useState<{ startedAt?: number; endedAt?: number; live?: boolean }>({})
  // 进页面时已经在跑的一轮，用电脑给的开始时间，和首页一致。
  const { snapshot: dashboard } = useDashboard()
  const liveActivity =
    dashboard?.hostId === hostId ? dashboard.activity.find((item) => item.id === id) : undefined
  const serverTurnStart =
    liveActivity && ['running', 'waiting'].includes(liveActivity.activityState)
      ? liveActivity.startedAt
      : undefined
  const clockRef = useRef<{ active: boolean; startedAt?: number; live: boolean } | undefined>(undefined)
  const connectionRef = useRef<ConnectionState>('connecting')
  const transport = useRef<SessionTransport | null>(null)
  // 消息流是倒置列表：offset 0 就是最新处。打开会话、键盘弹起、输入框变高、流式输出变长时
  // 由原生保持在底部，不需要 JS 算位置补滚动（那样会和原生尺寸变化赛跑，滚不到底）。
  const list = useRef<FlatList<ChatRow>>(null)
  // 离最新处的距离，以及列表可视高度和内容高度：决定什么时候提前往前翻。
  const scrollMetrics = useRef({ offset: 0 })
  const listSize = useRef({ viewport: 0, content: 0 })
  const olderInFlight = useRef(false)
  const olderFailedRef = useRef(false)
  // 一次拖动里连续自动翻了几批，见 shouldPrefetchOlder。
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
    if (!client || !credential) return
    let alive = true
    /** 本轮起止时间只在收到状态时记录：亲眼看到开始用本地时间，否则用消息时间。 */
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
      // 本页亲眼看到这一轮开始（连着线、从空闲变成运行）时本地时间最准；
      // 进页面时已经在跑的一轮才借用电脑给的开始时间。
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
    const channel = new SessionTransport({
      client,
      credential,
      sessionId: id,
      platform: Platform.OS === 'web' ? 'web' : 'native',
      history: sessionHistory.store(hostId, id),
      socketFactory: (options) =>
        Platform.OS === 'web'
          ? (new WebSocket(options.url) as unknown as SocketLike)
          : new NativeSocket(options.url, undefined, { headers: options.headers }),
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
          // 重新连上后，之前因为断线没翻成的可以再自动翻。
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
      if (value !== 'active') {
        hiddenAt ??= Date.now()
        return
      }
      if (
        shouldReconnectOnResume({
          connection: connectionRef.current,
          hiddenAt,
          now: Date.now(),
        })
      )
        channel.reconnect()
      hiddenAt = undefined
    })
    return () => {
      alive = false
      recovery.dispose()
      listener.remove()
      channel.dispose()
      if (transport.current === channel) transport.current = null
    }
  }, [client, credential, hostId, id, revision])

  const ready = connection === 'ready'
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
  // 这一轮结束后按顺序发出排队的消息。发送失败（断线、电脑还没确认上一条）时
  // 保持排队，条件变化后再试；传输层本身也会拒绝在上一条未确认时再发。
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
    // 先同步 ref 和内存草稿，停止后紧接着离开也不会丢稿或重复归还附件。
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
        // push 工作区等页面时聊天仍挂载；失焦即停止自动续发并退回输入框。
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
  /** 立即把排队消息插进正在运行的一轮；这一轮刚好结束时退回普通发送。 */
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
    showNotice('现在还不能引导，等上一条确认或当前决定处理完再试。', true)
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
  const modelLabel = runtime ? knownModel?.name || runtime.modelId : '选择模型'
  const permissionMode = state.permissionMode ?? session?.permissionMode
  const backgroundCount = state.backgroundTaskIds.length
  const title = state.title || session?.title || '会话'
  const computer = useComputerUse(client)
  const sendRaw = useCallback((message: ClientMessage) => transport.current?.send(message) ?? false, [])
  useEffect(() => registerSessionSender(id, sendRaw), [id, sendRaw])
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
  })

  // 分支只用于副标题与菜单；取不到就只显示项目名。
  useEffect(() => {
    if (!client || !ready) return
    const controller = new AbortController()
    client
      .get<{ branch: string | null }>(`${sessionPath(id)}/git-info`, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setBranch(value.branch ?? null)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [client, id, ready])

  // 本轮改动卡和菜单里的文件数都来自最新一轮检查点；运行中不读。
  const hasItems = state.items.length > 0
  useEffect(() => {
    if (!client || !ready || state.turnActive || !hasItems) return
    const controller = new AbortController()
    listCheckpoints(client, id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setCheckpoints(value.checkpoints)
      })
      .catch(() => {
        if (!controller.signal.aborted) setCheckpoints([])
      })
    return () => controller.abort()
  }, [client, id, ready, state.turnActive, hasItems, revision])
  const latest = useMemo(() => latestTurnCheckpoint(checkpoints), [checkpoints])

  // 后台任务列表只用来把“后台进行中”对到具体的子 Agent 步骤上。
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
      setNotice('首条任务留在输入框里了，确认会话状态后再发送。')
      return
    }
    try {
      const desired = value.task.runtime
      if (desired && !runtimeMatches(state.runtime, desired)) {
        if (value.phase === 'config') {
          value.phase = 'failed'
          setError('电脑没有换成所选模型，首条任务留在输入框里了。')
          return
        }
        value.phase = 'config'
        if (!transport.current?.send({ type: 'set_runtime_config', ...desired })) {
          value.phase = 'failed'
          setError('模型还没准备好，首条任务留在输入框里了。')
        }
        return
      }
      const message = buildComposerMessage(value.task.content, value.task.attachments, false)
      validateMessageSize(message, host?.auth ?? 'lan')
      value.phase = 'done'
      if (transport.current?.send(message)) {
        clearPendingTask(hostId, id)
        // 团队只对首条生效；编辑重发时把之前没发出的输入框内容还回去。
        setTeam(false)
        const restore = value.restore
        setDraft(restore?.text ?? '')
        setReferences(restore?.references ?? [])
        setAttachments(restore?.attachments ?? [])
        if (restore?.text) drafts.set(draftKey, restore.text)
        else drafts.delete(draftKey)
      } else {
        value.phase = 'failed'
        setError('首条任务没发出去，确认连接后手动发送。')
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
      setNotice('这条审批已经处理过，或者需要在会话里作答，请核对当前状态。')
      return
    }
    if (transport.current?.send(response))
      setNotice(
        notificationAction === 'allow'
          ? '已提交这一次允许，等电脑确认。'
          : '已提交这一次拒绝，等电脑确认。'
      )
    else setError('通知里的操作没发出去，请在当前审批里重试。')
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

  /** 发出一条指令；失败原因写到调用处给的位置，同一个错误只显示一次。 */
  function dispatch(message: ClientMessage, report: (message: string) => void = setError) {
    report('')
    try {
      const sent = transport.current?.send(message) ?? false
      if (!sent) report('操作还没发出。等会话同步完成，或核对当前任务状态。')
      return sent
    } catch (e) {
      report(errorText(e))
      return false
    }
  }
  const send = (message: ClientMessage) => dispatch(message)
  /** 往前翻一批（两页）；in-flight 只认 ref，避免重复请求。更早的内容接在倒置列表末尾（画面顶部），阅读位置不动。 */
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
        // 整批都并进了已有的折叠行时内容高度不变，不会再有布局回调，这里补一次判断。
        requestAnimationFrame(() => {
          if (mounted.current) maybeLoadOlder()
        })
      })
  }
  /** 滑近顶部（已加载的最早内容）时提前往前翻。只读 ref 和传输层，加载结束的回调里调用也不会读到旧状态。 */
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
  /** 回到最新处（倒置列表的起点）：发消息、点「回到最新」时用。 */
  function showLatest(animated = true) {
    list.current?.scrollToOffset({ offset: 0, animated })
  }
  function jumpToLatest() {
    setAwayFromLatest(false)
    showLatest()
  }
  // 列表往往在连上电脑之前就量好了尺寸；连上之后没有新的布局或滚动事件，要补一次判断，
  // 否则不满一屏的会话会停在「加载更早的消息」上不动。
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
  /** iOS 不能在一个弹层收起的同时弹出另一个，先收起再打开。 */
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

  function submit() {
    if (workspaceMissing) return
    try {
      const message = buildComposerMessage(serializeComposer(draft, references), attachments, team)
      validateMessageSize(message, host?.auth ?? 'lan')
      if (busy) {
        if (approval) return
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
        return
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
      }
    } catch (e) {
      setError(errorText(e))
    }
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
      setNotice('已回退对话，正在重新同步并发送修改后的消息。')
    } catch (e) {
      if (mounted.current) setSheetError(errorText(e))
    } finally {
      if (mounted.current) setWorking(false)
    }
  }
  /** 会话记录在别处被改写（回退）后，丢掉本地状态、重新连接并读取历史。 */
  const reloadSession = useCallback(() => {
    sessionHistory.forget(hostId, id)
    setState(createChatState(id))
    setUi({ expanded: new Set(), open: new Set(), revealed: new Set() })
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
      setNotice('已回退，正在重新读取这段会话。')
    }, [hostId, id, reloadSession])
  )
  function copy(text: string) {
    void Clipboard.setStringAsync(text)
      .then((ok) => {
        if (!ok) throw new Error('系统没有允许复制，请用“选择文字”手动选取。')
        if (mounted.current) showNotice('已复制。', true)
      })
      .catch((e) => {
        if (mounted.current) setError(errorText(e))
      })
  }

  // 消息流：连续工具调用合成一组；展开状态留在页面里，列表回收行时不丢。
  // 子 Agent 内部的工具步骤只在它自己的页面里看，不混进主对话。
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
  // 倒置列表从最新的一行排起。
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
    (key: string) => setUi((value) => ({ ...value, open: toggle(value.open, key) })),
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
        <TurnFold label={row.label} open={ui.open.has(row.key)} onToggle={() => toggleOpen(row.key)} />
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

  // 一轮结束：不在运行、最后一条不是用户消息（长的一轮里用户消息可能还在更早的分页里）。
  const turnSettled = !busy && hasItems && state.items.at(-1)?.type !== 'user'
  const meta = turnSettled
    ? turnMeta({ items: state.items, checkpoint: latest, local: turnClock, modelId: runtime?.modelId })
    : ''

  // 连接问题只在这一处说明并给出重试；导航栏副标题只显示状态。
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
          text: recoveryError || '这台电脑的配对已经失效，重新配对后才能继续。',
          action: 'hosts',
        }
      : connection === 'reconnecting' || connection === 'offline'
        ? {
            tone: 'attention',
            text: recoveryError || '和电脑的连接断开了，正在自动重连。',
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
            title={connectionProblem.action === 'hosts' ? '管理电脑' : '重试'}
            size="sm"
            variant="outline"
            pill
            onPress={() => {
              if (connectionProblem.action === 'hosts') router.push('/hosts')
              else reconnect()
            }}
          />
        </View>
      </Callout>
    ) : null,
    workspaceMissing ? (
      <Callout key="workspace" tone="error">
        这段会话的工作目录已经不可用。请在电脑上恢复目录后继续。
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
        正在等电脑确认新的运行配置…
      </Callout>
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
  // 「…」菜单头部和上下文底单共用一份占用：优先用电脑上报的实时上下文，读不到再用本轮用量近似。
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
  // 输入框上方唯一的运行提示；等批准时同一行变琥珀。
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

  // 菜单锚在导航栏下沿（kit 的 Menu 在 Android 上不覆盖状态栏）。
  const menuTop = (Platform.OS === 'web' ? 54 : insets.top) + 46
  const changedCount = latest?.code.filesChanged.length ?? 0
  const menuItems: ActionMenuItem[] = [
    {
      key: 'rename',
      label: '重命名',
      icon: 'pencil',
      onPress: () => {
        setTitleDraft(title === '会话' ? '' : title)
        openPanel('rename')
      },
    },
    {
      key: 'copy-id',
      label: '复制会话 ID',
      icon: 'copy',
      onPress: () => {
        setPanel(null)
        copy(id)
      },
    },
    { key: 'sync', label: '重新同步', icon: 'refresh-cw', onPress: reconnect },
    {
      key: 'delete',
      label: '删除会话…',
      icon: 'trash',
      destructive: true,
      onPress: () => openPanel('delete'),
    },
    'separator',
    {
      key: 'changes',
      label: '更改',
      icon: 'git-branch',
      count: changedCount || undefined,
      onPress: () => openFiles('changed'),
    },
    { key: 'files', label: '文件', icon: 'folder', onPress: () => openFiles('all') },
    {
      key: 'activity',
      label: '运行中',
      icon: 'activity',
      count: activity.runningCount || undefined,
      onPress: () => openPanel('activity'),
    },
  ]

  const messageActions = (item: ChatItem): MessageAction[] => {
    const persisted = persistedMessageId(item)
    const text = visibleMessageText(item.text)
    const actions: MessageAction[] = [
      { key: 'copy', label: '复制', icon: 'copy', disabled: !text },
      { key: 'select', label: '选择文字', icon: 'text-cursor', disabled: !text },
    ]
    if (item.type === 'user')
      actions.push({
        key: 'edit',
        group: true,
        label: '编辑后重新发送',
        icon: 'pencil',
        detail: busy
          ? '这一轮结束后才能用'
          : !persisted
            ? '等电脑保存这条消息后可用'
            : item.editableText === undefined
              ? '带材料的消息请复制文字后重新添加材料'
              : '回退到这条消息，电脑上的文件不动',
        disabled: busy || working || !persisted || item.editableText === undefined || menuBusy === 'fork',
        busy: menuBusy === 'edit',
      })
    actions.push({
      key: 'fork',
      group: item.type !== 'user',
      label: '从这里分叉',
      icon: 'git-fork',
      detail: lean
        ? '轻量档位不支持分叉'
        : !persisted
          ? '等电脑保存这条消息后可用'
          : '保留到这条，另开一段新会话',
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
    ? '这一轮结束后才能切换。'
    : state.configPending
      ? '正在等电脑确认上一次修改。'
      : !ready
        ? '连上电脑后才能切换。'
        : undefined

  return (
    <ScreenView>
      <NavBar
        floating
        back
        title={title}
        subtitle={ready ? sessionSubtitle(session, branch) || host?.name : connectionLabels[connection]}
        right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ActivityCapsule
              progress={activity.progress}
              runningCount={activity.runningCount}
              tone={activity.tone}
              active={activity.active}
              visible={activity.capsuleVisible}
              onPress={() => openPanel('activity')}
            />
            <FloatingButton
              icon="more"
              label="会话操作"
              active={panel === 'menu'}
              onPress={() => openPanel('menu')}
            />
          </View>
        }
      />
      <KeyboardViewport style={{ flex: 1 }}>
        <View style={{ flex: 1 }}>
          <FlatList
            ref={list}
            inverted
            data={latestFirst}
            extraData={ui}
            keyExtractor={(row) => row.key}
            renderItem={renderRow}
            style={{ flex: 1 }}
            // 倒置后 paddingTop 在画面底部、paddingBottom 在画面顶部。
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
            // 往上翻着看时，最新那条还在变长（流式输出、一轮结束后折叠）也不挪动正在看的内容；
            // 锚点跳过正在变化的最新一行（列表头部由 VirtualizedList 单独计入）。停在最新处时不开，
            // 新内容自然贴底。
            maintainVisibleContentPosition={atLatest ? undefined : { minIndexForVisible: 1 }}
            onLayout={({ nativeEvent }) => {
              listSize.current.viewport = nativeEvent.layout.height
              maybeLoadOlder()
            }}
            onScrollBeginDrag={() => {
              autoBatches.current = 0
            }}
            onScroll={({ nativeEvent }) => trackScroll(nativeEvent)}
            // 滚动事件有节流，一次快速甩到顶时最后的位置可能收不到；停下时再按最终位置判断一次。
            onScrollEndDrag={({ nativeEvent }) => trackScroll(nativeEvent)}
            onMomentumScrollEnd={({ nativeEvent }) => trackScroll(nativeEvent)}
            scrollEventThrottle={100}
            onContentSizeChange={(_, height) => {
              listSize.current.content = height
              maybeLoadOlder()
            }}
            // 倒置列表的尾部在画面顶部。头尾始终挂着、没内容时只隐藏，保持位置用的下标才不会变。
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
                    从这里开始
                  </Text>
                  <Text style={{ fontSize: 14, lineHeight: 21, color: colors.ink3, textAlign: 'center' }}>
                    {`说说你想做什么，任务会在 ${host?.name ?? '电脑'} 上执行。下面可以换模型和权限模式。`}
                  </Text>
                </View>
              ) : connectionProblem ? undefined : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                  <Spinner size={20} />
                </View>
              )
            }
            // 头部在画面底部，紧挨着最新一条：操作电脑的确认、本轮改动和用时。
            ListHeaderComponentStyle={
              state.computerUsePermissions.length || (turnSettled && (latest || meta)) ? undefined : { display: 'none' }
            }
            ListHeaderComponent={
              <View style={{ gap: 14 }}>
                {state.computerUsePermissions.map((request) => (
                  <Card key={request.requestId}>
                    <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ink }}>
                      操作电脑需要在电脑上确认
                    </Text>
                    {request.request.reason ? (
                      <Text style={{ fontSize: 14, lineHeight: 20, color: colors.ink2 }}>
                        {request.request.reason}
                      </Text>
                    ) : null}
                    <Callout>请在电脑设置里完成全局启用和系统权限授权。</Callout>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <Button
                        title="刷新授权状态"
                        variant="secondary"
                        style={{ flex: 1 }}
                        onPress={reconnect}
                      />
                      <Button
                        title="拒绝本次请求"
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
              <FloatingButton icon="arrow-down" label="回到最新" onPress={jumpToLatest} />
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
              // 换了材料，之前关于材料的错误就过时了。
              setAttachments(value)
              setError('')
            }}
            team={team}
            onTeam={setTeam}
            computer={computer}
            lean={lean}
            empty={!hasItems}
            busy={busy}
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
      <ActionMenu
        visible={panel === 'menu'}
        onClose={() => setPanel(null)}
        anchor={{ top: menuTop, right: 16 }}
        items={menuItems}
        header={
          <>
            <Mono numberOfLines={1} ellipsizeMode="middle" style={{ fontSize: 12.5, color: colors.ink3 }}>
              {[displayPath(session?.workDir) || '默认目录', branch].filter(Boolean).join(' · ')}
            </Mono>
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
          // 和「停止这段会话」一样：停下来就不再自动追加，排队的内容回到输入框由用户决定要不要发。
          if (state.turnActive && dispatch({ type: 'stop_generation' })) withdrawQueued()
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
        title="删除这段会话？"
        message="这会删除电脑上保存的这段会话，并停止它的任务。"
        confirmLabel="删除"
        destructive
        busy={working}
        disabled={!client}
        error={sheetError}
        onConfirm={() => void remove()}
      />
      <ConfirmSheet
        visible={panel === 'stop'}
        onClose={closePanel}
        title="停止这段会话？"
        message="当前生成和后台任务都会停下，已经改好的文件会保留。"
        confirmLabel="停止"
        destructive
        disabled={!ready}
        error={sheetError || (!ready ? '连上电脑后才能停止。' : '')}
        onConfirm={() => {
          if (dispatch({ type: 'stop_generation' }, setSheetError)) {
            setPanel(null)
            // 停下来就不再自动追加：排队的内容回到输入框，由用户决定要不要发。
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
            ? { runtime: modeUnavailable ?? '这一轮结束后才能切换。' }
            : {}),
        }}
        warning={
          backgroundCount
            ? `换模型会重启执行环境，正在跑的 ${backgroundCount} 项后台任务会停下。`
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
        disabledReason={busy ? '这一轮结束后才能回退。' : undefined}
        error={sheetError}
        onConfirm={() => void resendEdit()}
      />
    </ScreenView>
  )
}
