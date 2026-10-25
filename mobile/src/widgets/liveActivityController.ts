import {
  staleActivityProps,
  type FinishedActivity,
  type TaskActivityProps,
} from './activityData'

export type DismissalPolicy = 'immediate' | 'default' | { after: Date }
export type ActivityInstance = {
  getId(): string
  update(props: TaskActivityProps, staleDate?: Date): Promise<void>
  end(
    policy?: DismissalPolicy,
    props?: TaskActivityProps,
    date?: Date
  ): Promise<void>
  getPushToken(): Promise<string | null>
  addPushTokenListener(listener: (event: { pushToken: string }) => void): {
    remove(): void
  }
}
export type ActivityFactory = {
  getInstances(): ActivityInstance[]
  start(
    props: TaskActivityProps,
    url?: string,
    staleDate?: Date
  ): ActivityInstance
}
export type RegisterActivityToken = (
  activityId: string,
  token: string,
  props: TaskActivityProps
) => Promise<(() => Promise<void>) | undefined>

/** Serializes ActivityKit and registration changes, including a host switch during an update. */
export class TaskActivityController {
  private queue: Promise<unknown> = Promise.resolve()
  private nativeQueue: Promise<unknown> = Promise.resolve()
  private initialized = false
  private fresh = true
  private current?: {
    instance: ActivityInstance
    props: TaskActivityProps
    listener: { remove(): void }
    token?: string
    registrationKey: string
    desiredKey: string
    register: RegisterActivityToken
    registeredAt?: number
    unregister?: () => Promise<void>
  }
  constructor(
    private factory: ActivityFactory,
    private now: () => number = Date.now
  ) {}
  sync(
    props: TaskActivityProps | null,
    register: RegisterActivityToken,
    registrationKey: string,
    finished: FinishedActivity[] = []
  ): Promise<void> {
    this.fresh = props !== null
    return this.serial(async () => {
      if (!this.initialized) {
        // Native activities survive a process restart. Replace our old activity only
        // after a fresh desktop snapshot has arrived; never guess its session owner.
        for (const activity of this.factory.getInstances())
          await activity.end('immediate')
        this.initialized = true
      }
      const tracked = this.current
      const done =
        tracked &&
        finished.find(
          (item) =>
            item.props.hostId === tracked.props.hostId &&
            item.props.sessionId === tracked.props.sessionId
        )
      // A session that is live again in this snapshot is not finished.
      if (
        done &&
        !(
          props &&
          props.hostId === done.props.hostId &&
          props.sessionId === done.props.sessionId
        )
      )
        await this.conclude(done)
      if (
        !props ||
        (this.current &&
          (this.current.props.hostId !== props.hostId ||
            this.current.props.sessionId !== props.sessionId))
      )
        await this.finish()
      if (!props) return
      const staleDate = new Date(this.now() + 90000)
      if (!this.current) {
        if (!this.fresh) return
        const instance = this.factory.start(props, props.openUrl, staleDate)
        const listener = instance.addPushTokenListener((event) => {
          void this.serial(async () => {
            if (this.current?.instance !== instance) return
            await this.registerToken(event.pushToken)
          }).catch(() => {})
        })
        this.current = {
          instance,
          listener,
          props,
          registrationKey: '',
          desiredKey: registrationKey,
          register,
        }
      } else {
        this.current.register = register
        this.current.desiredKey = registrationKey
        const current = this.current
        await this.native(async () => {
          current.props = this.fresh ? props : staleActivityProps(props)
          await current.instance.update(
            current.props,
            this.fresh ? staleDate : new Date(this.now() - 1)
          )
        })
      }
      if (!this.fresh) return
      const token = await this.current.instance.getPushToken()
      if (token) await this.registerToken(token)
    })
  }
  /** Called only after the host's collection revoke succeeded. Do not enqueue a
   * second HTTP revoke from inside the host-removal transaction. */
  retireHost(hostId: string) {
    return this.serial(async () => {
      if (!this.initialized) {
        // Recovered instances have no readable props in this SDK. Retire them on
        // removal rather than leaving an actionable card for an unknown owner.
        for (const activity of this.factory.getInstances())
          await activity.end('immediate')
        this.initialized = true
      }
      if (this.current?.props.hostId === hostId) await this.finish(false)
    })
  }
  markStale() {
    this.fresh = false
    if (!this.initialized && !this.current)
      return this.serial(async () => {
        if (this.initialized) return
        for (const activity of this.factory.getInstances())
          await activity.end('immediate')
        this.initialized = true
      })
    // Native rendering has its own queue: an offline HTTP registration must not
    // delay removing already-obsolete action links from the lock screen.
    return this.native(async () => {
      if (this.fresh) return
      if (!this.current) return
      if (this.current.props.connectionState === 'stale') return
      this.current.props = staleActivityProps(this.current.props)
      await this.current.instance.update(
        this.current.props,
        new Date(this.now() - 1)
      )
    })
  }
  private async registerToken(token: string) {
    const current = this.current
    const registrationKey = current?.desiredKey
    if (
      !this.fresh ||
      !current ||
      (current.token === token &&
        current.registrationKey === registrationKey &&
        (current.unregister ||
          this.now() - (current.registeredAt ?? 0) < 60000))
    )
      return
    // A preference update may reuse the same server registration ID and token.
    // Deleting after the PUT would accidentally delete the replacement record.
    if (current.unregister) {
      await current.unregister()
      current.unregister = undefined
    }
    const unregister = await current.register(
      current.instance.getId(),
      token,
      current.props
    )
    current.token = token
    current.registrationKey = current.desiredKey
    current.registeredAt = this.now()
    current.unregister = unregister
  }
  /** Show the final completed/failed card until its dismissal date, then let
   * ActivityKit remove it. Outcomes already past their window end immediately. */
  private async conclude(done: FinishedActivity) {
    const current = this.current
    if (!current) return
    current.listener.remove()
    const linger = done.dismissAt > this.now()
    await this.native(() =>
      linger
        ? current.instance.end({ after: new Date(done.dismissAt) }, done.props)
        : current.instance.end('immediate')
    )
    this.current = undefined
    if (current.unregister) await current.unregister()
  }
  private async finish(revoke = true) {
    const current = this.current
    if (!current) return
    current.listener.remove()
    await this.native(() => current.instance.end('immediate'))
    this.current = undefined
    if (revoke && current.unregister) await current.unregister()
  }
  private serial(task: () => Promise<void>) {
    const result = this.queue.then(task)
    this.queue = result.catch(() => {})
    return result
  }
  private native(task: () => Promise<void>) {
    const result = this.nativeQueue.then(task)
    this.nativeQueue = result.catch(() => {})
    return result
  }
}
