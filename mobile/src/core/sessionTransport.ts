import { ApiError, type ApiClient } from './client'
import { buildSocketOptions } from './connection'
import {
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
  client: Pick<ApiClient, 'host' | 'history'>
  credential: string
  sessionId: string
  platform: 'native' | 'web'
  socketFactory: SocketFactory
  onState(state: ChatState): void
  onConnection(state: ConnectionState): void
  onError(error: Error): void
  timers?: TransportTimers
  history?: HistoryStore
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
  #hydrating = false
  #priorLiveIds = new Set<string>()
  #initialOverlapItems?: ChatItem[]
  #awaitingPong = false
  #paginationPending = false
  #reconnectTimer?: unknown
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

  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.#generation++
    this.#cleanup()
    this.connection = 'offline'
  }

  reconnect() {
    if (!this.#started || this.#disposed || this.#pairingRequired) return
    this.#connect(true)
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
      this.#socket?.readyState !== 1
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
    try {
      this.#socket.send(JSON.stringify(message))
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
      this.#options.onError(
        new ApiError('发送失败，消息没有自动重试', 0, 'SEND_FAILED')
      )
      this.#disconnect()
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
      this.#socket?.readyState !== 1
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
    try {
      this.#socket.send(JSON.stringify(message))
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
      this.#options.onError(
        new ApiError('发送失败，消息没有自动重试', 0, 'SEND_FAILED')
      )
      this.#disconnect()
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
      const history = await this.#options.client.history(
        this.#options.sessionId,
        undefined,
        { signal: controller.signal }
      )
      if (!this.#valid(generation)) return
      this.#preSubscribeHistory = history
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
      const options = buildSocketOptions(
        this.#options.client.host,
        this.#options.credential,
        this.#options.sessionId,
        this.#options.platform
      )
      const socket = this.#options.socketFactory(options)
      this.#socket = socket
      socket.onopen = () => {
        if (!this.#valid(generation)) return
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
      socket.onmessage = ({ data }) => {
        if (!this.#valid(generation)) return
        // 任何一帧都说明连接还活着：大消息在慢网上排在 pong 前面时，不能算心跳超时。
        this.#awaitingPong = false
        const event = parseServerEvent(data)
        if (!event) return
        if (event.type === 'pong') {
          this.#awaitingPong = false
          return
        }
        if (event.type === 'connected') {
          if (event.sessionId !== this.#options.sessionId) return
          this.#connectedSeen = true
        }
        if (event.type === 'session_state') this.#sessionSnapshotSeen = true
        if (event.type === 'permission_requests_snapshot')
          this.#permissionSnapshotSeen = true
        if (!this.#historyReady) this.#buffer.push(event)
        else this.#applyEvent(event)
        this.#maybeReady()
      }
      socket.onclose = ({ code }) => {
        if (!this.#valid(generation)) return
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
      this.#syncTimer = this.#timers.set(() => {
        if (!this.#valid(generation) || this.connection === 'ready') return
        this.#options.onError(new ApiError('会话同步超时', 0, 'SYNC_TIMEOUT'))
        this.#disconnect()
      }, 20000)
    } catch (error) {
      this.#report(error)
      this.#setConnection('offline')
    }
  }

  async #initialHistory(generation: number) {
    const controller = this.#requestController()
    try {
      const latest = await this.#options.client.history(
        this.#options.sessionId,
        undefined,
        { signal: controller.signal }
      )
      if (!this.#valid(generation)) return
      const history = await this.#joinLatest(latest, controller.signal, SYNC_BRIDGE_BUDGET_MS)
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
    if (this.connection === 'ready') return
    this.#timers.clear(this.#syncTimer)
    this.#syncTimer = undefined
    this.#retries = 0
    if (
      !this.state.turnActive &&
      this.state.items.some((item) => item.type === 'user' && item.pending)
    ) {
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
    this.#setConnection('ready')
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
      const latest = await this.#options.client.history(
        this.#options.sessionId,
        undefined,
        { signal: controller.signal }
      )
      if (stale()) return
      // 先接回已加载的历史再对账：这一轮超过一页（大图、读了很多文件）时，用户那条消息
      // 不在最新一页里，只拿最新一页比永远对不上，界面会一直停在实时状态，直到下次重连整体替换。
      const history = await this.#joinLatest(latest, controller.signal)
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
    this.#heartbeatTimer = this.#timers.set(() => {
      if (!this.#valid(generation) || this.#socket?.readyState !== 1) return
      if (this.#awaitingPong) {
        this.#disconnect()
        return
      }
      try {
        this.#socket.send(JSON.stringify({ type: 'ping' }))
        this.#awaitingPong = true
      } catch {
        this.#disconnect()
        return
      }
      this.#heartbeat(generation)
    }, 15000)
  }

  #disconnect() {
    if (this.#disposed || this.#pairingRequired) return
    this.#generation++
    this.#cleanup()
    this.#publish({ ...this.state, connected: false })
    this.#setConnection('reconnecting')
    const delay = Math.min(30000, 500 * 2 ** Math.min(this.#retries++, 6))
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
    const generation = this.#generation
    const controller = this.#requestController()
    try {
      await this.#options.client.history(this.#options.sessionId, undefined, {
        signal: controller.signal,
      })
    } catch (error) {
      if (
        this.#valid(generation) &&
        !controller.signal.aborted &&
        this.#isUnauthorized(error)
      )
        this.#requirePairing()
    } finally {
      this.#requests.delete(controller)
    }
  }

  #cleanup() {
    if (this.#disposed) this.#olderPages.clear()
    for (const timer of [
      this.#reconnectTimer,
      this.#heartbeatTimer,
      this.#syncTimer,
      this.#refreshTimer,
      this.#configTimer,
    ])
      this.#timers.clear(timer)
    this.#reconnectTimer =
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
    if (this.#socket) {
      const socket = this.#socket
      this.#socket = undefined
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
      try {
        socket.close(1000, 'Client disconnected')
      } catch {
        /* Already closed. */
      }
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
    this.#options.onConnection(connection)
  }
  #report(error: unknown) {
    this.#options.onError(
      error instanceof Error ? error : new Error('会话同步失败')
    )
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
