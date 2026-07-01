import { describe, it, expect, mock, beforeEach } from 'bun:test'

// Mock config module
const mockGlobalConfig = { activeSkills: undefined as string[] | undefined }
const mockProjectConfig = { activeSkills: undefined as string[] | undefined }
let lastSaveCurrentProjectCwd: string | undefined

mock.module('../../utils/config.js', () => ({
  getGlobalConfig: () => mockGlobalConfig,
  getCurrentProjectConfig: () => mockProjectConfig,
  saveGlobalConfig: (updater: (c: typeof mockGlobalConfig) => typeof mockGlobalConfig) => {
    Object.assign(mockGlobalConfig, updater(mockGlobalConfig))
  },
  saveCurrentProjectConfig: (updater: (c: typeof mockProjectConfig) => typeof mockProjectConfig, cwd?: string) => {
    lastSaveCurrentProjectCwd = cwd
    Object.assign(mockProjectConfig, updater(mockProjectConfig))
  },
}))

mock.module('../../skills/activeSkills.js', () => ({
  getActiveSkillNames: () => {
    const global = mockGlobalConfig.activeSkills ?? []
    const project = mockProjectConfig.activeSkills ?? []
    const seen = new Set<string>()
    const result: string[] = []
    for (const name of project) {
      if (!seen.has(name)) { seen.add(name); result.push(name) }
    }
    for (const name of global) {
      if (!seen.has(name)) { seen.add(name); result.push(name) }
    }
    return result
  },
}))

mock.module('../../utils/envUtils.js', () => ({
  getClaudeConfigHomeDir: () => '/mock/.claude',
}))

mock.module('../../utils/cwd.js', () => ({
  getCwd: () => '/mock/project',
}))

import { handleSkillsApi } from '../api/skills'

describe('skills API active skills endpoints', () => {
  beforeEach(() => {
    mockGlobalConfig.activeSkills = undefined
    mockProjectConfig.activeSkills = undefined
    lastSaveCurrentProjectCwd = undefined
  })

  it('GET /api/skills/active returns merged active skills', async () => {
    mockGlobalConfig.activeSkills = ['skill-a']
    mockProjectConfig.activeSkills = ['skill-b']

    const url = new URL('http://localhost/api/skills/active?scope=merged')
    const req = new Request(url, { method: 'GET' })
    const res = await handleSkillsApi(req, url, ['api', 'skills', 'active'])
    const data = await res.json() as { activeSkills: string[] }

    expect(data.activeSkills).toContain('skill-a')
    expect(data.activeSkills).toContain('skill-b')
  })

  it('GET /api/skills/active?scope=global returns only global skills', async () => {
    mockGlobalConfig.activeSkills = ['global-skill']
    mockProjectConfig.activeSkills = ['project-skill']

    const url = new URL('http://localhost/api/skills/active?scope=global')
    const req = new Request(url, { method: 'GET' })
    const res = await handleSkillsApi(req, url, ['api', 'skills', 'active'])
    const data = await res.json() as { activeSkills: string[] }

    expect(data.activeSkills).toEqual(['global-skill'])
  })

  it('GET /api/skills/active?scope=project returns only project skills', async () => {
    mockGlobalConfig.activeSkills = ['global-skill']
    mockProjectConfig.activeSkills = ['project-skill']

    const url = new URL('http://localhost/api/skills/active?scope=project')
    const req = new Request(url, { method: 'GET' })
    const res = await handleSkillsApi(req, url, ['api', 'skills', 'active'])
    const data = await res.json() as { activeSkills: string[] }

    expect(data.activeSkills).toEqual(['project-skill'])
  })

  it('POST /api/skills/active sets global active skills', async () => {
    const url = new URL('http://localhost/api/skills/active')
    const req = new Request(url, {
      method: 'POST',
      body: JSON.stringify({ scope: 'global', skills: ['new-skill'] }),
    })
    const res = await handleSkillsApi(req, url, ['api', 'skills', 'active'])
    const data = await res.json() as { ok: boolean; scope: string; activeSkills: string[] }

    expect(data.ok).toBe(true)
    expect(data.scope).toBe('global')
    expect(data.activeSkills).toEqual(['new-skill'])
  })

  it('POST /api/skills/active with invalid skills returns 400', async () => {
    const url = new URL('http://localhost/api/skills/active')
    const req = new Request(url, {
      method: 'POST',
      body: JSON.stringify({ scope: 'global', skills: 'not-an-array' }),
    })
    const res = await handleSkillsApi(req, url, ['api', 'skills', 'active'])

    expect(res.status).toBe(400)
  })

  it('POST /api/skills/active sets project active skills and forwards cwd to saveCurrentProjectConfig', async () => {
    // The "applies to" project picker in the UI must reach the right project
    // config on disk — verify the cwd from the request body is what
    // saveCurrentProjectConfig receives.
    const targetCwd = '/mock/work/alpha'
    const url = new URL('http://localhost/api/skills/active')
    const req = new Request(url, {
      method: 'POST',
      body: JSON.stringify({ scope: 'project', skills: ['my-skill'], cwd: targetCwd }),
    })
    const res = await handleSkillsApi(req, url, ['api', 'skills', 'active'])
    const data = await res.json() as { ok: boolean; scope: string; activeSkills: string[] }

    expect(data.ok).toBe(true)
    expect(data.scope).toBe('project')
    expect(data.activeSkills).toEqual(['my-skill'])
    expect(lastSaveCurrentProjectCwd).toBe(targetCwd)
    expect(mockProjectConfig.activeSkills).toEqual(['my-skill'])
  })

  it('POST /api/skills/active project scope without cwd falls back to current project (cwd undefined)', async () => {
    const url = new URL('http://localhost/api/skills/active')
    const req = new Request(url, {
      method: 'POST',
      body: JSON.stringify({ scope: 'project', skills: ['x'] }),
    })
    const res = await handleSkillsApi(req, url, ['api', 'skills', 'active'])
    expect(res.status).toBe(200)
    expect(lastSaveCurrentProjectCwd).toBeUndefined()
    expect(mockProjectConfig.activeSkills).toEqual(['x'])
  })

  it('POST then GET round-trip: a checked project skill appears in the project scope read', async () => {
    // Step 1: user "checks" a skill at project scope.
    const postUrl = new URL('http://localhost/api/skills/active')
    const postReq = new Request(postUrl, {
      method: 'POST',
      body: JSON.stringify({ scope: 'project', skills: ['confirmed'], cwd: '/mock/work/beta' }),
    })
    await handleSkillsApi(postReq, postUrl, ['api', 'skills', 'active'])

    // Step 2: GET the project scope and verify the same skill comes back.
    const getUrl = new URL('http://localhost/api/skills/active?scope=project')
    const getReq = new Request(getUrl, { method: 'GET' })
    const getRes = await handleSkillsApi(getReq, getUrl, ['api', 'skills', 'active'])
    const data = await getRes.json() as { activeSkills: string[] }

    expect(data.activeSkills).toEqual(['confirmed'])
  })
})
