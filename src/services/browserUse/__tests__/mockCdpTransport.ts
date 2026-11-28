import type {
  BrowserTargetKind,
  CdpEventListener,
  CdpSendOptions,
  CdpTransport,
} from '../types'

export interface RecordedCdpCommand {
  method: string
  params?: Record<string, unknown>
  options?: CdpSendOptions
}

export type MockCdpHandler = (
  params: Record<string, unknown> | undefined,
  options: CdpSendOptions | undefined,
) => Promise<Record<string, unknown>> | Record<string, unknown>

export class MockCdpTransport implements CdpTransport {
  readonly kind: BrowserTargetKind
  readonly commands: RecordedCdpCommand[] = []

  private connected = true
  private readonly handlers = new Map<string, MockCdpHandler>()
  private readonly eventListeners = new Set<CdpEventListener>()
  private readonly disconnectListeners = new Set<(reason: string) => void>()

  constructor(kind: BrowserTargetKind = 'workspace') {
    this.kind = kind
  }

  onCommand(method: string, handler: MockCdpHandler): this {
    this.handlers.set(method, handler)
    return this
  }

  emitEvent(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): void {
    for (const listener of this.eventListeners) {
      listener(method, params, sessionId)
    }
  }

  simulateDisconnect(reason = 'mock disconnect'): void {
    this.connected = false
    for (const listener of this.disconnectListeners) {
      listener(reason)
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  onEvent(listener: CdpEventListener): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  onDisconnect(listener: (reason: string) => void): () => void {
    this.disconnectListeners.add(listener)
    return () => {
      this.disconnectListeners.delete(listener)
    }
  }

  async send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    options?: CdpSendOptions,
  ): Promise<T> {
    if (!this.connected) {
      throw new Error(`MockCdpTransport disconnected (${method})`)
    }
    if (options?.signal?.aborted) {
      throw new Error(`CDP command "${method}" aborted`)
    }
    this.commands.push({ method, params, options })
    const handler = this.handlers.get(method)
    if (handler) {
      const res = await handler(params, options)
      return res as T
    }
    return {} as T
  }

  async close(): Promise<void> {
    this.connected = false
  }
}
