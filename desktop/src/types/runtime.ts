import type { EffortLevel } from './settings'

export type RuntimeSelection = {
  providerId: string | null
  modelId: string
  effortLevel?: EffortLevel
  // Per-session override for thinking mode. Undefined means inherit from global setting.
  thinkingEnabled?: boolean
}
