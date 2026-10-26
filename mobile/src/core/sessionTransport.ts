import { ApiError, type ApiClient } from './client'
import { buildSocketOptions } from './connection'
import {
  appendPendingUserMessage,
  chatReducer,
  createChatState,
  mergeHistoryPages,
  normalizeHistory,
  parseServerEvent,
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
}

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

  constructor(options: SessionTransportOptions) {
    this.#options = { ...options }
    this.#timers = options.timers ?? defaultTimers
    this.state = createChatState(options.sessionId)
  }

  start() {
    if (this.#started || this.#disposed) return
    this.#started = true
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

  async loadOlder(): Promise<void> {
    const current = this.historyPage
    const cursor = current?.page?.nextCursor
    if (
      this.#disposed ||
      !this.#historyReady ||
      this.#paginationPending ||
      !current ||
      !cursor
    )
      return
    this.#paginationPending = true
    const generation = this.#generation
    const historyEpoch = this.#historyEpoch
    const controller = this.#requestController()
    try {
      const older = await this.#options.client.history(
        this.#options.sessionId,
        cursor,
        { signal: controller.signal }
      )
      if (!this.#valid(generation) || historyEpoch !== this.#historyEpoch)
        return
      if (older.page?.nextCursor === cursor)
        throw new ApiError(
          '历史分页没有推进，请重新加载',
          409,
          'HISTORY_PAGE_STALE'
        )
      const merged = mergeHistoryPages(current, older)
      this.historyPage = merged
      this.#publish({
        ...this.state,
        items: [
          ...normalizeHistory(merged.messages),
          ...this.state.items.filter((item) => item.id.startsWith('live:')),
        ],
      })
    } catch (error) {
      if (!this.#valid(generation) || controller.signal.aborted) return
      if (this.#isUnauthorized(error)) return this.#requirePairing()
      if (
        (error instanceof ApiError && error.code === 'HISTORY_PAGE_STALE') ||
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
      } else this.#report(error)
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
      const history = await this.#options.client.history(
        this.#options.sessionId,
        undefined,
        { signal: controller.signal }
      )
      if (!this.#valid(generation)) return
      this.historyPage = history
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
    try {
      const history = await this.#options.client.history(
        this.#options.sessionId,
        undefined,
        { signal: controller.signal }
      )
      if (
        !this.#valid(generation) ||
        this.state.turnActive ||
        turnEpoch !== this.#turnEpoch
      )
        return
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
      this.historyPage = history
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
      this.historyPage = history
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
