import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearAgentDefinitionsCache,
  getAgentDefinitionsWithOverrides,
  parseAgentFromJson,
  parseAgentFromMarkdown,
} from './loadAgentsDir.js'

describe('agent effort parsing', () => {
  test('accepts xhigh consistently in JSON and Markdown definitions', () => {
    const jsonAgent = parseAgentFromJson('json-agent', {
      description: 'JSON agent',
      prompt: 'Run the JSON agent.',
      effort: 'xhigh',
    })
    const markdownAgent = parseAgentFromMarkdown(
      '/tmp/markdown-agent.md',
      '/tmp',
      {
        name: 'markdown-agent',
        description: 'Markdown agent',
        effort: 'xhigh',
      },
      'Run the Markdown agent.',
      'projectSettings',
    )

    expect(jsonAgent?.effort).toBe('xhigh')
    expect(markdownAgent?.effort).toBe('xhigh')
  })

  test('reads a pinned provider from JSON and Markdown definitions', () => {
    const jsonAgent = parseAgentFromJson('json-agent', {
      description: 'JSON agent',
      prompt: 'Run the JSON agent.',
      model: 'deepseek-v4-pro',
      provider: 'deepseek-direct',
    })
    const markdownAgent = parseAgentFromMarkdown(
      '/tmp/markdown-agent.md',
      '/tmp',
      { name: 'markdown-agent', description: 'Markdown agent', provider: ' deepseek-direct ' },
      'Run the Markdown agent.',
      'projectSettings',
    )
    // An unusable provider keeps the Agent visible; running it reports why.
    const invalidProvider = parseAgentFromMarkdown(
      '/tmp/invalid-provider.md',
      '/tmp',
      { name: 'invalid-provider', description: 'Invalid provider agent', provider: 42 },
      'Still loads.',
      'projectSettings',
    )

    expect(jsonAgent?.provider).toBe('deepseek-direct')
    expect(markdownAgent?.provider).toBe('deepseek-direct')
    expect(invalidProvider).not.toBeNull()
    expect(invalidProvider?.provider).toBeUndefined()
  })

  test('rejects an invalid Markdown effort instead of silently inheriting', () => {
    const agent = parseAgentFromMarkdown(
      '/tmp/invalid-agent.md',
      '/tmp',
      {
        name: 'invalid-agent',
        description: 'Invalid effort agent',
        effort: 'extreme',
      },
      'This agent must not load.',
      'projectSettings',
    )

    expect(agent).toBeNull()
  })

  test('reports the specific invalid-effort error when loading an agent directory', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agent-effort-error-'))
    const agentsDir = join(projectRoot, '.claude', 'agents')
    const filePath = join(agentsDir, 'invalid-effort.md')

    try {
      await mkdir(agentsDir, { recursive: true })
      await writeFile(
        filePath,
        [
          '---',
          'name: invalid-effort',
          'description: Invalid effort agent',
          'effort: extreme',
          '---',
          'This agent must not load.',
        ].join('\n'),
      )
      clearAgentDefinitionsCache()

      const result = await getAgentDefinitionsWithOverrides(projectRoot)

      expect(result.activeAgents.some(agent => agent.agentType === 'invalid-effort')).toBe(false)
      expect(result.failedFiles).toContainEqual({
        path: filePath,
        error: expect.stringContaining('Invalid "effort" field'),
      })
    } finally {
      clearAgentDefinitionsCache()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})
