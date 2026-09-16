import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { getCwdState, setCwdState } from '../../bootstrap/state.js'
import { enableConfigs } from '../../utils/config.js'
import { invalidateComputerUseSkillGate } from '../../utils/computerUse/skillGate.js'
import { clearInstalledPluginsCache } from '../../utils/plugins/installedPluginsManager.js'
import { clearPluginCache } from '../../utils/plugins/pluginLoader.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { handlePluginsApi } from '../api/plugins.js'
import { handleComputerUseApi } from '../api/computer-use.js'
import { handleSkillsApi, listSkillSlashCommands } from '../api/skills.js'

let tmpHome: string
let originalHome: string | undefined
let originalUserProfile: string | undefined
let originalClaudeConfigDir: string | undefined
let originalCwdState: string

function makeRequest(urlStr: string): { req: Request; url: URL; segments: string[] } {
  const url = new URL(urlStr, 'http://localhost:3456')
  const req = new Request(url.toString(), { method: 'GET' })
  return {
    req,
    url,
    segments: url.pathname.split('/').filter(Boolean),
  }
}

function makePluginReloadRequest(): { req: Request; url: URL; segments: string[] } {
  const url = new URL('/api/plugins/reload', 'http://localhost:3456')
  const req = new Request(url.toString(), { method: 'POST' })
  return {
    req,
    url,
    segments: url.pathname.split('/').filter(Boolean),
  }
}

async function writeSkill(root: string, skillName: string, content: string): Promise<void> {
  const skillDir = path.join(root, skillName)
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf-8')
}

describe('Skills API', () => {
  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-skills-test-'))
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalCwdState = getCwdState()

    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome
    process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude')
    setCwdState(tmpHome)
    // startServer() does this before serving anything, and the built-in command
    // table reads config while it is built. Without it the compiled-in half of
    // the slash list silently comes back empty — the exact bug these tests
    // cover, hidden by a test process that differs from production.
    enableConfigs()
    clearInstalledPluginsCache()
    clearPluginCache('skills-api-test-setup')
    resetSettingsCache()
    invalidateComputerUseSkillGate()
  })

  afterEach(async () => {
    clearInstalledPluginsCache()
    clearPluginCache('skills-api-test-teardown')
    resetSettingsCache()
    invalidateComputerUseSkillGate()
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }

    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE
    } else {
      process.env.USERPROFILE = originalUserProfile
    }

    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
    }

    setCwdState(originalCwdState)
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  it('isolates concurrent mention requests by project enablement and installed scope', async () => {
    const projectA = path.join(tmpHome, '普通目录 A')
    const projectB = path.join(tmpHome, '普通目录 B')
    const pluginsDir = path.join(tmpHome, '.claude', 'plugins')
    const market = path.join(tmpHome, 'market')
    const pluginRoot = path.join(market, 'plugins', 'draw')
    await Promise.all([projectA, projectB].map(project => fs.mkdir(path.join(project, '.claude'), { recursive: true })))
    await fs.mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(path.join(market, '.claude-plugin'), { recursive: true })
    await fs.mkdir(pluginsDir, { recursive: true })
    await fs.writeFile(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'draw', version: '1.0.0', description: 'Drawing' }))
    await writeSkill(path.join(pluginRoot, 'skills'), 'render', '---\ndescription: Draw a diagram.\n---\nDraw only on request.')
    await fs.writeFile(path.join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'test-market', owner: { name: 'Fixture' }, plugins: [{ name: 'draw', source: './plugins/draw', version: '1.0.0' }] }))
    await fs.writeFile(path.join(pluginsDir, 'known_marketplaces.json'), JSON.stringify({ 'test-market': { source: { source: 'directory', path: market }, installLocation: market, lastUpdated: new Date(0).toISOString() } }))
    const installed = (scope: 'user' | 'project') => ({ version: 2, plugins: { 'draw@test-market': [{ scope, ...(scope === 'project' ? { projectPath: projectA } : {}), installPath: pluginRoot, version: '1.0.0', installedAt: new Date(0).toISOString(), lastUpdated: new Date(0).toISOString() }] } })
    await fs.writeFile(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify(installed('user')))
    await fs.writeFile(path.join(tmpHome, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'draw@test-market': false } }))
    await fs.writeFile(path.join(projectA, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'draw@test-market': true } }))
    await fs.writeFile(path.join(projectB, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'draw@test-market': false } }))
    const mentions = async (cwd: string) => {
      const { req, url, segments } = makeRequest(`/api/skills/mentions?cwd=${encodeURIComponent(cwd)}`)
      const response = await handleSkillsApi(req, url, segments)
      expect(response.status).toBe(200)
      return response.json()
    }
    const [a, b] = await Promise.all([mentions(projectA), mentions(projectB)])
    expect(a.plugins.map((entry: { id: string }) => entry.id)).toEqual(['draw@test-market'])
    expect(a.skills.map((entry: { name: string }) => entry.name)).toContain('draw:render')
    expect(b.plugins).toEqual([])
    // Local settings override project settings without changing the server cwd.
    await fs.writeFile(path.join(projectA, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'draw@test-market': false } }))
    expect((await mentions(projectA)).plugins).toEqual([])
    await fs.rm(path.join(projectA, '.claude', 'settings.local.json'))
    // Even enabled=true cannot borrow another project's installation.
    await fs.writeFile(path.join(projectB, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'draw@test-market': true } }))
    await fs.writeFile(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify(installed('project')))
    const [scopedA, scopedB] = await Promise.all([mentions(projectA), mentions(projectB)])
    expect(scopedA.plugins.map((entry: { id: string }) => entry.id)).toEqual(['draw@test-market'])
    expect(scopedB.plugins).toEqual([])
    expect(getCwdState()).toBe(tmpHome)
  })

  it('lists mention candidates using runtime skill identities without market placeholders', async () => {
    await writeSkill(path.join(tmpHome, '.claude', 'skills'), 'mention-fixture', '---\nname: mention-fixture\ndescription: Temporary mention capability\n---\nUse temporary files only.\n')
    const { req, url, segments } = makeRequest(`/api/skills/mentions?cwd=${encodeURIComponent(tmpHome)}`)
    const response = await handleSkillsApi(req, url, segments)
    expect(response.status).toBe(200)
    const body = await response.json()
    const candidate = body.skills.find((item: { name: string }) => item.name === 'mention-fixture')
    expect(candidate.kind).toBe('skill')
    expect(candidate.modelText).toBe('Use the Skill tool with skill: "mention-fixture" for this request.')
    expect(body.plugins.some((item: { source: string }) => item.source.endsWith('@haha-connectors'))).toBe(false)
  })

  it('lists user and project skills for the requested cwd', async () => {
    const userSkillsRoot = path.join(tmpHome, '.claude', 'skills')
    const projectRoot = path.join(tmpHome, 'workspace')
    const cwd = path.join(projectRoot, 'packages', 'app')

    await writeSkill(
      userSkillsRoot,
      'user-skill',
      ['---', 'description: User scope', '---', '', '# User skill'].join('\n'),
    )
    await writeSkill(
      path.join(projectRoot, '.claude', 'skills'),
      'project-skill',
      ['---', 'description: Project scope', '---', '', '# Project skill'].join('\n'),
    )

    const { req, url, segments } = makeRequest(`/api/skills?cwd=${encodeURIComponent(cwd)}`)
    const res = await handleSkillsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json() as { skills: Array<{ name: string; source: string }> }
    expect(body.skills).toContainEqual(expect.objectContaining({ name: 'user-skill', source: 'user' }))
    expect(body.skills).toContainEqual(expect.objectContaining({ name: 'project-skill', source: 'project' }))
  })

  it('lists user skills installed through a directory symlink or junction', async () => {
    const linkedSkillsRoot = path.join(tmpHome, '.agents', 'skills')
    const userSkillsRoot = path.join(tmpHome, '.claude', 'skills')
    const projectRoot = path.join(tmpHome, 'workspace')
    const cwd = path.join(projectRoot, 'packages', 'app')

    await writeSkill(
      linkedSkillsRoot,
      'linked-skill',
      ['---', 'description: Linked skill', '---', '', '# Linked skill'].join('\n'),
    )
    await fs.mkdir(userSkillsRoot, { recursive: true })
    await fs.symlink(
      path.join(linkedSkillsRoot, 'linked-skill'),
      path.join(userSkillsRoot, 'linked-skill'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    const { req, url, segments } = makeRequest(`/api/skills?cwd=${encodeURIComponent(cwd)}`)
    const res = await handleSkillsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json() as { skills: Array<{ name: string; source: string }> }
    expect(body.skills).toContainEqual(expect.objectContaining({ name: 'linked-skill', source: 'user' }))
  })

  it('resolves project skill details from the nearest project skills directory', async () => {
    const projectRoot = path.join(tmpHome, 'workspace')
    const nestedRoot = path.join(projectRoot, 'packages', 'app')
    const nestedSkillsRoot = path.join(nestedRoot, '.claude', 'skills')
    const parentSkillsRoot = path.join(projectRoot, '.claude', 'skills')

    await writeSkill(
      parentSkillsRoot,
      'shared-skill',
      ['---', 'description: Parent version', '---', '', 'parent body'].join('\n'),
    )
    await writeSkill(
      nestedSkillsRoot,
      'shared-skill',
      ['---', 'description: Child version', '---', '', 'child body'].join('\n'),
    )

    const { req, url, segments } = makeRequest(
      `/api/skills/detail?source=project&name=shared-skill&cwd=${encodeURIComponent(nestedRoot)}`,
    )
    const res = await handleSkillsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json() as {
      detail: { meta: { description: string }; skillRoot: string; files: Array<{ path: string; body?: string }> }
    }

    expect(body.detail.meta.description).toBe('Child version')
    expect(body.detail.skillRoot).toBe(path.join(nestedSkillsRoot, 'shared-skill'))
    expect(body.detail.files).toContainEqual(
      expect.objectContaining({ path: 'SKILL.md', body: 'child body' }),
    )
  })

  it('does not expose a mismatched market marker on a user skill', async () => {
    const userSkillsRoot = path.join(tmpHome, '.claude', 'skills')
    const skillDir = path.join(userSkillsRoot, 'skill-a')
    await writeSkill(
      userSkillsRoot,
      'skill-a',
      ['---', 'description: User skill', '---', '', '# Skill A'].join('\n'),
    )
    await fs.writeFile(
      path.join(skillDir, '.market-meta.json'),
      JSON.stringify({
        id: 'clawhub:skill-b',
        source: 'clawhub',
        slug: 'skill-b',
        installedAt: new Date(0).toISOString(),
        fileCount: 1,
      }),
    )

    const { req, url, segments } = makeRequest('/api/skills/detail?source=user&name=skill-a')
    const res = await handleSkillsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json() as { detail: { marketMeta?: unknown } }
    expect(body.detail.marketMeta).toBeUndefined()
  })

  it('never exposes a market marker on a project skill', async () => {
    const projectRoot = path.join(tmpHome, 'workspace')
    const projectSkillsRoot = path.join(projectRoot, '.claude', 'skills')
    const skillDir = path.join(projectSkillsRoot, 'project-skill')
    await writeSkill(
      projectSkillsRoot,
      'project-skill',
      ['---', 'description: Project skill', '---', '', '# Project skill'].join('\n'),
    )
    await fs.writeFile(
      path.join(skillDir, '.market-meta.json'),
      JSON.stringify({
        id: 'clawhub:project-skill',
        source: 'clawhub',
        slug: 'project-skill',
        installedAt: new Date(0).toISOString(),
        fileCount: 1,
      }),
    )

    const { req, url, segments } = makeRequest(
      `/api/skills/detail?source=project&name=project-skill&cwd=${encodeURIComponent(projectRoot)}`,
    )
    const res = await handleSkillsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json() as { detail: { marketMeta?: unknown } }
    expect(body.detail.marketMeta).toBeUndefined()
  })

  it('lists plugin skills after reload rereads an external enable toggle', async () => {
    const marketplaceRoot = path.join(tmpHome, 'marketplace-root')
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'draw')
    const pluginsDir = path.join(tmpHome, '.claude', 'plugins')
    const marketplaceFile = path.join(
      marketplaceRoot,
      '.claude-plugin',
      'marketplace.json',
    )

    await fs.mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(path.join(pluginRoot, 'skills', 'render'), { recursive: true })
    await fs.mkdir(path.dirname(marketplaceFile), { recursive: true })
    await fs.mkdir(pluginsDir, { recursive: true })

    await fs.writeFile(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'draw',
        version: '1.0.0',
        description: 'Drawing plugin',
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginRoot, 'skills', 'render', 'SKILL.md'),
      [
        '---',
        'description: Render with the drawing plugin.',
        '---',
        '',
        '# Render',
      ].join('\n'),
      'utf-8',
    )
    await fs.writeFile(
      marketplaceFile,
      JSON.stringify({
        name: 'test-market',
        owner: { name: 'Test' },
        plugins: [
          {
            name: 'draw',
            source: './plugins/draw',
            version: '1.0.0',
          },
        ],
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({
        'test-market': {
          source: { source: 'directory', path: marketplaceRoot },
          installLocation: marketplaceRoot,
          lastUpdated: new Date(0).toISOString(),
        },
      }),
      'utf-8',
    )

    const settingsPath = path.join(tmpHome, '.claude', 'settings.json')
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        enabledPlugins: {
          'draw@test-market': false,
        },
      }),
      'utf-8',
    )

    const initial = makeRequest('/api/skills')
    const initialRes = await handleSkillsApi(initial.req, initial.url, initial.segments)
    const initialBody = await initialRes.json() as {
      skills: Array<{ name: string; source: string }>
    }
    expect(initialBody.skills).not.toContainEqual(
      expect.objectContaining({ name: 'draw:render', source: 'plugin' }),
    )

    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        enabledPlugins: {
          'draw@test-market': true,
        },
      }),
      'utf-8',
    )

    const reload = makePluginReloadRequest()
    const reloadRes = await handlePluginsApi(reload.req, reload.url, reload.segments)
    expect(reloadRes.status).toBe(200)

    const after = makeRequest('/api/skills')
    const afterRes = await handleSkillsApi(after.req, after.url, after.segments)
    const afterBody = await afterRes.json() as {
      skills: Array<{ name: string; source: string; description: string }>
    }

    expect(afterBody.skills).toContainEqual(
      expect.objectContaining({
        name: 'draw:render',
        source: 'plugin',
        description: 'Render with the drawing plugin.',
      }),
    )
  })

  it('lists plugin skills after an external CLI install updates portable config on disk', async () => {
    const marketplaceRoot = path.join(tmpHome, 'marketplace-root')
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'draw')
    const pluginsDir = path.join(tmpHome, '.claude', 'plugins')
    const marketplaceFile = path.join(
      marketplaceRoot,
      '.claude-plugin',
      'marketplace.json',
    )

    await fs.mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(path.dirname(marketplaceFile), { recursive: true })
    await fs.mkdir(pluginsDir, { recursive: true })
    await writeSkill(
      path.join(pluginRoot, 'skills'),
      'render',
      ['---', 'description: Render with the drawing plugin.', '---', '', '# Render'].join('\n'),
    )
    await fs.writeFile(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'draw',
        version: '1.0.0',
        description: 'Drawing plugin',
      }),
      'utf-8',
    )
    await fs.writeFile(
      marketplaceFile,
      JSON.stringify({
        name: 'test-market',
        owner: { name: 'Test' },
        plugins: [
          {
            name: 'draw',
            source: './plugins/draw',
            version: '1.0.0',
          },
        ],
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({
        'test-market': {
          source: { source: 'directory', path: marketplaceRoot },
          installLocation: marketplaceRoot,
          lastUpdated: new Date(0).toISOString(),
        },
      }),
      'utf-8',
    )

    const settingsPath = path.join(tmpHome, '.claude', 'settings.json')
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        enabledPlugins: {
          'draw@test-market': false,
        },
      }),
      'utf-8',
    )

    const initial = makeRequest('/api/skills')
    const initialRes = await handleSkillsApi(initial.req, initial.url, initial.segments)
    const initialBody = await initialRes.json() as {
      skills: Array<{ name: string; source: string }>
    }
    expect(initialBody.skills).not.toContainEqual(
      expect.objectContaining({ name: 'draw:render', source: 'plugin' }),
    )

    // Simulates the embedded terminal running the CLI against the same
    // CLAUDE_CONFIG_DIR while the desktop server process stays alive.
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        enabledPlugins: {
          'draw@test-market': true,
        },
      }),
      'utf-8',
    )

    const after = makeRequest('/api/skills')
    const afterRes = await handleSkillsApi(after.req, after.url, after.segments)
    const afterBody = await afterRes.json() as {
      skills: Array<{ name: string; source: string; description: string }>
    }

    expect(afterBody.skills).toContainEqual(
      expect.objectContaining({
        name: 'draw:render',
        source: 'plugin',
        description: 'Render with the drawing plugin.',
      }),
    )
  })

  describe('.agents/skills convention', () => {
    it('lists user and project skills from .agents, tagged with rootFlavor', async () => {
      const projectRoot = path.join(tmpHome, 'workspace')
      await fs.mkdir(path.join(projectRoot, '.git'), { recursive: true })

      await writeSkill(
        path.join(tmpHome, '.agents', 'skills'),
        'agents-user-skill',
        ['---', 'description: Installed by Codex', '---', '', '# Shared'].join('\n'),
      )
      await writeSkill(
        path.join(projectRoot, '.agents', 'skills'),
        'agents-project-skill',
        ['---', 'description: Checked into the repo', '---', '', '# Repo'].join('\n'),
      )

      const { req, url, segments } = makeRequest(
        `/api/skills?cwd=${encodeURIComponent(projectRoot)}`,
      )
      const res = await handleSkillsApi(req, url, segments)

      expect(res.status).toBe(200)
      const body = await res.json() as {
        skills: Array<{ name: string; source: string; rootFlavor?: string }>
      }
      expect(body.skills).toContainEqual(
        expect.objectContaining({
          name: 'agents-user-skill',
          source: 'user',
          rootFlavor: 'agents',
        }),
      )
      expect(body.skills).toContainEqual(
        expect.objectContaining({
          name: 'agents-project-skill',
          source: 'project',
          rootFlavor: 'agents',
        }),
      )
    })

    it('tags .claude skills as the claude flavor', async () => {
      await writeSkill(
        path.join(tmpHome, '.claude', 'skills'),
        'native-skill',
        ['---', 'description: Native', '---', '', '# Native'].join('\n'),
      )

      const { req, url, segments } = makeRequest('/api/skills')
      const res = await handleSkillsApi(req, url, segments)
      const body = await res.json() as {
        skills: Array<{ name: string; rootFlavor?: string }>
      }

      expect(body.skills).toContainEqual(
        expect.objectContaining({ name: 'native-skill', rootFlavor: 'claude' }),
      )
    })

    it('reports a name present in both user conventions once, as .claude', async () => {
      // A cwd whose own tree holds no skills, so only the user roots contribute
      // and the two spellings of the user scope are the only candidates.
      const emptyWorkspace = path.join(tmpHome, 'workspace-without-skills')
      await fs.mkdir(path.join(emptyWorkspace, '.git'), { recursive: true })

      await writeSkill(
        path.join(tmpHome, '.claude', 'skills'),
        'dup',
        ['---', 'description: The claude one', '---', '', '# Dup'].join('\n'),
      )
      await writeSkill(
        path.join(tmpHome, '.agents', 'skills'),
        'dup',
        ['---', 'description: The agents one', '---', '', '# Dup'].join('\n'),
      )

      const { req, url, segments } = makeRequest(
        `/api/skills?cwd=${encodeURIComponent(emptyWorkspace)}`,
      )
      const res = await handleSkillsApi(req, url, segments)
      const body = await res.json() as {
        skills: Array<{ name: string; description: string; rootFlavor?: string }>
      }

      const matches = body.skills.filter((s) => s.name === 'dup')
      expect(matches).toHaveLength(1)
      expect(matches[0]).toEqual(
        expect.objectContaining({
          description: 'The claude one',
          rootFlavor: 'claude',
        }),
      )
    })

    it('serves detail for a skill that only exists under .agents', async () => {
      await writeSkill(
        path.join(tmpHome, '.agents', 'skills'),
        'agents-only',
        ['---', 'description: Only in agents', '---', '', '# Body'].join('\n'),
      )

      const { req, url, segments } = makeRequest(
        '/api/skills/detail?source=user&name=agents-only',
      )
      const res = await handleSkillsApi(req, url, segments)

      expect(res.status).toBe(200)
      const body = await res.json() as {
        detail: { meta: { name: string; rootFlavor?: string }; skillRoot: string }
      }
      expect(body.detail.meta.name).toBe('agents-only')
      expect(body.detail.skillRoot).toBe(
        path.join(tmpHome, '.agents', 'skills', 'agents-only'),
      )
      // Detail must report the same flavor the listing does, or the badge
      // flickers when the user opens a skill.
      expect(body.detail.meta.rootFlavor).toBe('agents')
    })

    it('reports the claude flavor in detail for a .claude skill', async () => {
      await writeSkill(
        path.join(tmpHome, '.claude', 'skills'),
        'native-only',
        ['---', 'description: Native', '---', '', '# Body'].join('\n'),
      )

      const { req, url, segments } = makeRequest(
        '/api/skills/detail?source=user&name=native-only',
      )
      const res = await handleSkillsApi(req, url, segments)
      const body = await res.json() as {
        detail: { meta: { rootFlavor?: string } }
      }

      expect(body.detail.meta.rootFlavor).toBe('claude')
    })

    it('ignores .agents when the feature is switched off', async () => {
      process.env.CLAUDE_CODE_DISABLE_AGENT_SKILLS_DIR = '1'
      try {
        await writeSkill(
          path.join(tmpHome, '.agents', 'skills'),
          'agents-only',
          ['---', 'description: Only in agents', '---', '', '# Body'].join('\n'),
        )

        const { req, url, segments } = makeRequest('/api/skills')
        const res = await handleSkillsApi(req, url, segments)
        const body = await res.json() as { skills: Array<{ name: string }> }

        expect(body.skills.map((s) => s.name)).not.toContain('agents-only')
      } finally {
        delete process.env.CLAUDE_CODE_DISABLE_AGENT_SKILLS_DIR
      }
    })
  })

  /**
   * The slash command list feeds the desktop composer menu, so it has to agree
   * with the CLI on which file a name resolves to — otherwise the menu
   * describes one skill and running it executes another.
   *
   * See the matching cases in
   * src/skills/__tests__/agentSkillsDiscovery.test.ts.
   */
  describe('slash command name collisions', () => {
    async function repoWith(
      skills: Array<{ root: string; marker: string }>,
    ): Promise<string> {
      const repo = path.join(tmpHome, 'workspace')
      await fs.mkdir(path.join(repo, '.git'), { recursive: true })
      for (const { root, marker } of skills) {
        await writeSkill(
          root.replace('<repo>', repo),
          'deploy',
          ['---', `description: ${marker}`, '---', '', '# Deploy'].join('\n'),
        )
      }
      return repo
    }

    it('prefers a project .claude skill over a user .agents skill', async () => {
      const repo = await repoWith([
        { root: path.join(tmpHome, '.agents', 'skills'), marker: 'User agents' },
        { root: path.join('<repo>', '.claude', 'skills'), marker: 'Project claude' },
      ])

      const commands = await listSkillSlashCommands(repo)
      const matches = commands.filter((c) => c.name === 'deploy')

      expect(matches).toHaveLength(1)
      expect(matches[0]!.description).toBe('Project claude')
    })

    it('prefers a user .claude skill over a project .agents skill', async () => {
      const repo = await repoWith([
        { root: path.join(tmpHome, '.claude', 'skills'), marker: 'User claude' },
        { root: path.join('<repo>', '.agents', 'skills'), marker: 'Project agents' },
      ])

      const commands = await listSkillSlashCommands(repo)
      const matches = commands.filter((c) => c.name === 'deploy')

      expect(matches).toHaveLength(1)
      expect(matches[0]!.description).toBe('User claude')
    })

    it('keeps the user copy when both scopes use .claude', async () => {
      const repo = await repoWith([
        { root: path.join(tmpHome, '.claude', 'skills'), marker: 'User claude' },
        { root: path.join('<repo>', '.claude', 'skills'), marker: 'Project claude' },
      ])

      const commands = await listSkillSlashCommands(repo)
      const matches = commands.filter((c) => c.name === 'deploy')

      expect(matches).toHaveLength(1)
      expect(matches[0]!.description).toBe('User claude')
    })

    it('lists no duplicate names at all', async () => {
      const repo = await repoWith([
        { root: path.join(tmpHome, '.claude', 'skills'), marker: 'User claude' },
        { root: path.join(tmpHome, '.agents', 'skills'), marker: 'User agents' },
        { root: path.join('<repo>', '.claude', 'skills'), marker: 'Repo claude' },
        { root: path.join('<repo>', '.agents', 'skills'), marker: 'Repo agents' },
      ])

      const names = (await listSkillSlashCommands(repo)).map((c) => c.name)

      expect(names.filter((n) => n === 'deploy')).toHaveLength(1)
      expect(new Set(names).size).toBe(names.length)
    })
  })

  /**
   * This list stands in for the CLI whenever a session's subprocess has not
   * started yet — which is every freshly opened session, i.e. exactly when a
   * user first opens the slash menu. It used to scan directories only, so a
   * brand-new session offered no built-in command and no bundled skill; a user
   * who enabled Computer Use could not select /computer-use until after they
   * had already sent a message. Measured against a live server, the list went
   * from 93 entries to 110 the moment the first message was sent.
   */
  describe('commands that exist only inside the binary', () => {
    const repoRoot = path.resolve(import.meta.dir, '..', '..', '..')

    async function emptyRepo(): Promise<string> {
      const repo = path.join(tmpHome, 'bare-workspace')
      await fs.mkdir(path.join(repo, '.git'), { recursive: true })
      return repo
    }

    it('lists bundled skills even with no skill directory on disk', async () => {
      const names = (await listSkillSlashCommands(await emptyRepo())).map(
        (c) => c.name,
      )

      // Two unconditional bundled skills — neither is behind a feature flag or
      // a user setting, so their absence means the whole category is missing.
      expect(names).toContain('simplify')
      expect(names).toContain('batch')
    })

    it('lists built-in commands the headless CLI can run', async () => {
      // Assembling the built-in table reads auth state; a signed-in server is
      // the case this covers. The not-signed-in case is the test below.
      const originalKey = process.env.ANTHROPIC_API_KEY
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key'
      try {
        const names = (await listSkillSlashCommands(await emptyRepo())).map(
          (c) => c.name,
        )

        expect(names).toContain('compact')
        expect(names).toContain('context')
      } finally {
        if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY
        else process.env.ANTHROPIC_API_KEY = originalKey
      }
    })

    it('still lists bundled skills when nobody has signed in', async () => {
      // Built-ins and bundled skills are assembled together, and the built-in
      // half throws without credentials. Letting that failure take the bundled
      // skills with it would empty the slash menu for every new user — the
      // people least able to tell a missing feature from a broken one.
      //
      // Runs in its own process on purpose: the built-in table is memoized at
      // module scope, so any earlier test that built it successfully would
      // leave this one asserting against a warm cache and passing no matter
      // what the code does.
      const scriptPath = path.join(tmpHome, 'no-auth-probe.ts')
      await fs.writeFile(
        scriptPath,
        [
          `import { getCompiledInCommands } from '${path.join(repoRoot, 'src', 'commands.js')}'`,
          `import { enableConfigs } from '${path.join(repoRoot, 'src', 'utils', 'config.js')}'`,
          'enableConfigs()',
          'console.log(JSON.stringify(getCompiledInCommands().map(c => c.name)))',
        ].join('\n'),
      )

      const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome }
      delete env.ANTHROPIC_API_KEY
      delete env.CLAUDE_CODE_OAUTH_TOKEN
      const proc = Bun.spawn(['bun', 'run', scriptPath], {
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const stdout = await new Response(proc.stdout).text()
      await proc.exited

      const lastLine = stdout.trim().split('\n').at(-1) ?? '[]'
      expect(JSON.parse(lastLine)).toContain('simplify')
    })

    it('carries descriptions, not bare names', async () => {
      const commands = await listSkillSlashCommands(await emptyRepo())
      const simplify = commands.find((c) => c.name === 'simplify')

      // A name with an empty description renders as a blank menu row: the user
      // cannot tell what the command does before running it.
      expect(simplify?.description ?? '').not.toBe('')
    })

    it('offers /computer-use before the first message only while enabled in settings', async () => {
      if (process.platform !== 'darwin' && process.platform !== 'win32') return
      const repo = await emptyRepo()
      let now = Date.now()
      const clock = spyOn(Date, 'now').mockImplementation(() => now)
      const names = async () => (await listSkillSlashCommands(repo)).map(c => c.name)
      const setEnabled = async (enabled: boolean) => {
        const url = new URL('http://localhost:3456/api/computer-use/authorized-apps')
        const response = await handleComputerUseApi(new Request(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        }), url, url.pathname.split('/').filter(Boolean))
        expect(response.status).toBe(200)
        // The server and CLI read the same file in different processes; let
        // the real gate expire its cache instead of forcing its value.
        now += 3_001
      }

      try {
        expect(await names()).not.toContain('computer-use')
        await setEnabled(true)
        expect(await names()).toContain('computer-use')
        await setEnabled(false)
        expect(await names()).not.toContain('computer-use')
      } finally {
        clock.mockRestore()
      }
    })

    it('can be asked to leave them out once the CLI has reported', async () => {
      // This process judges a command's availability against its own state,
      // which is near the CLI's but not the same — a live server offered
      // /extra-usage where the CLI did not. Since the two lists get merged, a
      // wrong guess would otherwise sit in the menu for the rest of the
      // session even after the real list arrived.
      const names = (
        await listSkillSlashCommands(await emptyRepo(), {
          includeCompiledIn: false,
        })
      ).map((c) => c.name)

      expect(names).not.toContain('simplify')
      expect(names).not.toContain('compact')
    })

    it('omits commands the user cannot invoke', async () => {
      const names = (await listSkillSlashCommands(await emptyRepo())).map(
        (c) => c.name,
      )

      // Registered with userInvocable: false — it backs a keyboard shortcut,
      // and listing it would put a row in the menu that does nothing useful.
      expect(names).not.toContain('keybindings-help')
    })

    it('lets a same-named skill on disk win', async () => {
      // Whatever the CLI would actually run has to be what the menu describes,
      // and a disk skill outranks the compiled-in copy in the CLI loader.
      const repo = await emptyRepo()
      await writeSkill(
        path.join(tmpHome, '.claude', 'skills'),
        'simplify',
        ['---', 'description: Mine, not the bundled one', '---', '', '# Hi'].join(
          '\n',
        ),
      )

      const matches = (await listSkillSlashCommands(repo)).filter(
        (c) => c.name === 'simplify',
      )

      expect(matches).toHaveLength(1)
      expect(matches[0]!.description).toBe('Mine, not the bundled one')
    })
  })
})
