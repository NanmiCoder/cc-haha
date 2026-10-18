import { describe, expect, test } from 'bun:test'
import { buildLeanSystemPrompt } from './leanPrompt.js'

const context = {
  toolNames: ['Read', 'Edit', 'Bash'],
  cwd: '/fixture/project',
  additionalWorkingDirectories: ['/fixture/shared'],
  platform: 'linux',
  osVersion: 'fixture-os',
  shell: 'Shell: bash',
  date: '2026-10-17',
  language: 'Chinese',
  memory: 'Fixture memory policy: preserve previous decisions.',
}

describe('lean system prompt', () => {
  test('preserves execution context, language, memory and essential behavior', () => {
    const text = buildLeanSystemPrompt(context).join('\n')
    for (const value of [
      context.cwd, '/fixture/shared', context.platform, context.osVersion,
      context.shell, context.date, context.language, context.memory,
      'Read, Edit, Bash', 'project instructions', 'Preserve existing user changes',
      'verify the affected behavior', 'Do not bypass a denied operation',
      'Do not invent results', 'new standard-profile session',
    ]) expect(text).toContain(value)
    expect(text).not.toContain('ToolSearch')
    expect(text).not.toContain('MCP Server Instructions')
    expect(text).not.toContain('available_skills')
  })

  test('describes the effective tool pool, including when permission filtering removes all tools', () => {
    const text = buildLeanSystemPrompt({
      ...context, toolNames: [], memory: null, language: undefined,
      additionalWorkingDirectories: [],
    }).join('\n')
    expect(text).toContain('skills: (none)')
    expect(text).not.toContain('Read, Edit, Bash')
    expect(text).not.toContain('Additional working directories')
    expect(text).not.toContain('Respond in')
    expect(text).not.toContain('Fixture memory')
  })
})
