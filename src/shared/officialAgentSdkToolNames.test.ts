import { expect, test } from 'bun:test'
import { normalizeOfficialAgentSdkToolContent, normalizeOfficialAgentSdkToolName } from './officialAgentSdkToolNames.js'

test('desktop projection normalizes exact registered tools without relabeling foreign or unknown MCP tools', () => {
  for (const name of ['TeamCreate', 'TeamPlan', 'Workflow', 'TaskUpdate', 'CronCreate', 'CreateSessions']) {
    expect(normalizeOfficialAgentSdkToolName(`mcp__cc_haha__${name}`)).toBe(name)
    expect(normalizeOfficialAgentSdkToolName(name)).toBe(name)
  }
  for (const name of ['mcp__other__TeamCreate', 'mcp__cc_haha__Unknown', 'mcp__cc_haha__Read', 'mcp__cc_haha_computer__click', 'mcp__cc_haha__TeamCreate_extra']) {
    expect(normalizeOfficialAgentSdkToolName(name)).toBe(name)
  }
})

test('normalization copies changed blocks but preserves raw events, IDs, tool results and unchanged references', () => {
  const raw = [{ type: 'tool_use', id: 'fixture-id', name: 'mcp__cc_haha__TeamCreate', input: { team_name: 'fixture' } }, { type: 'text', text: 'mcp__cc_haha__TeamCreate' }, { type: 'tool_result', tool_use_id: 'fixture-id', content: 'mcp__cc_haha__TeamCreate' }]
  const projected = normalizeOfficialAgentSdkToolContent(raw)
  expect(projected).not.toBe(raw)
  expect(projected[0]).toMatchObject({ id: 'fixture-id', name: 'TeamCreate', input: raw[0]!.input })
  expect(raw[0]!.name).toBe('mcp__cc_haha__TeamCreate')
  expect(projected[1]).toBe(raw[1])
  expect(projected[2]).toBe(raw[2])
  expect(normalizeOfficialAgentSdkToolContent(projected)).toBe(projected)
})
