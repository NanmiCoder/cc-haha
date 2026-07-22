import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AppState } from '../../state/AppStateStore.js'
import { handleAgentsApi } from '../api/agents.js'
import { clearAgentDefinitionsCache } from '../../tools/AgentTool/loadAgentsDir.js'
import { findGitRoot } from '../../utils/git.js'
import { refreshActivePlugins } from '../../utils/plugins/refresh.js'
import { AgentService } from '../services/agentService.js'
import { conversationService } from '../services/conversationService.js'
import {
  __resetWebSocketHandlerStateForTests,
  getSlashCommands,
} from '../ws/handler.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalNativeSearch = process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH
const originalHome = process.env.HOME

let tempRoot: string
let configDir: string
let projectRoot: string
let projectCwd: string
let originalHasSession: typeof conversationService.hasSession
let originalRequestControl: typeof conversationService.requestControl

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-agents-api-'))
  configDir = path.join(tempRoot, 'config')
  projectRoot = path.join(tempRoot, 'project')
  projectCwd = path.join(projectRoot, 'src')
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(path.join(projectRoot, '.git'), { recursive: true })
  await fs.mkdir(projectCwd, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH = '1'
  clearAgentDefinitionsCache()
  __resetWebSocketHandlerStateForTests()
  originalHasSession = conversationService.hasSession.bind(conversationService)
  originalRequestControl = conversationService.requestControl.bind(conversationService)
})

afterEach(async () => {
  conversationService.hasSession = originalHasSession
  conversationService.requestControl = originalRequestControl
  __resetWebSocketHandlerStateForTests()
  clearAgentDefinitionsCache()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalNativeSearch === undefined) {
    delete process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH
  } else {
    process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH = originalNativeSearch
  }
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  await fs.rm(tempRoot, { recursive: true, force: true })
})

describe('Agents API Markdown CRUD', () => {
  it('reloads agent definitions in the active CLI session without replacing it', async () => {
    const controlRequests: Array<{
      sessionId: string
      request: Record<string, unknown>
      timeoutMs: number
    }> = []
    conversationService.hasSession = ((sessionId: string) =>
      sessionId === 'session-agents') as typeof conversationService.hasSession
    conversationService.requestControl = (async (
      sessionId: string,
      request: Record<string, unknown>,
      timeoutMs: number,
    ) => {
      controlRequests.push({ sessionId, request, timeoutMs })
      return {
        commands: [
          {
            name: 'agents',
            description: 'Manage agent configurations.',
            argumentHint: '[agent-name]',
          },
        ],
        agents: [
          { name: 'new-reviewer' },
          { name: 'updated-writer' },
        ],
        plugins: [],
        mcpServers: [],
        error_count: 0,
      }
    }) as typeof conversationService.requestControl

    const response = await api(
      'POST',
      '/api/agents/reload?sessionId=session-agents',
    )

    expect(response.status).toBe(200)
    expect(controlRequests).toEqual([
      {
        sessionId: 'session-agents',
        request: { subtype: 'reload_plugins' },
        timeoutMs: 120_000,
      },
    ])
    expect(response.data).toEqual({
      ok: true,
      session: {
        applied: true,
        commands: 1,
        agents: 2,
        plugins: 0,
        mcpServers: 0,
        errors: 0,
      },
    })
    expect(getSlashCommands('session-agents')).toEqual([
      {
        name: 'agents',
        description: 'Manage agent configurations.',
        argumentHint: '[agent-name]',
      },
    ])
  })

  it('refreshes the running AppState agent definitions from the current config directory', async () => {
    const agentsDir = path.join(configDir, 'agents')
    await fs.mkdir(agentsDir, { recursive: true })
    await fs.writeFile(
      path.join(agentsDir, 'live-reviewer.md'),
      [
        '---',
        'name: live-reviewer',
        'description: Loaded into the current session state',
        'model: haiku',
        'effort: high',
        '---',
        'Review the current change.',
      ].join('\n'),
      'utf-8',
    )

    let appState = {
      plugins: {
        enabled: [],
        disabled: [],
        commands: [],
        errors: [],
        needsRefresh: true,
      },
      mcp: { pluginReconnectKey: 0 },
      agentDefinitions: { activeAgents: [], allAgents: [] },
    } as unknown as AppState

    const result = await refreshActivePlugins(updater => {
      appState = updater(appState)
    })

    expect(result.agentDefinitions.activeAgents).toContainEqual(
      expect.objectContaining({
        agentType: 'live-reviewer',
        source: 'userSettings',
        model: 'haiku',
        effort: 'high',
      }),
    )
    expect(appState.agentDefinitions.activeAgents).toContainEqual(
      expect.objectContaining({ agentType: 'live-reviewer' }),
    )
  })

  it('validates agent session reloads and reports unavailable sessions without failing', async () => {
    conversationService.hasSession = (() => false) as typeof conversationService.hasSession

    const missingSessionId = await api('POST', '/api/agents/reload')
    expect(missingSessionId.status).toBe(400)

    const whitespaceSessionId = await api(
      'POST',
      '/api/agents/reload?sessionId=%20%20',
    )
    expect(whitespaceSessionId.status).toBe(400)

    const unavailable = await api(
      'POST',
      '/api/agents/reload?sessionId=closed-session',
    )
    expect(unavailable.status).toBe(200)
    expect(unavailable.data.session).toEqual({
      applied: false,
      reason: 'not_running',
      commands: 0,
      agents: 0,
      plugins: 0,
      mcpServers: 0,
      errors: 0,
    })
  })

  it('reports a session reload control failure without failing the request', async () => {
    conversationService.hasSession = (() => true) as typeof conversationService.hasSession
    conversationService.requestControl = (async () => {
      throw new Error('CLI control channel closed')
    }) as typeof conversationService.requestControl

    const response = await api(
      'POST',
      '/api/agents/reload?sessionId=session-agents',
    )

    expect(response.status).toBe(200)
    expect(response.data.session).toEqual({
      applied: false,
      reason: 'failed',
      commands: 0,
      agents: 0,
      plugins: 0,
      mcpServers: 0,
      errors: 0,
      error: 'CLI control channel closed',
    })
  })

  it('creates, lists, updates, and deletes user and project agents', async () => {
    const userCreate = await api('POST', '/api/agents', {
      scope: 'user',
      cwd: projectCwd,
      name: 'security-reviewer',
      description: 'Reviews security-sensitive changes',
      systemPrompt: 'Review this change for security regressions.',
      model: 'opus',
      effort: 'xhigh',
      tools: ['Read', 'Grep'],
      color: 'red',
    })

    expect(userCreate.status).toBe(201)
    expect(userCreate.data.agent).toMatchObject({
      agentType: 'security-reviewer',
      source: 'userSettings',
      effort: 'xhigh',
      editable: true,
    })
    const userFile = path.join(configDir, 'agents', 'security-reviewer.md')
    expect(userCreate.data.agent.target).toBe(await fs.realpath(userFile))
    const createdMarkdown = await fs.readFile(userFile, 'utf-8')
    expect(createdMarkdown).toContain('name: security-reviewer')
    expect(createdMarkdown).toContain('effort: xhigh')
    expect(createdMarkdown).toContain('Review this change for security regressions.')

    const userList = await api(
      'GET',
      `/api/agents?cwd=${encodeURIComponent(projectCwd)}`,
    )
    expect(userList.status).toBe(200)
    expect(userList.data.availableTools).toEqual(
      expect.arrayContaining(['Read', 'Grep', 'Bash']),
    )
    expect(userList.data.availableTools).not.toContain('Agent')
    expect(userList.data.activeAgents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentType: 'security-reviewer',
          effort: 'xhigh',
          editable: true,
        }),
      ]),
    )

    const nestedUserDir = path.join(configDir, 'agents', 'review')
    const nestedUserFile = path.join(nestedUserDir, 'reviewer-definition.md')
    await fs.mkdir(nestedUserDir, { recursive: true })
    await fs.writeFile(
      nestedUserFile,
      `---\nname: nested-reviewer\ndescription: Nested official agent\ncustomNested: keep\n---\nReview from a nested folder.\n`,
      'utf-8',
    )
    clearAgentDefinitionsCache()
    const nestedList = await api(
      'GET',
      `/api/agents?cwd=${encodeURIComponent(projectCwd)}`,
    )
    const nestedAgent = nestedList.data.allAgents.find(
      (agent: { agentType: string }) => agent.agentType === 'nested-reviewer',
    )
    expect(nestedAgent).toMatchObject({
      editable: true,
      source: 'userSettings',
      target: await fs.realpath(nestedUserFile),
    })
    const nestedUpdate = await api('PUT', '/api/agents/nested-reviewer', {
      scope: 'user',
      cwd: projectCwd,
      target: nestedAgent.target,
      description: 'Updated nested official agent',
    })
    expect(nestedUpdate.status).toBe(200)
    expect(nestedUpdate.data.agent.target).toBe(await fs.realpath(nestedUserFile))
    const updatedNested = await fs.readFile(nestedUserFile, 'utf-8')
    expect(updatedNested).toContain('description: Updated nested official agent')
    expect(updatedNested).toContain('customNested: keep')
    expect(updatedNested).toContain('Review from a nested folder.')
    const nestedDelete = await api(
      'DELETE',
      `/api/agents/nested-reviewer?scope=user&cwd=${encodeURIComponent(projectCwd)}&target=${encodeURIComponent(nestedAgent.target)}`,
    )
    expect(nestedDelete.status).toBe(200)
    expect(await fileExists(nestedUserFile)).toBe(false)

    await fs.writeFile(
      userFile,
      createdMarkdown.replace(
        'description:',
        'permissionMode: plan\ncustomMetadata:\n  owner: desktop\ndescription:',
      ),
      'utf-8',
    )

    const userUpdate = await api('PUT', '/api/agents/security-reviewer', {
      scope: 'user',
      cwd: projectCwd,
      description: 'Updated security reviewer',
      effort: 'low',
    })
    expect(userUpdate.status).toBe(200)
    expect(userUpdate.data.agent).toMatchObject({
      agentType: 'security-reviewer',
      description: 'Updated security reviewer',
      effort: 'low',
      editable: true,
    })

    const updatedMarkdown = await fs.readFile(userFile, 'utf-8')
    expect(updatedMarkdown).toContain('permissionMode: plan')
    expect(updatedMarkdown).toContain('customMetadata:')
    expect(updatedMarkdown).toContain('owner: desktop')
    expect(updatedMarkdown).toContain('Review this change for security regressions.')

    const clearedOverrides = await api('PUT', '/api/agents/security-reviewer', {
      scope: 'user',
      cwd: projectCwd,
      model: null,
      effort: null,
      color: null,
      tools: [],
    })
    expect(clearedOverrides.status).toBe(200)
    expect(clearedOverrides.data.agent.modelDisplay).toBe('inherit')
    expect(clearedOverrides.data.agent).not.toHaveProperty('model')
    expect(clearedOverrides.data.agent).not.toHaveProperty('effort')
    expect(clearedOverrides.data.agent).not.toHaveProperty('color')
    expect(clearedOverrides.data.agent.tools).toEqual([])
    const clearedMarkdown = await fs.readFile(userFile, 'utf-8')
    expect(clearedMarkdown).not.toMatch(/^model:/m)
    expect(clearedMarkdown).not.toMatch(/^effort:/m)
    expect(clearedMarkdown).not.toMatch(/^color:/m)
    expect(clearedMarkdown).toContain('tools: []')
    expect(clearedMarkdown).toContain('customMetadata:')

    const inheritedTools = await api('PUT', '/api/agents/security-reviewer', {
      scope: 'user',
      cwd: projectCwd,
      tools: null,
    })
    expect(inheritedTools.status).toBe(200)
    expect(inheritedTools.data.agent).not.toHaveProperty('tools')
    const inheritedToolsMarkdown = await fs.readFile(userFile, 'utf-8')
    expect(inheritedToolsMarkdown).not.toMatch(/^tools:/m)
    expect(inheritedToolsMarkdown).toContain('customMetadata:')

    const memoryCreate = await api('POST', '/api/agents', {
      scope: 'user',
      cwd: projectCwd,
      name: 'memory-reviewer',
      description: 'Reviews with private persistent memory',
      systemPrompt: 'Only this raw prompt should be returned by the API.',
      tools: ['Read'],
    })
    expect(memoryCreate.status).toBe(201)
    const memoryFile = path.join(configDir, 'agents', 'memory-reviewer.md')
    const memoryMarkdown = await fs.readFile(memoryFile, 'utf-8')
    await fs.writeFile(
      memoryFile,
      memoryMarkdown.replace('description:', 'memory: user\ndescription:'),
      'utf-8',
    )
    clearAgentDefinitionsCache()
    const memoryList = await api(
      'GET',
      `/api/agents?cwd=${encodeURIComponent(projectCwd)}`,
    )
    const memoryAgent = memoryList.data.activeAgents.find(
      (agent: { agentType: string }) => agent.agentType === 'memory-reviewer',
    )
    expect(memoryAgent.systemPrompt).toBe(
      'Only this raw prompt should be returned by the API.',
    )
    expect(memoryAgent.systemPrompt).not.toContain('Persistent Agent Memory')
    expect(memoryAgent.tools).toEqual(['Read'])

    const projectCreate = await api('POST', '/api/agents', {
      scope: 'project',
      cwd: projectCwd,
      name: 'test-writer',
      description: 'Writes focused regression tests',
      systemPrompt: 'Write the smallest deterministic regression test.',
      model: 'haiku',
      effort: 'medium',
      tools: ['Read', 'Write'],
    })
    expect(projectCreate.status).toBe(201)
    expect(projectCreate.data.agent).toMatchObject({
      agentType: 'test-writer',
      source: 'projectSettings',
      effort: 'medium',
      editable: true,
    })
    expect(projectCreate.data.agent.target).toBe(
      await fs.realpath(
        path.join(projectRoot, '.claude', 'agents', 'test-writer.md'),
      ),
    )
    expect(
      await fs.readFile(
        path.join(projectRoot, '.claude', 'agents', 'test-writer.md'),
        'utf-8',
      ),
    ).toContain('name: test-writer')

    const projectDelete = await api(
      'DELETE',
      `/api/agents/test-writer?scope=project&cwd=${encodeURIComponent(projectCwd)}`,
    )
    expect(projectDelete.status).toBe(200)
    expect(projectDelete.data).toEqual({ ok: true })

    const userDelete = await api(
      'DELETE',
      `/api/agents/security-reviewer?scope=user&cwd=${encodeURIComponent(projectCwd)}`,
    )
    expect(userDelete.status).toBe(200)
    expect(
      (
        await api(
          'DELETE',
          `/api/agents/memory-reviewer?scope=user&cwd=${encodeURIComponent(projectCwd)}`,
        )
      ).status,
    ).toBe(200)

    const afterDelete = await api(
      'GET',
      `/api/agents?cwd=${encodeURIComponent(projectCwd)}`,
    )
    expect(
      afterDelete.data.activeAgents.some(
        (agent: { agentType: string }) => agent.agentType === 'security-reviewer',
      ),
    ).toBe(false)
    expect(
      afterDelete.data.activeAgents.some(
        (agent: { agentType: string }) => agent.agentType === 'test-writer',
      ),
    ).toBe(false)
  })

  it('creates a project agent in a nested repository initialized after its root was cached', async () => {
    const nestedProjectRoot = path.join(projectRoot, 'manual-workspace')
    await fs.mkdir(nestedProjectRoot, { recursive: true })

    findGitRoot.cache.delete(nestedProjectRoot)
    expect(findGitRoot(nestedProjectRoot)).toBe(projectRoot)
    await fs.mkdir(path.join(nestedProjectRoot, '.git'))

    try {
      const creation = await api('POST', '/api/agents', {
        scope: 'project',
        cwd: nestedProjectRoot,
        name: 'nested-repository-reviewer',
        description: 'Reviews the independently initialized nested repository',
        systemPrompt: 'Keep project agent changes inside this repository.',
      })

      const nestedAgentFile = path.join(
        nestedProjectRoot,
        '.claude',
        'agents',
        'nested-repository-reviewer.md',
      )
      expect(creation.status).toBe(201)
      expect(creation.data.agent.target).toBe(await fs.realpath(nestedAgentFile))
      expect(await fileExists(nestedAgentFile)).toBe(true)
      expect(
        await fileExists(
          path.join(
            projectRoot,
            '.claude',
            'agents',
            'nested-repository-reviewer.md',
          ),
        ),
      ).toBe(false)
    } finally {
      findGitRoot.cache.delete(nestedProjectRoot)
    }
  })

  it('updates and deletes the exact nested project file when its filename differs from its agent name', async () => {
    const nestedProjectDir = path.join(
      projectRoot,
      '.claude',
      'agents',
      'team',
    )
    const nestedProjectFile = path.join(
      nestedProjectDir,
      'reviewer-definition.md',
    )
    await fs.mkdir(nestedProjectDir, { recursive: true })
    await fs.writeFile(
      nestedProjectFile,
      `---\nname: project-reviewer\ndescription: Reviews this project\ncustomProject:\n  owner: team\n---\nReview the project-specific change.\n`,
      'utf-8',
    )
    const duplicateProjectFile = path.join(
      projectRoot,
      '.claude',
      'agents',
      'project-reviewer.md',
    )
    const duplicateProjectContent =
      '---\nname: project-reviewer\ndescription: Direct duplicate\neffort: low\n---\nDo not update this duplicate.\n'
    await fs.writeFile(
      duplicateProjectFile,
      duplicateProjectContent,
      'utf-8',
    )
    const nestedProjectTarget = await fs.realpath(nestedProjectFile)
    clearAgentDefinitionsCache()

    const list = await api(
      'GET',
      `/api/agents?cwd=${encodeURIComponent(projectCwd)}`,
    )
    const listedAgent = list.data.allAgents.find(
      (agent: { agentType: string; source: string }) =>
        agent.agentType === 'project-reviewer' &&
        agent.source === 'projectSettings',
    )
    expect(listedAgent).toMatchObject({
      editable: true,
      source: 'projectSettings',
    })

    const update = await api('PUT', '/api/agents/project-reviewer', {
      scope: 'project',
      cwd: projectCwd,
      target: nestedProjectTarget,
      effort: 'high',
      systemPrompt: 'Review the exact nested project definition.',
    })
    expect(update.status).toBe(200)
    expect(update.data.agent).toMatchObject({
      agentType: 'project-reviewer',
      source: 'projectSettings',
      effort: 'high',
      editable: true,
      target: nestedProjectTarget,
    })
    const updatedMarkdown = await fs.readFile(nestedProjectFile, 'utf-8')
    expect(updatedMarkdown).toContain('customProject:')
    expect(updatedMarkdown).toContain('owner: team')
    expect(updatedMarkdown).toContain('effort: high')
    expect(updatedMarkdown).toContain(
      'Review the exact nested project definition.',
    )
    expect(await fs.readFile(duplicateProjectFile, 'utf-8')).toBe(
      duplicateProjectContent,
    )

    const deletion = await api(
      'DELETE',
      `/api/agents/project-reviewer?scope=project&cwd=${encodeURIComponent(projectCwd)}&target=${encodeURIComponent(nestedProjectTarget)}`,
    )
    expect(deletion.status).toBe(200)
    expect(await fileExists(nestedProjectFile)).toBe(false)
    expect(await fs.readFile(duplicateProjectFile, 'utf-8')).toBe(
      duplicateProjectContent,
    )
  })

  it('round-trips official empty-body agents while keeping create strict', async () => {
    const agentsDir = path.join(configDir, 'agents')
    const emptyBodyFile = path.join(agentsDir, 'empty-body-definition.md')
    await fs.mkdir(agentsDir, { recursive: true })
    await fs.writeFile(
      emptyBodyFile,
      '---\nname: empty-body-agent\ndescription: Existing empty body\ncustomMetadata: keep\n---\n',
      'utf-8',
    )
    clearAgentDefinitionsCache()

    const list = await api(
      'GET',
      `/api/agents?cwd=${encodeURIComponent(projectCwd)}`,
    )
    const emptyBodyAgent = list.data.activeAgents.find(
      (agent: { agentType: string }) => agent.agentType === 'empty-body-agent',
    )
    expect(emptyBodyAgent).toMatchObject({
      editable: true,
      source: 'userSettings',
      systemPrompt: '',
      target: await fs.realpath(emptyBodyFile),
    })

    const metadataOnly = await api('PUT', '/api/agents/empty-body-agent', {
      scope: 'user',
      cwd: projectCwd,
      target: emptyBodyAgent.target,
      description: 'Metadata changed with an empty body',
    })
    expect(metadataOnly.status).toBe(200)
    expect(metadataOnly.data.agent).toMatchObject({
      description: 'Metadata changed with an empty body',
      systemPrompt: '',
    })
    const metadataMarkdown = await fs.readFile(emptyBodyFile, 'utf-8')
    expect(metadataMarkdown).toContain('customMetadata: keep')
    expect(markdownBody(metadataMarkdown).trim()).toBe('')

    const clearableCreate = await api('POST', '/api/agents', {
      scope: 'user',
      cwd: projectCwd,
      name: 'clearable-body',
      description: 'Starts with a non-empty body',
      systemPrompt: 'Remove this prompt explicitly.',
    })
    expect(clearableCreate.status).toBe(201)
    const clearableFile = path.join(configDir, 'agents', 'clearable-body.md')
    const explicitClear = await api('PUT', '/api/agents/clearable-body', {
      scope: 'user',
      cwd: projectCwd,
      target: clearableCreate.data.agent.target,
      systemPrompt: '  \n\t ',
    })
    expect(explicitClear.status).toBe(200)
    expect(explicitClear.data.agent.systemPrompt).toBe('')
    expect(markdownBody(await fs.readFile(clearableFile, 'utf-8')).trim()).toBe(
      '',
    )

    const clearedMarkdown = await fs.readFile(clearableFile, 'utf-8')
    const emptyDescription = await api('PUT', '/api/agents/clearable-body', {
      scope: 'user',
      cwd: projectCwd,
      target: explicitClear.data.agent.target,
      description: '   ',
    })
    expect(emptyDescription.status).toBe(400)
    const nonStringClear = await api('PUT', '/api/agents/clearable-body', {
      scope: 'user',
      cwd: projectCwd,
      target: explicitClear.data.agent.target,
      systemPrompt: null,
    })
    expect(nonStringClear.status).toBe(400)
    expect(await fs.readFile(clearableFile, 'utf-8')).toBe(clearedMarkdown)
  })

  it('rejects traversal, arbitrary fields, and mutations of read-only agents', async () => {
    const compatibilityCreate = await api('POST', '/api/agents', {
      name: 'legacy-client',
      description: 'Uses the backward-compatible default user scope',
      systemPrompt: 'Run with inherited defaults.',
      model: null,
      effort: null,
      tools: null,
      color: null,
    })
    expect(compatibilityCreate.status).toBe(201)
    expect(compatibilityCreate.data.agent.source).toBe('userSettings')
    expect(compatibilityCreate.data.agent.modelDisplay).toBe('inherit')
    const compatibilityMarkdown = await fs.readFile(
      path.join(configDir, 'agents', 'legacy-client.md'),
      'utf-8',
    )
    expect(compatibilityMarkdown).not.toMatch(/^model:|^effort:|^tools:|^color:/m)
    expect((await api('DELETE', '/api/agents/legacy-client')).status).toBe(200)

    const traversal = await api('POST', '/api/agents', {
      scope: 'user',
      cwd: projectCwd,
      name: '../escape',
      description: 'Traversal attempt',
      systemPrompt: 'Do not write this file.',
    })
    expect(traversal.status).toBe(400)
    expect(await fileExists(path.join(configDir, 'escape.md'))).toBe(false)

    const arbitraryPath = await api('POST', '/api/agents', {
      scope: 'user',
      cwd: projectCwd,
      name: 'unsafe-path',
      description: 'Arbitrary path attempt',
      systemPrompt: 'Do not write this file.',
      path: path.join(tempRoot, 'outside.md'),
    })
    expect(arbitraryPath.status).toBe(400)
    expect(await fileExists(path.join(tempRoot, 'outside.md'))).toBe(false)

    const arbitraryTarget = await api('POST', '/api/agents', {
      scope: 'user',
      cwd: projectCwd,
      name: 'unsafe-target',
      description: 'Arbitrary target attempt',
      systemPrompt: 'Do not write this file.',
      target: path.join(tempRoot, 'outside.md'),
    })
    expect(arbitraryTarget.status).toBe(400)
    expect(
      await fileExists(path.join(configDir, 'agents', 'unsafe-target.md')),
    ).toBe(false)

    const nestedUserDuplicateFile = path.join(
      configDir,
      'agents',
      'nested',
      'existing-definition.md',
    )
    await fs.mkdir(path.dirname(nestedUserDuplicateFile), { recursive: true })
    await fs.writeFile(
      nestedUserDuplicateFile,
      '---\nname: existing-nested\ndescription: Existing nested user agent\n---\nExisting prompt.\n',
      'utf-8',
    )
    const duplicateNestedUser = await api('POST', '/api/agents', {
      scope: 'user',
      cwd: projectCwd,
      name: 'existing-nested',
      description: 'Must not duplicate the nested identity',
      systemPrompt: 'Must not be created.',
    })
    expect(duplicateNestedUser.status).toBe(409)
    expect(
      await fileExists(path.join(configDir, 'agents', 'existing-nested.md')),
    ).toBe(false)

    const nestedProjectDuplicateFile = path.join(
      projectRoot,
      '.claude',
      'agents',
      'nested',
      'existing-project-definition.md',
    )
    await fs.mkdir(path.dirname(nestedProjectDuplicateFile), { recursive: true })
    await fs.writeFile(
      nestedProjectDuplicateFile,
      '---\nname: existing-project\ndescription: Existing nested project agent\n---\nExisting prompt.\n',
      'utf-8',
    )
    const duplicateNestedProject = await api('POST', '/api/agents', {
      scope: 'project',
      cwd: projectCwd,
      name: 'existing-project',
      description: 'Must not duplicate the nested project identity',
      systemPrompt: 'Must not be created.',
    })
    expect(duplicateNestedProject.status).toBe(409)
    expect(
      await fileExists(
        path.join(
          projectRoot,
          '.claude',
          'agents',
          'existing-project.md',
        ),
      ),
    ).toBe(false)

    const readOnlyUpdate = await api('PUT', '/api/agents/general-purpose', {
      scope: 'user',
      cwd: projectCwd,
      description: 'Attempt to overwrite a built-in',
    })
    expect(readOnlyUpdate.status).toBe(403)
    expect(readOnlyUpdate.data.error).toBe('READ_ONLY_AGENT')

    const readOnlyDelete = await api(
      'DELETE',
      `/api/agents/general-purpose?scope=user&cwd=${encodeURIComponent(projectCwd)}`,
    )
    expect(readOnlyDelete.status).toBe(403)
    expect(readOnlyDelete.data.error).toBe('READ_ONLY_AGENT')
  })

  it('validates request shapes, fields, methods, and scoped targets', async () => {
    const invalidJson = await rawApi('POST', '/api/agents', '{')
    expect(invalidJson.status).toBe(400)
    expect(invalidJson.data.message).toBe('Invalid JSON body')

    const nonObjectJson = await rawApi('POST', '/api/agents', '[]')
    expect(nonObjectJson.status).toBe(400)
    expect(nonObjectJson.data.message).toBe('JSON body must be an object')

    const malformedName = await api('GET', '/api/agents/%E0%A4%A')
    expect(malformedName.status).toBe(400)
    expect(malformedName.data.message).toBe('Invalid encoded agent name')

    expect((await api('PATCH', '/api/agents')).status).toBe(405)
    expect((await api('PATCH', '/api/agents/general-purpose')).status).toBe(405)

    const invalidScope = await api('POST', '/api/agents', {
      scope: 'workspace',
      name: 'invalid-scope',
      description: 'Invalid scope',
      systemPrompt: 'Never persisted.',
    })
    expect(invalidScope.status).toBe(400)

    const invalidCwdType = await api('POST', '/api/agents', {
      scope: 'user',
      cwd: 42,
      name: 'invalid-cwd',
      description: 'Invalid cwd',
      systemPrompt: 'Never persisted.',
    })
    expect(invalidCwdType.status).toBe(400)

    const missingDescription = await api('POST', '/api/agents', {
      scope: 'user',
      name: 'missing-description',
      systemPrompt: 'Never persisted.',
    })
    expect(missingDescription.status).toBe(400)

    const invalidEffort = await api('POST', '/api/agents', {
      scope: 'user',
      name: 'invalid-effort',
      description: 'Invalid effort',
      systemPrompt: 'Never persisted.',
      effort: 'extreme',
    })
    expect(invalidEffort.status).toBe(400)

    const invalidTools = await api('POST', '/api/agents', {
      scope: 'user',
      name: 'invalid-tools',
      description: 'Invalid tools',
      systemPrompt: 'Never persisted.',
      tools: ['Read', ''],
    })
    expect(invalidTools.status).toBe(400)

    const invalidColor = await api('POST', '/api/agents', {
      scope: 'user',
      name: 'invalid-color',
      description: 'Invalid color',
      systemPrompt: 'Never persisted.',
      color: 'ultraviolet',
    })
    expect(invalidColor.status).toBe(400)

    const missingProjectCwd = await api('POST', '/api/agents', {
      scope: 'project',
      cwd: path.join(tempRoot, 'missing-project'),
      name: 'missing-project',
      description: 'Missing project',
      systemPrompt: 'Never persisted.',
    })
    expect(missingProjectCwd.status).toBe(400)

    const cwdFile = path.join(tempRoot, 'not-a-directory')
    await fs.writeFile(cwdFile, 'file', 'utf-8')
    const fileProjectCwd = await api('POST', '/api/agents', {
      scope: 'project',
      cwd: cwdFile,
      name: 'file-project',
      description: 'File project',
      systemPrompt: 'Never persisted.',
    })
    expect(fileProjectCwd.status).toBe(400)

    const create = await api('POST', '/api/agents', {
      scope: 'user',
      cwd: projectCwd,
      name: 'validation-agent',
      description: 'Valid agent for update validation',
      systemPrompt: 'Original prompt.',
    })
    expect(create.status).toBe(201)

    const detail = await api(
      'GET',
      `/api/agents/validation-agent?cwd=${encodeURIComponent(projectCwd)}`,
    )
    expect(detail.status).toBe(200)
    expect(detail.data.agent.agentType).toBe('validation-agent')

    const rename = await api('PUT', '/api/agents/validation-agent', {
      scope: 'user',
      cwd: projectCwd,
      name: 'renamed-agent',
    })
    expect(rename.status).toBe(400)

    const nonStringPrompt = await api('PUT', '/api/agents/validation-agent', {
      scope: 'user',
      cwd: projectCwd,
      systemPrompt: 42,
    })
    expect(nonStringPrompt.status).toBe(400)

    const emptyPromptCreate = await api('POST', '/api/agents', {
      scope: 'user',
      cwd: projectCwd,
      name: 'empty-create',
      description: 'Create still requires a prompt',
      systemPrompt: '',
    })
    expect(emptyPromptCreate.status).toBe(400)
    expect(
      await fileExists(path.join(configDir, 'agents', 'empty-create.md')),
    ).toBe(false)

    const duplicate = await api('POST', '/api/agents', {
      scope: 'user',
      cwd: projectCwd,
      name: 'validation-agent',
      description: 'Duplicate',
      systemPrompt: 'Duplicate.',
    })
    expect(duplicate.status).toBe(409)

    const missingUpdate = await api('PUT', '/api/agents/not-created', {
      scope: 'user',
      cwd: projectCwd,
      description: 'Still missing',
    })
    expect(missingUpdate.status).toBe(404)

    const missingDelete = await api(
      'DELETE',
      `/api/agents/not-created?scope=user&cwd=${encodeURIComponent(projectCwd)}`,
    )
    expect(missingDelete.status).toBe(404)
  })

  it('rejects symlinked user and project agent roots for create, update, and delete', async () => {
    const outsideUserAgents = path.join(tempRoot, 'outside-user-agents')
    const outsideUserFile = path.join(outsideUserAgents, 'escaped-user.md')
    const outsideUserContent =
      '---\nname: escaped-user\ndescription: Outside user agent\n---\nOutside user prompt.\n'
    await fs.mkdir(outsideUserAgents, { recursive: true })
    await fs.writeFile(outsideUserFile, outsideUserContent, 'utf-8')
    await fs.symlink(outsideUserAgents, path.join(configDir, 'agents'))

    const userCreate = await api('POST', '/api/agents', {
      scope: 'user',
      cwd: projectCwd,
      name: 'must-stay-inside-user-root',
      description: 'Must not escape through the user agents symlink',
      systemPrompt: 'Never persisted outside.',
    })
    expect(userCreate.status).toBe(403)
    expect(
      await fileExists(
        path.join(outsideUserAgents, 'must-stay-inside-user-root.md'),
      ),
    ).toBe(false)

    const userNoTargetUpdate = await api('PUT', '/api/agents/escaped-user', {
      scope: 'user',
      cwd: projectCwd,
      description: 'Must not update through the user root symlink',
    })
    expect(userNoTargetUpdate.status).toBe(403)
    const userTargetUpdate = await api('PUT', '/api/agents/escaped-user', {
      scope: 'user',
      cwd: projectCwd,
      target: await fs.realpath(outsideUserFile),
      description: 'Must not update an explicit escaped target',
    })
    expect(userTargetUpdate.status).toBe(403)
    expect(
      (
        await api(
          'DELETE',
          `/api/agents/escaped-user?scope=user&cwd=${encodeURIComponent(projectCwd)}`,
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await api(
          'DELETE',
          `/api/agents/escaped-user?scope=user&cwd=${encodeURIComponent(projectCwd)}&target=${encodeURIComponent(await fs.realpath(outsideUserFile))}`,
        )
      ).status,
    ).toBe(403)
    expect(await fs.readFile(outsideUserFile, 'utf-8')).toBe(outsideUserContent)

    const outsideProjectAgents = path.join(tempRoot, 'outside-project-agents')
    const outsideProjectFile = path.join(
      outsideProjectAgents,
      'escaped-project.md',
    )
    const outsideProjectContent =
      '---\nname: escaped-project\ndescription: Outside project agent\n---\nOutside project prompt.\n'
    await fs.mkdir(outsideProjectAgents, { recursive: true })
    await fs.writeFile(outsideProjectFile, outsideProjectContent, 'utf-8')
    await fs.mkdir(path.join(projectRoot, '.claude'), { recursive: true })
    await fs.symlink(
      outsideProjectAgents,
      path.join(projectRoot, '.claude', 'agents'),
    )

    const projectCreate = await api('POST', '/api/agents', {
      scope: 'project',
      cwd: projectCwd,
      name: 'must-stay-inside-project-root',
      description: 'Must not escape through the project agents symlink',
      systemPrompt: 'Never persisted outside.',
    })
    expect(projectCreate.status).toBe(403)
    expect(
      await fileExists(
        path.join(outsideProjectAgents, 'must-stay-inside-project-root.md'),
      ),
    ).toBe(false)

    const projectNoTargetUpdate = await api(
      'PUT',
      '/api/agents/escaped-project',
      {
        scope: 'project',
        cwd: projectCwd,
        description: 'Must not update through the project root symlink',
      },
    )
    expect(projectNoTargetUpdate.status).toBe(403)
    const projectTargetUpdate = await api(
      'PUT',
      '/api/agents/escaped-project',
      {
        scope: 'project',
        cwd: projectCwd,
        target: await fs.realpath(outsideProjectFile),
        description: 'Must not update an explicit escaped project target',
      },
    )
    expect(projectTargetUpdate.status).toBe(403)
    expect(
      (
        await api(
          'DELETE',
          `/api/agents/escaped-project?scope=project&cwd=${encodeURIComponent(projectCwd)}`,
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await api(
          'DELETE',
          `/api/agents/escaped-project?scope=project&cwd=${encodeURIComponent(projectCwd)}&target=${encodeURIComponent(await fs.realpath(outsideProjectFile))}`,
        )
      ).status,
    ).toBe(403)
    expect(await fs.readFile(outsideProjectFile, 'utf-8')).toBe(
      outsideProjectContent,
    )

    const ancestorProjectRoot = path.join(tempRoot, 'ancestor-project')
    const ancestorProjectCwd = path.join(ancestorProjectRoot, 'src')
    const outsideClaudeDir = path.join(tempRoot, 'outside-claude')
    await fs.mkdir(path.join(ancestorProjectRoot, '.git'), { recursive: true })
    await fs.mkdir(ancestorProjectCwd, { recursive: true })
    await fs.mkdir(path.join(outsideClaudeDir, 'agents'), { recursive: true })
    await fs.symlink(outsideClaudeDir, path.join(ancestorProjectRoot, '.claude'))
    const ancestorCreate = await api('POST', '/api/agents', {
      scope: 'project',
      cwd: ancestorProjectCwd,
      name: 'must-not-follow-claude',
      description: 'Must not follow a symlinked .claude ancestor',
      systemPrompt: 'Never persisted outside.',
    })
    expect(ancestorCreate.status).toBe(403)
    expect(
      await fileExists(
        path.join(outsideClaudeDir, 'agents', 'must-not-follow-claude.md'),
      ),
    ).toBe(false)
  })

  it('fails closed when canonical user and project agent roots overlap', async () => {
    const fakeHome = path.join(tempRoot, 'fake-home-project')
    const fakeHomeCwd = path.join(fakeHome, 'src')
    const sharedAgentsDir = path.join(fakeHome, '.claude', 'agents')
    const sharedUserFile = path.join(sharedAgentsDir, 'shared-user.md')
    const sharedUserContent =
      '---\nname: shared-user\ndescription: User-owned shared-root agent\n---\nKeep this user file unchanged.\n'
    await fs.mkdir(path.join(fakeHome, '.git'), { recursive: true })
    await fs.mkdir(fakeHomeCwd, { recursive: true })
    await fs.mkdir(sharedAgentsDir, { recursive: true })
    await fs.writeFile(sharedUserFile, sharedUserContent, 'utf-8')
    process.env.HOME = fakeHome
    process.env.CLAUDE_CONFIG_DIR = path.join(fakeHome, '.claude')
    clearAgentDefinitionsCache()

    const equalRootCreate = await api('POST', '/api/agents', {
      scope: 'project',
      cwd: fakeHomeCwd,
      name: 'must-not-write-shared-root',
      description: 'Project and user roots are identical',
      systemPrompt: 'Never write into the user scope.',
    })
    expect(equalRootCreate.status).toBe(403)
    expect(equalRootCreate.data.error).toBe('AGENT_SCOPE_COLLISION')
    expect(
      await fileExists(path.join(sharedAgentsDir, 'must-not-write-shared-root.md')),
    ).toBe(false)

    const equalNoTargetUpdate = await api('PUT', '/api/agents/shared-user', {
      scope: 'project',
      cwd: fakeHomeCwd,
      description: 'Must not cross from project into user scope',
    })
    expect(equalNoTargetUpdate.status).toBe(403)
    expect(equalNoTargetUpdate.data.error).toBe('AGENT_SCOPE_COLLISION')
    const equalTargetUpdate = await api('PUT', '/api/agents/shared-user', {
      scope: 'project',
      cwd: fakeHomeCwd,
      target: await fs.realpath(sharedUserFile),
      description: 'Explicit target must not bypass scope isolation',
    })
    expect(equalTargetUpdate.status).toBe(403)
    expect(equalTargetUpdate.data.error).toBe('AGENT_SCOPE_COLLISION')
    expect(
      (
        await api(
          'DELETE',
          `/api/agents/shared-user?scope=project&cwd=${encodeURIComponent(fakeHomeCwd)}`,
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await api(
          'DELETE',
          `/api/agents/shared-user?scope=project&cwd=${encodeURIComponent(fakeHomeCwd)}&target=${encodeURIComponent(await fs.realpath(sharedUserFile))}`,
        )
      ).status,
    ).toBe(403)
    expect(await fs.readFile(sharedUserFile, 'utf-8')).toBe(sharedUserContent)

    const nestedProjectRoot = path.join(tempRoot, 'nested-overlap-project')
    const nestedProjectCwd = path.join(nestedProjectRoot, 'src')
    const nestedProjectAgents = path.join(
      nestedProjectRoot,
      '.claude',
      'agents',
    )
    const nestedConfigDir = path.join(nestedProjectAgents, 'global-config')
    const nestedUserAgents = path.join(nestedConfigDir, 'agents')
    const nestedUserFile = path.join(nestedUserAgents, 'nested-user.md')
    const nestedUserContent =
      '---\nname: nested-user\ndescription: User root nested in project root\n---\nDo not cross scopes.\n'
    await fs.mkdir(path.join(nestedProjectRoot, '.git'), { recursive: true })
    await fs.mkdir(nestedProjectCwd, { recursive: true })
    await fs.mkdir(nestedUserAgents, { recursive: true })
    await fs.writeFile(
      path.join(nestedProjectAgents, 'project-sentinel.md'),
      '---\nname: project-sentinel\ndescription: Valid project entry\n---\nProject prompt.\n',
      'utf-8',
    )
    await fs.writeFile(nestedUserFile, nestedUserContent, 'utf-8')
    process.env.HOME = path.join(tempRoot, 'separate-fake-home')
    process.env.CLAUDE_CONFIG_DIR = nestedConfigDir
    clearAgentDefinitionsCache()

    const nestedCreate = await api('POST', '/api/agents', {
      scope: 'project',
      cwd: nestedProjectCwd,
      name: 'must-not-create-in-overlap',
      description: 'User root is nested in project root',
      systemPrompt: 'Never write across overlapping scopes.',
    })
    expect(nestedCreate.status).toBe(403)
    expect(nestedCreate.data.error).toBe('AGENT_SCOPE_COLLISION')
    const nestedTargetUpdate = await api('PUT', '/api/agents/nested-user', {
      scope: 'project',
      cwd: nestedProjectCwd,
      target: await fs.realpath(nestedUserFile),
      description: 'Must not mutate nested user scope',
    })
    expect(nestedTargetUpdate.status).toBe(403)
    expect(nestedTargetUpdate.data.error).toBe('AGENT_SCOPE_COLLISION')
    expect(
      (
        await api(
          'DELETE',
          `/api/agents/nested-user?scope=project&cwd=${encodeURIComponent(nestedProjectCwd)}&target=${encodeURIComponent(await fs.realpath(nestedUserFile))}`,
        )
      ).status,
    ).toBe(403)
    expect(await fs.readFile(nestedUserFile, 'utf-8')).toBe(nestedUserContent)

    const outerConfigDir = path.join(tempRoot, 'outer-config')
    const outerUserAgents = path.join(outerConfigDir, 'agents')
    const innerProjectRoot = path.join(outerUserAgents, 'inner-project')
    const innerProjectCwd = path.join(innerProjectRoot, 'src')
    await fs.mkdir(path.join(innerProjectRoot, '.git'), { recursive: true })
    await fs.mkdir(innerProjectCwd, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = outerConfigDir
    clearAgentDefinitionsCache()
    const inverseOverlapCreate = await api('POST', '/api/agents', {
      scope: 'project',
      cwd: innerProjectCwd,
      name: 'must-not-create-under-user-root',
      description: 'Project root is nested under the user agents root',
      systemPrompt: 'Never create inside recursively loaded user scope.',
    })
    expect(inverseOverlapCreate.status).toBe(403)
    expect(inverseOverlapCreate.data.error).toBe('AGENT_SCOPE_COLLISION')
    expect(
      await fileExists(
        path.join(
          innerProjectRoot,
          '.claude',
          'agents',
          'must-not-create-under-user-root.md',
        ),
      ),
    ).toBe(false)
  })

  it('rechecks scope separation after case-folding project directories are created', async () => {
    const caseProjectRoot = path.join(tempRoot, 'case-fold-project')
    const caseProjectCwd = path.join(caseProjectRoot, 'src')
    await fs.mkdir(path.join(caseProjectRoot, '.git'), { recursive: true })
    await fs.mkdir(caseProjectCwd, { recursive: true })

    const probe = path.join(caseProjectRoot, 'case-probe')
    await fs.mkdir(probe)
    let caseInsensitive = false
    try {
      const [lowerStat, upperStat] = await Promise.all([
        fs.stat(probe),
        fs.stat(path.join(caseProjectRoot, 'CASE-PROBE')),
      ])
      caseInsensitive =
        lowerStat.dev === upperStat.dev && lowerStat.ino === upperStat.ino
    } catch {
      caseInsensitive = false
    }
    await fs.rmdir(probe)

    const differentlyCasedConfigDir = path.join(caseProjectRoot, '.CLAUDE')
    process.env.CLAUDE_CONFIG_DIR = differentlyCasedConfigDir
    clearAgentDefinitionsCache()
    const creation = await api('POST', '/api/agents', {
      scope: 'project',
      cwd: caseProjectCwd,
      name: 'case-collision',
      description: 'Exercises filesystem case folding after mkdir',
      systemPrompt: 'Never cross into the user agent scope.',
    })

    const projectFile = path.join(
      caseProjectRoot,
      '.claude',
      'agents',
      'case-collision.md',
    )
    const userFile = path.join(
      differentlyCasedConfigDir,
      'agents',
      'case-collision.md',
    )
    if (caseInsensitive) {
      expect(creation.status).toBe(403)
      expect(creation.data.error).toBe('AGENT_SCOPE_COLLISION')
      expect(await fileExists(projectFile)).toBe(false)
      expect(await fileExists(userFile)).toBe(false)
    } else {
      // On case-sensitive filesystems these are genuinely separate roots.
      expect(creation.status).toBe(201)
      expect(await fileExists(projectFile)).toBe(true)
      expect(await fileExists(userFile)).toBe(false)
    }
  })

  it('serializes concurrent updates by canonical target without losing fields', async () => {
    const service = new AgentService()
    const context = { scope: 'user' as const, cwd: projectCwd }
    await service.createAgent(
      {
        name: 'concurrent-reviewer',
        description: 'Initial description',
        systemPrompt: 'Keep every concurrent field update.',
      },
      context,
    )

    for (let iteration = 0; iteration < 20; iteration += 1) {
      await service.updateAgent(
        'concurrent-reviewer',
        { description: `Base ${iteration}`, effort: null },
        context,
      )
      const [descriptionUpdate, effortUpdate] = await Promise.all([
        service.updateAgent(
          'concurrent-reviewer',
          { description: `Concurrent ${iteration}` },
          context,
        ),
        service.updateAgent(
          'concurrent-reviewer',
          { effort: iteration },
          context,
        ),
      ])
      expect(descriptionUpdate.agent.description).toBe(`Concurrent ${iteration}`)
      expect(effortUpdate.agent.effort).toBe(iteration)
      expect((await service.getAgent('concurrent-reviewer', context))?.agent).toMatchObject(
        {
          description: `Concurrent ${iteration}`,
          effort: iteration,
        },
      )
    }
  })

  it('creates in the canonical main fallback without shadowing worktree agents', async () => {
    const mainRoot = path.join(tempRoot, 'main-repository')
    const mainGitDir = path.join(mainRoot, '.git')
    const worktreeRoot = path.join(tempRoot, 'linked-worktree')
    const worktreeCwd = path.join(worktreeRoot, 'src')
    const worktreeGitDir = path.join(mainGitDir, 'worktrees', 'linked-worktree')
    const mainAgentsDir = path.join(mainRoot, '.claude', 'agents')
    await fs.mkdir(worktreeGitDir, { recursive: true })
    await fs.mkdir(worktreeCwd, { recursive: true })
    await fs.mkdir(mainAgentsDir, { recursive: true })
    await fs.writeFile(
      path.join(worktreeRoot, '.git'),
      `gitdir: ${worktreeGitDir}\n`,
      'utf-8',
    )
    await fs.writeFile(
      path.join(worktreeGitDir, 'commondir'),
      '../..\n',
      'utf-8',
    )
    await fs.writeFile(
      path.join(worktreeGitDir, 'gitdir'),
      `${path.join(worktreeRoot, '.git')}\n`,
      'utf-8',
    )
    await fs.writeFile(
      path.join(mainAgentsDir, 'existing-main.md'),
      '---\nname: existing-main\ndescription: Existing main fallback\n---\nKeep this visible.\n',
      'utf-8',
    )
    clearAgentDefinitionsCache()

    const creation = await api('POST', '/api/agents', {
      scope: 'project',
      cwd: worktreeCwd,
      name: 'worktree-created',
      description: 'Created while the main fallback is active',
      systemPrompt: 'Stay alongside the main fallback agents.',
    })
    expect(creation.status).toBe(201)
    expect(creation.data.agent.target).toBe(
      await fs.realpath(path.join(mainAgentsDir, 'worktree-created.md')),
    )
    expect(
      await fileExists(path.join(worktreeRoot, '.claude', 'agents')),
    ).toBe(false)

    const list = await api(
      'GET',
      `/api/agents?cwd=${encodeURIComponent(worktreeCwd)}`,
    )
    expect(
      list.data.activeAgents.map((agent: { agentType: string }) => agent.agentType),
    ).toEqual(expect.arrayContaining(['existing-main', 'worktree-created']))
  })

  it('rejects malformed or non-regular Markdown files without leaving the safe scope', async () => {
    const agentsDir = path.join(configDir, 'agents')
    await fs.mkdir(agentsDir, { recursive: true })

    const invalidFiles = [
      ['no-frontmatter', 'plain text only'],
      ['invalid-yaml', '---\nname: [\n---\nPrompt'],
      ['non-mapping', '---\n- item\n---\nPrompt'],
    ] as const

    for (const [name, content] of invalidFiles) {
      await fs.writeFile(path.join(agentsDir, `${name}.md`), content, 'utf-8')
      const response = await api('PUT', `/api/agents/${name}`, {
        scope: 'user',
        cwd: projectCwd,
        description: 'Must not replace malformed input',
      })
      expect(response.status).toBe(400)
      expect(await fs.readFile(path.join(agentsDir, `${name}.md`), 'utf-8')).toBe(
        content,
      )
    }

    const outsideFile = path.join(tempRoot, 'outside-agent.md')
    await fs.writeFile(
      outsideFile,
      '---\nname: linked-agent\ndescription: Outside\n---\nPrompt',
      'utf-8',
    )
    await fs.symlink(outsideFile, path.join(agentsDir, 'linked-agent.md'))
    const linkedUpdate = await api('PUT', '/api/agents/linked-agent', {
      scope: 'user',
      cwd: projectCwd,
      description: 'Must not follow the link',
    })
    expect(linkedUpdate.status).toBe(403)
    expect(await fs.readFile(outsideFile, 'utf-8')).toContain('description: Outside')

    const linkedTargetUpdate = await api('PUT', '/api/agents/linked-agent', {
      scope: 'user',
      cwd: projectCwd,
      target: path.join(agentsDir, 'linked-agent.md'),
      description: 'Must not follow an explicit link either',
    })
    expect(linkedTargetUpdate.status).toBe(403)
    expect(await fs.readFile(outsideFile, 'utf-8')).toContain('description: Outside')

    const escapedTarget = path.join(tempRoot, 'escaped-target.md')
    const escapedContent =
      '---\nname: escaped-target\ndescription: Outside scope\n---\nOutside prompt.\n'
    await fs.writeFile(escapedTarget, escapedContent, 'utf-8')
    const escapedUpdate = await api('PUT', '/api/agents/escaped-target', {
      scope: 'user',
      cwd: projectCwd,
      target: escapedTarget,
      description: 'Must remain outside',
    })
    expect(escapedUpdate.status).toBe(403)
    expect(escapedUpdate.data.error).toBe('AGENT_SCOPE_MISMATCH')
    expect(await fs.readFile(escapedTarget, 'utf-8')).toBe(escapedContent)

    const identityFile = path.join(agentsDir, 'identity-definition.md')
    const identityContent =
      '---\nname: actual-identity\ndescription: Identity owner\n---\nOriginal prompt.\n'
    await fs.writeFile(identityFile, identityContent, 'utf-8')
    clearAgentDefinitionsCache()
    const mismatchedIdentity = await api('PUT', '/api/agents/requested-identity', {
      scope: 'user',
      cwd: projectCwd,
      target: identityFile,
      description: 'Must not change another identity',
    })
    expect(mismatchedIdentity.status).toBe(409)
    expect(mismatchedIdentity.data.error).toBe('CONFLICT')
    expect(await fs.readFile(identityFile, 'utf-8')).toBe(identityContent)
  })

  it('keeps service-level guards active behind the HTTP validation layer', async () => {
    const service = new AgentService()
    const userContext = { scope: 'user' as const, cwd: projectCwd }

    await expect(
      service.resolveAgentsDir({ scope: 'invalid' as 'user' }),
    ).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      service.updateAgent('missing-agent', {}, userContext),
    ).rejects.toMatchObject({ statusCode: 404 })
    await expect(
      service.deleteAgent('missing-agent', userContext),
    ).rejects.toMatchObject({ statusCode: 404 })

    await service.createAgent(
      {
        name: 'direct-service',
        description: 'Created directly through the service',
        systemPrompt: 'Original prompt.',
      },
      userContext,
    )
    await expect(
      service.updateAgent('direct-service', { name: 'different-name' }, userContext),
    ).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      service.updateAgent(
        'direct-service',
        { systemPrompt: 42 as unknown as string },
        userContext,
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

async function api(
  method: string,
  requestPath: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, any> }> {
  const url = new URL(requestPath, 'http://localhost')
  const request = new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const segments = requestPath
    .split('?')[0]!
    .split('/')
    .filter(Boolean)
  const response = await handleAgentsApi(request, url, segments)
  return {
    status: response.status,
    data: (await response.json()) as Record<string, any>,
  }
}

async function rawApi(
  method: string,
  requestPath: string,
  body: string,
): Promise<{ status: number; data: Record<string, any> }> {
  const url = new URL(requestPath, 'http://localhost')
  const request = new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  const segments = requestPath
    .split('?')[0]!
    .split('/')
    .filter(Boolean)
  const response = await handleAgentsApi(request, url, segments)
  return {
    status: response.status,
    data: (await response.json()) as Record<string, any>,
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

function markdownBody(markdown: string): string {
  const closingFrontmatter = markdown.indexOf('\n---\n', 4)
  if (closingFrontmatter < 0) {
    throw new Error('Expected Markdown agent frontmatter')
  }
  return markdown.slice(closingFrontmatter + '\n---\n'.length)
}
