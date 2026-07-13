import { describe, expect, it } from 'bun:test'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { PermissionDecision } from './PermissionResult.js'
import {
  checkRuleBasedPermissions,
  hasPermissionsToUseTool,
  syncPermissionRulesFromDisk,
} from './permissions.js'

const inputSchema = {
  parse: (input: Record<string, unknown>) => input,
}

function permissionContext(
  overrides: Partial<ToolPermissionContext>,
): ToolPermissionContext {
  return {
    ...getEmptyToolPermissionContext(),
    ...overrides,
  }
}

function toolUseContext(
  toolPermissionContext: ToolPermissionContext,
): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () =>
      ({
        toolPermissionContext,
      }) as ReturnType<ToolUseContext['getAppState']>,
    setAppState: () => {},
  } as ToolUseContext
}

function fakeTool({
  permissionDecision,
  requiresUserInteraction = false,
}: {
  permissionDecision: PermissionDecision | { behavior: 'passthrough'; message: string }
  requiresUserInteraction?: boolean
}): Tool {
  return {
    name: 'FakeTool',
    inputSchema,
    checkPermissions: async () => permissionDecision,
    requiresUserInteraction: () => requiresUserInteraction,
  } as unknown as Tool
}

async function canUseFakeTool(
  tool: Tool,
  toolPermissionContext: ToolPermissionContext,
): Promise<PermissionDecision> {
  return hasPermissionsToUseTool(
    tool,
    {},
    toolUseContext(toolPermissionContext),
    {} as never,
    'toolu_test',
  )
}

describe('hasPermissionsToUseTool bypassPermissions mode', () => {
  it('ignores whole-tool ask rules', async () => {
    const result = await canUseFakeTool(
      fakeTool({
        permissionDecision: {
          behavior: 'passthrough',
          message: 'No tool-specific decision',
        },
      }),
      permissionContext({
        mode: 'bypassPermissions',
        isBypassPermissionsModeAvailable: true,
        alwaysAskRules: {
          session: ['FakeTool'],
        },
      }),
    )

    expect(result).toMatchObject({
      behavior: 'allow',
      decisionReason: {
        type: 'mode',
        mode: 'bypassPermissions',
      },
    })
  })

  it('keeps whole-tool ask rules in default mode', async () => {
    const result = await canUseFakeTool(
      fakeTool({
        permissionDecision: {
          behavior: 'passthrough',
          message: 'No tool-specific decision',
        },
      }),
      permissionContext({
        mode: 'default',
        alwaysAskRules: {
          session: ['FakeTool'],
        },
      }),
    )

    expect(result).toMatchObject({
      behavior: 'ask',
      decisionReason: {
        type: 'rule',
      },
    })
  })

  it('ignores content-specific ask rules returned by tools', async () => {
    const result = await canUseFakeTool(
      fakeTool({
        permissionDecision: {
          behavior: 'ask',
          message: 'Ask rule matched',
          decisionReason: {
            type: 'rule',
            rule: {
              source: 'session',
              ruleBehavior: 'ask',
              ruleValue: {
                toolName: 'FakeTool',
                ruleContent: 'sensitive:*',
              },
            },
          },
        },
      }),
      permissionContext({
        mode: 'bypassPermissions',
        isBypassPermissionsModeAvailable: true,
      }),
    )

    expect(result).toMatchObject({
      behavior: 'allow',
      decisionReason: {
        type: 'mode',
        mode: 'bypassPermissions',
      },
    })
  })

  it('ignores safety-check ask decisions', async () => {
    const result = await canUseFakeTool(
      fakeTool({
        permissionDecision: {
          behavior: 'ask',
          message: 'Safety check matched',
          decisionReason: {
            type: 'safetyCheck',
            reason: 'Protected path',
          },
        },
      }),
      permissionContext({
        mode: 'bypassPermissions',
        isBypassPermissionsModeAvailable: true,
      }),
    )

    expect(result).toMatchObject({
      behavior: 'allow',
      decisionReason: {
        type: 'mode',
        mode: 'bypassPermissions',
      },
    })
  })

  it('preserves explicit deny decisions', async () => {
    const result = await canUseFakeTool(
      fakeTool({
        permissionDecision: {
          behavior: 'deny',
          message: 'Denied by rule',
          decisionReason: {
            type: 'rule',
            rule: {
              source: 'session',
              ruleBehavior: 'deny',
              ruleValue: {
                toolName: 'FakeTool',
              },
            },
          },
        },
      }),
      permissionContext({
        mode: 'bypassPermissions',
        isBypassPermissionsModeAvailable: true,
      }),
    )

    expect(result).toMatchObject({
      behavior: 'deny',
      message: 'Denied by rule',
    })
  })

  it('preserves prompts for tools that require user interaction', async () => {
    const result = await canUseFakeTool(
      fakeTool({
        requiresUserInteraction: true,
        permissionDecision: {
          behavior: 'ask',
          message: 'Needs user input',
        },
      }),
      permissionContext({
        mode: 'bypassPermissions',
        isBypassPermissionsModeAvailable: true,
      }),
    )

    expect(result).toMatchObject({
      behavior: 'ask',
      message: 'Needs user input',
    })
  })

  it('lets hook rule checks skip ask rules in bypass mode', async () => {
    const result = await checkRuleBasedPermissions(
      fakeTool({
        permissionDecision: {
          behavior: 'ask',
          message: 'Ask rule matched',
          decisionReason: {
            type: 'rule',
            rule: {
              source: 'session',
              ruleBehavior: 'ask',
              ruleValue: {
                toolName: 'FakeTool',
                ruleContent: 'sensitive:*',
              },
            },
          },
        },
      }),
      {},
      toolUseContext(permissionContext({
        mode: 'bypassPermissions',
        isBypassPermissionsModeAvailable: true,
      })),
    )

    expect(result).toBeNull()
  })

  it('keeps hook rule-check denies in bypass mode', async () => {
    const result = await checkRuleBasedPermissions(
      fakeTool({
        permissionDecision: {
          behavior: 'deny',
          message: 'Denied by rule',
          decisionReason: {
            type: 'rule',
            rule: {
              source: 'session',
              ruleBehavior: 'deny',
              ruleValue: {
                toolName: 'FakeTool',
              },
            },
          },
        },
      }),
      {},
      toolUseContext(permissionContext({
        mode: 'bypassPermissions',
        isBypassPermissionsModeAvailable: true,
      })),
    )

    expect(result).toMatchObject({
      behavior: 'deny',
      message: 'Denied by rule',
    })
  })
})

describe('syncPermissionRulesFromDisk', () => {
  it('revokes stale policy and flag rules on an empty settings snapshot', () => {
    const context = permissionContext({
      alwaysAllowRules: {
        policySettings: ['FakeTool'],
        flagSettings: ['FakeTool'],
        session: ['SessionTool'],
      },
      alwaysDenyRules: {
        policySettings: ['DeniedTool'],
        flagSettings: ['DeniedTool'],
      },
      alwaysAskRules: {
        policySettings: ['AskedTool'],
        flagSettings: ['AskedTool'],
      },
    })

    const synced = syncPermissionRulesFromDisk(context, [])

    expect(synced.alwaysAllowRules.policySettings).toEqual([])
    expect(synced.alwaysAllowRules.flagSettings).toEqual([])
    expect(synced.alwaysDenyRules.policySettings).toEqual([])
    expect(synced.alwaysDenyRules.flagSettings).toEqual([])
    expect(synced.alwaysAskRules.policySettings).toEqual([])
    expect(synced.alwaysAskRules.flagSettings).toEqual([])
    expect(synced.alwaysAllowRules.session).toEqual(['SessionTool'])
  })
})
