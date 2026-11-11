import type { DesktopPublicAccessStatus } from '../../src/lib/desktopHost/types'

type Options = {
  directoryUrl: string
  request<T>(route: string, method: string, body?: unknown): Promise<T>
  fetch?: typeof fetch
  changed(state: DesktopPublicAccessStatus['directoryState'], hostId?: string): void
}

/** Directory outages must never tear down a working tunnel. */
export class RemoteDirectoryPublisher {
  private generation = 0
  private retryCount = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private controller: AbortController | undefined
  constructor(private readonly options: Options) {}

  start() {
    this.stop()
    this.retryCount = 0
    return this.publish(this.generation)
  }

  stop() {
    ++this.generation
    clearTimeout(this.timer)
    this.timer = undefined
    this.controller?.abort()
    this.controller = undefined
  }

  private async publish(generation: number) {
    const current = () => generation === this.generation
    const { directoryUrl } = this.options
    this.options.changed('publishing')
    const controller = new AbortController()
    this.controller = controller
    const timeout = setTimeout(() => controller.abort(), 10_000)
    timeout.unref?.()
    let delay = 300_000
    try {
      if (directoryUrl && new URL(directoryUrl).origin !== directoryUrl) throw new Error('Invalid directory origin')
      if (directoryUrl && !directoryUrl.startsWith('https://')) throw new Error('Invalid directory scheme')
      await this.options.request('/native/configure', 'POST', { directoryUrl })
      if (!current()) return
      if (!directoryUrl) { this.options.changed('unconfigured'); return }
      const announcement = await this.options.request<{ hostId: string }>('/native/announcement', 'POST')
      if (!current()) return
      const body = JSON.stringify(announcement)
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(announcement.hostId) || Buffer.byteLength(body) > 4096) throw new Error('Invalid directory announcement')
      const response = await (this.options.fetch ?? fetch)(`${directoryUrl}/v1/hosts/${announcement.hostId}`, {
        method: 'PUT', body, redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
      })
      // No response body is needed. Bound resource use even for an untrusted response.
      void response.body?.cancel().catch(() => {})
      if (!current()) return
      if (response.status !== 200 && response.status !== 201) throw new Error('Directory unavailable')
      this.retryCount = 0
      this.options.changed('ready', announcement.hostId)
    } catch {
      if (!current()) return
      this.options.changed('retrying')
      delay = Math.min(60_000, 1000 * 2 ** Math.min(this.retryCount++, 6))
    } finally {
      clearTimeout(timeout)
      if (this.controller === controller) this.controller = undefined
    }
    if (current()) {
      this.timer = setTimeout(() => { void this.publish(generation) }, delay)
      this.timer.unref?.()
    }
  }
}
