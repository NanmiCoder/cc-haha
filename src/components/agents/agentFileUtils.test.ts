import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { getCwdState, setCwdState } from '../../bootstrap/state.js'
import type {
  AgentDefinition,
  CustomAgentDefinition,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import {
  deleteAgentFromFile,
  formatAgentAsMarkdown,
  getActualAgentFilePath,
  getActualRelativeAgentFilePath,
  getNewAgentFilePath,
  getNewRelativeAgentFilePath,
  getPersistedAgentFrontmatter,
  getPersistedAgentTools,
  saveAgentToFile,
  updateAgentFile,
  updateAgentMarkdown,
} from './agentFileUtils.js'

describe('agent markdown persistence', () => {
  test('writes xhigh and advanced fields while omitting inherited model', () => {
    const markdown = formatAgentAsMarkdown(
      'reviewer',
      'Review risky changes',
      ['Read', 'Grep'],
      'Review the implementation.',
      'blue',
      'inherit',
      'project',
      'xhigh',
      {
        skills: ['reviewing'],
        mcpServers: ['github'],
        hooks: {
          PreToolUse: [{ matcher: 'Bash' }],
        },
      },
    )
    const { frontmatter } = parseFrontmatter(markdown)

    expect(frontmatter).toMatchObject({
      name: 'reviewer',
      description: 'Review risky changes',
      tools: ['Read', 'Grep'],
      effort: 'xhigh',
      memory: 'project',
      skills: ['reviewing'],
      mcpServers: ['github'],
    })
    expect(frontmatter.model).toBeUndefined()
    expect(frontmatter.hooks).toEqual({
      PreToolUse: [{ matcher: 'Bash' }],
    })
  })

  test('edits owned fields without dropping advanced or unknown frontmatter', () => {
    const original = `---
name: reviewer
description: Old description
tools: Read
model: opus
effort: xhigh
memory: project
skills:
  - reviewing
mcpServers:
  - github
hooks:
  PreToolUse:
    - matcher: Bash
customExtension:
  nested: true
---

Keep this prompt exactly.
`

    const updated = updateAgentMarkdown(original, {
      description: 'New description',
      tools: ['Read', 'Grep'],
      model: 'inherit',
      color: 'blue',
    })
    const { frontmatter, content } = parseFrontmatter(updated)

    expect(frontmatter).toMatchObject({
      description: 'New description',
      tools: ['Read', 'Grep'],
      color: 'blue',
      effort: 'xhigh',
      memory: 'project',
      skills: ['reviewing'],
      mcpServers: ['github'],
      customExtension: { nested: true },
    })
    expect(frontmatter.model).toBeUndefined()
    expect(frontmatter.hooks).toEqual({
      PreToolUse: [{ matcher: 'Bash' }],
    })
    expect(content).toBe('Keep this prompt exactly.\n')
  })

  test('updates an explicit prompt and validates frontmatter before editing', () => {
    expect(() =>
      updateAgentMarkdown('No frontmatter', {
        description: 'Description',
        tools: undefined,
        model: undefined,
        color: undefined,
      }),
    ).toThrow('Cannot update agent file without valid frontmatter')

    const updated = updateAgentMarkdown(
      `---\r
name: reviewer\r
description: Old\r
---\r
\r
Old prompt.\r
`,
      {
        description: 'New',
        tools: ['*'],
        model: '  opus  ',
        color: undefined,
        memory: 'local',
        effort: 7,
      },
      'New prompt.',
    )
    const { frontmatter, content } = parseFrontmatter(updated)

    expect(frontmatter).toMatchObject({
      description: 'New',
      model: 'opus',
      memory: 'local',
      effort: 7,
    })
    expect(frontmatter.tools).toBeUndefined()
    expect(content).toBe('New prompt.\r\n')
  })

  test('extracts all persistable advanced fields', () => {
    const agent = {
      agentType: 'advanced',
      whenToUse: 'Advanced agent',
      rawSystemPrompt: 'Prompt',
      getSystemPrompt: () => 'Prompt',
      source: 'projectSettings',
      disallowedTools: ['Bash'],
      skills: ['reviewing'],
      mcpServers: ['github'],
      hooks: { PreToolUse: [{ matcher: 'Bash' }] },
      permissionMode: 'plan',
      maxTurns: 12,
      background: true,
      initialPrompt: 'Start here',
      isolation: 'worktree',
    } as CustomAgentDefinition

    expect(getPersistedAgentFrontmatter(agent)).toEqual({
      disallowedTools: ['Bash'],
      skills: ['reviewing'],
      mcpServers: ['github'],
      hooks: { PreToolUse: [{ matcher: 'Bash' }] },
      permissionMode: 'plan',
      maxTurns: 12,
      background: true,
      initialPrompt: 'Start here',
      isolation: 'worktree',
    })
    expect(
      getPersistedAgentFrontmatter({
        agentType: 'minimal',
        whenToUse: 'Minimal agent',
        rawSystemPrompt: 'Prompt',
        getSystemPrompt: () => 'Prompt',
        source: 'projectSettings',
      }),
    ).toEqual({})
  })

  test('uses persisted Markdown tools instead of runtime memory additions', () => {
    const persistedTools = {
      agentType: 'memory-agent',
      whenToUse: 'Uses memory',
      rawSystemPrompt: 'Prompt',
      rawTools: ['Read'],
      tools: ['Read', 'Write', 'Edit'],
      getSystemPrompt: () => 'Prompt plus runtime memory instructions',
      source: 'projectSettings',
    } as CustomAgentDefinition
    const inheritedTools = {
      ...persistedTools,
      rawTools: undefined,
    } as CustomAgentDefinition
    const legacyAgent = {
      agentType: 'legacy-agent',
      whenToUse: 'Legacy source',
      tools: ['Read'],
      getSystemPrompt: () => 'Prompt',
      source: 'built-in',
    } as AgentDefinition

    expect(getPersistedAgentTools(persistedTools)).toEqual(['Read'])
    expect(getPersistedAgentTools(inheritedTools)).toBeUndefined()
    expect(getPersistedAgentTools(legacyAgent)).toEqual(['Read'])
  })
})

describe('agent file paths and persistence', () => {
  let temporaryRoot: string
  let originalCwd: string
  let originalConfigDir: string | undefined

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-files-'))
    originalCwd = getCwdState()
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    setCwdState(temporaryRoot)
    process.env.CLAUDE_CONFIG_DIR = path.join(temporaryRoot, 'config')
  })

  afterEach(async () => {
    setCwdState(originalCwd)
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    await fs.rm(temporaryRoot, { recursive: true, force: true })
  })

  test('resolves custom, built-in, plugin, and CLI paths', () => {
    const customAgent: CustomAgentDefinition = {
      agentType: 'reviewer',
      whenToUse: 'Review changes',
      rawSystemPrompt: 'Review.',
      getSystemPrompt: () => 'Review.',
      source: 'projectSettings',
      filename: 'custom-reviewer',
    }
    const nestedCustomAgent: CustomAgentDefinition = {
      ...customAgent,
      baseDir: path.join(temporaryRoot, '.claude', 'agents'),
      sourceFilePath: path.join(
        temporaryRoot,
        '.claude',
        'agents',
        'nested',
        'different-filename.md',
      ),
    }
    const outOfRootSourceAgent: CustomAgentDefinition = {
      ...customAgent,
      baseDir: path.join(temporaryRoot, '.claude', 'agents'),
      sourceFilePath: path.join(temporaryRoot, 'outside.md'),
    }
    const builtInAgent: AgentDefinition = {
      agentType: 'explore',
      whenToUse: 'Explore',
      getSystemPrompt: () => 'Explore.',
      source: 'built-in',
      baseDir: 'built-in',
    }
    const pluginAgent: AgentDefinition = {
      agentType: 'plugin-reviewer',
      whenToUse: 'Review from plugin',
      getSystemPrompt: () => 'Review.',
      source: 'plugin',
      plugin: '',
    }

    expect(getActualAgentFilePath(customAgent)).toBe(
      path.join(temporaryRoot, '.claude', 'agents', 'custom-reviewer.md'),
    )
    expect(getActualAgentFilePath(nestedCustomAgent)).toBe(
      path.join(
        temporaryRoot,
        '.claude',
        'agents',
        'nested',
        'different-filename.md',
      ),
    )
    expect(getActualRelativeAgentFilePath(nestedCustomAgent)).toBe(
      path.join('.claude', 'agents', 'nested', 'different-filename.md'),
    )
    expect(getActualAgentFilePath(outOfRootSourceAgent)).toBe(
      path.join(temporaryRoot, '.claude', 'agents', 'custom-reviewer.md'),
    )
    expect(getActualAgentFilePath(builtInAgent)).toBe('Built-in')
    expect(() => getActualAgentFilePath(pluginAgent)).toThrow(
      'Cannot get file path for plugin agents',
    )
    expect(getNewRelativeAgentFilePath(builtInAgent)).toBe('Built-in')
    expect(getActualRelativeAgentFilePath(builtInAgent)).toBe('Built-in')
    expect(getActualRelativeAgentFilePath(pluginAgent)).toBe(
      'Plugin: Unknown',
    )
    expect(
      getActualRelativeAgentFilePath({
        ...customAgent,
        source: 'flagSettings',
      }),
    ).toBe('CLI argument')
    expect(
      getNewAgentFilePath({ source: 'userSettings', agentType: 'user-agent' }),
    ).toBe(path.join(temporaryRoot, 'config', 'agents', 'user-agent.md'))
    expect(() =>
      getNewAgentFilePath({
        source: 'flagSettings',
        agentType: 'flag-agent',
      }),
    ).toThrow('Cannot get directory path for flagSettings agents')
    expect(
      getNewRelativeAgentFilePath({
        source: 'localSettings',
        agentType: 'local-agent',
      }),
    ).toBe(path.join(temporaryRoot, '.claude', 'agents', 'local-agent.md'))
  })

  test('creates, updates, overwrites, and deletes an agent file', async () => {
    const agent: CustomAgentDefinition = {
      agentType: 'reviewer',
      whenToUse: 'Review changes',
      rawSystemPrompt: 'Original prompt.',
      getSystemPrompt: () => 'Original prompt.\n\nRuntime memory.',
      source: 'projectSettings',
      memory: 'project',
      effort: 'xhigh',
    }

    await saveAgentToFile(
      'projectSettings',
      agent.agentType,
      agent.whenToUse,
      ['Read'],
      agent.rawSystemPrompt,
      true,
      'blue',
      'inherit',
      agent.memory,
      agent.effort,
      { skills: ['reviewing'] },
    )
    const filePath = getNewAgentFilePath(agent)
    await expect(
      saveAgentToFile(
        'projectSettings',
        agent.agentType,
        agent.whenToUse,
        undefined,
        agent.rawSystemPrompt,
      ),
    ).rejects.toThrow(`Agent file already exists: ${filePath}`)

    await updateAgentFile(
      agent,
      'Review carefully',
      ['Read', 'Grep'],
      undefined,
      'green',
      'opus',
      'local',
      9,
    )
    let parsed = parseFrontmatter(await fs.readFile(filePath, 'utf-8'))
    expect(parsed.frontmatter).toMatchObject({
      description: 'Review carefully',
      tools: ['Read', 'Grep'],
      model: 'opus',
      color: 'green',
      memory: 'local',
      effort: 9,
      skills: ['reviewing'],
    })
    expect(parsed.content).toBe('Original prompt.\n')

    await saveAgentToFile(
      'projectSettings',
      agent.agentType,
      'Overwritten description',
      undefined,
      'Overwritten prompt.',
      false,
    )
    parsed = parseFrontmatter(await fs.readFile(filePath, 'utf-8'))
    expect(parsed.frontmatter.description).toBe('Overwritten description')
    expect(parsed.content).toBe('Overwritten prompt.\n')

    await deleteAgentFromFile(agent)
    await expect(fs.stat(filePath)).rejects.toThrow()
    await deleteAgentFromFile(agent)
  })

  test('does not write runtime memory tools during an unrelated edit', async () => {
    const agent: CustomAgentDefinition = {
      agentType: 'memory-reviewer',
      whenToUse: 'Review with memory',
      rawSystemPrompt: 'Review without changing this prompt.',
      rawTools: ['Bash'],
      tools: ['Bash', 'Write', 'Edit', 'Read'],
      getSystemPrompt: () => 'Review without changing this prompt.\n\nRuntime memory instructions.',
      source: 'projectSettings',
      memory: 'project',
    }

    await saveAgentToFile(
      agent.source,
      agent.agentType,
      agent.whenToUse,
      agent.rawTools,
      agent.rawSystemPrompt,
      true,
      undefined,
      undefined,
      agent.memory,
    )
    await updateAgentFile(
      agent,
      'Updated description only',
      getPersistedAgentTools(agent),
      undefined,
    )

    const parsed = parseFrontmatter(
      await fs.readFile(getNewAgentFilePath(agent), 'utf-8'),
    )
    expect(parsed.frontmatter.tools).toEqual(['Bash'])
    expect(parsed.content).toBe('Review without changing this prompt.\n')
  })

  test('updates and deletes the exact nested Markdown file when its filename differs', async () => {
    const agentsDir = path.join(temporaryRoot, '.claude', 'agents')
    const nestedFile = path.join(agentsDir, 'nested', 'different-filename.md')
    const fallbackFile = path.join(agentsDir, 'different-filename.md')
    await fs.mkdir(path.dirname(nestedFile), { recursive: true })
    await fs.writeFile(
      nestedFile,
      formatAgentAsMarkdown(
        'reviewer',
        'Original description',
        ['Read'],
        'Keep this prompt.',
      ),
      'utf-8',
    )
    const agent: CustomAgentDefinition = {
      agentType: 'reviewer',
      whenToUse: 'Original description',
      rawSystemPrompt: 'Keep this prompt.',
      rawTools: ['Read'],
      tools: ['Read'],
      getSystemPrompt: () => 'Keep this prompt.',
      source: 'projectSettings',
      filename: 'different-filename',
      baseDir: agentsDir,
      sourceFilePath: nestedFile,
    }

    await updateAgentFile(
      agent,
      'Updated nested description',
      getPersistedAgentTools(agent),
      undefined,
    )
    const parsed = parseFrontmatter(await fs.readFile(nestedFile, 'utf-8'))
    expect(parsed.frontmatter.description).toBe('Updated nested description')
    await expect(fs.stat(fallbackFile)).rejects.toThrow()

    await deleteAgentFromFile(agent)
    await expect(fs.stat(nestedFile)).rejects.toThrow()
  })

  test('rejects updating a project agent through a final symlink', async () => {
    const agentsDir = path.join(temporaryRoot, '.claude', 'agents')
    const outsideFile = path.join(temporaryRoot, 'outside-agent.md')
    const symlinkFile = path.join(agentsDir, 'linked-agent.md')
    const originalContent = formatAgentAsMarkdown(
      'linked-agent',
      'Original outside description',
      ['Read'],
      'Keep this outside prompt.',
    )
    await fs.mkdir(agentsDir, { recursive: true })
    await fs.writeFile(outsideFile, originalContent, 'utf-8')
    if (process.platform === 'win32') {
      // Junctions exercise the same final-reparse-point rejection without
      // requiring the machine-wide privilege for creating file symlinks.
      await fs.symlink(temporaryRoot, symlinkFile, 'junction')
    } else {
      await fs.symlink(outsideFile, symlinkFile)
    }
    const agent: CustomAgentDefinition = {
      agentType: 'linked-agent',
      whenToUse: 'Original outside description',
      rawSystemPrompt: 'Keep this outside prompt.',
      rawTools: ['Read'],
      tools: ['Read'],
      getSystemPrompt: () => 'Keep this outside prompt.',
      source: 'projectSettings',
      baseDir: agentsDir,
      sourceFilePath: symlinkFile,
    }

    await expect(
      updateAgentFile(
        agent,
        'Changed through project symlink',
        getPersistedAgentTools(agent),
        undefined,
      ),
    ).rejects.toThrow('symbolic link')
    expect(await fs.readFile(outsideFile, 'utf-8')).toBe(originalContent)
  })

  test('rejects updating a project agent whose canonical path escapes its loaded directory', async () => {
    const agentsDir = path.join(temporaryRoot, '.claude', 'agents')
    const outsideDir = path.join(temporaryRoot, 'outside-agents')
    const outsideFile = path.join(outsideDir, 'nested-agent.md')
    const linkedDirectory = path.join(agentsDir, 'linked-directory')
    const lexicalFile = path.join(linkedDirectory, 'nested-agent.md')
    const originalContent = formatAgentAsMarkdown(
      'nested-agent',
      'Original outside description',
      ['Read'],
      'Keep this outside prompt.',
    )
    await fs.mkdir(agentsDir, { recursive: true })
    await fs.mkdir(outsideDir, { recursive: true })
    await fs.writeFile(outsideFile, originalContent, 'utf-8')
    await fs.symlink(outsideDir, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')
    const agent: CustomAgentDefinition = {
      agentType: 'nested-agent',
      whenToUse: 'Original outside description',
      rawSystemPrompt: 'Keep this outside prompt.',
      rawTools: ['Read'],
      tools: ['Read'],
      getSystemPrompt: () => 'Keep this outside prompt.',
      source: 'projectSettings',
      baseDir: agentsDir,
      sourceFilePath: lexicalFile,
    }

    await expect(
      updateAgentFile(
        agent,
        'Changed through linked directory',
        getPersistedAgentTools(agent),
        undefined,
      ),
    ).rejects.toThrow('outside its agents directory')
    expect(await fs.readFile(outsideFile, 'utf-8')).toBe(originalContent)
  })

  test('rejects mutations of built-in agents', async () => {
    const builtInAgent: AgentDefinition = {
      agentType: 'explore',
      whenToUse: 'Explore',
      getSystemPrompt: () => 'Explore.',
      source: 'built-in',
      baseDir: 'built-in',
    }

    await expect(
      saveAgentToFile(
        'built-in',
        'explore',
        'Explore',
        undefined,
        'Explore.',
      ),
    ).rejects.toThrow('Cannot save built-in agents')
    await expect(
      updateAgentFile(
        builtInAgent,
        'Explore',
        undefined,
        undefined,
      ),
    ).rejects.toThrow('Cannot update built-in agents')
    await expect(deleteAgentFromFile(builtInAgent)).rejects.toThrow(
      'Cannot delete built-in agents',
    )
  })
})
