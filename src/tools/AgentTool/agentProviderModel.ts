import { getAgentModel } from '../../utils/model/agent.js'
import { getDefaultMainLoopModel } from '../../utils/model/model.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import {
  getProviderRuntimeContext,
  runWithProviderRuntime,
} from '../../services/api/providerRuntimeContext.js'
import { getAgentModelSetting } from './builtInAgentOverrides.js'
import type { AgentDefinition } from './loadAgentsDir.js'

/** Resolve a provider's aliases and default model before publishing task metadata. */
export function getAgentProviderModel(
  agent: AgentDefinition,
  parentModel: string,
  toolModel: string | undefined,
  permissionMode: PermissionMode,
  runtime = getProviderRuntimeContext(),
  resumedParentModel?: string,
): string {
  const resolve = () => {
    const effectiveParent = resumedParentModel ?? (agent.source === 'built-in' && agent.providerId && runtime
      ? runtime.env.ANTHROPIC_MODEL || getDefaultMainLoopModel()
      : parentModel)
    return getAgentModel(getAgentModelSetting(agent, effectiveParent), effectiveParent, toolModel, permissionMode)
  }
  return runtime ? runWithProviderRuntime(runtime, resolve) : resolve()
}

export function getBuiltInAgentProviderId(agent: AgentDefinition): string | undefined {
  return agent.source === 'built-in' ? agent.providerId : undefined
}
