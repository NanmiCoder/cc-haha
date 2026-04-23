import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
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

  it('createSession throws on server error', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'BAD_REQUEST', message: 'workDir required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }))
    ) as any

    expect(client.createSession('')).rejects.toThrow()
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
})
