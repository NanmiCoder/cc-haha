import type { RuntimeSelection } from '../../../types/runtime'

export type SensitiveRuntimeSwitchPlan = 'none' | 'confirm-provider' | 'notice-model'

export function sensitiveRuntimeSwitchPlan(input: {
  sensitiveContext: boolean
  current: RuntimeSelection | null | undefined
  next: RuntimeSelection
}): SensitiveRuntimeSwitchPlan {
  if (!input.sensitiveContext || !input.current) return 'none'
  if ((input.current.providerId ?? null) !== (input.next.providerId ?? null)) {
    return 'confirm-provider'
  }
  if (input.current.modelId !== input.next.modelId) return 'notice-model'
  return 'none'
}
