import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as processUtils from './process.js'
import {
  initializeAgentProfile,
  assertAgentProfileSettingCompatible,
  filterAgentProfileTools,
  getAgentProfile,
  isAgentProfileMcpEnabled,
  LEAN_MCP_UNAVAILABLE,
  setAgentProfile,
  validateAgentProfileInitialize,
  validateAgentProfileControlRequest,
  validateAgentProfileOptions,
} from './agentProfile.js'

afterEach(() => setAgentProfile('standard'))

describe('experimental agent profile', () => {
  test('standard preserves the existing tool pool and accepts existing options', () => {
    expect(getAgentProfile()).toBe('standard')
    const tools = [{ name: 'Agent' }, { name: 'Read' }, { name: 'mcp__fixture__read' }]
    expect(filterAgentProfileTools(tools)).toBe(tools)
    expect(validateAgentProfileOptions({ resume: 'id', systemPrompt: 'custom' })).toBeUndefined()
  })

  test('lean intersects core tools without adding denied or unavailable tools', () => {
    setAgentProfile('lean')
    const tools = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'PowerShell', 'Agent', 'Skill', 'WebFetch', 'mcp__fixture__read', 'TaskCreate']
      .map(name => ({ name, marker: name }))
    expect(filterAgentProfileTools(tools).map(tool => tool.name)).toEqual([
      'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'PowerShell', 'Skill',
    ])
    const permitted = tools.filter(tool => tool.name !== 'Write' && tool.name !== 'PowerShell')
    expect(filterAgentProfileTools(permitted).map(tool => tool.name)).toEqual([
      'Read', 'Grep', 'Glob', 'Edit', 'Bash', 'Skill',
    ])
    expect(filterAgentProfileTools([])).toEqual([])
    expect(filterAgentProfileTools([{ name: 'Read', isMcp: true }, { name: 'Bash', mcpInfo: {} }])).toEqual([])
    expect(filterAgentProfileTools(tools)[0]).toBe(tools[0])
  })

  test('lean requires print but permits append prompts and a fresh explicit session ID', () => {
    expect(validateAgentProfileOptions({}, 'lean')).toContain('requires --print')
    expect(validateAgentProfileOptions({ print: true, sessionId: 'new-id', appendSystemPrompt: 'instructions' }, 'lean')).toBeUndefined()
  })

  for (const key of ['continue', 'forkSession', 'fromPr', 'resumeSessionAt', 'rewindFiles', 'teleport', 'remote', 'bare', 'agent', 'agents', 'agentId', 'agentName', 'teamName', 'agentType', 'systemPrompt', 'systemPromptFile', 'jsonSchema', 'advisor', 'chrome', 'mcpConfig']) {
    test(`lean rejects ${key} before running the session`, () => {
      expect(validateAgentProfileOptions({ print: true, [key]: 'value' }, 'lean')).toContain('cannot be combined')
    })
  }

  test('empty explicit system prompt and empty agent definitions cannot bypass validation', () => {
    expect(validateAgentProfileOptions({ print: true, systemPrompt: '' }, 'lean')).toContain('--system-prompt')
    setAgentProfile('lean')
    expect(validateAgentProfileInitialize({ systemPrompt: '' })).toContain('SDK')
    expect(validateAgentProfileInitialize({ agents: {} })).toContain('SDK')
    expect(validateAgentProfileInitialize({ jsonSchema: {} })).toContain('SDK')
    expect(validateAgentProfileInitialize({})).toBeUndefined()
    setAgentProfile('standard')
    expect(validateAgentProfileInitialize({ systemPrompt: 'custom', agents: {} })).toBeUndefined()
  })

  test('lean rejects SDK subagent messages without changing standard control behavior', () => {
    expect(validateAgentProfileControlRequest('send_agent_message')).toBeUndefined()
    setAgentProfile('lean')
    expect(validateAgentProfileControlRequest('send_agent_message')).toContain('resuming subagents')
    expect(validateAgentProfileControlRequest('stop_task')).toBeUndefined()
    expect(validateAgentProfileControlRequest('interrupt')).toBeUndefined()
  })

  test('only lean drops the MCP runtime, and every explicit MCP source fails closed', () => {
    expect(isAgentProfileMcpEnabled()).toBe(true)
    expect(validateAgentProfileOptions({ print: true, mcpConfig: ['{"mcpServers":{}}'] })).toBeUndefined()
    expect(validateAgentProfileInitialize({ sdkMcpServers: ['host'] })).toBeUndefined()
    expect(validateAgentProfileControlRequest('mcp_set_servers', { servers: { host: { type: 'sdk' } } })).toBeUndefined()
    setAgentProfile('lean')
    expect(isAgentProfileMcpEnabled()).toBe(false)
    expect(validateAgentProfileOptions({ print: true, mcpConfig: ['{"mcpServers":{}}'] })).toContain('--mcp-config')
    expect(validateAgentProfileInitialize({ sdkMcpServers: ['host'] })).toBe(LEAN_MCP_UNAVAILABLE)
    expect(validateAgentProfileControlRequest('mcp_set_servers', { servers: { host: { type: 'sdk' } } })).toBe(LEAN_MCP_UNAVAILABLE)
    // Nothing to start: an empty server list adds no capability.
    expect(validateAgentProfileInitialize({ sdkMcpServers: [] })).toBeUndefined()
    expect(validateAgentProfileControlRequest('mcp_set_servers', { servers: {} })).toBeUndefined()
  })

  test('profile selection does not change SIMPLE or environment settings', () => {
    const before = process.env.CLAUDE_CODE_SIMPLE
    setAgentProfile('lean')
    expect(process.env.CLAUDE_CODE_SIMPLE).toBe(before)
    setAgentProfile('standard')
    expect(filterAgentProfileTools([{ name: 'Agent' }])).toHaveLength(1)
  })
})


describe('agent profile CLI startup', () => {
  function expectStartupError(run: () => void, message: string) {
    const exit = spyOn(processUtils, 'exitWithError').mockImplementation(error => {
      throw new Error(error)
    })
    try {
      expect(run).toThrow(message)
      expect(exit).toHaveBeenCalledTimes(1)
    } finally {
      exit.mockRestore()
    }
  }

  test('defaults to standard and accepts its existing environment and options', () => {
    setAgentProfile('lean')
    initializeAgentProfile({ resume: 'old-session' }, { CLAUDE_CODE_SIMPLE: '1' })
    expect(getAgentProfile()).toBe('standard')
  })

  test('selects lean without modifying the caller environment', () => {
    const env = { CLAUDE_CODE_SIMPLE: 'false', CLAUDE_CODE_COORDINATOR_MODE: '0', KEEP: 'unchanged' }
    const before = { ...env }
    initializeAgentProfile({ agentProfile: 'lean', print: true }, env)
    expect(getAgentProfile()).toBe('lean')
    expect(env).toEqual(before)
  })

  test('invalid flags fail before changing the current profile', () => {
    expectStartupError(() => initializeAgentProfile({ agentProfile: 'invalid' }, {}), 'must be standard or lean')
    expectStartupError(() => initializeAgentProfile({ agentProfile: 'lean' }, {}), 'requires --print')
    expectStartupError(() => initializeAgentProfile({ agentProfile: 'lean', print: true, bare: true }, {}), 'cannot be combined with --bare')
    expect(getAgentProfile()).toBe('standard')
  })

  for (const key of ['CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_COORDINATOR_MODE']) {
    test(`rejects truthy ${key} without changing profile or environment`, () => {
      const env = { [key]: 'YES' }
      expectStartupError(() => initializeAgentProfile({ agentProfile: 'lean', print: true }, env), 'cannot be combined with CLAUDE_CODE_SIMPLE or CLAUDE_CODE_COORDINATOR_MODE')
      expect(getAgentProfile()).toBe('standard')
      expect(env).toEqual({ [key]: 'YES' })
    })
  }

  test('settings selection preserves standard behavior and unset lean settings', () => {
    expect(() => assertAgentProfileSettingCompatible('agent', 'custom')).not.toThrow()
    expect(() => assertAgentProfileSettingCompatible('advisor', 'model')).not.toThrow()
    setAgentProfile('lean')
    expect(() => assertAgentProfileSettingCompatible('agent', undefined)).not.toThrow()
    expect(() => assertAgentProfileSettingCompatible('advisor', '')).not.toThrow()
  })

  test('lean rejects agent and advisor settings with actionable CLI errors', () => {
    setAgentProfile('lean')
    expectStartupError(() => assertAgentProfileSettingCompatible('agent', 'custom'), 'Remove the agent setting or use --agent-profile standard.')
    expectStartupError(() => assertAgentProfileSettingCompatible('advisor', 'model'), 'cannot use an advisor selected in settings.')
    expect(getAgentProfile()).toBe('lean')
  })
})

test('lean rejects plan startup and SDK transition but accepts safe modes', () => {
  setAgentProfile('lean')
  expect(validateAgentProfileOptions({ print: true, permissionMode: 'plan' })).toContain('plan')
  expect(validateAgentProfileControlRequest('set_permission_mode', { mode: 'plan' })).toContain('plan')
  expect(validateAgentProfileControlRequest('set_permission_mode', { mode: 'default' })).toBeUndefined()
  expect(validateAgentProfileOptions({ print: true, chrome: false })).toBeUndefined()
})
