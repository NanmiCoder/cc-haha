import { describe, expect, test } from 'bun:test'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { createUserMessage } from '../../utils/messages.js'
import type { CustomAgentDefinition } from './loadAgentsDir.js'
import {
  resolvePersistedAgentType,
  runAgent,
  selectInitialTranscriptMessages,
  selectUnrecordedTranscriptMessages,
  resolveSubagentEffortValue,
  resolveSubagentThinkingConfig,
} from './runAgent.js'

describe('subagent runtime configuration', () => {
  test('keeps a resumed teammate identity while allowing ordinary agents to use their runtime type', () => {
    expect(
      resolvePersistedAgentType('id-worker-a', 'general-purpose'),
    ).toBe('id-worker-a')
    expect(resolvePersistedAgentType(undefined, 'Explore')).toBe('Explore')
    expect(resolvePersistedAgentType('  ', 'general-purpose')).toBe(
      'general-purpose',
    )
  })

  test('records only new continuation messages while keeping the persisted parent chain', () => {
    const persisted = createUserMessage({ content: 'old turn' })
    const continuation = createUserMessage({ content: 'new turn' })

    expect(selectInitialTranscriptMessages(
      [persisted, continuation],
      1,
    )).toEqual({
      messages: [continuation],
      startingParentUuid: persisted.uuid,
    })
    expect(selectInitialTranscriptMessages(
      [persisted, continuation],
      undefined,
    )).toEqual({
      messages: [persisted, continuation],
      startingParentUuid: undefined,
    })
  })

  test('appends only what follows the last recorded message of a long-lived transcript', () => {
    const recorded = createUserMessage({ content: 'old prompt' })
    const recordedAnswer = createUserMessage({ content: 'old tool result' })
    const notRecorded = createUserMessage({ content: 'kept in memory only' })
    const next = createUserMessage({ content: 'new prompt' })

    expect(selectUnrecordedTranscriptMessages(
      [recorded, notRecorded, recordedAnswer, next],
      new Set([recorded.uuid, recordedAnswer.uuid]),
    )).toEqual({
      messages: [next],
      startingParentUuid: recordedAnswer.uuid,
    })
    // Progress entries are recorded but never chained to
    const recordedProgress = {
      type: 'progress',
      uuid: '00000000-0000-4000-8000-000000000001',
    } as unknown as Parameters<typeof selectUnrecordedTranscriptMessages>[0][number]
    expect(selectUnrecordedTranscriptMessages(
      [recorded, recordedProgress, next],
      new Set([recorded.uuid, recordedProgress.uuid]),
    )).toEqual({
      messages: [next],
      startingParentUuid: recorded.uuid,
    })
    // Nothing recorded yet: a new teammate, or history replaced by compaction
    expect(selectUnrecordedTranscriptMessages(
      [notRecorded, next],
      new Set(),
    )).toEqual({
      messages: [notRecorded, next],
      startingParentUuid: undefined,
    })
  })

  test('inherits the parent thinking configuration for regular and fork agents', () => {
    const disabled = { type: 'disabled' } as const
    const enabled = { type: 'enabled', budgetTokens: 4096 } as const
    const adaptive = { type: 'adaptive' } as const

    expect(resolveSubagentThinkingConfig(disabled)).toBe(disabled)
    expect(resolveSubagentThinkingConfig(enabled)).toBe(enabled)
    expect(resolveSubagentThinkingConfig(adaptive)).toBe(adaptive)
  })

  test('agent effort overrides the parent independently of disabled thinking', () => {
    const thinking = resolveSubagentThinkingConfig({ type: 'disabled' })
    const effort = resolveSubagentEffortValue('low', 'high')

    expect(thinking).toEqual({ type: 'disabled' })
    expect(effort).toBe('low')
    expect(resolveSubagentEffortValue(undefined, 'xhigh')).toBe('xhigh')
  })

  test('applies inherited thinking and definition effort to the constructed agent context', async () => {
    const thinkingConfig = { type: 'enabled', budgetTokens: 2048 } as const
    const agentDefinition: CustomAgentDefinition = {
      agentType: 'runtime-reviewer',
      whenToUse: 'Review runtime propagation',
      rawSystemPrompt: 'Review carefully.',
      getSystemPrompt: () => 'Review carefully.',
      source: 'projectSettings',
      model: 'gpt-5.6-luna',
      effort: 'low',
    }
    const parentState = {
      ...getDefaultAppState(),
      effortValue: 'high' as const,
    }
    const parentContext = {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'sonnet',
        tools: [],
        verbose: false,
        thinkingConfig,
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: false,
        agentDefinitions: {
          activeAgents: [agentDefinition],
          allAgents: [agentDefinition],
        },
      },
      abortController: new AbortController(),
      readFileState: createFileStateCacheWithSizeLimit(),
      getAppState: () => parentState,
      setAppState: () => {},
      setResponseLength: () => {},
      messages: [],
    } as unknown as ToolUseContext
    let capturedContext: ToolUseContext | undefined
    const stopAfterContext = new Error('context captured')

    const generator = runAgent({
      agentDefinition,
      promptMessages: [],
      toolUseContext: parentContext,
      canUseTool: (async () => ({ behavior: 'allow' })) as never,
      isAsync: false,
      querySource: 'agent:custom',
      override: {
        userContext: {},
        systemContext: {},
        systemPrompt: asSystemPrompt([]),
        agentId: 'runtime-agent-id' as never,
      },
      availableTools: [],
      onCacheSafeParams: params => {
        capturedContext = params.toolUseContext
        throw stopAfterContext
      },
    })

    await expect(generator.next()).rejects.toBe(stopAfterContext)
    expect(capturedContext?.options.mainLoopModel).toBe('gpt-5.6-luna')
    expect(capturedContext?.options.thinkingConfig).toBe(thinkingConfig)
    expect(capturedContext?.getAppState().effortValue).toBe('low')
  })

  test('prevents repository agents from elevating a default parent to bypassPermissions', async () => {
    async function capturePermissionMode(
      source: CustomAgentDefinition['source'] | 'built-in' | 'policySettings',
    ): Promise<string | undefined> {
      const agentDefinition = {
        agentType: `permission-reviewer-${source}`,
        whenToUse: 'Review permission propagation',
        rawSystemPrompt: 'Review carefully.',
        getSystemPrompt: () => 'Review carefully.',
        source,
        permissionMode: 'bypassPermissions' as const,
      } as CustomAgentDefinition
      const parentState = getDefaultAppState()
      const parentContext = {
        options: {
          commands: [],
          debug: false,
          mainLoopModel: 'sonnet',
          tools: [],
          verbose: false,
          thinkingConfig: { type: 'disabled' as const },
          mcpClients: [],
          mcpResources: {},
          isNonInteractiveSession: false,
          agentDefinitions: {
            activeAgents: [agentDefinition],
            allAgents: [agentDefinition],
          },
        },
        abortController: new AbortController(),
        readFileState: createFileStateCacheWithSizeLimit(),
        getAppState: () => parentState,
        setAppState: () => {},
        setResponseLength: () => {},
        messages: [],
      } as unknown as ToolUseContext
      let capturedContext: ToolUseContext | undefined
      const stopAfterContext = new Error('context captured')

      const generator = runAgent({
        agentDefinition,
        promptMessages: [],
        toolUseContext: parentContext,
        canUseTool: (async () => ({ behavior: 'allow' })) as never,
        isAsync: false,
        querySource: 'agent:custom',
        override: {
          userContext: {},
          systemContext: {},
          systemPrompt: asSystemPrompt([]),
          agentId: `permission-agent-${source}` as never,
        },
        availableTools: [],
        onCacheSafeParams: params => {
          capturedContext = params.toolUseContext
          throw stopAfterContext
        },
      })

      await expect(generator.next()).rejects.toBe(stopAfterContext)
      return capturedContext?.getAppState().toolPermissionContext.mode
    }

    expect(await capturePermissionMode('projectSettings')).toBe('default')
    expect(await capturePermissionMode('localSettings')).toBe('default')
    expect(await capturePermissionMode('userSettings')).toBe(
      'bypassPermissions',
    )
    expect(await capturePermissionMode('policySettings')).toBe(
      'bypassPermissions',
    )
    expect(await capturePermissionMode('built-in')).toBe('bypassPermissions')
  })
})
