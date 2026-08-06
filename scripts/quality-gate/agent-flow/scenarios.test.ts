import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  AGENT_FLOW_COVERAGE,
  AGENT_FLOW_SCENARIOS,
  buildMockToolPrompt,
  coveredSteps,
  findOrderedTypes,
  firstOfType,
  selectScenarios,
  uncoveredSteps,
} from './scenarios'

describe('agent-flow catalog', () => {
  test('covers every step of the desktop chat user flow', () => {
    expect(uncoveredSteps(AGENT_FLOW_SCENARIOS)).toEqual([])
    expect(coveredSteps(AGENT_FLOW_SCENARIOS)).toEqual([...AGENT_FLOW_COVERAGE])
  })

  test('has a runner for every catalogued scenario', () => {
    // The runner map lives in execute.ts, which boots a server on import of its
    // dependencies; read it as text so this stays a unit test.
    const execute = readFileSync('scripts/quality-gate/agent-flow/execute.ts', 'utf8')
    for (const scenario of AGENT_FLOW_SCENARIOS) {
      const declared = new RegExp(`async\\s+'?${scenario.id.replace(/[-]/g, '\\-')}'?\\(ctx\\)`)
      expect(declared.test(execute), `missing runner for ${scenario.id}`).toBe(true)
    }
  })

  test('runs without any provider, credential, or network dependency', () => {
    const execute = readFileSync('scripts/quality-gate/agent-flow/execute.ts', 'utf8')
    expect(execute).toContain('src/server/__tests__/fixtures/mock-sdk-cli.ts')
    expect(execute).toContain('CLAUDE_CLI_PATH')
    expect(execute).toContain('seedProviders: false')
    expect(execute).toContain("'127.0.0.1'")
    expect(execute).toContain('createQualityGateSandbox')
    expect(execute).toContain('detectUserStateMutations')
  })

  test('reports uncovered steps when only part of the catalog is selected', () => {
    const selected = selectScenarios(['tool-permission-allow'])
    expect(selected).toHaveLength(1)
    expect(uncoveredSteps(selected)).toContain('reconnect')
    expect(uncoveredSteps(selected)).not.toContain('permission-allow')
  })

  test('rejects unknown scenario ids instead of silently running nothing', () => {
    expect(() => selectScenarios(['nope'])).toThrow(/Unknown agent-flow scenario "nope"/)
    expect(selectScenarios([])).toEqual(AGENT_FLOW_SCENARIOS)
  })
})

describe('mock tool prompt', () => {
  test('round-trips through the marker the mock CLI parses', () => {
    const prompt = buildMockToolPrompt({
      tool: 'Write',
      input: { file_path: '/tmp/x', content: 'hi' },
      write: { path: '/tmp/x', content: 'hi' },
    })

    expect(prompt.startsWith('MOCK_TOOL ')).toBe(true)
    expect(JSON.parse(prompt.slice('MOCK_TOOL '.length))).toEqual({
      tool: 'Write',
      input: { file_path: '/tmp/x', content: 'hi' },
      write: { path: '/tmp/x', content: 'hi' },
    })
  })

  test('uses the same marker the fixture checks for', () => {
    const fixture = readFileSync('src/server/__tests__/fixtures/mock-sdk-cli.ts', 'utf8')
    expect(fixture).toContain("const MOCK_TOOL_PREFIX = 'MOCK_TOOL '")
    // The fixture must keep answering permission decisions, or every tool scenario
    // would hang instead of failing with a useful message.
    expect(fixture).toContain("subtype: 'can_use_tool'")
    expect(fixture).toContain("parsed.type === 'control_response'")
    expect(fixture).toContain("type: 'tool_result'")
  })

  test('refuses an empty tool name rather than emitting an unusable request', () => {
    expect(() => buildMockToolPrompt({ tool: '  ', input: {} })).toThrow(/tool name/)
  })
})

describe('protocol ordering assertions', () => {
  const turn = [
    { type: 'content_start' },
    { type: 'content_delta' },
    { type: 'permission_request', requestId: 'r1' },
    { type: 'tool_result', isError: false },
    { type: 'message_complete' },
  ]

  test('accepts the expected order with unrelated frames in between', () => {
    expect(findOrderedTypes(turn, ['content_start', 'permission_request', 'tool_result', 'message_complete']))
      .toEqual({ ok: true })
  })

  test('rejects a reversed order instead of just checking membership', () => {
    const result = findOrderedTypes(turn, ['tool_result', 'permission_request'])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missing).toBe('permission_request')
      expect(result.seen).toContain('permission_request')
    }
  })

  test('names the first missing type so a failure is actionable', () => {
    const result = findOrderedTypes(turn, ['content_start', 'thinking'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.missing).toBe('thinking')
  })

  test('finds the first frame of a type', () => {
    expect(firstOfType(turn, 'permission_request')).toEqual({ type: 'permission_request', requestId: 'r1' })
    expect(firstOfType(turn, 'nope')).toBeUndefined()
  })
})
