/** One computer the Android foreground service pulls alerts from. */
export type DutyHost = {
  hostId: string
  hostName: string
  /** Request origin, e.g. `http://192.168.1.8:3456`. */
  origin: string
  /** The same authentication the app's own requests carry. */
  headers: Record<string, string>
  /** The pull token this phone registered with that computer. */
  token: string
}

/** `modules/cchaha-duty`; absent on iOS, web and builds without the module. */
export type DutyNative = {
  setHost(json: string): void
  removeHost(hostId: string): void
  retainHosts(json: string): void
  setAppActive(active: boolean): void
}

/**
 * The native service keeps its own list of computers, so it can run while the
 * app is gone. This only reports per-computer facts, never a whole list: at
 * launch the app knows nothing yet, and a computer that is offline then must not
 * drop out of background pulling.
 */
export class BackgroundDuty {
  constructor(private native: DutyNative | null) {}

  /**
   * A registration result for one computer. Sent on every registration, changed
   * or not: the service drops a computer that answered 404, and the next
   * registration restores it. Unchanged hosts keep their connection.
   */
  set(hostId: string, host: DutyHost | undefined) {
    try {
      if (host) this.native?.setHost(JSON.stringify(host))
      else this.native?.removeHost(hostId)
    } catch {
      // The next registration reports this computer again.
    }
  }

  /** Forget computers this phone no longer has, e.g. removed while the module was unavailable. */
  retain(hostIds: string[]) {
    try {
      this.native?.retainHosts(JSON.stringify(hostIds))
    } catch {}
  }

  setAppActive(active: boolean) {
    try {
      this.native?.setAppActive(active)
    } catch {}
  }
}
