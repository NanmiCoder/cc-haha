import { requireOptionalNativeModule } from 'expo'

export type DutyStatus = {
  /** The foreground service is running. */
  running: boolean
  /** At least one computer answered the service's last pull. */
  connected: boolean
  /** The system will not suspend the service's network in Doze. */
  batteryOptimizationIgnored: boolean
}

type CCHahaDutyModule = {
  /** Adds or updates one `DutyHost` (JSON) and starts the service. */
  setHost(json: string): void
  /** The service stops when its last computer is removed. */
  removeHost(hostId: string): void
  /** JSON array of host IDs to keep; every other computer is removed. */
  retainHosts(json: string): void
  setAppActive(active: boolean): void
  status(): DutyStatus
  requestIgnoreBatteryOptimizations(): void
}

/** Android only; `null` elsewhere. */
export default requireOptionalNativeModule<CCHahaDutyModule>('CCHahaDuty')
