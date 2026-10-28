import { ApiError } from './client'
import type { ConnectionState } from './sessionTransport'
import type { Session } from './types'

type ChatRecoveryOptions = {
  loadSummary(signal: AbortSignal): Promise<Session>
  onSummary(session: Session): void
  onConnectionError(message: string): void
  onBusinessError(error: Error): void
}

/** Keeps retryable connection feedback separate from failed user operations. */
export class ChatRecovery {
  #options: ChatRecoveryOptions
  #disposed = false
  #summaryLoaded = false
  #summaryRequest?: AbortController
  #summaryError = ''
  #transportError = ''

  constructor(options: ChatRecoveryOptions) {
    this.#options = options
  }

  start() {
    if (this.#disposed) return
    this.#publish()
    void this.#loadSummary()
  }

  onConnection(connection: ConnectionState) {
    if (this.#disposed || connection !== 'ready') return
    this.#transportError = ''
    this.#publish()
    // A healthy stream does not prove the independent summary request succeeded.
    // Replace any pre-recovery request so its late rejection cannot restore a banner.
    if (!this.#summaryLoaded) void this.#loadSummary()
  }

  onTransportError(error: Error) {
    if (this.#disposed) return
    if (
      error instanceof ApiError &&
      ['NETWORK_ERROR', 'TIMEOUT', 'SYNC_TIMEOUT', 'PAIRING_REQUIRED'].includes(
        error.code ?? ''
      )
    ) {
      this.#transportError = error.message
      this.#publish()
    } else {
      // CONFIG_TIMEOUT and SEND_FAILED require a user decision even after reconnect.
      this.#options.onBusinessError(error)
    }
  }

  dispose() {
    this.#disposed = true
    this.#summaryRequest?.abort()
  }

  async #loadSummary() {
    this.#summaryRequest?.abort()
    const request = new AbortController()
    this.#summaryRequest = request
    try {
      const session = await this.#options.loadSummary(request.signal)
      if (this.#disposed || this.#summaryRequest !== request) return
      this.#summaryLoaded = true
      this.#summaryError = ''
      this.#options.onSummary(session)
      this.#publish()
    } catch (error) {
      if (
        this.#disposed ||
        this.#summaryRequest !== request ||
        request.signal.aborted
      )
        return
      this.#summaryError =
        error instanceof Error ? error.message : '会话摘要加载失败，请重试'
      this.#publish()
    } finally {
      if (this.#summaryRequest === request) this.#summaryRequest = undefined
    }
  }

  #publish() {
    this.#options.onConnectionError(this.#transportError || this.#summaryError)
  }
}
