import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AdapterHttpClient } from '../http-client.js'

describe('AdapterHttpClient', () => {
  let client: AdapterHttpClient
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    client = new AdapterHttpClient('ws://127.0.0.1:3456')
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('derives HTTP URL from WS URL', () => {
    expect(client.httpBaseUrl).toBe('http://127.0.0.1:3456')

    const secure = new AdapterHttpClient('wss://example.com:443')
    expect(secure.httpBaseUrl).toBe('https://example.com:443')
  })

  it('createSession calls POST /api/sessions', async () => {
    const mockSessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ sessionId: mockSessionId }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }))
    ) as any

    const sessionId = await client.createSession('/path/to/project')
    expect(sessionId).toBe(mockSessionId)

    const call = (globalThis.fetch as any).mock.calls[0]
    expect(call[0]).toBe('http://127.0.0.1:3456/api/sessions')
    const body = JSON.parse(call[1].body)
    expect(body.workDir).toBe('/path/to/project')
  })

  it('listRecentProjects calls GET /api/sessions/recent-projects', async () => {
    const mockProjects = [
      { projectName: 'my-app', realPath: '/home/user/my-app', sessionCount: 3 },
    ]
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ projects: mockProjects }), {
        headers: { 'Content-Type': 'application/json' },
      }))
    ) as any

    const projects = await client.listRecentProjects()
    expect(projects).toHaveLength(1)
    expect(projects[0].projectName).toBe('my-app')
  })

  it('matchProject accepts an absolute local project path inside an allowed root without recent history', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'im-root-'))
    const projectDir = fs.mkdtempSync(path.join(rootDir, 'project-'))
    try {
      client = new AdapterHttpClient('ws://127.0.0.1:3456', { allowedProjectRoots: [rootDir] })
      globalThis.fetch = mock(() => {
        throw new Error('recent projects should not be queried for absolute paths')
      }) as any

      const result = await client.matchProject(projectDir)

      expect(result.project?.realPath).toBe(fs.realpathSync(projectDir))
      expect(result.project?.projectName).toBe(path.basename(projectDir))
      expect((globalThis.fetch as any).mock.calls).toHaveLength(0)
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true })
    }
  })

  it('matchProject rejects absolute local project paths outside allowed roots', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'im-root-'))
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'im-project-'))
    try {
      client = new AdapterHttpClient('ws://127.0.0.1:3456', { allowedProjectRoots: [rootDir] })
      globalThis.fetch = mock(() => {
        throw new Error('recent projects should not be queried for rejected absolute paths')
      }) as any

      const result = await client.matchProject(projectDir)

      expect(result.project).toBeUndefined()
      expect(result.ambiguous).toBeUndefined()
      expect((globalThis.fetch as any).mock.calls).toHaveLength(0)
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true })
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('createSession throws on server error', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'BAD_REQUEST', message: 'workDir required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }))
    ) as any

    expect(client.createSession('')).rejects.toThrow()
  })

  it('sessionExists returns false for deleted sessions', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'NOT_FOUND' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }))
    ) as any

    await expect(client.sessionExists('deleted-session')).resolves.toBe(false)
    expect((globalThis.fetch as any).mock.calls[0][0]).toBe(
      'http://127.0.0.1:3456/api/sessions/deleted-session',
    )
  })

  it('getGitInfo calls GET /api/sessions/:id/git-info', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({
        branch: 'main',
        repoName: 'claude-code-haha',
        workDir: '/repo/claude-code-haha',
        changedFiles: 2,
      }), {
        headers: { 'Content-Type': 'application/json' },
      }))
    ) as any

    const gitInfo = await client.getGitInfo('session-123')
    expect(gitInfo.repoName).toBe('claude-code-haha')
    expect((globalThis.fetch as any).mock.calls[0][0]).toBe(
      'http://127.0.0.1:3456/api/sessions/session-123/git-info',
    )
  })

  it('getTasksForSession calls GET /api/tasks/lists/:id', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({
        tasks: [
          { id: '1', subject: 'Fix bug', status: 'in_progress' },
          { id: '2', subject: 'Write docs', status: 'pending' },
        ],
      }), {
        headers: { 'Content-Type': 'application/json' },
      }))
    ) as any

    const tasks = await client.getTasksForSession('session-123')
    expect(tasks).toHaveLength(2)
    expect(tasks[0]?.status).toBe('in_progress')
    expect((globalThis.fetch as any).mock.calls[0][0]).toBe(
      'http://127.0.0.1:3456/api/tasks/lists/session-123',
    )
  })

  it('listSessions calls GET /api/sessions with project and pagination query', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({
        sessions: [
          {
            id: 'session-1',
            title: 'Fix Telegram menu',
            createdAt: '2026-06-09T00:00:00.000Z',
            modifiedAt: '2026-06-09T01:00:00.000Z',
            messageCount: 3,
            projectPath: '-repo',
            projectRoot: '/repo',
            workDir: '/repo',
            workDirExists: true,
          },
        ],
        total: 1,
      }), {
        headers: { 'Content-Type': 'application/json' },
      }))
    ) as any

    const result = await client.listSessions({ project: '/repo', limit: 10, offset: 5 })

    expect(result.sessions[0]?.id).toBe('session-1')
    expect((globalThis.fetch as any).mock.calls[0][0]).toBe(
      'http://127.0.0.1:3456/api/sessions?project=%2Frepo&limit=10&offset=5',
    )
  })

  it('lists and activates providers through the server provider API', async () => {
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      if (url.endsWith('/api/providers') && !init?.method) {
        return Promise.resolve(new Response(JSON.stringify({
          providers: [{ id: 'provider-1', name: 'Provider One', models: { main: 'model-main' } }],
          activeId: null,
        }), {
          headers: { 'Content-Type': 'application/json' },
        }))
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      }))
    }) as any

    const providers = await client.listProviders()
    await client.activateProvider('provider-1')
    await client.activateOfficialProvider()

    expect(providers.providers[0]?.name).toBe('Provider One')
    expect((globalThis.fetch as any).mock.calls[1][0]).toBe(
      'http://127.0.0.1:3456/api/providers/provider-1/activate',
    )
    expect((globalThis.fetch as any).mock.calls[1][1].method).toBe('POST')
    expect((globalThis.fetch as any).mock.calls[2][0]).toBe(
      'http://127.0.0.1:3456/api/providers/official',
    )
  })

  it('lists and sets models through the server models API', async () => {
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      if (url.endsWith('/api/models') && !init?.method) {
        return Promise.resolve(new Response(JSON.stringify({
          provider: null,
          models: [{ id: 'claude-opus-4-7', name: 'Opus 4.7', description: 'Most capable', context: '1m' }],
        }), {
          headers: { 'Content-Type': 'application/json' },
        }))
      }
      if (url.endsWith('/api/models/current') && !init?.method) {
        return Promise.resolve(new Response(JSON.stringify({
          model: { id: 'claude-opus-4-7', name: 'Opus 4.7', description: 'Most capable', context: '1m' },
        }), {
          headers: { 'Content-Type': 'application/json' },
        }))
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true, model: 'claude-sonnet-4-6' }), {
        headers: { 'Content-Type': 'application/json' },
      }))
    }) as any

    const models = await client.listModels()
    const current = await client.getCurrentModel()
    await client.setCurrentModel('claude-sonnet-4-6')

    expect(models.models[0]?.id).toBe('claude-opus-4-7')
    expect(current.model.id).toBe('claude-opus-4-7')
    expect(JSON.parse((globalThis.fetch as any).mock.calls[2][1].body)).toEqual({
      modelId: 'claude-sonnet-4-6',
    })
  })

  it('lists skills for a cwd through the server skills API', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({
        skills: [
          {
            name: 'reviewer',
            description: 'Review code',
            source: 'user',
            userInvocable: true,
            contentLength: 120,
            hasDirectory: true,
          },
        ],
      }), {
        headers: { 'Content-Type': 'application/json' },
      }))
    ) as any

    const result = await client.listSkills('/repo')

    expect(result.skills[0]?.name).toBe('reviewer')
    expect((globalThis.fetch as any).mock.calls[0][0]).toBe(
      'http://127.0.0.1:3456/api/skills?cwd=%2Frepo',
    )
  })
})
