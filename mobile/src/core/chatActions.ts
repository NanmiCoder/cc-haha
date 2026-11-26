import type { ChatState, ClientMessage, RuntimeConfig } from './types'
import { ANTIGRAVITY_DEFAULT_MODEL, ANTIGRAVITY_PROVIDER_ID } from './runtimeCatalog'

export function runtimeMatches(
  actual: RuntimeConfig | undefined,
  desired: RuntimeConfig
) {
  const modelMatches =
    actual?.modelId === desired.modelId ||
    (desired.providerId === ANTIGRAVITY_PROVIDER_ID &&
      desired.modelId === ANTIGRAVITY_DEFAULT_MODEL &&
      Boolean(actual?.modelId))
  return (
    !!actual &&
    actual.providerId === desired.providerId &&
    modelMatches &&
    (desired.effortLevel === undefined ||
      actual.effortLevel === desired.effortLevel) &&
    (desired.openAIFastMode === undefined ||
      actual.openAIFastMode === desired.openAIFastMode)
  )
}

/** A notification is a reference to one pending tool request, never blanket consent. */
export function notificationPermissionResponse(
  state: ChatState,
  action?: string,
  requestId?: string
): Extract<ClientMessage, { type: 'permission_response' }> | null {
  if (!requestId || (action !== 'allow' && action !== 'deny')) return null
  const request = state.permissions.find(
    (value) => value.requestId === requestId
  )
  if (
    !request ||
    request.toolName === 'AskUserQuestion' ||
    request.toolName === 'ExitPlanMode'
  )
    return null
  return { type: 'permission_response', requestId, allowed: action === 'allow' }
}
