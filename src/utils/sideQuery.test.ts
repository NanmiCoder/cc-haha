import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import { getIsInteractive, setIsInteractive } from '../bootstrap/state.js'
import { enableConfigs } from './config.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { generatePermissionExplanation } from './permissions/permissionExplainer.js'
import { sideQuery } from './sideQuery.js'

const explanation = {
  explanation: 'Lists the working directory.',
  reasoning: 'I need to inspect the project files.',
  risk: 'No files are changed.',
  riskLevel: 'LOW',
}

test('local proxy side queries keep their explicit small budget despite a provider reply budget', async () => {
  const { requests, headers } = await withCapturedRequests('claude-sonnet-4-6', () => {
    process.env.ANTHROPIC_BASE_URL += '/proxy/providers/fixture'
    process.env.CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS = '131072'
    return sideQuery({
      model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'Return OK' }],
      max_tokens: 256, thinking: false, querySource: 'permission_explainer',
    })
  }, [{ type: 'text', text: 'OK' }])
  expect(requests[0]?.max_tokens).toBe(256)
  expect(headers[0]?.get('x-cc-haha-output-budget-source')).toBe('explicit')
})

async function withCapturedRequests<T>(
  model: string,
  run: () => Promise<T>,
  responseContent: unknown[] = [{
    type: 'tool_use', id: 'toolu_fixture', name: 'explain_command', input: explanation,
  }],
) {
  const requests: Record<string, any>[] = []
  const headers: Headers[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = await request.json() as Record<string, any>
      requests.push(body)
      headers.push(request.headers)
      if (model === 'claude-fable-5-1' &&
        (body.tool_choice?.type === 'tool' || body.tool_choice?.type === 'any' ||
          body.thinking?.type === 'disabled' || 'temperature' in body)) {
        return Response.json({ type: 'error', error: {
          type: 'invalid_request_error', message: 'Unsupported Fable request controls',
        } }, { status: 400 })
      }
      return Response.json({
        id: 'msg_fixture', type: 'message', role: 'assistant', model,
        content: responseContent, stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    },
  })
  const sandbox = await mkdtemp(join(tmpdir(), 'cc-haha-side-query-'))
  const originalEnv = { ...process.env }
  const interactive = getIsInteractive()
  try {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, createSandboxedTestEnvironment(sandbox, {
      NODE_ENV: 'production',
      ANTHROPIC_API_KEY: 'loopback-test-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
      ANTHROPIC_MODEL: model,
      CC_HAHA_SEND_DISABLED_THINKING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    }, originalEnv))
    setIsInteractive(false)
    get3PModelCapabilityOverride.cache.clear()
    enableConfigs()
    return { result: await run(), requests, headers }
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, originalEnv)
    setIsInteractive(interactive)
    get3PModelCapabilityOverride.cache.clear()
    server.stop(true)
    await rm(sandbox, { recursive: true, force: true })
  }
}

test('permission explanations work with Fable 5.1 without forced tool choice', async () => {
  const { result, requests, headers } = await withCapturedRequests('claude-fable-5-1', () =>
    generatePermissionExplanation({
      toolName: 'Bash', toolInput: { command: 'ls' },
      signal: new AbortController().signal,
    }))
  expect(result).toEqual(explanation)
  expect(requests).toHaveLength(1)
  expect(requests[0]?.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true })
  expect(requests[0]?.thinking).toEqual({
    type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' },
  })
  expect(headers[0]?.get('anthropic-beta')).toContain('thinking-binding-controls-2026-08-01')
  expect(JSON.stringify(requests[0]?.system)).toContain('explain_command')
  expect(requests[0]?.tools.map((tool: any) => tool.name)).toEqual(['explain_command'])
})

test('Fable side classifiers retain output headroom and omit incompatible sampling controls', async () => {
  const { requests } = await withCapturedRequests('claude-fable-5-1', () => sideQuery({
    model: 'claude-fable-5-1', messages: [{ role: 'user', content: 'Classify action' }],
    thinking: false, temperature: 0, max_tokens: 64,
    stop_sequences: ['</block>'], querySource: 'auto_mode',
  }), [{ type: 'text', text: '<block>no</block>' }])
  expect(requests[0]?.thinking).toMatchObject({ type: 'adaptive' })
  expect(requests[0]).not.toHaveProperty('temperature')
  expect(requests[0]?.max_tokens).toBeGreaterThanOrEqual(2112)
  expect(requests[0]?.stop_sequences).toEqual(['</block>'])
})

test('Fable side-query thinking headroom respects the output limit without reducing caller budgets', async () => {
  for (const [requested, expected] of [[127_000, 128_000], [128_000, 128_000], [130_000, 130_000]]) {
    const { requests } = await withCapturedRequests('claude-fable-5-1', () => sideQuery({
      model: 'claude-fable-5-1', messages: [{ role: 'user', content: 'Return result' }],
      max_tokens: requested, querySource: 'permission_explainer',
    }))
    expect(requests[0]?.max_tokens).toBe(expected)
  }
})

test('permission explanation rejects missing or invalid tool results', async () => {
  for (const content of [
    [{ type: 'text', text: 'The command is safe' }],
    [{ type: 'tool_use', id: 'toolu_bad', name: 'explain_command', input: { riskLevel: 'LOW' } }],
    [{ type: 'tool_use', id: 'toolu_wrong', name: 'unrelated_tool', input: explanation }],
  ]) {
    const { result, requests } = await withCapturedRequests('claude-fable-5-1', () =>
      generatePermissionExplanation({ toolName: 'Bash', toolInput: 'ls',
        signal: new AbortController().signal }), content)
    expect(result).toBeNull()
    expect(requests).toHaveLength(1)
  }
})

test('Fable any-tool side queries retain all choices and require a tool result in the prompt', async () => {
  const tools = ['first_result', 'second_result'].map(name => ({
    name, input_schema: { type: 'object' as const, properties: {} },
  }))
  const { requests } = await withCapturedRequests('claude-fable-5-1', () => sideQuery({
    model: 'claude-fable-5-1', messages: [{ role: 'user', content: 'Return result' }],
    tools, tool_choice: { type: 'any' }, thinking: 2048, max_tokens: 4096,
    querySource: 'permission_explainer',
  }))
  expect(requests[0]?.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true })
  expect(requests[0]?.tools).toEqual(tools)
  expect(JSON.stringify(requests[0]?.system)).toContain('calling one of the provided tools')
  expect(requests[0]?.thinking.type).toBe('adaptive')
  expect(requests[0]?.max_tokens).toBe(4096)
})

test('Fable 5 side queries require thinking without the 5.1 binding controls', async () => {
  const { requests, headers } = await withCapturedRequests('claude-fable-5', () => sideQuery({
    model: 'claude-fable-5', messages: [{ role: 'user', content: 'Return result' }],
    thinking: false, querySource: 'permission_explainer',
  }))
  expect(requests[0]?.thinking).toEqual({ type: 'adaptive' })
  expect(headers[0]?.get('anthropic-beta') ?? '').not.toContain('thinking-binding-controls')
})

test('existing non-Fable side queries preserve forced tools and disabled thinking', async () => {
  const { result, requests } = await withCapturedRequests('claude-sonnet-4-6', () =>
    generatePermissionExplanation({ toolName: 'Bash', toolInput: 'ls',
      signal: new AbortController().signal }))
  expect(result).toEqual(explanation)
  expect(requests[0]?.tool_choice).toEqual({ type: 'tool', name: 'explain_command' })
  expect(requests[0]?.thinking).toEqual({ type: 'disabled' })
  expect(requests[0]?.max_tokens).toBe(1024)
})
