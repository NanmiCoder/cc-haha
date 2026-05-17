import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleMemoryApi } from '../api/memory.js'
import { sanitizePath } from '../../utils/path.js'

let tmpDir: string
let originalConfigDir: string | undefined
let originalHome: string | undefined
let originalUserProfile: string | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-memory-api-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalHome = process.env.HOME
  originalUserProfile = process.env.USERPROFILE
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  process.env.HOME = tmpDir
  process.env.USERPROFILE = tmpDir
})

afterEach(async () => {
  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  if (originalHome !== undefined) {
    process.env.HOME = originalHome
  } else {
    delete process.env.HOME
  }
  if (originalUserProfile !== undefined) {
    process.env.USERPROFILE = originalUserProfile
  } else {
    delete process.env.USERPROFILE
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('memory API', () => {
  it('lists current project memory files with frontmatter metadata', async () => {
    const cwd = path.join(tmpDir, 'workspace', 'app')
    const projectId = sanitizePath(cwd)
    const memoryDir = path.join(tmpDir, 'projects', projectId, 'memory')
    await fs.mkdir(path.join(memoryDir, 'notes'), { recursive: true })
    await fs.writeFile(
      path.join(memoryDir, 'MEMORY.md'),
      [
        '---',
        'type: project',
        'description: Stable project conventions.',
        '---',
        '',
        '# Project Memory',
      ].join('\n'),
    )
    await fs.writeFile(path.join(memoryDir, 'notes', 'manual.md'), '# Manual')

    const projectsRes = await request('GET', `/api/memory/projects?cwd=${encodeURIComponent(cwd)}`)
    expect(projectsRes.status).toBe(200)
    const projectsBody = await projectsRes.json() as {
      projects: Array<{ id: string; isCurrent: boolean; fileCount: number }>
    }
    expect(projectsBody.projects[0]).toMatchObject({
      id: projectId,
      isCurrent: true,
      fileCount: 2,
    })

    const filesRes = await request('GET', `/api/memory/files?projectId=${encodeURIComponent(projectId)}`)
    expect(filesRes.status).toBe(200)
    const filesBody = await filesRes.json() as {
      files: Array<{ path: string; type?: string; description?: string; isIndex: boolean }>
    }
    expect(filesBody.files[0]).toMatchObject({
      path: 'MEMORY.md',
      type: 'project',
      description: 'Stable project conventions.',
      isIndex: true,
    })
    expect(filesBody.files.some((file) => file.path === 'notes/manual.md')).toBe(true)
  })

  it('uses session metadata for project labels when sanitized paths contain non-ascii characters', async () => {
    const cwd = path.join(tmpDir, '中文 项目', 'GLM', '5V', 'turbo')
    const projectId = sanitizePath(cwd)
    const projectDir = path.join(tmpDir, 'projects', projectId)
    const memoryDir = path.join(projectDir, 'memory')
    await fs.mkdir(memoryDir, { recursive: true })
    await fs.writeFile(path.join(memoryDir, 'MEMORY.md'), '# Project Memory')
    await fs.writeFile(
      path.join(projectDir, 'session.jsonl'),
      JSON.stringify({
        type: 'user',
        cwd,
        message: { role: 'user', content: 'hello' },
      }) + '\n',
    )

    const projectsRes = await request('GET', '/api/memory/projects')
    expect(projectsRes.status).toBe(200)
    const projectsBody = await projectsRes.json() as {
      projects: Array<{ id: string; label: string }>
    }

    const project = projectsBody.projects.find((item) => item.id === projectId)
    expect(project).toMatchObject({ label: cwd })
  })

  it('recovers project labels from existing directories when no session metadata exists', async () => {
    const cwd = path.join(tmpDir, '个人自媒体', '314', 'opus4', 'PicTacticAgent')
    const projectId = sanitizePath(cwd)
    const memoryDir = path.join(tmpDir, 'projects', projectId, 'memory')
    await fs.mkdir(cwd, { recursive: true })
    await fs.mkdir(memoryDir, { recursive: true })
    await fs.writeFile(path.join(memoryDir, 'MEMORY.md'), '# Project Memory')

    const projectsRes = await request('GET', '/api/memory/projects')
    expect(projectsRes.status).toBe(200)
    const projectsBody = await projectsRes.json() as {
      projects: Array<{ id: string; label: string }>
    }

    const project = projectsBody.projects.find((item) => item.id === projectId)
    expect(project).toMatchObject({ label: cwd })
  })

  it('reads and writes only markdown files inside the project memory directory', async () => {
    const projectId = sanitizePath(path.join(tmpDir, 'workspace', 'app'))

    const writeRes = await request('PUT', '/api/memory/file', {
      projectId,
      path: 'notes/project.md',
      content: '# Edited Memory\n',
    })
    expect(writeRes.status).toBe(200)

    const filePath = path.join(tmpDir, 'projects', projectId, 'memory', 'notes', 'project.md')
    expect(await fs.readFile(filePath, 'utf-8')).toBe('# Edited Memory\n')

    const readRes = await request('GET', `/api/memory/file?projectId=${encodeURIComponent(projectId)}&path=notes%2Fproject.md`)
    expect(readRes.status).toBe(200)
    const body = await readRes.json() as { file: { path: string; content: string } }
    expect(body.file).toMatchObject({
      path: 'notes/project.md',
      content: '# Edited Memory\n',
    })
  })

  it('rejects traversal and symlink escapes', async () => {
    const projectId = sanitizePath(path.join(tmpDir, 'workspace', 'app'))
    const memoryDir = path.join(tmpDir, 'projects', projectId, 'memory')
    const outsideDir = path.join(tmpDir, 'outside')
    await fs.mkdir(memoryDir, { recursive: true })
    await fs.mkdir(outsideDir, { recursive: true })
    await fs.symlink(outsideDir, path.join(memoryDir, 'linked'), 'dir')

    const traversalRes = await request('PUT', '/api/memory/file', {
      projectId,
      path: '../outside.md',
      content: 'escape',
    })
    expect(traversalRes.status).toBe(400)

    const symlinkRes = await request('PUT', '/api/memory/file', {
      projectId,
      path: 'linked/outside.md',
      content: 'escape',
    })
    expect(symlinkRes.status).toBe(400)
    await expect(fs.readFile(path.join(outsideDir, 'outside.md'), 'utf-8')).rejects.toThrow()
  })
})

function request(method: string, pathname: string, body?: Record<string, unknown>): Promise<Response> {
  const url = new URL(pathname, 'http://localhost:3456')
  const init: RequestInit = { method }
  if (body) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return handleMemoryApi(
    new Request(url.toString(), init),
    url,
    url.pathname.split('/').filter(Boolean),
  )
}
