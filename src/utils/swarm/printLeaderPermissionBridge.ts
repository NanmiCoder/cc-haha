/**
 * Headless / desktop host for teammate permission requests.
 *
 * Interactive REPL consumes mailbox permission_request via useInboxPoller and
 * the in-memory leaderPermissionBridge. --print never mounts REPL, so those
 * requests used to be formatted as ordinary teammate chat and injected into
 * the model while the worker waited forever.
 *
 * This module is the missing leader-side consumer: classify mailbox messages,
 * prompt the SDK host through the existing can_use_tool protocol, then write
 * the resolution back to the worker mailbox. Members never see a permission
 * UI of their own — the lead session is the only approval surface.
 */
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import type { PermissionUpdate } from '../permissions/PermissionUpdateSchema.js'
import {
  isPermissionRequest,
  isSandboxPermissionRequest,
  type PermissionRequestMessage,
  type SandboxPermissionRequestMessage,
  type TeammateMessage,
} from '../teammateMailbox.js'
import {
  sendPermissionResponseViaMailbox,
  sendSandboxPermissionResponseViaMailbox,
} from './permissionSync.js'

export const HEADLESS_TEAMMATE_PERMISSION_UNAVAILABLE =
  'Team lead cannot prompt for teammate tool permission in this session.'

export type HostToolPermissionDecision =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      updatedPermissions?: PermissionUpdate[]
    }
  | {
      behavior: 'deny'
      message?: string
    }

export type HostToolPermissionPrompt = {
  askHostForToolPermission(params: {
    toolName: string
    input: Record<string, unknown>
    toolUseId: string
    description?: string
    displayName?: string
    permissionSuggestions?: unknown[]
  }): Promise<HostToolPermissionDecision>
}

export type PartitionedLeadMailbox = {
  permissionRequests: Array<{
    message: TeammateMessage
    parsed: PermissionRequestMessage
  }>
  sandboxPermissionRequests: Array<{
    message: TeammateMessage
    parsed: SandboxPermissionRequestMessage
  }>
  remaining: TeammateMessage[]
}

export function partitionLeadMailboxMessages(
  messages: TeammateMessage[],
): PartitionedLeadMailbox {
  const permissionRequests: PartitionedLeadMailbox['permissionRequests'] = []
  const sandboxPermissionRequests: PartitionedLeadMailbox['sandboxPermissionRequests'] =
    []
  const remaining: TeammateMessage[] = []

  for (const message of messages) {
    const permissionRequest = isPermissionRequest(message.text)
    if (permissionRequest) {
      permissionRequests.push({ message, parsed: permissionRequest })
      continue
    }
    const sandboxRequest = isSandboxPermissionRequest(message.text)
    if (sandboxRequest) {
      sandboxPermissionRequests.push({ message, parsed: sandboxRequest })
      continue
    }
    remaining.push(message)
  }

  return { permissionRequests, sandboxPermissionRequests, remaining }
}

export async function resolveTeammatePermissionRequests(params: {
  host: HostToolPermissionPrompt
  canPromptHost: boolean
  teamName: string | undefined
  permissionRequests: PartitionedLeadMailbox['permissionRequests']
  sandboxPermissionRequests: PartitionedLeadMailbox['sandboxPermissionRequests']
}): Promise<void> {
  const {
    host,
    canPromptHost,
    teamName,
    permissionRequests,
    sandboxPermissionRequests,
  } = params

  await Promise.all([
    ...permissionRequests.map(({ parsed }) =>
      resolveToolPermission({
        host,
        canPromptHost,
        teamName,
        parsed,
      }),
    ),
    ...sandboxPermissionRequests.map(({ parsed }) =>
      resolveSandboxPermission({
        host,
        canPromptHost,
        teamName,
        parsed,
      }),
    ),
  ])
}

async function resolveToolPermission(params: {
  host: HostToolPermissionPrompt
  canPromptHost: boolean
  teamName: string | undefined
  parsed: PermissionRequestMessage
}): Promise<void> {
  const { host, canPromptHost, teamName, parsed } = params
  const reject = (feedback: string) =>
    sendPermissionResponseViaMailbox(
      parsed.agent_id,
      {
        decision: 'rejected',
        resolvedBy: 'leader',
        feedback,
      },
      parsed.request_id,
      teamName,
    )

  if (!canPromptHost) {
    logForDebugging(
      `[print.ts] Rejecting teammate permission for ${parsed.tool_name} from ${parsed.agent_id}: no host prompt`,
    )
    await reject(HEADLESS_TEAMMATE_PERMISSION_UNAVAILABLE)
    return
  }

  try {
    const result = await host.askHostForToolPermission({
      toolName: parsed.tool_name,
      input: parsed.input,
      toolUseId: parsed.tool_use_id,
      description: parsed.description,
      // display_name labels the member on the lead-session prompt.
      // Do not send worker identity as agent_id: desktop treats a set
      // agent_id as a stopped-subagent permission and drops it.
      displayName: parsed.agent_id,
      permissionSuggestions: parsed.permission_suggestions,
    })
    if (result.behavior === 'allow') {
      await sendPermissionResponseViaMailbox(
        parsed.agent_id,
        {
          decision: 'approved',
          resolvedBy: 'leader',
          updatedInput: result.updatedInput,
          permissionUpdates: result.updatedPermissions,
        },
        parsed.request_id,
        teamName,
      )
      return
    }
    await reject(result.message || 'Permission denied')
  } catch (error) {
    logForDebugging(
      `[print.ts] Host prompt failed for teammate permission ${parsed.request_id}: ${errorMessage(error)}`,
    )
    await reject(errorMessage(error))
  }
}

async function resolveSandboxPermission(params: {
  host: HostToolPermissionPrompt
  canPromptHost: boolean
  teamName: string | undefined
  parsed: SandboxPermissionRequestMessage
}): Promise<void> {
  const { host, canPromptHost, teamName, parsed } = params
  const hostName = parsed.hostPattern?.host
  if (!hostName) {
    logForDebugging(
      '[print.ts] Ignoring sandbox permission request with no host',
    )
    return
  }

  const respond = (allow: boolean) =>
    sendSandboxPermissionResponseViaMailbox(
      parsed.workerName,
      parsed.requestId,
      hostName,
      allow,
      teamName,
    )

  if (!canPromptHost) {
    logForDebugging(
      `[print.ts] Denying teammate sandbox access to ${hostName} from ${parsed.workerName}: no host prompt`,
    )
    await respond(false)
    return
  }

  try {
    const result = await host.askHostForToolPermission({
      // Keep this aligned with SANDBOX_NETWORK_ACCESS_TOOL_NAME in structuredIO.
      toolName: 'SandboxNetworkAccess',
      input: { host: hostName },
      toolUseId: parsed.requestId,
      description: `${parsed.workerName} needs network access to ${hostName}`,
      displayName: parsed.workerName,
    })
    await respond(result.behavior === 'allow')
  } catch (error) {
    logForDebugging(
      `[print.ts] Host prompt failed for teammate sandbox permission ${parsed.requestId}: ${errorMessage(error)}`,
    )
    await respond(false)
  }
}
