import { afterEach, describe, expect, mock, test } from 'bun:test'
import { feature } from 'bun:bundle'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  _resetForTesting,
  setAutoModeActive,
} from '../../utils/permissions/autoModeState.js'
import { resolveHookPermissionDecision } from './toolHooks.js'

const fakeTool = {
  name: 'RiskyTool',
  inputSchema: { parse: (input: unknown) => input },
  checkPermissions: async () => ({
    behavior: 'passthrough' as const,
    message: 'ask',
  }),
} as unknown as Tool

function context(mode: 'auto' | 'plan' = 'auto'): ToolUseContext {
  const toolPermissionContext = {
    ...getEmptyToolPermissionContext(),
    mode,
  }
  return {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext }) as never,
  } as ToolUseContext
}

describe('PreToolUse decisions in auto mode', () => {
  afterEach(() => {
    _resetForTesting()
  })

  test('routes hook allow through the normal permission classifier path', async () => {
    const canUseTool = mock(async () => ({
      behavior: 'deny' as const,
      message: 'classifier blocked',
      decisionReason: {
        type: 'classifier' as const,
        classifier: 'auto-mode',
        reason: 'risky',
      },
    }))

    const result = await resolveHookPermissionDecision(
      { behavior: 'allow', updatedInput: { command: 'updated' } },
      fakeTool,
      { command: 'original' },
      context(),
      canUseTool,
      {} as never,
      'toolu_hook_allow',
    )

    expect(canUseTool).toHaveBeenCalledTimes(1)
    expect(canUseTool.mock.calls[0]?.[1]).toEqual({ command: 'updated' })
    expect(result.decision.behavior).toBe('deny')
  })

  const autoModeTest = feature('TRANSCRIPT_CLASSIFIER') ? test : test.skip

  autoModeTest('also classifies hook allow while auto remains active in plan mode', async () => {
    setAutoModeActive(true)
    const canUseTool = mock(async () => ({
      behavior: 'deny' as const,
      message: 'classifier blocked',
      decisionReason: {
        type: 'classifier' as const,
        classifier: 'auto-mode',
        reason: 'risky',
      },
    }))

    const result = await resolveHookPermissionDecision(
      { behavior: 'allow' },
      fakeTool,
      { command: 'original' },
      context('plan'),
      canUseTool,
      {} as never,
      'toolu_plan_hook_allow',
    )

    expect(canUseTool).toHaveBeenCalledTimes(1)
    expect(result.decision.behavior).toBe('deny')
  })

  test('keeps hook deny final', async () => {
    const canUseTool = mock(async () => ({ behavior: 'allow' as const }))

    const result = await resolveHookPermissionDecision(
      { behavior: 'deny', message: 'hook blocked' },
      fakeTool,
      { command: 'original' },
      context(),
      canUseTool,
      {} as never,
      'toolu_hook_deny',
    )

    expect(canUseTool).not.toHaveBeenCalled()
    expect(result.decision).toMatchObject({
      behavior: 'deny',
      message: 'hook blocked',
    })
  })
})
