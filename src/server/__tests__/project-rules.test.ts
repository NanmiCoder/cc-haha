import { describe, it, expect, mock, beforeEach } from 'bun:test'
import * as path from 'path'

const MOCK_CLAUDE_HOME = path.join('/mock', 'home', '.claude')
const MOCK_PROJECT = path.join('/mock', 'project')
const MOCK_PROJECTS_DIR = path.join(MOCK_CLAUDE_HOME, 'projects')

// Mock dependencies
mock.module('../../utils/envUtils.js', () => ({
  getClaudeConfigHomeDir: () => MOCK_CLAUDE_HOME,
}))

mock.module('../../utils/cwd.js', () => ({
  getCwd: () => MOCK_PROJECT,
}))

mock.module('../../utils/git.js', () => ({
  findCanonicalGitRoot: (cwd: string) => cwd,
}))

const mockFiles = new Set<string>()
const mockDirs = new Map<string, string[]>()

mock.module('fs/promises', () => ({
  access: async (filePath: string) => {
    if (!mockFiles.has(filePath)) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
  },
  stat: async (filePath: string) => {
    if (!mockFiles.has(filePath)) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    return { isDirectory: () => true }
  },
  mkdir: async () => {},
  writeFile: async (filePath: string) => {
    mockFiles.add(filePath)
  },
  readFile: async () => '{}',
  readdir: async (dirPath: string, _opts?: unknown) => {
    // Check all registered mock dirs
    const entries = mockDirs.get(dirPath)
    if (entries) {
      // If dirPath ends with 'projects', return as directories
      if (dirPath.endsWith('projects')) {
        return entries.map(name => ({ name, isDirectory: () => true, isFile: () => false }))
      }
      // Otherwise return as files
      return entries.map(name => ({ name, isFile: () => true, isDirectory: () => false }))
    }
    // Default: throw ENOENT
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  },
}))

import { handleProjectRulesApi } from '../api/project-rules'

describe('project-rules API', () => {
  beforeEach(() => {
    mockFiles.clear()
    mockDirs.clear()
  })

  it('GET /api/project-rules returns current project and user files', async () => {
    const url = new URL(`http://localhost/api/project-rules?cwd=${encodeURIComponent(MOCK_PROJECT)}`)
    const req = new Request(url, { method: 'GET' })
    const res = await handleProjectRulesApi(req, url, ['api', 'project-rules'])
    const data = await res.json() as { projects: unknown[]; userFiles: unknown[]; cwd: string }

    expect(data.cwd).toBe(MOCK_PROJECT)
    expect(data.projects.length).toBeGreaterThanOrEqual(1)
    expect(data.userFiles.length).toBeGreaterThanOrEqual(1)
  })

  it('GET /api/project-rules marks current project', async () => {
    const url = new URL(`http://localhost/api/project-rules?cwd=${encodeURIComponent(MOCK_PROJECT)}`)
    const req = new Request(url, { method: 'GET' })
    const res = await handleProjectRulesApi(req, url, ['api', 'project-rules'])
    const data = await res.json() as { projects: Array<{ isCurrent: boolean }> }

    expect(data.projects[0].isCurrent).toBe(true)
  })

  it('GET /api/project-rules includes current project in response', async () => {
    // Even without other projects in the dir, current project should appear
    const url = new URL(`http://localhost/api/project-rules?cwd=${encodeURIComponent(MOCK_PROJECT)}`)
    const req = new Request(url, { method: 'GET' })
    const res = await handleProjectRulesApi(req, url, ['api', 'project-rules'])
    const data = await res.json() as { projects: Array<{ id: string; isCurrent: boolean }> }

    expect(data.projects.length).toBeGreaterThanOrEqual(1)
    const current = data.projects.find(p => p.isCurrent)
    expect(current).toBeDefined()
  })

  it('GET /api/project-rules detects existing CLAUDE.md in project root', async () => {
    const rootMd = path.join(MOCK_PROJECT, 'CLAUDE.md')
    mockFiles.add(rootMd)

    const url = new URL(`http://localhost/api/project-rules?cwd=${encodeURIComponent(MOCK_PROJECT)}`)
    const req = new Request(url, { method: 'GET' })
    const res = await handleProjectRulesApi(req, url, ['api', 'project-rules'])
    const data = await res.json() as { projects: Array<{ files: Array<{ label: string; exists: boolean }> }> }

    const currentProject = data.projects[0]
    const rootFile = currentProject.files.find(f => f.label === 'CLAUDE.md')
    expect(rootFile?.exists).toBe(true)
  })

  it('POST /api/project-rules/create creates project-root CLAUDE.md', async () => {
    const url = new URL('http://localhost/api/project-rules/create')
    const res = await handleProjectRulesApi(
      new Request(url, {
        method: 'POST',
        body: JSON.stringify({ scope: 'project-root', cwd: MOCK_PROJECT }),
      }),
      url,
      ['api', 'project-rules', 'create'],
    )
    const data = await res.json() as { ok: boolean; created: boolean; path: string }

    expect(data.ok).toBe(true)
    expect(data.created).toBe(true)
    expect(data.path).toBe(path.join(MOCK_PROJECT, 'CLAUDE.md'))
  })

  it('POST /api/project-rules/create with invalid scope returns 400', async () => {
    const url = new URL('http://localhost/api/project-rules/create')
    const res = await handleProjectRulesApi(
      new Request(url, {
        method: 'POST',
        body: JSON.stringify({ scope: 'invalid' }),
      }),
      url,
      ['api', 'project-rules', 'create'],
    )
    expect(res.status).toBe(400)
  })

  it('POST /api/project-rules/create rejects path traversal in filename', async () => {
    const url = new URL('http://localhost/api/project-rules/create')
    const res = await handleProjectRulesApi(
      new Request(url, {
        method: 'POST',
        body: JSON.stringify({ scope: 'project-root', cwd: MOCK_PROJECT, filename: '../../../escaped.md' }),
      }),
      url,
      ['api', 'project-rules', 'create'],
    )
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toBe('Invalid filename')
  })

  it('POST /api/project-rules/create rejects absolute filename', async () => {
    const url = new URL('http://localhost/api/project-rules/create')
    const res = await handleProjectRulesApi(
      new Request(url, {
        method: 'POST',
        body: JSON.stringify({ scope: 'project-rules', cwd: MOCK_PROJECT, filename: path.join(MOCK_CLAUDE_HOME, 'evil.md') }),
      }),
      url,
      ['api', 'project-rules', 'create'],
    )
    expect(res.status).toBe(400)
  })

  it('POST /api/project-rules/create does not overwrite existing file', async () => {
    const userPath = path.join(MOCK_CLAUDE_HOME, 'CLAUDE.md')
    mockFiles.add(userPath)

    const url = new URL('http://localhost/api/project-rules/create')
    const res = await handleProjectRulesApi(
      new Request(url, {
        method: 'POST',
        body: JSON.stringify({ scope: 'user' }),
      }),
      url,
      ['api', 'project-rules', 'create'],
    )
    const data = await res.json() as { ok: boolean; created: boolean }

    expect(data.ok).toBe(true)
    expect(data.created).toBe(false)
  })

  it('GET /api/project-rules lists projects without any rules files (regression: previously filtered)', async () => {
    // Current project has no rules at all (no CLAUDE.md anywhere).
    // It must still appear so the user can create rules from there.
    const url = new URL(`http://localhost/api/project-rules?cwd=${encodeURIComponent(MOCK_PROJECT)}`)
    const req = new Request(url, { method: 'GET' })
    const res = await handleProjectRulesApi(req, url, ['api', 'project-rules'])
    const data = await res.json() as { projects: Array<{ isCurrent: boolean; files: Array<{ exists: boolean }> }> }

    expect(data.projects).toHaveLength(1)
    const project = data.projects[0]!
    expect(project.isCurrent).toBe(true)
    // Confirm the test setup: no rules file actually exists.
    expect(project.files.some(f => f.exists)).toBe(false)
  })
})
