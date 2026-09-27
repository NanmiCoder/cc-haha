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

describe('official Agent definition fields', () => {
  test('JSON snapshots retain built-in instruction scope and tool restrictions', () => {
    expect(parseAgentFromJson('review-worker', {
      description: 'Approved preset snapshot', prompt: 'Read-only fixture',
      omitClaudeMd: true, tools: ['Read'], disallowedTools: ['Edit', 'Write'],
    })).toMatchObject({ omitClaudeMd: true, tools: ['Read'], disallowedTools: ['Edit', 'Write'] })
  })
  test('JSON agents preserve hooks, isolation, color, and trimmed strings', () => {
    const hooks = {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command' as const, command: 'echo checked' }],
        },
      ],
    }
    const agent = parseAgentFromJson('protocol-agent', {
      description: '  Protocol agent  ',
      prompt: '  Follow the official protocol.  ',
      model: '  sonnet  ',
      hooks,
      isolation: 'worktree',
      color: 'cyan',
    })

    expect(agent).toMatchObject({
      agentType: 'protocol-agent',
      whenToUse: 'Protocol agent',
      rawSystemPrompt: 'Follow the official protocol.',
      model: 'sonnet',
      hooks,
      isolation: 'worktree',
      color: 'cyan',
    })
  })

  test('JSON agents reject blank descriptions, prompts, and models', () => {
    for (const definition of [
      { description: ' ', prompt: 'Run.' },
      { description: 'Agent', prompt: '\n\t' },
      { description: 'Agent', prompt: 'Run.', model: '  ' },
    ]) {
      expect(parseAgentFromJson('invalid-agent', definition)).toBeNull()
    }
  })
})

describe('Markdown Agent model validation', () => {
  test('rejects present non-string and blank model fields', () => {
    for (const model of [123, false, {}, '  ', null]) {
      expect(
        parseAgentFromMarkdown(
          '/tmp/invalid-model.md',
          '/tmp',
          {
            name: 'invalid-model',
            description: 'Invalid model agent',
            model,
          },
          'This agent must not load.',
          'projectSettings',
        ),
      ).toBeNull()
    }
  })

  test('reports a specific model error through failedFiles', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agent-model-error-'))
    const agentsDir = join(projectRoot, '.claude', 'agents')
    const filePath = join(agentsDir, 'invalid-model.md')

    try {
      await mkdir(agentsDir, { recursive: true })
      await writeFile(
        filePath,
        [
          '---',
          'name: invalid-model',
          'description: Invalid model agent',
          'model: 123',
          '---',
          'This agent must not load.',
        ].join('\n'),
      )
      clearAgentDefinitionsCache()

      const result = await getAgentDefinitionsWithOverrides(projectRoot)

      expect(
        result.activeAgents.some(agent => agent.agentType === 'invalid-model'),
      ).toBe(false)
      expect(result.failedFiles).toContainEqual({
        path: filePath,
        error: expect.stringContaining('Invalid "model" field'),
      })
    } finally {
      clearAgentDefinitionsCache()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})
