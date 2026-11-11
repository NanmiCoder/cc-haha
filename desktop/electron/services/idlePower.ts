import { randomUUID } from 'node:crypto'
import type { PowerSaveBlocker } from 'electron'
import type { PreviewLocalAccess } from './previewSession'
import {
  isIdlePowerSettings,
  type IdlePowerAction,
  type IdlePowerCapabilities,
  type IdlePowerNotice,
  type IdlePowerRecord,
  type IdlePowerSettings,
  type IdlePowerState,
} from '../../src/lib/idlePower'

export type PowerActivitySnapshot = {
  epoch: string
  revision: number
  busy: boolean
  completionSequence: number
  scheduledCompletionSequence: number
}

export async function readIdlePowerActivity(
  access: PreviewLocalAccess | null,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<PowerActivitySnapshot> {
  if (!access) throw new Error('Session activity unavailable')
  const response = await request(`${access.serverUrl}/api/sessions/power-activity`, {
    headers: { Authorization: `Bearer ${access.token}` }, signal, redirect: 'error', cache: 'no-store',
  })
  if (!response.ok) throw new Error('Session activity unavailable')
  const body = await response.json() as Partial<PowerActivitySnapshot> | null
  if (!body || typeof body.epoch !== 'string' || !body.epoch || typeof body.busy !== 'boolean'
    || ![body.revision, body.completionSequence, body.scheduledCompletionSequence].every(value => Number.isSafeInteger(value) && value! >= 0)) {
    throw new Error('Invalid session activity')
  }
  return body as PowerActivitySnapshot
}

type Options = {
  settings: IdlePowerSettings
  blocker?: Pick<PowerSaveBlocker, 'start' | 'stop'>
  lastAction: IdlePowerRecord | null
  capabilities: IdlePowerCapabilities
  readActivity(signal: AbortSignal): Promise<PowerActivitySnapshot>
  /** The platform calls beforeExecute after capability checks, immediately before dispatch. */
  execute(action: IdlePowerAction, beforeExecute: () => Promise<void>): Promise<void>
  save(value: { settings: IdlePowerSettings, lastAction: IdlePowerRecord | null }): void
  notifyCountdown(countdown: NonNullable<IdlePowerState['countdown']>, seconds: number, cancel: (notice?: Exclude<IdlePowerNotice, null>) => void): boolean
  notifyNotice(notice: Exclude<IdlePowerNotice, null>): void
  onChange(state: IdlePowerState): void
  getIdleSeconds(): number
  getPointerPosition?(): { x: number, y: number }
  pollIntervalMs?: number
  quietPeriodMs?: number
}

/** Main-process owner: renderer throttling cannot accelerate or strand a countdown. */
export class IdlePowerService {
  private state: IdlePowerState
  private running = false
  private blockerId: number | null = null
  private dispatchGeneration: number | null = null
  private disposed = false
  private generation = 0
  private observed: PowerActivitySnapshot | null = null
  private pendingCompletion = false
  private quietSince: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private inputTimer: ReturnType<typeof setInterval> | null = null
  private request: AbortController | null = null
  private countdownInput: { at: number, idle: number, pointer?: { x: number, y: number } } | null = null

  constructor(private readonly options: Options) {
    this.state = { settings: { ...options.settings }, capabilities: { ...options.capabilities },
      lastAction: options.lastAction, countdown: null,
      notice: options.settings.action !== 'none' && !options.capabilities[options.settings.action] ? 'unavailable' : null }
  }

  getState(): IdlePowerState {
    return structuredClone(this.state)
  }

  start(): void {
    if (this.running || this.disposed) return
    this.running = true
    this.inputTimer = setInterval(() => {
      if (this.state.countdown && this.hasUserInput()) this.cancel('user-activity')
    }, 250)
    this.schedule(0)
  }

  /** Called synchronously before PreventSleep releases its final task assertion. */
  prepareIdleHandoff(): void {
    const action = this.state.settings.action
    if (!this.running || this.disposed || !this.options.blocker
      || action === 'none' || !this.state.capabilities[action] || this.dispatchGeneration === this.generation) return
    this.setBlocked(true)
    // A read started before this handoff may still describe the old busy state.
    // Preserve the completion baseline but validate ownership using a new read.
    this.generation += 1
    this.request?.abort()
    this.request = null
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.schedule(0)
  }

  private setBlocked(blocked: boolean): void {
    if (blocked && this.blockerId === null && this.options.blocker) {
      this.blockerId = this.options.blocker.start('prevent-app-suspension')
    } else if (!blocked && this.blockerId !== null) {
      const id = this.blockerId
      this.blockerId = null
      this.options.blocker!.stop(id)
    }
  }

  configure(settings: IdlePowerSettings): IdlePowerState {
    if (!isIdlePowerSettings(settings)) throw new Error('Invalid power settings')
    if (settings.action !== 'none' && !this.state.capabilities[settings.action]) throw new Error('Power action unavailable')
    this.options.save({ settings, lastAction: this.state.lastAction })
    this.invalidate()
    this.state.settings = { ...settings }
    this.state.notice = null
    this.observed = null
    this.emit()
    this.schedule(0)
    return this.getState()
  }

  cancel(notice: Exclude<IdlePowerNotice, null> = 'cancelled'): void {
    const hadCountdown = this.state.countdown !== null
    this.invalidate()
    if (hadCountdown) {
      this.state.notice = notice
      this.emit()
      try { this.options.notifyNotice(notice) } catch { /* The UI still exposes cancellation. */ }
    }
    this.schedule()
  }

  /** Renderer loss, system suspend and quit invalidate history as well as pending work. */
  stop(): void {
    this.running = false
    this.invalidate()
    this.observed = null
    if (this.inputTimer !== null) clearInterval(this.inputTimer)
    this.inputTimer = null
    this.emit()
  }

  dispose(): void { this.stop(); this.disposed = true }

  private emit(): void { this.options.onChange(this.getState()) }

  private invalidate(): void {
    this.generation += 1
    this.request?.abort()
    this.request = null
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.state.countdown = null
    this.countdownInput = null
    this.pendingCompletion = false
    this.quietSince = null
    this.setBlocked(false)
  }

  private schedule(delay = this.options.pollIntervalMs ?? 1000): void {
    if (!this.running || this.disposed || this.timer !== null) return
    this.timer = setTimeout(() => { this.timer = null; void this.refresh(this.generation) }, delay)
  }

  private async read(): Promise<PowerActivitySnapshot> {
    const controller = new AbortController()
    this.request = controller
    return this.options.readActivity(AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]))
  }

  private hasUserInput(): boolean {
    if (!this.countdownInput) return false
    const initial = this.countdownInput
    let idle: number
    let pointer: { x: number, y: number } | undefined
    try {
      idle = this.options.getIdleSeconds()
      pointer = this.options.getPointerPosition?.()
    } catch { return true }
    // Electron's OS idle clock has one-second resolution. Pointer movement and
    // native before-input events cancel sooner; global keyboard input is caught
    // by the next idle-clock sample, including activity in another application.
    return !Number.isFinite(idle) || idle < 0
      || idle < initial.idle + Math.floor((Date.now() - initial.at) / 1000)
      || (!!pointer && !!initial.pointer && (pointer.x !== initial.pointer.x || pointer.y !== initial.pointer.y))
  }

  private async refresh(generation: number): Promise<void> {
    try {
      if (this.state.settings.action === 'none' || !this.state.capabilities[this.state.settings.action]) return
      const snapshot = await this.read()
      if (generation !== this.generation || !this.running) return
      const previous = this.observed
      this.observed = snapshot
      if (!previous || previous.epoch !== snapshot.epoch
        || snapshot.revision < previous.revision
        || snapshot.completionSequence < previous.completionSequence
        || snapshot.scheduledCompletionSequence < previous.scheduledCompletionSequence) {
        if (this.state.countdown) this.cancel('unavailable')
        this.pendingCompletion = false
        this.quietSince = null
        this.setBlocked(false)
        return
      }
      if (this.state.countdown) {
        if (snapshot.busy || snapshot.revision !== previous.revision) { this.cancel('new-work'); return }
        if (this.hasUserInput()) { this.cancel('user-activity'); return }
        if (Date.now() >= this.state.countdown.deadline) await this.execute(generation, snapshot)
        return
      }
      const sequence = this.state.settings.scope === 'scheduled' ? 'scheduledCompletionSequence' : 'completionSequence'
      if (snapshot[sequence] > previous[sequence]) this.pendingCompletion = true
      if (snapshot.busy || snapshot.revision !== previous.revision) this.quietSince = null
      if (!this.pendingCompletion || snapshot.busy) {
        this.setBlocked(false)
        return
      }
      this.setBlocked(true)
      this.quietSince ??= Date.now()
      if (Date.now() - this.quietSince < (this.options.quietPeriodMs ?? 5000)) return
      const action = this.state.settings.action
      const seconds = this.state.settings.countdownSeconds
      const countdown = { id: randomUUID(), action, deadline: Date.now() + seconds * 1000 }
      this.state.countdown = countdown
      this.state.notice = null
      this.countdownInput = { at: Date.now(), idle: this.options.getIdleSeconds(), pointer: this.options.getPointerPosition?.() }
      this.emit()
      if (!Number.isFinite(this.countdownInput.idle) || this.countdownInput.idle < 0) { this.cancel('unavailable'); return }
      if (!this.options.notifyCountdown(countdown, seconds, notice => {
        if (this.state.countdown?.id === countdown.id) this.cancel(notice)
      })) { this.cancel('unavailable'); return }
      if (seconds === 0 && this.state.countdown) await this.execute(generation, snapshot)
    } catch {
      if (generation !== this.generation || !this.running) return
      this.cancel('unavailable')
      this.observed = null
    } finally {
      if (generation === this.generation) this.request = null
      this.schedule()
    }
  }

  private async execute(generation: number, expected: PowerActivitySnapshot): Promise<void> {
    const countdown = this.state.countdown
    if (!countdown) return
    let dispatched = false
    try {
      await this.options.execute(countdown.action, async () => {
        const fresh = await this.read()
        if (generation !== this.generation || !this.running || this.state.countdown?.id !== countdown.id) throw new Error('Power action cancelled')
        if (fresh.epoch !== expected.epoch || fresh.revision !== expected.revision || fresh.busy) {
          this.observed = fresh
          this.cancel('new-work')
          throw new Error('New work before power action')
        }
        if (this.hasUserInput()) {
          this.cancel('user-activity')
          throw new Error('User activity before power action')
        }
        const record: IdlePowerRecord = { action: countdown.action, requestedAt: Date.now(), result: 'requested' }
        this.options.save({ settings: this.state.settings, lastAction: record })
        this.state.lastAction = record
        dispatched = true
        this.state.countdown = null
        this.countdownInput = null
        this.pendingCompletion = false
        this.emit()
        // The final fresh check and durable journal are complete. Releasing here
        // lets the selected OS action proceed without suppressing manual sleep.
        this.dispatchGeneration = generation
        this.setBlocked(false)
      })
      if (!dispatched) throw new Error('Power backend did not validate dispatch')
      this.state.lastAction = { ...this.state.lastAction!, result: 'accepted' }
      try { this.options.save({ settings: this.state.settings, lastAction: this.state.lastAction }) } catch { /* The durable requested record remains truthful. */ }
      this.invalidate()
      this.emit()
    } catch {
      if (generation !== this.generation || !this.running) return
      if (dispatched) {
        this.state.lastAction = { ...this.state.lastAction!, result: 'failed' }
        try { this.options.save({ settings: this.state.settings, lastAction: this.state.lastAction }) } catch { /* Keep requested journal on disk. */ }
      }
      this.cancel('failed')
      this.state.notice = 'failed'
      this.emit()
      if (dispatched) { try { this.options.notifyNotice('failed') } catch { /* The UI still exposes failure. */ } }
    }
  }
}
