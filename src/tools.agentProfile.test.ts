import { afterEach, describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext, type Tool } from './Tool.js'
import { assembleToolPool, getMergedTools, getTools } from './tools.js'
import { AGENT_PROFILES, setAgentProfile } from './utils/agentProfile.js'

afterEach(() => setAgentProfile('standard'))

describe('profile tool assembly', () => {
  test('default standard catalog is unchanged after a lean run', () => {
    const permissions = getEmptyToolPermissionContext()
    const before = getTools(permissions).map(tool => tool.name)
    expect(before).toContain('Skill')
    setAgentProfile('lean')
    const lean = getTools(permissions).map(tool => tool.name)
    for (const name of ['Read', 'Glob', 'Grep', 'Edit', 'Write']) expect(lean).toContain(name)
    expect(lean.every(name => (AGENT_PROFILES.lean.toolNames as readonly string[]).includes(name))).toBe(true)
    setAgentProfile('standard')
    expect(getTools(permissions).map(tool => tool.name)).toEqual(before)
  })

  test('MCP additions cannot reintroduce tools and blanket denies remain effective', () => {
    setAgentProfile('lean')
    const permissions = getEmptyToolPermissionContext()
    permissions.alwaysDenyRules = { cliArg: ['Read', 'Bash', 'PowerShell'] }
    const mcp = { name: 'mcp__fixture__search', isMcp: true } as Tool
    const assembled = assembleToolPool(permissions, [mcp]).map(tool => tool.name)
    expect(assembled).toContain('Edit')
    expect(assembled).not.toContain('Read')
    expect(assembled).not.toContain('Bash')
    expect(assembled).not.toContain('PowerShell')
    expect(assembled).not.toContain(mcp.name)
    expect(getMergedTools(permissions, [mcp]).map(tool => tool.name)).not.toContain(mcp.name)
  })
})
