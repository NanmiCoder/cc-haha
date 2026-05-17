import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { getCwdState, setCwdState } from '../../bootstrap/state.js'
import { clearInstalledPluginsCache } from '../../utils/plugins/installedPluginsManager.js'
import { clearPluginCache } from '../../utils/plugins/pluginLoader.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { handlePluginsApi } from '../api/plugins.js'
import { handleSkillsApi } from '../api/skills.js'

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
    clearInstalledPluginsCache()
    clearPluginCache('skills-api-test-setup')
    resetSettingsCache()
  })

  afterEach(async () => {
    clearInstalledPluginsCache()
    clearPluginCache('skills-api-test-teardown')
    resetSettingsCache()
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
})
