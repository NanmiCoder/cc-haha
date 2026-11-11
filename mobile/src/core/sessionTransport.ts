import { ApiError, type ApiClient } from './client'
import { buildSocketOptions } from './connection'
import { resumeAction } from './resume'
import {
  CommandOutbox,
  MAX_COMMAND_RESENDS,
  readStreamFrame,
  STREAM_ACK_EVERY,
  streamSocketUrl,
  type StreamAttached,
} from './resumableStream'
import {
  appendFollowPage,
  appendPendingUserMessage,
  chatReducer,
  createChatState,
  mergeHistoryPages,
  normalizeHistory,
  parseServerEvent,
  stitchLatestPage,
} from './chat'
import type {
  ChatItem,
  ChatState,
  ClientMessage,
  HistoryPage,
  ServerEvent,
} from './types'

export type ConnectionState =
  | 'connecting'
  | 'syncing'
  | 'ready'
  /** 断线后带着已看到的帧号接回原来的流，不读历史。 */
  | 'resuming'
  | 'reconnecting'
  | 'offline'
  | 'pairing_required'
/** 翻更早历史的结果：界面据此区分加载成功、到底、正在翻和暂时不可用。 */
export type LoadOlderResult = 'loaded' | 'busy' | 'unavailable' | 'end'
export type SocketLike = {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason?: string }) => void) | null
  onerror: (() => void) | null
}
export type SocketFactory = (options: {
  url: string
  headers?: Record<string, string>
}) => SocketLike
export type TransportTimers = {
  set(callback: () => void, delay: number): unknown
  clear(handle: unknown): void
}
/** 这段会话上次读到的历史（含往前翻过的页）。进页面先显示它，再和电脑对齐。 */
export type HistoryStore = {
  read(): HistoryPage | undefined
  write(page: HistoryPage): void
}
export type SessionTransportOptions = {
  client: Pick<ApiClient, 'host' | 'history' | 'verify'>
  credential: string
  sessionId: string
  platform: 'native' | 'web'
  socketFactory: SocketFactory
  onState(state: ChatState): void
  onConnection(state: ConnectionState): void
  onError(error: Error): void
  timers?: TransportTimers
  history?: HistoryStore
  /** 和 `resume(hiddenAt)` 用同一个时钟；默认 Date.now。 */
  clock?: () => number
  /** 连接没就绪时占住，让不急的请求先让路（见 foregroundGate）。 */
  gate?: { hold(): () => void }
  /** 提供时启用可续传的流（见 resumableStream.ts）；每条新流调用一次。 */
  newStreamId?: () => string
}
/** 最新一页和已加载的历史之间隔着几页以内时补齐，超过就只留最新一页。 */
const BRIDGE_PAGES = 3
/**
 * 同步阶段往回补页的总时长。补不上就先用最新一页进入就绪，更早的内容翻页时再取；
 * 否则一页大的历史就能把 20 秒的同步时限耗光，变成反复重连。
 */
const SYNC_BRIDGE_BUDGET_MS = 8000
/** 按游标记住的旧页：对账重试、重新同步时不再重复下载同一页。 */
const OLDER_PAGE_MEMO = 16
/** 从末尾往后读新增记录最多读几页；还没读到尾就改读最新一页。 */
const FOLLOW_PAGES = 3
/** 新连接从创建到握手完成的时限（经公网隧道要过 TLS 和升级）。 */
const SOCKET_OPEN_TIMEOUT_MS = 12000
/** 握手完成后和电脑对齐（快照 + 历史）的时限。 */
const SYNC_TIMEOUT_MS = 15000
const HEARTBEAT_MS = 15000
/** 心跳计时器晚到这么多，说明进程被挂起过（iOS 后台），没等到 pong 不能算连接已死。 */
const HEARTBEAT_LATE_MS = 5000
/** 回到前台时的探活时限：这段时间内等到这次探活的 pong，原连接就继续用。 */
export const RESUME_PROBE_TIMEOUT_MS = 2500
/** 换路时新连接从创建到被电脑接上的时限；到点没接上就继续用旧连接。 */
const MIGRATION_TIMEOUT_MS = SOCKET_OPEN_TIMEOUT_MS
/** 两次鉴权探测的最短间隔：连着断几次时，不在慢隧道上反复问。 */
const AUTH_PROBE_INTERVAL_MS = 30_000
/** 电脑用它关掉被同一条流的新连接顶替的旧连接（见 resumableStreams.ts）。 */
const STREAM_SUPERSEDED = 4000

const defaultTimers: TransportTimers = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}
const startsTurn = (event: ServerEvent) =>
  [
    'content_start',
    'content_delta',
    'thinking',
    'user_message_replay',
    'permission_request',
    'computer_use_permission_request',
  ].includes(event.type) ||
  (event.type === 'status' && event.state !== 'idle') ||
  (event.type === 'session_state' && event.turnState === 'running') ||
  (event.type === 'permission_requests_snapshot' && event.turnActive)

/** A host-bound controller. It never retries a user command after a disconnect. */
export class SessionTransport {
  state: ChatState
  historyPage?: HistoryPage
  connection: ConnectionState = 'offline'
  #options: SessionTransportOptions
  #timers: TransportTimers
  #socket?: SocketLike
  #started = false
  #disposed = false
  #pairingRequired = false
  #generation = 0
  #turnEpoch = 0
  #historyEpoch = 0
  #retries = 0
  #historyReady = false
  #connectedSeen = false
  #sessionSnapshotSeen = false
  #permissionSnapshotSeen = false
  #buffer: ServerEvent[] = []
  #pendingConfig?: Extract<
    ClientMessage,
    { type: 'set_runtime_config' | 'set_permission_mode' }
  >
  #pendingBaseIds = new Set<string>()
  #turnBaseItems = new Map<string, ChatItem>()
  #preSubscribeHistory?: HistoryPage
  /** 订阅前那次读取已经接在已加载的历史后面（往后读），不用再拼接。 */
  #preSubscribeJoined = false
  #hydrating = false
  #priorLiveIds = new Set<string>()
  #initialOverlapItems?: ChatItem[]
  #awaitingPong = false
  #paginationPending = false
  #attemptStartedAt?: number
  #authProbing = false
  #releaseGate?: () => void
  /** 当前的续传流。epoch 是电脑接上它时给的；synced 表示它已和电脑对齐过，可以续。 */
  #stream?: {
    id: string
    epoch?: string
    synced: boolean
    lastSeq: number
    ackedSeq: number
    /** 续传接上后，补发到这一帧为止；之后才重发还没执行的命令。 */
    replayUntil?: number
  }
  #streamsUnsupported = false
  #outbox = new CommandOutbox()
  /** 这次建连是接回原来的流。 */
  #resuming = false
  /** 这个套接字请求了续传，还没收到 stream_attached。 */
  #awaitingAttach = false
  /** 正在换到更好的路上：新连接还没被电脑接上，旧连接照常收发。ack 是新连接请求续传时带的帧号。 */
  #migration?: { socket: SocketLike; ack: number; timer?: unknown }
  /** 更好的路在没就绪时出现：就绪时用的若还是之前建的连接，就再换一次。 */
  #migrateWanted = false
  /** 下一次对齐整页重读最新历史，不沿已加载的末尾往后读（用户点了「重新同步」）。 */
  #fullResync = false
  #syncEpoch = 0
  #failures = 0
  /** 这条连接上发出、还没等到 pong 的 ping。pong 按顺序回来。 */
  #pingsInFlight = 0
  /** 回前台探活还要等几个 pong：轮到它自己那一个才算数。 */
  #probePongs = 0
  #authProbedAt?: number
  #reconnectTimer?: unknown
  #probeTimer?: unknown
  #heartbeatTimer?: unknown
  #syncTimer?: unknown
  #refreshTimer?: unknown
  #configTimer?: unknown
  #requests = new Set<AbortController>()
  #olderPages = new Map<string, HistoryPage>()

  constructor(options: SessionTransportOptions) {
    this.#options = { ...options }
    this.#timers = options.timers ?? defaultTimers
    this.state = createChatState(options.sessionId)
    if (options.newStreamId) this.#stream = this.#freshStream()
  }

  start() {
    if (this.#started || this.#disposed) return
    this.#started = true
    const cached = this.#options.history?.read()
    if (cached) {
      this.historyPage = cached
      this.#publish({ ...this.state, items: normalizeHistory(cached.messages) })
    }
    this.#connect(false)
  }

  /** 完成真正对齐（读过历史）的次数；续传、换路接回不算。依赖会话内容的周边数据据此重读。 */
  get syncEpoch() {
    return this.#syncEpoch
  }

  /** 连着失败的建连次数，就绪后清零。从就绪掉线本身不算。 */
  get failures() {
    return this.#failures
  }

  dispose() {
    if (this.#disposed) return
    // 离开会话：告诉电脑不用再为这条流保留，会话连接照常结束。
    this.#endStream()
    this.#disposed = true
    this.#generation++
    this.#cleanup()
    this.connection = 'offline'
    this.#holdGate(false)
  }

  /**
   * 用户点「重试」「重新同步」：换一条新流、整页重读最新历史，不续传——用户要的是和电脑
   * 重新对齐，续传只会补发帧、不读历史。回到前台请用 `resume`。
   */
  reconnect() {
    if (!this.#started || this.#disposed || this.#pairingRequired) return
    this.#endStream()
    if (this.#stream) {
      this.#stream = this.#freshStream()
      this.#outbox.clear()
    }
    this.#fullResync = true
    this.#connect(true)
  }

  /**
   * 回到前台或网络变化时调用。连接看起来还开着就先探活，不拆掉还能用的连接；
   * 正在建连的不打断；在等退避的立即重试。`hiddenAt` 是切到后台的时刻（同一时钟）。
   */
  resume(hiddenAt?: number) {
    if (!this.#started || this.#disposed || this.#pairingRequired) return
    const action = resumeAction({
      connection: this.connection,
      socketOpen: this.#socket?.readyState === 1,
      backoffPending: this.#reconnectTimer !== undefined,
      attemptStartedAt: this.#attemptStartedAt,
      hiddenAt,
      now: this.#now(),
    })
    if (action === 'probe') this.#probe()
    else if (action !== 'none') this.#connect(true)
  }

  /**
   * 有了更好的路（直连打通了）：带着已看到的帧号在新路上接回同一条流，不读历史、不重开会话。
   * 先建后断：新连接被电脑接上之前，旧连接照常收发；新路失败就继续用旧的。
   * 还没就绪时先记下，就绪后若用的还是之前建的连接再换（之后新建的连接本来就走新路）。
   */
  migrate() {
    if (!this.#started || this.#disposed || this.#pairingRequired || this.#streamsUnsupported) return
    if (!this.#beginMigration()) this.#migrateWanted = true
  }

  /** PATCH rename does not broadcast an event; apply its confirmed result to the live state. */
  confirmTitle(title: string) {
    if (this.#disposed || !title.trim()) return
    this.#publish({ ...this.state, title: title.trim() })
  }

  send(message: ClientMessage): boolean {
    if (
      this.#disposed ||
      this.connection !== 'ready' ||
      this.#socket?.readyState !== 1 ||
      this.#replaying()
    )
      return false
    const pending =
      this.state.permissions.length > 0 ||
      this.state.computerUsePermissions.length > 0 ||
      this.state.items.some((item) => item.type === 'user' && item.pending)
    if (
      message.type === 'set_runtime_config' &&
      (this.state.turnActive || pending || this.state.configPending)
    )
      return false
    if (message.type === 'set_permission_mode' && this.state.configPending)
      return false
    if (
      message.type === 'user_message' &&
      (this.state.turnActive ||
        pending ||
        this.state.configPending ||
        (!message.content.trim() && !message.attachments?.length))
    )
      return false
    if (
      message.type === 'permission_response' &&
      !this.state.permissions.some((p) => p.requestId === message.requestId)
    )
      return false
    if (
      message.type === 'computer_use_permission_response' &&
      !this.state.computerUsePermissions.some(
        (p) => p.requestId === message.requestId
      )
    )
      return false
    if (
      message.type === 'ask_user_question_activity' &&
      !this.state.permissions.some(
        (p) =>
          p.requestId === message.requestId && p.toolName === 'AskUserQuestion'
      )
    )
      return false
    const encoded = this.#encode(message)
    try {
      this.#socket.send(encoded.text)
      if (
        message.type === 'set_runtime_config' ||
        message.type === 'set_permission_mode'
      ) {
        this.#pendingConfig = message
        this.#publish({ ...this.state, configPending: true })
        this.#configTimer = this.#timers.set(() => {
          this.#pendingConfig = undefined
          const error = new ApiError(
            '电脑尚未确认配置，请重新选择后重试',
            0,
            'CONFIG_TIMEOUT'
          )
          this.#publish({
            ...this.state,
            configPending: false,
            error: { message: error.message, code: error.code! },
          })
          this.#options.onError(error)
        }, 10000)
      }
      if (message.type === 'user_message') {
        this.#captureTurnBaseline()
        this.#initialOverlapItems = undefined
        this.#pendingBaseIds = new Set(this.state.items.map((item) => item.id))
        this.#turnEpoch++
        this.#publish({
          ...appendPendingUserMessage(
            this.state,
            message.content,
            message.attachments
          ),
          status: 'thinking',
          turnActive: true,
        })
      }
      return true
    } catch {
      this.#unsent(encoded)
      return false
    }
  }

  /**
   * 把一条消息立即送进正在运行的一轮（桌面端的「引导」）。
   * 和 `send` 不同，这里允许 turnActive；但模型被决定卡住、配置还没确认、
   * 上一条用户消息还没被电脑确认，或连接没就绪时不发。最后一条很关键：
   * 服务端收到新消息会替换当前 activeTurn，若上一条还在写 SDK 之前，
   * 它会被静默丢掉，客户端却只看到一条已发送的乐观消息。
   */
  steer(message: ClientMessage): boolean {
    if (message.type !== 'user_message') return false
    if (
      this.#disposed ||
      this.connection !== 'ready' ||
      this.#socket?.readyState !== 1 ||
      this.#replaying()
    )
      return false
    const waitingForDecision =
      this.state.permissions.length > 0 ||
      this.state.computerUsePermissions.length > 0
    const pendingUser = this.state.items.some(
      (item) => item.type === 'user' && item.pending
    )
    if (
      !this.state.turnActive ||
      pendingUser ||
      waitingForDecision ||
      this.state.configPending ||
      (!message.content.trim() && !message.attachments?.length)
    )
      return false
    const encoded = this.#encode(message)
    try {
      this.#socket.send(encoded.text)
      // 先显示在消息流里；服务端回放同一段文字时会按 pending 匹配并确认，
      // 不会出现两条一样的消息。
      this.#publish(
        appendPendingUserMessage(
          this.state,
          message.content,
          message.attachments
        )
      )
      return true
    } catch {
      this.#unsent(encoded)
      return false
    }
  }

  /**
   * 往更早翻历史。默认一次翻一页；`pages` 可以在一轮里连续翻多页，
   * 让「加载更早的消息」一次给出更多内容。
   * 返回结果让界面能区分「真的加载了」「没连上」「已经在翻」「到底了」，
   * 不会出现点了没反应又没有任何提示的情况。
   */
  async loadOlder(pages = 1): Promise<LoadOlderResult> {
    if (this.#disposed || !this.#historyReady) return 'unavailable'
    if (this.#paginationPending) return 'busy'
    let current = this.historyPage
    let cursor: string | null = current?.page?.nextCursor ?? null
    if (!current || !cursor) return 'end'
    this.#paginationPending = true
    const generation = this.#generation
    const historyEpoch = this.#historyEpoch
    const controller = this.#requestController()
    const limit = Math.max(1, Math.min(10, Math.trunc(pages) || 1))
    let loaded = false
    try {
      for (let page = 0; page < limit; page++) {
        if (!cursor) break
        const older = await this.#options.client.history(
          this.#options.sessionId,
          cursor,
          { signal: controller.signal }
        )
        if (!this.#valid(generation) || historyEpoch !== this.#historyEpoch)
          return loaded ? 'loaded' : 'unavailable'
        if (older.page?.nextCursor === cursor)
          throw new ApiError(
            '历史分页没有推进，请重新加载',
            409,
            'HISTORY_PAGE_STALE'
          )
        const merged = mergeHistoryPages(current, older)
        this.#setHistory(merged)
        this.#publish({
          ...this.state,
          items: [
            ...normalizeHistory(merged.messages),
            ...this.state.items.filter((item) => item.id.startsWith('live:')),
          ],
        })
        current = merged
        cursor = merged.page?.nextCursor ?? null
        loaded = true
      }
      return loaded ? 'loaded' : 'end'
    } catch (error) {
      if (!this.#valid(generation) || controller.signal.aborted)
        return loaded ? 'loaded' : 'unavailable'
      if (this.#isUnauthorized(error)) {
        this.#requirePairing()
        return loaded ? 'loaded' : 'unavailable'
      }
      if (
        (error instanceof ApiError &&
          (error.code === 'HISTORY_PAGE_STALE' ||
            error.code === 'HISTORY_CHANGED')) ||
        (error instanceof Error && error.message === 'HISTORY_PAGE_STALE')
      ) {
        this.#options.onError(
          new ApiError(
            '会话历史已更新，正在重新加载',
            409,
            'HISTORY_PAGE_STALE'
          )
        )
        await this.#reloadHistory(generation)
        // 已经用最新一页恢复，不再让界面提示“没连上”。
        return 'loaded'
      } else this.#report(error)
      return loaded ? 'loaded' : 'unavailable'
    } finally {
      this.#requests.delete(controller)
      this.#paginationPending = false
    }
  }

  #connect(reconnecting: boolean) {
    this.#generation++
    const generation = this.#generation
    this.#cleanup()
    this.#attemptStartedAt = this.#now()
    // 已和电脑对齐过的流：带着看到的帧号直接接回去，不读历史、不重开会话。
    this.#resuming =
      !this.#streamsUnsupported && !!this.#stream?.epoch && this.#stream.synced
    if (this.#resuming) {
      this.#publish({ ...this.state, connected: false })
      this.#setConnection('resuming')
      this.#openSocket(generation)
      return
    }
    // 没对齐完就断了的流续不上：换一条新流，从头对齐。
    if (this.#stream && (this.#stream.epoch || this.#stream.lastSeq)) {
      this.#stream = this.#freshStream()
      this.#outbox.clear()
    }
    this.#historyReady = false
    this.#connectedSeen = false
    this.#sessionSnapshotSeen = false
    this.#permissionSnapshotSeen = false
    this.#buffer = []
    this.#publish({ ...this.state, connected: false })
    this.#setConnection(reconnecting ? 'reconnecting' : 'connecting')
    void this.#preflight(generation)
  }

  async #preflight(generation: number) {
    const controller = this.#requestController()
    try {
      // A completed read before subscription is the only trustworthy old-record boundary.
      // 已加载过的历史只往后读新增的部分，不在慢隧道上整页重下；用户要求重新同步时整页读。
      const loaded = this.#fullResync ? undefined : this.historyPage
      const followed = loaded?.page?.tailCursor
        ? await this.#followFrom(loaded, controller.signal)
        : undefined
      if (!this.#valid(generation)) return
      const history =
        followed ??
        (await this.#options.client.history(
          this.#options.sessionId,
          undefined,
          { signal: controller.signal }
        ))
      if (!this.#valid(generation)) return
      this.#fullResync = false
      this.#preSubscribeHistory = history
      this.#preSubscribeJoined = followed !== undefined
      this.#openSocket(generation)
    } catch (error) {
      if (!this.#valid(generation) || controller.signal.aborted) return
      if (this.#isUnauthorized(error)) this.#requirePairing()
      else {
        this.#report(error)
        this.#disconnect()
      }
    } finally {
      this.#requests.delete(controller)
    }
  }

  #openSocket(generation: number) {
    try {
      const stream = this.#streamsUnsupported ? undefined : this.#stream
      this.#awaitingAttach = !!stream
      const socket = this.#createSocket(
        stream && {
          id: stream.id,
          ...(this.#resuming && stream.epoch
            ? { resume: { epoch: stream.epoch, ack: stream.lastSeq } }
            : {}),
        }
      )
      this.#socket = socket
      // 这条连接现在才建，走的就是眼下最好的路：之前记下的换路请求不用再做。
      this.#migrateWanted = false
      this.#bind(socket, generation)
      this.#syncTimer = this.#timers.set(() => {
        if (!this.#valid(generation) || this.connection === 'ready') return
        this.#options.onError(new ApiError('连接电脑超时', 0, 'TIMEOUT'))
        this.#disconnect()
      }, SOCKET_OPEN_TIMEOUT_MS)
    } catch (error) {
      this.#report(error)
      this.#setConnection('offline')
    }
  }

  #createSocket(stream?: { id: string; resume?: { epoch: string; ack: number } }) {
    const options = buildSocketOptions(
      this.#options.client.host,
      this.#options.credential,
      this.#options.sessionId,
      this.#options.platform
    )
    return this.#options.socketFactory(
      stream ? { ...options, url: streamSocketUrl(options.url, stream) } : options
    )
  }

  /** 把一条连接设为会话正在用的那条。 */
  #bind(socket: SocketLike, generation: number) {
    socket.onopen = () => {
      if (!this.#valid(generation)) return
      this.#timers.clear(this.#syncTimer)
      this.#syncTimer = this.#timers.set(() => {
        if (!this.#valid(generation) || this.connection === 'ready') return
        this.#options.onError(new ApiError('会话同步超时', 0, 'SYNC_TIMEOUT'))
        this.#disconnect()
      }, SYNC_TIMEOUT_MS)
      // 接回原来的流：等电脑答复能不能续，再决定要不要重新对齐。补发迟迟收不完也由上面的时限兜底。
      if (this.#resuming) return
      this.#setConnection('syncing')
      try {
        socket.send(JSON.stringify({ type: 'sync_state' }))
      } catch {
        this.#disconnect()
        return
      }
      this.#heartbeat(generation)
      // The stream is already subscribed before taking its HTTP baseline.
      void this.#initialHistory(generation)
    }
    socket.onmessage = ({ data }) => this.#receive(generation, data)
    socket.onclose = ({ code }) => {
      if (!this.#valid(generation)) return
      // 换路时电脑把流交给了新连接，用 4000 关掉旧的：等新连接答复，不当断线。
      if (code === STREAM_SUPERSEDED && this.#migration) return
      this.#disconnect()
      // Older gateways also use 1008 for restarts and rate limits. Only an
      // authenticated HTTP rejection can establish that pairing was revoked.
      if (code === 1006 || code === 1008) void this.#probeAuthorization()
    }
    socket.onerror = () => {
      if (this.#valid(generation)) {
        this.#disconnect()
        void this.#probeAuthorization()
      }
    }
  }

  #receive(generation: number, data: unknown) {
    if (!this.#valid(generation)) return
    // 任何一帧都说明连接还活着：大消息在慢网上排在 pong 前面时，不能算心跳超时。
    // 回前台的探活不在此列，它只认自己的 pong（见 #probe）。
    this.#awaitingPong = false
    const frame = readStreamFrame(data)
    if (!frame) return
    if (frame.kind === 'attached') {
      this.#attached(generation, frame.frame)
      return
    }
    if (frame.kind === 'command_ack') {
      this.#outbox.acknowledge(frame.cseq)
      return
    }
    if (this.#awaitingAttach) {
      // 电脑没有先答复续传：它还不支持，这条连接照旧用。
      this.#awaitingAttach = false
      this.#streamsUnsupported = true
      if (this.#resuming) {
        this.#resuming = false
        this.#disconnect(true)
        return
      }
    }
    const stream = this.#streamActive() ? this.#stream : undefined
    if (stream && frame.seq !== undefined) {
      // 换路或补发时同一帧可能到两次。
      if (frame.seq <= stream.lastSeq) return
      stream.lastSeq = frame.seq
      if (!this.#migration && stream.lastSeq - stream.ackedSeq >= STREAM_ACK_EVERY)
        this.#acknowledgeFrames()
    }
    const event = parseServerEvent(frame.value)
    if (event?.type === 'pong') {
      this.#pong(generation)
      return
    }
    if (event && (event.type !== 'connected' || event.sessionId === this.#options.sessionId)) {
      if (event.type === 'connected') this.#connectedSeen = true
      if (event.type === 'session_state') this.#sessionSnapshotSeen = true
      if (event.type === 'permission_requests_snapshot')
        this.#permissionSnapshotSeen = true
      if (!this.#historyReady) this.#buffer.push(event)
      else this.#applyEvent(event)
      this.#maybeReady()
    }
    // 认不出的帧也占一个帧号：补发是否收完按帧号算，不能因为它卡住。
    this.#finishReplay()
  }

  async #initialHistory(generation: number) {
    const controller = this.#requestController()
    try {
      // 订阅之后再往后读一次，补上订阅前那次读取和订阅之间落盘的记录。
      const pre = this.#preSubscribeHistory
      const followed = pre?.page?.tailCursor
        ? await this.#followFrom(pre, controller.signal)
        : undefined
      if (!this.#valid(generation)) return
      const history =
        followed && this.#preSubscribeJoined
          ? followed
          : await this.#joinLatest(
              followed ??
                (await this.#options.client.history(
                  this.#options.sessionId,
                  undefined,
                  { signal: controller.signal }
                )),
              controller.signal,
              SYNC_BRIDGE_BUDGET_MS
            )
      if (!this.#valid(generation)) return
      this.#setHistory(history)
      this.#historyEpoch++
      const items = normalizeHistory(history.messages)
      this.#hydrating = true
      this.#captureTurnBaseline()
      // Keep uncertain local sends/partial output visible until server persistence catches up.
      const unfinished = this.state.items.filter(
        (item) =>
          item.pending &&
          item.id.startsWith('live:') &&
          !items.some(
            (saved) =>
              equivalent(saved, item) &&
              (item.type !== 'user' || !this.#pendingBaseIds.has(saved.id))
          )
      )
      this.#publish({
        ...this.state,
        items: [...items, ...unfinished],
        activeTextId: undefined,
        activeThinkingId: undefined,
        activeToolId: undefined,
      })
      this.#historyReady = true
      const buffer = this.#buffer
      this.#buffer = []
      this.#initialOverlapItems = buffer.some(
        (event) => event.type === 'user_message_replay'
      )
        ? items
        : undefined
      for (const event of buffer) this.#applyEvent(event)
      this.#hydrating = false
      this.#collapseInitialOverlap()
      this.#maybeReady()
      if (
        !this.state.turnActive &&
        this.state.items.some(
          (item) => item.id.startsWith('live:') && item.type !== 'error'
        )
      )
        this.#scheduleReconcile()
    } catch (error) {
      if (!this.#valid(generation) || controller.signal.aborted) return
      if (this.#isUnauthorized(error)) this.#requirePairing()
      else {
        this.#report(error)
        this.#disconnect()
      }
    } finally {
      this.#requests.delete(controller)
    }
  }

  #applyEvent(event: ServerEvent) {
    if (startsTurn(event) && !this.state.turnActive) {
      this.#turnEpoch++
      this.#captureTurnBaseline()
    }
    const pending = this.#pendingConfig
    const runtimeAck =
      pending?.type === 'set_runtime_config' &&
      event.type === 'runtime_config_applied' &&
      (!event.requestedConfig ||
        (event.requestedConfig.modelId === pending.modelId &&
          event.requestedConfig.providerId === pending.providerId))
    const modeAck =
      pending?.type === 'set_permission_mode' &&
      event.type === 'permission_mode_changed' &&
      event.mode === pending.mode
    if (runtimeAck || modeAck || event.type === 'error')
      this.#clearConfigPending()
    this.#publish(chatReducer(this.state, event))
    this.#collapseInitialOverlap()
    if (event.type === 'message_complete') this.#scheduleReconcile()
  }

  #maybeReady() {
    if (
      !this.#historyReady ||
      !this.#connectedSeen ||
      !this.#sessionSnapshotSeen ||
      !this.#permissionSnapshotSeen ||
      this.#socket?.readyState !== 1
    )
      return
    // 续传接回时这些都还是上次对齐留下的：是否就绪由补发收完决定（见 #finishReplay）。
    if (this.connection === 'ready' || this.connection === 'resuming') return
    this.#timers.clear(this.#syncTimer)
    this.#syncTimer = undefined
    this.#retries = 0
    if (this.#streamActive()) this.#stream!.synced = true
    this.#syncEpoch++
    if (!this.state.turnActive) this.#markUndelivered()
    this.#setConnection('ready')
    this.#afterReady()
  }

  /** 还在等电脑确认的用户消息改成「未确认送达」，让用户决定要不要重发。 */
  #markUndelivered() {
    if (!this.state.items.some((item) => item.type === 'user' && item.pending)) return
    this.#publish({
      ...this.state,
      items: this.state.items.map((item) =>
        item.type === 'user' && item.pending
          ? { ...item, pending: false, delivery: 'uncertain' }
          : item
      ),
      error: {
        message: '上一条消息未确认送达，请检查电脑后再决定是否重发',
        code: 'DELIVERY_UNCONFIRMED',
      },
    })
  }

  /** 就绪之后：没就绪时出现的更好的路，现在换过去。 */
  #afterReady() {
    if (!this.#migrateWanted) return
    this.#migrateWanted = false
    this.#beginMigration()
  }

  #scheduleReconcile(attempt = 0, turnEpoch = this.#turnEpoch) {
    this.#timers.clear(this.#refreshTimer)
    const generation = this.#generation
    this.#refreshTimer = this.#timers.set(
      () => {
        if (
          this.#valid(generation) &&
          !this.state.turnActive &&
          turnEpoch === this.#turnEpoch
        )
          void this.#reconcile(generation, turnEpoch, attempt)
      },
      [100, 500, 1500][attempt] ?? 1500
    )
  }

  async #reconcile(generation: number, turnEpoch: number, attempt: number) {
    const controller = this.#requestController()
    const stale = () =>
      !this.#valid(generation) ||
      this.state.turnActive ||
      turnEpoch !== this.#turnEpoch
    try {
      // 先接回已加载的历史再对账：这一轮超过一页（大图、读了很多文件）时，用户那条消息
      // 不在最新一页里，只拿最新一页比永远对不上，界面会一直停在实时状态，直到下次重连整体替换。
      // 能往后读就只读这一轮新增的记录。
      const loaded = this.historyPage
      const followed = loaded?.page?.tailCursor
        ? await this.#followFrom(loaded, controller.signal)
        : undefined
      if (stale()) return
      const history =
        followed ??
        (await this.#joinLatest(
          await this.#options.client.history(
            this.#options.sessionId,
            undefined,
            { signal: controller.signal }
          ),
          controller.signal
        ))
      if (stale()) return
      const items = normalizeHistory(history.messages)
      const live = this.state.items.filter(
        (item) =>
          item.id.startsWith('live:') &&
          !this.#priorLiveIds.has(item.id) &&
          ['assistant', 'tool', 'user'].includes(item.type) &&
          item.delivery !== 'uncertain' &&
          (!!item.text || !!item.toolUseId || !!item.attachments?.length)
      )
      const added = items
        .filter((item) => {
          const prior = this.#turnBaseItems.get(item.id)
          return !prior || !equivalent(prior, item)
        })
        .filter((item) => ['assistant', 'tool', 'user'].includes(item.type))
      // Some runtimes flush the transcript after message_complete. Do not erase fresh output.
      let caughtUp = !live.length || endsWithItems(added, live)
      // Joining mid-turn can split one assistant block between persisted prefix and live suffix.
      if (!caughtUp && live[0]?.type === 'assistant') {
        const prior = [...this.#turnBaseItems.values()].at(-1)
        if (prior?.type === 'assistant')
          caughtUp = endsWithItems(added, [
            { ...live[0], text: prior.text + live[0].text },
            ...live.slice(1),
          ])
      }
      if (!caughtUp) {
        if (attempt < 2) this.#scheduleReconcile(attempt + 1, turnEpoch)
        return
      }
      this.#setHistory(history)
      this.#historyEpoch++
      this.#initialOverlapItems = undefined
      const uncertain = this.state.items.filter(
        (item) =>
          item.delivery === 'uncertain' &&
          !items.some(
            (saved) =>
              equivalent(saved, item) && !this.#pendingBaseIds.has(saved.id)
          )
      )
      this.#publish({ ...this.state, items: [...items, ...uncertain] })
    } catch (error) {
      if (!this.#valid(generation) || controller.signal.aborted) return
      if (this.#isUnauthorized(error)) this.#requirePairing()
      else this.#report(error)
    } finally {
      this.#requests.delete(controller)
    }
  }

  async #reloadHistory(generation: number) {
    const controller = this.#requestController()
    const historyEpoch = ++this.#historyEpoch
    try {
      const history = await this.#options.client.history(
        this.#options.sessionId,
        undefined,
        { signal: controller.signal }
      )
      if (!this.#valid(generation) || historyEpoch !== this.#historyEpoch)
        return
      // 会话被改写过，旧的游标链作废，只用最新一页。
      this.#olderPages.clear()
      this.#setHistory(history)
      this.#publish({
        ...this.state,
        items: [
          ...normalizeHistory(history.messages),
          ...this.state.items.filter((item) => item.id.startsWith('live:')),
        ],
      })
    } catch (error) {
      if (!this.#valid(generation) || controller.signal.aborted) return
      if (this.#isUnauthorized(error)) this.#requirePairing()
      else this.#report(error)
    } finally {
      this.#requests.delete(controller)
    }
  }

  #heartbeat(generation: number) {
    const due = this.#now() + HEARTBEAT_MS
    this.#heartbeatTimer = this.#timers.set(() => {
      if (!this.#valid(generation) || this.#socket?.readyState !== 1) return
      if (this.#now() - due > HEARTBEAT_LATE_MS) {
        this.#probe()
        return
      }
      if (this.#awaitingPong) {
        this.#disconnect()
        return
      }
      try {
        this.#sendPing()
        this.#awaitingPong = true
      } catch {
        this.#disconnect()
        return
      }
      this.#heartbeat(generation)
    }, HEARTBEAT_MS)
  }

  /**
   * 发一个 ping，限时内等到它的 pong 就说明连接还活着；否则立即重连，不等退避。
   * 挂起期间压在缓冲里的旧帧、挂起前那个 ping 的 pong 一回来就会送到，它们只能说明
   * 连接当时还通，所以这里只认这次 ping 的 pong（同一条连接上 pong 按顺序回来）。
   */
  #probe() {
    if (this.#probeTimer !== undefined || this.#socket?.readyState !== 1) return
    const generation = this.#generation
    // 挂起前发出的 ping 可能永远等不到 pong：交给这次探活判断，不让心跳误杀。
    this.#timers.clear(this.#heartbeatTimer)
    this.#heartbeatTimer = undefined
    this.#awaitingPong = false
    try {
      this.#sendPing()
    } catch {
      this.#disconnect(true)
      return
    }
    this.#probePongs = this.#pingsInFlight
    this.#probeTimer = this.#timers.set(() => {
      this.#probeTimer = undefined
      if (this.#valid(generation)) this.#disconnect(true)
    }, RESUME_PROBE_TIMEOUT_MS)
  }

  #sendPing() {
    this.#socket!.send(this.#pingText())
    this.#pingsInFlight++
  }

  #pong(generation: number) {
    this.#pingsInFlight = Math.max(0, this.#pingsInFlight - 1)
    if (this.#probeTimer === undefined || --this.#probePongs > 0) return
    this.#timers.clear(this.#probeTimer)
    this.#probeTimer = undefined
    this.#heartbeat(generation)
  }

  #disconnect(immediate = false) {
    if (this.#disposed || this.#pairingRequired) return
    // 从就绪掉线不算失败；之后每次建连没成才算，连着两次就该告诉用户了。
    if (this.connection !== 'ready') this.#failures++
    this.#generation++
    this.#cleanup()
    this.#publish({ ...this.state, connected: false })
    this.#setConnection('reconnecting')
    const delay = immediate
      ? 0
      : Math.min(30000, 500 * 2 ** Math.min(this.#retries++, 6))
    this.#reconnectTimer = this.#timers.set(() => {
      if (!this.#disposed && !this.#pairingRequired) this.#connect(true)
    }, delay)
  }

  #requirePairing() {
    this.#pairingRequired = true
    this.#generation++
    this.#cleanup()
    this.#publish({ ...this.state, connected: false })
    this.#setConnection('pairing_required')
    this.#options.onError(
      new ApiError('连接凭据已失效，请重新配对电脑', 401, 'PAIRING_REQUIRED')
    )
  }

  async #probeAuthorization() {
    // Native WebSocket handshake failures often hide HTTP 401 behind close 1006.
    // 只问凭据是否还有效（几个字节），不为此在慢隧道上下载一整页历史；连着断时 30 秒问一次就够。
    if (this.#authProbing) return
    const now = this.#now()
    if (this.#authProbedAt !== undefined && now - this.#authProbedAt < AUTH_PROBE_INTERVAL_MS) return
    this.#authProbedAt = now
    this.#authProbing = true
    const generation = this.#generation
    const controller = this.#requestController()
    try {
      await this.#options.client.verify({ signal: controller.signal })
    } catch (error) {
      if (
        this.#valid(generation) &&
        !controller.signal.aborted &&
        this.#isUnauthorized(error)
      )
        this.#requirePairing()
    } finally {
      this.#requests.delete(controller)
      this.#authProbing = false
    }
  }

  #cleanup() {
    if (this.#disposed) this.#olderPages.clear()
    for (const timer of [
      this.#reconnectTimer,
      this.#probeTimer,
      this.#heartbeatTimer,
      this.#syncTimer,
      this.#refreshTimer,
      this.#configTimer,
    ])
      this.#timers.clear(timer)
    this.#reconnectTimer =
      this.#probeTimer =
      this.#heartbeatTimer =
      this.#syncTimer =
      this.#refreshTimer =
        undefined
    this.#awaitingPong = false
    this.#pendingConfig = undefined
    this.#configTimer = undefined
    this.state = { ...this.state, configPending: false }
    this.#paginationPending = false
    for (const request of this.#requests) request.abort()
    this.#requests.clear()
    this.#dropMigration()
    this.#pingsInFlight = this.#probePongs = 0
    if (this.#socket) {
      const socket = this.#socket
      this.#socket = undefined
      retire(socket)
    }
  }

  #valid(generation: number) {
    return (
      !this.#disposed &&
      !this.#pairingRequired &&
      generation === this.#generation
    )
  }
  #captureTurnBaseline() {
    this.#turnBaseItems = new Map(
      normalizeHistory(
        (this.#hydrating ? this.#preSubscribeHistory : this.historyPage)
          ?.messages ?? []
      ).map((item) => [item.id, item])
    )
    this.#priorLiveIds = new Set(
      this.state.items
        .filter((item) => item.id.startsWith('live:'))
        .map((item) => item.id)
    )
  }
  #collapseInitialOverlap() {
    const history = this.#initialOverlapItems
    if (!history) return
    const live = this.state.items.filter((item) => item.id.startsWith('live:'))
    // Without the turn's user boundary there is no safe text-only overlap decision.
    if (live[0]?.type !== 'user') return
    const start = history.findLastIndex((item) => item.type === 'user')
    if (start < 0) return
    const suffix = history.slice(start)
    if (
      !suffix.length ||
      suffix.length > live.length ||
      !suffix.every((item, index) => compatiblePrefix(item, live[index]))
    )
      return
    const beforeSubscription = new Map(
      normalizeHistory(this.#preSubscribeHistory?.messages ?? []).map(
        (item) => [item.id, item]
      )
    )
    // Equal text from a completed pre-subscription turn is never evidence of overlap.
    if (
      suffix.some((item) => {
        const prior = beforeSubscription.get(item.id)
        return prior && equivalent(prior, item)
      })
    )
      return
    const ids = new Set(suffix.map((item) => item.id))
    if (this.state.items.some((item) => ids.has(item.id)))
      this.#publish({
        ...this.state,
        items: this.state.items.filter((item) => !ids.has(item.id)),
      })
  }
  #clearConfigPending() {
    this.#timers.clear(this.#configTimer)
    this.#configTimer = undefined
    this.#pendingConfig = undefined
    this.state = { ...this.state, configPending: false }
  }
  #isUnauthorized(error: unknown) {
    return error instanceof ApiError && error.status === 401
  }
  #requestController() {
    const controller = new AbortController()
    this.#requests.add(controller)
    return controller
  }
  #publish(state: ChatState) {
    this.state = state
    this.#options.onState(state)
  }
  #setHistory(page: HistoryPage) {
    this.historyPage = page
    this.#options.history?.write(page)
  }
  /**
   * 把重新读到的最新一页接到已加载的历史上。新增超过一页时往前补几页再接；
   * 最新一页的开头已在已加载范围里却对不上，说明会话被改写，只用最新的。
   */
  async #joinLatest(latest: HistoryPage, signal: AbortSignal, budgetMs?: number) {
    let page = latest
    // 补页有自己的时限；超时只是少接几页，不算同步失败。
    const bridge = new AbortController()
    const stop = () => bridge.abort()
    signal.addEventListener('abort', stop, { once: true })
    const deadline = budgetMs === undefined ? undefined : this.#timers.set(stop, budgetMs)
    try {
      for (let bridged = 0; ; bridged++) {
        const loaded = this.historyPage
        const joined = stitchLatestPage(loaded, page)
        if (joined) return joined
        const cursor = page.page?.nextCursor
        const first = page.messages[0]?.id
        if (
          bridged >= BRIDGE_PAGES ||
          !cursor ||
          loaded?.messages.some((entry) => entry.id === first)
        )
          return page
        try {
          page = mergeHistoryPages(page, await this.#olderPage(cursor, bridge.signal))
        } catch (error) {
          if (signal.aborted || this.#isUnauthorized(error)) throw error
          return page
        }
      }
    } finally {
      signal.removeEventListener('abort', stop)
      if (deadline !== undefined) this.#timers.clear(deadline)
    }
  }
  /**
   * 从 `base` 的末尾往后读新增的记录并接上。会话被改写（409）、游标不认识（旧电脑 400）
   * 或几页内读不到尾时返回 undefined，由调用方改读最新一页。
   */
  async #followFrom(base: HistoryPage, signal: AbortSignal) {
    let page = base
    for (let reads = 0; reads < FOLLOW_PAGES; reads++) {
      const cursor = page.page?.tailCursor
      if (!cursor) return undefined
      let delta: HistoryPage
      try {
        delta = await this.#options.client.history(this.#options.sessionId, cursor, { signal })
      } catch (error) {
        if (
          !signal.aborted &&
          error instanceof ApiError &&
          (error.status === 409 || error.status === 400)
        )
          return undefined
        throw error
      }
      // 旧电脑不认 follow，把游标当普通的「更新的页」读，回一页空的、不带 tailCursor：
      // 这不是「已读到末尾」，改读最新一页。
      if (!delta.page?.tailCursor) return undefined
      page = appendFollowPage(page, delta)
      if (delta.page?.tailComplete !== false) return page
    }
    return undefined
  }
  /**
   * 同一个游标对应的旧页内容不变（会话被改写时最新一页会给出新游标），
   * 对账重试和补页可以直接复用，不必在慢网上再下一遍。
   */
  async #olderPage(cursor: string, signal: AbortSignal) {
    const known = this.#olderPages.get(cursor)
    if (known) return known
    const older = await this.#options.client.history(this.#options.sessionId, cursor, { signal })
    this.#olderPages.set(cursor, older)
    for (const oldest of this.#olderPages.keys()) {
      if (this.#olderPages.size <= OLDER_PAGE_MEMO) break
      this.#olderPages.delete(oldest)
    }
    return older
  }
  #setConnection(connection: ConnectionState) {
    this.connection = connection
    if (connection === 'ready') this.#failures = 0
    this.#holdGate(
      connection === 'connecting' ||
        connection === 'syncing' ||
        connection === 'resuming' ||
        connection === 'reconnecting'
    )
    this.#options.onConnection(connection)
  }
  #holdGate(busy: boolean) {
    if (busy) this.#releaseGate ??= this.#options.gate?.hold()
    else {
      this.#releaseGate?.()
      this.#releaseGate = undefined
    }
  }
  #now() {
    return (this.#options.clock ?? Date.now)()
  }
  #freshStream() {
    return { id: this.#options.newStreamId!(), synced: false, lastSeq: 0, ackedSeq: 0 }
  }
  /** 电脑接上了这条流（不是旧电脑、也不是还在等它答复）。 */
  #streamActive() {
    return !this.#streamsUnsupported && !!this.#stream?.epoch && !this.#awaitingAttach
  }
  #encode(message: ClientMessage): { text: string; cseq?: number } {
    return this.#streamActive() ? this.#outbox.encode(message) : { text: JSON.stringify(message) }
  }
  /**
   * 当场没发出去的命令：撤回编号（界面已告诉用户它没发出、不会自动重试，续传后也不能悄悄补发），
   * 再按断线处理。
   */
  #unsent(encoded: { cseq?: number }) {
    if (encoded.cseq !== undefined) this.#outbox.drop(encoded.cseq)
    this.#options.onError(
      new ApiError('发送失败，消息没有自动重试', 0, 'SEND_FAILED')
    )
    this.#disconnect()
  }
  /** 续传或换路接上后，补发还没收完：新命令不能抢在断线前没执行的命令前面。 */
  #replaying() {
    return this.#stream?.replayUntil !== undefined
  }
  /** 离开或重新对齐前告诉电脑这条流不用再留（套接字已断就让它自己过期）。 */
  #endStream() {
    if (!this.#streamActive() || this.#socket?.readyState !== 1) return
    try {
      this.#socket.send(JSON.stringify({ type: 'stream_end' }))
    } catch {
      /* The socket is already gone; the server lets the stream expire. */
    }
  }
  /**
   * 能告诉电脑「已收到」的帧号。换路途中不超过新连接请求续传时带的帧号：否则电脑先按
   * 旧连接上的确认裁掉缓冲，新连接接上时帧号就对不上（断档），只能从头对齐。
   */
  #ackable() {
    const stream = this.#stream!
    return this.#migration ? Math.min(stream.lastSeq, this.#migration.ack) : stream.lastSeq
  }
  #pingText() {
    if (!this.#streamActive()) return JSON.stringify({ type: 'ping' })
    const ack = this.#ackable()
    this.#stream!.ackedSeq = ack
    return JSON.stringify({ type: 'ping', ack })
  }
  #acknowledgeFrames() {
    const stream = this.#stream
    if (!stream || this.#socket?.readyState !== 1) return
    try {
      const ack = this.#ackable()
      this.#socket.send(JSON.stringify({ type: 'stream_ack', ack }))
      stream.ackedSeq = ack
    } catch {
      /* The heartbeat notices a dead socket. */
    }
  }
  /** 电脑答复了续传请求。 */
  #attached(generation: number, attached: StreamAttached) {
    const stream = this.#stream
    if (!stream || !this.#awaitingAttach) return
    this.#awaitingAttach = false
    stream.epoch = attached.epoch
    if (!this.#resuming) {
      // 新流：会话连接刚打开，照常对齐。
      stream.lastSeq = stream.ackedSeq = attached.next - 1
      return
    }
    this.#resuming = false
    if (!attached.resumed) {
      // 电脑那边这条流已经不在了（过期、断档、电脑重启）。它不会为这个套接字打开会话、
      // 随后用 4001 关掉它，所以不用发 stream_end：换新流从头对齐（关闭事件到时这条连接已作废）。
      stream.synced = false
      this.#connect(true)
      return
    }
    this.#heartbeat(generation)
    this.#resumed(attached)
  }
  /** 电脑接回了这条流（续传或换路）：记下从哪里补发，等补发收完再重发没执行的命令。 */
  #resumed(attached: StreamAttached) {
    const stream = this.#stream!
    // 换路时旧连接可能已经收到比请求时更新的帧，补发里重复的按帧号丢掉。
    stream.lastSeq = Math.max(stream.lastSeq, attached.next - 1)
    stream.ackedSeq = attached.next - 1
    stream.replayUntil = attached.last
    this.#outbox.acknowledge(attached.cack)
    this.#finishReplay()
  }
  /**
   * 补发收完后，把断线前发出、电脑还没执行的命令按原编号、原顺序再发一次（电脑会去重），
   * 之后才就绪、才放行新命令。补发里已经处理掉的决定（别的设备批了、超时了）不再发；
   * 同一条重发过两次还没执行的，不再转圈，按「未确认送达」交给用户。
   */
  #finishReplay() {
    const stream = this.#stream
    if (
      !stream ||
      stream.replayUntil === undefined ||
      stream.lastSeq < stream.replayUntil ||
      this.#socket?.readyState !== 1
    )
      return
    stream.replayUntil = undefined
    let undelivered = false
    for (const item of this.#outbox.unacknowledged(0)) {
      if (!this.#stillWanted(item.message)) {
        this.#outbox.drop(item.cseq)
        continue
      }
      if (item.resends >= MAX_COMMAND_RESENDS) {
        this.#outbox.drop(item.cseq)
        if (item.message.type === 'user_message') undelivered = true
        continue
      }
      try {
        this.#socket.send(item.text)
        this.#outbox.resent(item.cseq)
      } catch {
        this.#disconnect()
        return
      }
    }
    if (undelivered) {
      this.#markUndelivered()
      // 乐观显示的「运行中」可能并不存在：请电脑报一次这段会话的真实状态。
      try {
        this.#socket.send(JSON.stringify({ type: 'sync_state' }))
      } catch {
        /* The heartbeat notices a dead socket. */
      }
    }
    this.#timers.clear(this.#syncTimer)
    this.#syncTimer = undefined
    if (this.connection !== 'resuming') {
      this.#afterReady()
      return
    }
    this.#retries = 0
    this.#publish({ ...this.state, connected: true })
    this.#setConnection('ready')
    // 断线时排好的对账跟着连接一起取消了：这一轮的实时内容还没换成已保存的记录，重新排一次。
    if (
      !this.state.turnActive &&
      this.state.items.some(
        (item) =>
          item.id.startsWith('live:') && item.type !== 'error' && item.delivery !== 'uncertain'
      )
    )
      this.#scheduleReconcile()
    this.#afterReady()
  }
  /** 换到新路：新连接先被电脑接上，旧连接才让出来。返回 false 表示现在换不了。 */
  #beginMigration() {
    const stream = this.#stream
    if (
      this.#migration ||
      this.connection !== 'ready' ||
      !this.#streamActive() ||
      !stream?.synced ||
      !stream.epoch ||
      stream.replayUntil !== undefined ||
      this.#socket?.readyState !== 1
    )
      return false
    const generation = this.#generation
    const ack = stream.lastSeq
    let socket: SocketLike
    try {
      socket = this.#createSocket({ id: stream.id, resume: { epoch: stream.epoch, ack } })
    } catch {
      // 新路这时建不起来：继续用旧连接，不再反复试。
      return true
    }
    this.#migrateWanted = false
    const migration: { socket: SocketLike; ack: number; timer?: unknown } = { socket, ack }
    this.#migration = migration
    const abandon = () => {
      if (this.#migration !== migration) return
      this.#dropMigration()
      // 电脑已经把流交给了新连接（旧连接收到了 4000），新连接却没成：这才按断线处理。
      if (this.#socket?.readyState !== 1) this.#disconnect(true)
    }
    socket.onmessage = ({ data }) => {
      if (!this.#valid(generation) || this.#migration !== migration) return
      const frame = readStreamFrame(data)
      if (frame?.kind !== 'attached') abandon()
      else this.#moveTo(migration, frame.frame, generation)
    }
    socket.onclose = () => abandon()
    socket.onerror = () => abandon()
    migration.timer = this.#timers.set(abandon, MIGRATION_TIMEOUT_MS)
    return true
  }
  #moveTo(migration: { socket: SocketLike; timer?: unknown }, attached: StreamAttached, generation: number) {
    const stream = this.#stream!
    this.#timers.clear(migration.timer)
    this.#migration = undefined
    const socket = migration.socket
    stream.epoch = attached.epoch
    if (!attached.resumed) {
      // 电脑那边这条流续不上了（缓冲溢出等）：和续传失败一样换新流从头对齐。
      // 电脑不为这个套接字打开会话；旧连接上的流若还在，告诉电脑不用再留。
      retire(socket)
      this.#endStream()
      stream.synced = false
      this.#connect(true)
      return
    }
    // 电脑已用 4000 关掉旧连接；旧路上还没送到的帧，新连接的补发里都有。
    if (this.#socket) retire(this.#socket)
    this.#socket = socket
    // 旧连接上的 ping 不会在新连接上回 pong；这次接上本身就是刚收到的一帧。
    this.#pingsInFlight = 0
    this.#awaitingPong = false
    this.#bind(socket, generation)
    // 这次接上是电脑刚刚的答复，足以说明连接是通的：回前台的探活不必再等旧路上的 pong，
    // 心跳从新连接重新算（旧连接被顶替那一刻心跳可能正好停了）。
    this.#timers.clear(this.#probeTimer)
    this.#timers.clear(this.#heartbeatTimer)
    this.#probeTimer = undefined
    this.#heartbeat(generation)
    this.#resumed(attached)
    // 补发迟迟收不完时不能一直挡着新命令：和续传一样由同步时限兜底，重新接一次。
    if (!this.#replaying()) return
    this.#timers.clear(this.#syncTimer)
    this.#syncTimer = this.#timers.set(() => {
      if (!this.#valid(generation) || !this.#replaying()) return
      this.#options.onError(new ApiError('会话同步超时', 0, 'SYNC_TIMEOUT'))
      this.#disconnect()
    }, SYNC_TIMEOUT_MS)
  }
  #dropMigration() {
    const migration = this.#migration
    if (!migration) return
    this.#migration = undefined
    this.#timers.clear(migration.timer)
    retire(migration.socket)
  }
  #stillWanted(message: ClientMessage) {
    if (message.type === 'permission_response' || message.type === 'ask_user_question_activity')
      return this.state.permissions.some((item) => item.requestId === message.requestId)
    if (message.type === 'computer_use_permission_response')
      return this.state.computerUsePermissions.some((item) => item.requestId === message.requestId)
    return true
  }
  #report(error: unknown) {
    this.#options.onError(
      error instanceof Error ? error : new Error('会话同步失败')
    )
  }
}

/** 不再用的连接：先摘掉回调（之后到的关闭事件不再触发断线处理），再关掉。 */
function retire(socket: SocketLike) {
  socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
  try {
    socket.close(1000, 'Client disconnected')
  } catch {
    /* Already closed. */
  }
}
function equivalent(a: ChatItem, b: ChatItem) {
  return (
    a.type === b.type &&
    a.text === b.text &&
    (a.type !== 'tool' || a.toolUseId === b.toolUseId) &&
    ((!a.attachments?.length && !b.attachments?.length) || sameMaterials(a, b))
  )
}
function sameMaterials(a: ChatItem, b: ChatItem) {
  return (
    !!a.attachments?.length &&
    a.attachments.length === b.attachments?.length &&
    a.attachments.every((value, index) => {
      const other = b.attachments![index]
      return (
        value.type === other.type &&
        value.data === other.data &&
        value.mimeType === other.mimeType &&
        value.path === other.path
      )
    })
  )
}
function endsWithItems(items: ChatItem[], suffix: ChatItem[]) {
  return (
    items.length >= suffix.length &&
    suffix.every((item, index) =>
      equivalent(items[items.length - suffix.length + index], item)
    )
  )
}
function compatiblePrefix(saved: ChatItem, live: ChatItem) {
  if (
    saved.type !== live.type ||
    (saved.type === 'tool' && saved.toolUseId !== live.toolUseId)
  )
    return false
  if (
    (saved.attachments?.length || live.attachments?.length) &&
    !sameMaterials(saved, live)
  )
    return false
  return saved.type === 'user'
    ? saved.text === live.text
    : live.text.startsWith(saved.text)
}
