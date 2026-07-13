import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  resetSettingsCache,
  setCachedSettingsForSource,
} from '../settings/settingsCache.js'
import {
  _resetForTesting as resetAutoModeState,
  setAutoModeActive,
} from './autoModeState.js'
import { createDenialTrackingState } from './denialTracking.js'

process.env.ANTHROPIC_API_KEY = 'test-key'

let classifierMode: 'allow' | 'block' | 'parse-failure' | 'unavailable' =
  'allow'
let configDir = ''

const actualSideQuery = await import('../sideQuery.js')
mock.module('../sideQuery.js', () => ({
  ...actualSideQuery,
  sideQuery: async () => {
    if (classifierMode === 'unavailable') throw new Error('classifier offline')
    const content =
      classifierMode === 'parse-failure'
        ? [{ type: 'text', text: 'not structured' }]
        : [
            {
              type: 'tool_use',
              id: 'toolu_classifier',
              name: 'classify_result',
              input: {
                thinking: 'checked policy',
                shouldBlock: classifierMode === 'block',
                reason: classifierMode === 'block' ? 'unsafe action' : 'safe action',
              },
            },
          ]
    return {
      id: 'msg_classifier',
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      stop_reason: 'tool_use',
      stop_sequence: null,
      content,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }
  },
}))

const { hasPermissionsToUseTool } = await import('./permissions.js')

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'cc-haha-auto-mode-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(() => {
  classifierMode = 'allow'
  resetSettingsCache()
  resetAutoModeState()
})

afterAll(async () => {
  if (configDir) await rm(configDir, { recursive: true, force: true })
})

const riskyTool = {
  name: 'RiskyTool',
  inputSchema: { parse: (input: unknown) => input },
  toAutoClassifierInput: (input: unknown) => input,
  checkPermissions: async () => ({
    behavior: 'ask' as const,
    message: 'manual approval required',
    decisionReason: { type: 'mode' as const, mode: 'default' as const },
  }),
} as unknown as Tool

function context(options?: {
  headless?: boolean
  consecutiveDenials?: number
  totalDenials?: number
  tool?: Tool
  allowRules?: Partial<Record<'session' | 'flagSettings' | 'policySettings', string[]>>
  mode?: 'auto' | 'plan'
}): ToolUseContext {
  let state = {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode: options?.mode ?? ('auto' as const),
      shouldAvoidPermissionPrompts: options?.headless ?? false,
      alwaysAllowRules: {
        ...getEmptyToolPermissionContext().alwaysAllowRules,
        ...options?.allowRules,
      },
    },
    denialTracking: {
      ...createDenialTrackingState(),
      consecutiveDenials: options?.consecutiveDenials ?? 0,
      totalDenials: options?.totalDenials ?? 0,
    },
  }
  return {
    abortController: new AbortController(),
    messages: [],
    options: { tools: [options?.tool ?? riskyTool], mainLoopModel: 'test-model' },
    getAppState: () => state as never,
    setAppState: update => {
      state = update(state as never) as typeof state
    },
  } as ToolUseContext
}

async function decide(ctx = context()) {
  return hasPermissionsToUseTool(
    riskyTool,
    { command: 'risky' },
    ctx,
    { message: { id: 'msg_agent' } } as never,
    'toolu_risky',
  )
}

const transcriptClassifierEnabled = feature('TRANSCRIPT_CLASSIFIER')
  ? true
  : false
const autoModeDescribe = transcriptClassifierEnabled ? describe : describe.skip

describe('auto mode permission feature guard', () => {
  const featureOffTest = transcriptClassifierEnabled ? test.skip : test

  featureOffTest('does not enable classifier-only tests without the feature', () => {
    expect(transcriptClassifierEnabled).toBe(false)
  })
})

autoModeDescribe('auto mode classifier decisions', () => {
  test('allows a classifier-approved action', async () => {
    classifierMode = 'allow'
    expect(await decide()).toMatchObject({
      behavior: 'allow',
      decisionReason: { type: 'classifier', classifier: 'auto-mode' },
    })
  })

  test('denies a classifier-blocked action', async () => {
    classifierMode = 'block'
    expect(await decide()).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'classifier', reason: 'unsafe action' },
    })
  })

  test('fails closed on an unparseable classifier response', async () => {
    classifierMode = 'parse-failure'
    expect(await decide()).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'classifier' },
    })
  })

  test('restores the original ask when the classifier is unavailable interactively', async () => {
    classifierMode = 'unavailable'
    expect(await decide()).toMatchObject({
      behavior: 'ask',
      message: 'manual approval required',
    })
  })

  test('fails closed when the classifier is unavailable headlessly', async () => {
    classifierMode = 'unavailable'
    expect(await decide(context({ headless: true }))).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'classifier', reason: 'Classifier unavailable' },
    })
  })

  test('classifies Bash even when acceptEdits would allow it under classifyAllShell', async () => {
    setCachedSettingsForSource('userSettings', {
      autoMode: { classifyAllShell: true },
    } as never)
    classifierMode = 'block'
    const shellTool = {
      name: 'Bash',
      inputSchema: { parse: (input: unknown) => input },
      toAutoClassifierInput: (input: unknown) => input,
      checkPermissions: async (_input: unknown, toolContext: ToolUseContext) =>
        toolContext.getAppState().toolPermissionContext.mode === 'acceptEdits'
          ? { behavior: 'allow' as const }
          : {
              behavior: 'ask' as const,
              message: 'manual approval required',
              decisionReason: {
                type: 'mode' as const,
                mode: 'default' as const,
              },
            },
    } as unknown as Tool
    const ctx = context({ tool: shellTool })

    expect(
      await hasPermissionsToUseTool(
        shellTool,
        { command: 'git status' },
        ctx,
        { message: { id: 'msg_agent' } } as never,
        'toolu_shell',
      ),
    ).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'classifier', reason: 'unsafe action' },
    })
  })

  test.each(['session', 'flagSettings', 'policySettings'] as const)(
    'classifies Bash before returning a %s allow rule under classifyAllShell',
    async source => {
      setCachedSettingsForSource('userSettings', {
        autoMode: { classifyAllShell: true },
      } as never)
      classifierMode = 'block'
      const shellTool = {
        name: 'Bash',
        inputSchema: { parse: (input: unknown) => input },
        toAutoClassifierInput: (input: unknown) => input,
        checkPermissions: async () => ({ behavior: 'passthrough' as const }),
      } as unknown as Tool
      const ctx = context({
        tool: shellTool,
        allowRules: { [source]: ['Bash'] },
      })

      expect(
        await hasPermissionsToUseTool(
          shellTool,
          { command: 'git status' },
          ctx,
          { message: { id: 'msg_agent' } } as never,
          `toolu_shell_${source}`,
        ),
      ).toMatchObject({
        behavior: 'deny',
        decisionReason: { type: 'classifier', reason: 'unsafe action' },
      })
    },
  )

  test('classifies a dynamic Bash allow result under classifyAllShell', async () => {
    setCachedSettingsForSource('userSettings', {
      autoMode: { classifyAllShell: true },
    } as never)
    classifierMode = 'block'
    const shellTool = {
      name: 'Bash',
      inputSchema: { parse: (input: unknown) => input },
      toAutoClassifierInput: (input: unknown) => input,
      checkPermissions: async () => ({ behavior: 'allow' as const }),
    } as unknown as Tool

    expect(
      await hasPermissionsToUseTool(
        shellTool,
        { command: 'git status' },
        context({ tool: shellTool }),
        { message: { id: 'msg_agent' } } as never,
        'toolu_dynamic_shell',
      ),
    ).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'classifier', reason: 'unsafe action' },
    })
  })

  test('classifies a Plan-mode shell allow while Auto remains active', async () => {
    setCachedSettingsForSource('userSettings', {
      autoMode: { classifyAllShell: true },
    } as never)
    setAutoModeActive(true)
    classifierMode = 'block'
    const shellTool = {
      name: 'Bash',
      inputSchema: { parse: (input: unknown) => input },
      toAutoClassifierInput: (input: unknown) => input,
      checkPermissions: async () => ({ behavior: 'allow' as const }),
    } as unknown as Tool

    expect(
      await hasPermissionsToUseTool(
        shellTool,
        { command: 'git status' },
        context({ tool: shellTool, mode: 'plan' }),
        { message: { id: 'msg_agent' } } as never,
        'toolu_plan_shell',
      ),
    ).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'classifier', reason: 'unsafe action' },
    })
  })

  test('classifies PowerShell instead of returning its interactive guard under classifyAllShell', async () => {
    setCachedSettingsForSource('userSettings', {
      autoMode: { classifyAllShell: true },
    } as never)
    classifierMode = 'block'
    const shellTool = {
      name: 'PowerShell',
      inputSchema: { parse: (input: unknown) => input },
      toAutoClassifierInput: (input: unknown) => input,
      checkPermissions: async () => ({
        behavior: 'ask' as const,
        message: 'PowerShell permission required',
      }),
    } as unknown as Tool

    expect(
      await hasPermissionsToUseTool(
        shellTool,
        { command: 'Get-ChildItem' },
        context({ tool: shellTool }),
        { message: { id: 'msg_agent' } } as never,
        'toolu_powershell',
      ),
    ).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'classifier', reason: 'unsafe action' },
    })
  })
})

autoModeDescribe('auto mode denial limits', () => {
  test('falls back to human review after three consecutive denials', async () => {
    classifierMode = 'block'
    expect(await decide(context({ consecutiveDenials: 2, totalDenials: 2 }))).toMatchObject({
      behavior: 'ask',
      decisionReason: { type: 'classifier' },
    })
  })

  test('falls back to human review after twenty total denials', async () => {
    classifierMode = 'block'
    expect(await decide(context({ consecutiveDenials: 0, totalDenials: 19 }))).toMatchObject({
      behavior: 'ask',
      decisionReason: { type: 'classifier' },
    })
  })
})
