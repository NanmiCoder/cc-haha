import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { jsonStringify } from '../slowOperations.js'
import {
  createPermissionRequestMessage,
  createSandboxPermissionRequestMessage,
  isPermissionResponse,
  isSandboxPermissionResponse,
  type TeammateMessage,
} from '../teammateMailbox.js'
import * as mailbox from '../teammateMailbox.js'
import {
  HEADLESS_TEAMMATE_PERMISSION_UNAVAILABLE,
  partitionLeadMailboxMessages,
  resolveTeammatePermissionRequests,
  type HostToolPermissionPrompt,
} from './printLeaderPermissionBridge.js'

function mailboxMessage(
  from: string,
  payload: unknown,
  extras: Partial<TeammateMessage> = {},
): TeammateMessage {
  return {
    from,
    text: jsonStringify(payload),
    timestamp: new Date().toISOString(),
    read: false,
    ...extras,
  }
}

describe('printLeaderPermissionBridge', () => {
  const writes: Array<{ to: string; text: string; teamName?: string }> = []
  let writeSpy: ReturnType<typeof spyOn> | undefined

  afterEach(() => {
    writes.length = 0
    writeSpy?.mockRestore()
    writeSpy = undefined
  })

  function captureMailboxWrites() {
    writeSpy = spyOn(mailbox, 'writeToMailbox').mockImplementation(
      async (to, message, teamName) => {
        writes.push({ to, text: message.text, teamName })
      },
    )
  }

  test('keeps permission and sandbox asks out of remaining teammate chat', () => {
    const permission = createPermissionRequestMessage({
      request_id: 'perm-1',
      agent_id: 'researcher',
      tool_name: 'Bash',
      tool_use_id: 'toolu_1',
      description: 'list files',
      input: { command: 'ls' },
    })
    const sandbox = createSandboxPermissionRequestMessage({
      requestId: 'sandbox-1',
      workerId: 'w1',
      workerName: 'researcher',
      host: 'example.com',
    })
    const chat = mailboxMessage('researcher', 'need a second look at the plan')

    const partitioned = partitionLeadMailboxMessages([
      mailboxMessage('researcher', permission),
      mailboxMessage('researcher', sandbox),
      chat,
    ])

    expect(partitioned.permissionRequests).toHaveLength(1)
    expect(partitioned.permissionRequests[0]?.parsed.request_id).toBe('perm-1')
    expect(partitioned.sandboxPermissionRequests).toHaveLength(1)
    expect(partitioned.sandboxPermissionRequests[0]?.parsed.requestId).toBe(
      'sandbox-1',
    )
    expect(partitioned.remaining).toEqual([chat])
  })

  test('rejects teammate tool asks when the host cannot prompt', async () => {
    captureMailboxWrites()
    const parsed = createPermissionRequestMessage({
      request_id: 'perm-deny-no-host',
      agent_id: 'researcher',
      tool_name: 'Bash',
      tool_use_id: 'toolu_deny',
      description: 'rm -rf /',
      input: { command: 'rm -rf /' },
    })
    const host: HostToolPermissionPrompt = {
      askHostForToolPermission: mock(() => {
        throw new Error('host should not be prompted')
      }),
    }

    await resolveTeammatePermissionRequests({
      host,
      canPromptHost: false,
      teamName: 'team-alpha',
      permissionRequests: [
        { message: mailboxMessage('researcher', parsed), parsed },
      ],
      sandboxPermissionRequests: [],
    })

    expect(host.askHostForToolPermission).not.toHaveBeenCalled()
    expect(writes).toHaveLength(1)
    expect(writes[0]?.to).toBe('researcher')
    expect(writes[0]?.teamName).toBe('team-alpha')
    expect(isPermissionResponse(writes[0]?.text ?? '')).toEqual(
      expect.objectContaining({
        type: 'permission_response',
        request_id: 'perm-deny-no-host',
        subtype: 'error',
        error: HEADLESS_TEAMMATE_PERMISSION_UNAVAILABLE,
      }),
    )
  })

  test('writes an approved mailbox response after the host allows the tool', async () => {
    captureMailboxWrites()
    const parsed = createPermissionRequestMessage({
      request_id: 'perm-allow',
      agent_id: 'researcher',
      tool_name: 'Bash',
      tool_use_id: 'toolu_allow',
      description: 'list files',
      input: { command: 'ls' },
    })
    const host: HostToolPermissionPrompt = {
      askHostForToolPermission: mock(async params => {
        expect(params).toEqual({
          toolName: 'Bash',
          input: { command: 'ls' },
          toolUseId: 'toolu_allow',
          description: 'list files',
          displayName: 'researcher',
          permissionSuggestions: [],
        })
        return {
          behavior: 'allow',
          updatedInput: { command: 'ls -la' },
        }
      }),
    }

    await resolveTeammatePermissionRequests({
      host,
      canPromptHost: true,
      teamName: 'team-alpha',
      permissionRequests: [
        { message: mailboxMessage('researcher', parsed), parsed },
      ],
      sandboxPermissionRequests: [],
    })

    expect(writes).toHaveLength(1)
    const parsedResponse = isPermissionResponse(writes[0]?.text ?? '')
    expect(parsedResponse).toEqual(
      expect.objectContaining({
        type: 'permission_response',
        request_id: 'perm-allow',
        subtype: 'success',
      }),
    )
    expect(
      parsedResponse && 'response' in parsedResponse
        ? parsedResponse.response?.updated_input
        : undefined,
    ).toEqual({ command: 'ls -la' })
  })

  test('forwards teammate sandbox network asks through the host prompt', async () => {
    captureMailboxWrites()
    const parsed = createSandboxPermissionRequestMessage({
      requestId: 'sandbox-allow',
      workerId: 'w1',
      workerName: 'researcher',
      host: 'api.example.com',
    })
    const host: HostToolPermissionPrompt = {
      askHostForToolPermission: mock(async params => {
        expect(params.toolName).toBe('SandboxNetworkAccess')
        expect(params.description).toContain('api.example.com')
        expect(params.input).toEqual({ host: 'api.example.com' })
        expect(params.displayName).toBe('researcher')
        return { behavior: 'allow', updatedInput: params.input }
      }),
    }

    await resolveTeammatePermissionRequests({
      host,
      canPromptHost: true,
      teamName: 'team-alpha',
      permissionRequests: [],
      sandboxPermissionRequests: [
        { message: mailboxMessage('researcher', parsed), parsed },
      ],
    })

    expect(writes).toHaveLength(1)
    expect(isSandboxPermissionResponse(writes[0]?.text ?? '')).toEqual(
      expect.objectContaining({
        type: 'sandbox_permission_response',
        requestId: 'sandbox-allow',
        host: 'api.example.com',
        allow: true,
      }),
    )
  })
})
