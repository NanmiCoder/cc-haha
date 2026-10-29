import type { PowerSaveBlocker, WebContents } from 'electron'
import type { PreviewLocalAccess } from './previewSession'

const POLL_INTERVAL_MS = 2_000
const REQUEST_TIMEOUT_MS = 5_000

/** One local snapshot includes turns, background work and remote/scheduled sessions. */
export async function readPreventSleepActivity(
  access: PreviewLocalAccess | null,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<boolean> {
  if (!access) return false
  const response = await request(`${access.serverUrl}/api/sessions/live-status?includeTeamWorkers=1`, {
    headers: { Authorization: `Bearer ${access.token}` },
    signal,
    redirect: 'error',
  })
  if (!response.ok) throw new Error('Session activity unavailable')
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object' || !('sessions' in body) || !Array.isArray(body.sessions)) {
    throw new Error('Invalid session activity')
  }
  return body.sessions.some((session: unknown) =>
    !!session && typeof session === 'object' && 'activityState' in session
    && (session.activityState === 'running' || session.activityState === 'waiting'))
}

type PreventSleepOptions = {
  blocker: Pick<PowerSaveBlocker, 'start' | 'stop'>
  readActivity: (signal: AbortSignal) => Promise<boolean>
  onError: () => void
  pollIntervalMs?: number
}

/** Lives in the main process so minimizing or hiding the window cannot throttle it. */
export class PreventSleepService {
  private enabled = false
  private disposed = false
  private generation = 0
  private blockerId: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private request: AbortController | null = null
  private failed = false

  constructor(private readonly options: PreventSleepOptions) {}

  setEnabled(enabled: boolean): void {
    if (this.disposed || enabled === this.enabled) return
    this.enabled = enabled
    this.generation += 1
    this.request?.abort()
    this.request = null
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (enabled) void this.refresh(this.generation)
    else this.setBlocked(false)
  }

  dispose(): void {
    this.setEnabled(false)
    this.disposed = true
  }

  private setBlocked(blocked: boolean): void {
    if (blocked && this.blockerId === null) {
      // Allows display sleep on both macOS and Windows, like the Codex app.
      this.blockerId = this.options.blocker.start('prevent-app-suspension')
    } else if (!blocked && this.blockerId !== null) {
      this.options.blocker.stop(this.blockerId)
      this.blockerId = null
    }
  }

  private async refresh(generation: number): Promise<void> {
    const controller = new AbortController()
    this.request = controller
    try {
      const active = await this.options.readActivity(AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]))
      if (generation !== this.generation) return
      this.setBlocked(active)
      this.failed = false
    } catch {
      if (generation !== this.generation) return
      // A dead sidecar must not leave an old activity snapshot holding the machine awake.
      this.setBlocked(false)
      if (!this.failed) this.options.onError()
      this.failed = true
    } finally {
      if (generation === this.generation && this.enabled) {
        this.request = null
        this.timer = setTimeout(() => void this.refresh(generation), this.options.pollIntervalMs ?? POLL_INTERVAL_MS)
      }
    }
  }
}

export function installPreventSleepLifecycle(
  contents: Pick<WebContents, 'on'>,
  service: Pick<PreventSleepService, 'setEnabled'>,
): void {
  const release = () => service.setEnabled(false)
  // A canceled navigation still emits did-start-navigation. Only a committed
  // main-document replacement will mount App again and restore the preference.
  contents.on('did-navigate', release)
  contents.on('render-process-gone', release)
  contents.on('destroyed', release)
}
