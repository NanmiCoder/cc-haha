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
  /** After a disconnect reattach the original stream with the seen frame number, without reading history. */
  | 'resuming'
  | 'reconnecting'
  | 'offline'
  | 'pairing_required'
/** Result of paging back through history: the UI uses it to distinguish loaded, reached the start, paging and temporarily unavailable. */
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
/** History last read for this session (including paged-back pages). Show it on page entry, then sync with the computer. */
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
  /** Uses the same clock as `resume(hiddenAt)`; defaults to Date.now. */
  clock?: () => number
  /** Hold it while the connection is not ready so non-urgent requests yield first (see foregroundGate). */
  gate?: { hold(): () => void }
  /** When provided enables resumable streams (see resumableStream.ts); called once per new stream. */
  newStreamId?: () => string
}
/** Fill the gap when the latest page and the loaded history are within a few pages, otherwise keep only the latest page. */
const BRIDGE_PAGES = 3
/**
 * Total time for backfilling pages during sync. If it cannot fill, become ready with the latest page and fetch earlier content when paging; 
 * otherwise one large history page could use up the 20 second sync deadline and turn into repeated reconnects.
 */
const SYNC_BRIDGE_BUDGET_MS = 8000
/** Old pages remembered by cursor: reconciliation retries and resyncs do not redownload the same page. */
const OLDER_PAGE_MEMO = 16
/** Maximum pages to read forward from the end; if the end is not reached, read the latest page instead. */
const FOLLOW_PAGES = 3
/** Deadline from creating a new connection to finishing the handshake (through the public tunnel it needs TLS and upgrade). */
const SOCKET_OPEN_TIMEOUT_MS = 12000
/** Deadline for syncing with the computer (snapshot + history) after the handshake. */
const SYNC_TIMEOUT_MS = 15000
const HEARTBEAT_MS = 15000
/** A heartbeat timer this late means the process was suspended (iOS background), so a missing pong does not mean the connection is dead. */
const HEARTBEAT_LATE_MS = 5000
/** Probe deadline on return to foreground: if this probe's pong arrives within it, keep using the original connection. */
export const RESUME_PROBE_TIMEOUT_MS = 2500
/** Deadline from creating a new connection to the computer attaching it when rerouting; if not attached in time keep using the old connection. */
const MIGRATION_TIMEOUT_MS = SOCKET_OPEN_TIMEOUT_MS
/** Minimum interval between two auth probes: when disconnecting several times in a row, do not ask repeatedly over the slow tunnel. */
const AUTH_PROBE_INTERVAL_MS = 30_000
/** The computer uses it to close an old connection replaced by a new one on the same stream (see resumableStreams.ts). */
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
  /** The read before subscribing was already attached after the loaded history (reading forward), so no stitching is needed. */
  #preSubscribeJoined = false
  #hydrating = false
  #priorLiveIds = new Set<string>()
  #initialOverlapItems?: ChatItem[]
  #awaitingPong = false
  #paginationPending = false
  #attemptStartedAt?: number
  #authProbing = false
  #releaseGate?: () => void
  /** Current resume stream. epoch is given by the computer when it attaches; synced means it has synced with the computer and can resume. */
  #stream?: {
    id: string
    epoch?: string
    synced: boolean
    lastSeq: number
    ackedSeq: number
    /** After resume attaches, the replay runs up to this frame; only then resend unexecuted commands. */
    replayUntil?: number
  }
  #streamsUnsupported = false
  #outbox = new CommandOutbox()
  /** This connect reattaches the original stream. */
  #resuming = false
  /** This socket requested resume and has not received stream_attached yet. */
  #awaitingAttach = false
  /** Switching to a better path: the new connection is not attached by the computer yet, and the old one keeps sending and receiving. ack is the frame number sent when the new connection requested resume. */
  #migration?: { socket: SocketLike; ack: number; timer?: unknown }
  /** A better path appeared before ready: if the connection in use at ready time is still the earlier one, switch again. */
  #migrateWanted = false
  /** The next sync rereads the latest history page in full instead of reading forward from the loaded end (the user tapped Resync). */
  #fullResync = false
  #syncEpoch = 0
  #failures = 0
  /** Pings sent on this connection still waiting for pongs. Pongs come back in order. */
  #pingsInFlight = 0
  /** How many pongs the foreground probe still waits for: only its own counts. */
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

  /** Number of real syncs (history read); resume and reroute do not count. Peripheral data depending on session content rereads based on it. */
  get syncEpoch() {
    return this.#syncEpoch
  }

  /** Consecutive failed connects, reset when ready. Dropping from ready itself does not count. */
  get failures() {
    return this.#failures
  }

  dispose() {
    if (this.#disposed) return
    // Leave the session: tell the computer it need not keep this stream, and end the session connection as usual.
    this.#endStream()
    this.#disposed = true
    this.#generation++
    this.#cleanup()
    this.connection = 'offline'
    this.#holdGate(false)
  }

  /**
   * The user taps Retry or Resync: switch to a new stream and reread the latest history page in full without resuming — the user wants to resync with the computer,
   * and resume only replays frames without reading history. On return to foreground use `resume`.
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
   * Called on return to foreground or network change. If the connection looks open, probe first without tearing down usable connections; 
   * do not interrupt one being established; retry immediately if waiting on backoff. `hiddenAt` is the time it went to background (same clock).
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
   * A better path is available (direct established): reattach the same stream on the new path with the seen frame number, without reading history or reopening the session.
   * Make before break: until the new connection is attached by the computer, the old one keeps sending and receiving; if the new path fails keep using the old one.
   * If not ready yet, note it first and switch after ready if the connection in use is still the earlier one (connections created later already use the new path).
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
            'The computer has not confirmed the configuration; please choose again and retry',
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
   * Send a message into the running turn immediately (desktop "steer").
   * Unlike `send`, turnActive is allowed here; but do not send when the model is blocked on a decision, the configuration is not confirmed, 
   * the previous user message is not confirmed by the computer, or the connection is not ready. The last one is crucial: 
   * when the server receives a new message it replaces the current activeTurn, and if the previous one has not reached the SDK yet 
   * it is silently dropped while the client only sees an optimistic sent message.
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
      // Show it in the message stream first; when the server replays the same text it is matched against pending and confirmed, 
      // so the same message never appears twice.
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
   * Page back through history. One page at a time by default; `pages` can page several times in a row in one go, 
   * so "Load earlier messages" yields more content at once.
   * The result lets the UI distinguish "actually loaded", "not connected", "already paging" and "reached the start", 
   * so tapping never does nothing without any feedback.
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
            'History paging did not advance; please reload',
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
            'Session history was updated; reloading',
            409,
            'HISTORY_PAGE_STALE'
          )
        )
        await this.#reloadHistory(generation)
        // Already recovered with the latest page, so the UI no longer shows "not connected".
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
    // A stream already synced with the computer: reattach directly with the seen frame number, without reading history or reopening the session.
    this.#resuming =
      !this.#streamsUnsupported && !!this.#stream?.epoch && this.#stream.synced
    if (this.#resuming) {
      this.#publish({ ...this.state, connected: false })
      this.#setConnection('resuming')
      this.#openSocket(generation)
      return
    }
    // A stream that dropped before finishing sync cannot resume: start a new stream and sync from scratch.
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
      // Already loaded history only reads newly added parts forward instead of redownloading full pages over the slow tunnel; read the full page when the user asks to resync.
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
      // This connection is created only now, so it already uses the best current path: the previously noted reroute request is no longer needed.
      this.#migrateWanted = false
      this.#bind(socket, generation)
      this.#syncTimer = this.#timers.set(() => {
        if (!this.#valid(generation) || this.connection === 'ready') return
        this.#options.onError(new ApiError('Connecting to the computer timed out', 0, 'TIMEOUT'))
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

  /** Set a connection as the one the session is using. */
  #bind(socket: SocketLike, generation: number) {
    socket.onopen = () => {
      if (!this.#valid(generation)) return
      this.#timers.clear(this.#syncTimer)
      this.#syncTimer = this.#timers.set(() => {
        if (!this.#valid(generation) || this.connection === 'ready') return
        this.#options.onError(new ApiError('Session sync timed out', 0, 'SYNC_TIMEOUT'))
        this.#disconnect()
      }, SYNC_TIMEOUT_MS)
      // Reattach the original stream: wait for the computer to answer whether it can resume, then decide whether to resync. A replay that takes too long is also backstopped by the deadline above.
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
      // While rerouting the computer handed the stream to the new connection and closed the old one with 4000: wait for the new connection's reply instead of treating it as a disconnect.
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
    // Any frame shows the connection is alive: when large messages queue ahead of the pong on a slow network, it must not count as a heartbeat timeout.
    // The foreground probe is excluded; it only accepts its own pong (see #probe).
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
      // The computer did not answer resume first: it does not support it yet, so keep using this connection as before.
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
      // The same frame may arrive twice during reroute or replay.
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
    // Unrecognized frames also take a frame number: replay completion is counted by frame number and must not get stuck on them.
    this.#finishReplay()
  }

  async #initialHistory(generation: number) {
    const controller = this.#requestController()
    try {
      // Read forward once more after subscribing to fill in records written between the pre-subscribe read and the subscription.
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
    // On resume these are all still from the last sync: readiness is decided by the replay finishing (see #finishReplay).
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

  /** User messages still waiting for computer confirmation become "delivery not confirmed", letting the user decide whether to resend. */
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
        message: 'Delivery of the previous message was not confirmed; check the computer before deciding whether to resend',
        code: 'DELIVERY_UNCONFIRMED',
      },
    })
  }

  /** After ready: switch now to the better path that appeared before ready. */
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
      // Reattach loaded history before reconciling: when this turn spans more than a page (large images, many file reads), the user message
      // is not on the latest page, and comparing only the latest page would never match, leaving the UI in live state until the next reconnect replaces everything.
      // When reading forward is possible, read only the records added in this turn.
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
      // The session was rewritten, the old cursor chain is void; use only the latest page.
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
   * Send a ping; if its pong arrives in time the connection is alive, otherwise reconnect immediately without backoff.
   * Old frames buffered during suspension and the pong for the ping before suspension arrive as soon as it resumes, but they only show
   * the connection was alive back then, so only this ping's pong counts here (pongs come back in order on the same connection).
   */
  #probe() {
    if (this.#probeTimer !== undefined || this.#socket?.readyState !== 1) return
    const generation = this.#generation
    // A ping sent before suspension may never get a pong: leave it to this probe so the heartbeat does not kill it by mistake.
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
    // Dropping from ready does not count as a failure; only each failed connect afterwards counts, and two in a row should be told to the user.
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
      new ApiError('Connection credentials are no longer valid; please pair the computer again', 401, 'PAIRING_REQUIRED')
    )
  }

  async #probeAuthorization() {
    // Native WebSocket handshake failures often hide HTTP 401 behind close 1006.
    // Only ask whether the credential is still valid (a few bytes) instead of downloading a full history page over the slow tunnel; asking every 30 seconds while disconnecting is enough.
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
   * Attach the reread latest page to the loaded history. If more than a page was added, backfill a few pages first; 
   * if the start of the latest page is within the loaded range but does not match, the session was rewritten, so use only the latest.
   */
  async #joinLatest(latest: HistoryPage, signal: AbortSignal, budgetMs?: number) {
    let page = latest
    // Backfill has its own deadline; timing out just attaches fewer pages and does not count as a sync failure.
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
   * Read new records after the end of `base` and attach them. Session rewritten (409), unknown cursor (old computer 400)
   * or no end reached within a few pages returns undefined, and the caller reads the latest page instead.
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
      // Old computers do not recognize follow and read the cursor as an ordinary "newer page", returning an empty page without tailCursor: 
      // this is not "reached the end", so read the latest page instead.
      if (!delta.page?.tailCursor) return undefined
      page = appendFollowPage(page, delta)
      if (delta.page?.tailComplete !== false) return page
    }
    return undefined
  }
  /**
   * Old page content for the same cursor does not change (when the session is rewritten the latest page gives a new cursor), 
   * so reconciliation retries and backfill can reuse it directly without downloading again on a slow network.
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
  /** The computer attached this stream (not an old computer, and not still waiting for its reply). */
  #streamActive() {
    return !this.#streamsUnsupported && !!this.#stream?.epoch && !this.#awaitingAttach
  }
  #encode(message: ClientMessage): { text: string; cseq?: number } {
    return this.#streamActive() ? this.#outbox.encode(message) : { text: JSON.stringify(message) }
  }
  /**
   * A command not sent on the spot: withdraw its number (the UI already told the user it was not sent and will not auto-retry, and it must not be silently resent after resume), 
   * then handle as a disconnect.
   */
  #unsent(encoded: { cseq?: number }) {
    if (encoded.cseq !== undefined) this.#outbox.drop(encoded.cseq)
    this.#options.onError(
      new ApiError('Send failed; the message was not retried automatically', 0, 'SEND_FAILED')
    )
    this.#disconnect()
  }
  /** After resume or reroute, the replay has not finished: new commands must not jump ahead of commands not executed before the disconnect. */
  #replaying() {
    return this.#stream?.replayUntil !== undefined
  }
  /** Before leaving or resyncing tell the computer this stream need not be kept (if the socket is already gone let it expire). */
  #endStream() {
    if (!this.#streamActive() || this.#socket?.readyState !== 1) return
    try {
      this.#socket.send(JSON.stringify({ type: 'stream_end' }))
    } catch {
      /* The socket is already gone; the server lets the stream expire. */
    }
  }
  /**
   * The frame number that can be reported as "received". While rerouting it must not exceed the frame number sent when the new connection requested resume: otherwise the computer first trims the buffer by
   * acks on the old connection, and when the new connection attaches the frame numbers do not line up (gap), forcing a full resync.
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
  /** The computer answered the resume request. */
  #attached(generation: number, attached: StreamAttached) {
    const stream = this.#stream
    if (!stream || !this.#awaitingAttach) return
    this.#awaitingAttach = false
    stream.epoch = attached.epoch
    if (!this.#resuming) {
      // New stream: the session connection just opened; sync as usual.
      stream.lastSeq = stream.ackedSeq = attached.next - 1
      return
    }
    this.#resuming = false
    if (!attached.resumed) {
      // The stream no longer exists on the computer (expired, gap, computer restarted). It will not open a session for this socket 
      // and then closes it with 4001, so no stream_end is needed: start a new stream and sync from scratch (the connection is void by the time the close event arrives).
      stream.synced = false
      this.#connect(true)
      return
    }
    this.#heartbeat(generation)
    this.#resumed(attached)
  }
  /** The computer reattached this stream (resume or reroute): record where the replay starts, and resend unexecuted commands once the replay is done. */
  #resumed(attached: StreamAttached) {
    const stream = this.#stream!
    // While rerouting the old connection may have received frames newer than at request time; duplicates in the replay are dropped by frame number.
    stream.lastSeq = Math.max(stream.lastSeq, attached.next - 1)
    stream.ackedSeq = attached.next - 1
    stream.replayUntil = attached.last
    this.#outbox.acknowledge(attached.cack)
    this.#finishReplay()
  }
  /**
   * After the replay finishes, resend commands sent before the disconnect that the computer has not executed, with original numbers in original order (the computer dedupes), 
   * and only then become ready and let new commands through. Decisions already handled in the replay (approved on another device, timed out) are not resent; 
   * one resent twice and still not executed stops spinning and goes to the user as "delivery not confirmed".
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
      // The optimistic "running" may not exist: ask the computer to report this session's real state once.
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
    // Reconciliation scheduled at disconnect was canceled with the connection: this turn's live content is not yet replaced by saved records, so schedule again.
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
  /** Switch to a new path: the new connection is attached by the computer first, then the old one yields. Returns false if it cannot switch now. */
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
      // The new path cannot be built right now: keep using the old connection and stop retrying.
      return true
    }
    this.#migrateWanted = false
    const migration: { socket: SocketLike; ack: number; timer?: unknown } = { socket, ack }
    this.#migration = migration
    const abandon = () => {
      if (this.#migration !== migration) return
      this.#dropMigration()
      // The computer already handed the stream to the new connection (old one got 4000) but the new one failed: only now handle as a disconnect.
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
      // The stream cannot continue on the computer (buffer overflow etc): like a failed resume, start a new stream and sync from scratch.
      // The computer does not open a session for this socket; if the stream on the old connection is still there, tell the computer it need not be kept.
      retire(socket)
      this.#endStream()
      stream.synced = false
      this.#connect(true)
      return
    }
    // The computer closed the old connection with 4000; frames not yet delivered on the old path are all in the new connection's replay.
    if (this.#socket) retire(this.#socket)
    this.#socket = socket
    // Pings on the old connection will not get pongs on the new one; this attach itself is a freshly received frame.
    this.#pingsInFlight = 0
    this.#awaitingPong = false
    this.#bind(socket, generation)
    // This attach is the computer's fresh reply, which is enough to show the connection is alive: the foreground probe need not wait for a pong on the old path, 
    // and the heartbeat restarts from the new connection (the heartbeat may have stopped right when the old connection was replaced).
    this.#timers.clear(this.#probeTimer)
    this.#timers.clear(this.#heartbeatTimer)
    this.#probeTimer = undefined
    this.#heartbeat(generation)
    this.#resumed(attached)
    // When the replay takes too long it must not block new commands forever: like resume, the sync deadline is the backstop and reconnects once.
    if (!this.#replaying()) return
    this.#timers.clear(this.#syncTimer)
    this.#syncTimer = this.#timers.set(() => {
      if (!this.#valid(generation) || !this.#replaying()) return
      this.#options.onError(new ApiError('Session sync timed out', 0, 'SYNC_TIMEOUT'))
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
      error instanceof Error ? error : new Error('Session sync failed')
    )
  }
}

/** A connection no longer used: detach callbacks first (later close events no longer trigger disconnect handling), then close it. */
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
