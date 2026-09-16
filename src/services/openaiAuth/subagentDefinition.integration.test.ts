import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  clearAgentDefinitionsCache,
  getAgentDefinitionsWithOverrides,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { runAgent } from '../../tools/AgentTool/runAgent.js'
import { configureEffortParams } from '../api/claude.js'
import { resolveAppliedEffort } from '../../utils/effort.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { OPENAI_CODEX_API_ENDPOINT } from './client.js'
import { buildOpenAICodexFetch } from './fetch.js'
import { clearOpenAIOAuthTokenCache } from './storage.js'

const ENV_KEYS = [
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_USE_NATIVE_FILE_SEARCH',
  'CLAUDE_CONFIG_DIR',
  'CC_HAHA_OPENAI_REASONING_EFFORT',
  'OPENAI_CODEX_HAIKU_MODEL',
  'OPENAI_CODEX_MODEL',
  'OPENAI_CODEX_OAUTH_FILE',
] as const

describe('Markdown subagent to OpenAI request integration', () => {
  let tempRoot: string
  let configDir: string
  let projectDir: string
  let tokenFile: string
  let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>

  beforeEach(async () => {
    originalEnv = Object.fromEntries(
      ENV_KEYS.flatMap(key =>
        process.env[key] === undefined ? [] : [[key, process.env[key]!]],
      ),
    )
    tempRoot = await mkdtemp(join(tmpdir(), 'subagent-openai-request-'))
    configDir = join(tempRoot, 'claude-config')
    projectDir = join(tempRoot, 'project')
    tokenFile = join(tempRoot, 'openai-oauth.json')

    await mkdir(join(configDir, 'agents'), { recursive: true })
    await mkdir(join(projectDir, '.git'), { recursive: true })

    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH = '1'
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'gpt-5.6-luna'
    process.env.OPENAI_CODEX_OAUTH_FILE = tokenFile
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    delete process.env.CC_HAHA_OPENAI_REASONING_EFFORT
    delete process.env.OPENAI_CODEX_HAIKU_MODEL
    delete process.env.OPENAI_CODEX_MODEL

    clearAgentDefinitionsCache()
    clearOpenAIOAuthTokenCache()
  })

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    clearAgentDefinitionsCache()
    clearOpenAIOAuthTokenCache()
    await rm(tempRoot, { recursive: true, force: true })
  })

  test('maps haiku and xhigh from an official Agent file into the final OpenAI request', async () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high'

    await writeFile(
      join(configDir, 'agents', 'quick-researcher.md'),
      [
        '---',
        'name: quick-researcher',
        'description: Fast research with deeper reasoning',
        'model: haiku',
        'effort: xhigh',
        '---',
        'Research the request and return concise evidence.',
        '',
      ].join('\n'),
      'utf-8',
    )

    const definitions = await getAgentDefinitionsWithOverrides(projectDir)
    const agent = definitions.activeAgents.find(
      candidate => candidate.agentType === 'quick-researcher',
    )

    expect(agent).toMatchObject({
      agentType: 'quick-researcher',
      source: 'userSettings',
      model: 'haiku',
      effort: 'xhigh',
    })
    if (!agent) throw new Error('Expected quick-researcher to load')

    const parentState = {
      ...getDefaultAppState(),
      effortValue: 'medium' as const,
    }
    const parentContext = {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'gpt-5.6-sol',
        tools: [],
        verbose: false,
        thinkingConfig: { type: 'disabled' } as const,
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: false,
        agentDefinitions: definitions,
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
      agentDefinition: agent,
      promptMessages: [],
      toolUseContext: parentContext,
      canUseTool: (async () => ({ behavior: 'allow' })) as never,
      isAsync: false,
      querySource: 'agent:custom',
      override: {
        userContext: {},
        systemContext: {},
        systemPrompt: asSystemPrompt([]),
        agentId: 'subagent-integration-agent' as never,
      },
      availableTools: [],
      onCacheSafeParams: params => {
        capturedContext = params.toolUseContext
        throw stopAfterContext
      },
    })

    await expect(generator.next()).rejects.toBe(stopAfterContext)
    if (!capturedContext) throw new Error('Expected runAgent context capture')

    const resolvedModel = capturedContext.options.mainLoopModel
    const resolvedEffort = resolveAppliedEffort(
      resolvedModel,
      capturedContext.getAppState().effortValue,
      {
        effortValueOverridesEnv:
          capturedContext.options.effortValueOverridesEnv,
      },
    )
    const outputConfig: Record<string, unknown> = {}
    const extraBodyParams: Record<string, unknown> = {}
    const betas: string[] = []
    configureEffortParams(
      resolvedEffort,
      outputConfig as never,
      extraBodyParams,
      betas,
      resolvedModel,
    )

    expect(resolvedModel).toBe('gpt-5.6-luna')
    expect(capturedContext.getAppState().effortValue).toBe('xhigh')
    expect(capturedContext.options.effortValueOverridesEnv).toBe(true)
    expect(resolvedEffort).toBe('xhigh')
    expect(capturedContext.options.thinkingConfig).toEqual({ type: 'disabled' })
    expect(outputConfig).toEqual({ effort: 'xhigh' })

    await writeFile(
      tokenFile,
      JSON.stringify({
        accessToken: 'offline-access-token',
        refreshToken: 'offline-refresh-token',
        expiresAt: Date.now() + 60 * 60_000,
        accountId: 'acct_offline_subagent',
      }),
      'utf-8',
    )
    clearOpenAIOAuthTokenCache()

    const upstreamCalls: Array<{
      url: string
      body: Record<string, unknown>
    }> = []
    const fetchOverride: typeof fetch = async (input, init) => {
      upstreamCalls.push({
        url: String(input),
        body: JSON.parse(init?.body instanceof Uint8Array ? Buffer.from(await Bun.zstdDecompress(init.body)).toString('utf8') : String(init?.body)) as Record<string, unknown>,
      })
      return Response.json({
        id: 'resp_subagent_integration',
        object: 'response',
        created_at: 1_779_118_000,
        model: resolvedModel,
        status: 'completed',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })
    }

    const openAIFetch = buildOpenAICodexFetch(
      fetchOverride,
      'agent:custom',
    )
    const response = await openAIFetch(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          ...extraBodyParams,
          model: resolvedModel,
          max_tokens: 64,
          messages: [{ role: 'user', content: 'Find the relevant files.' }],
          thinking: capturedContext.options.thinkingConfig,
          output_config: outputConfig,
        }),
      },
    )

    expect(response.status).toBe(200)
    expect(upstreamCalls).toHaveLength(1)
    expect(upstreamCalls[0]).toMatchObject({
      url: OPENAI_CODEX_API_ENDPOINT,
      body: {
        model: 'gpt-5.6-luna',
        reasoning: { effort: 'xhigh' },
      },
    })
  })
})
