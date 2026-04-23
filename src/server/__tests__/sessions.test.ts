/**
 * Unit tests for SessionService and Sessions API
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { SessionService } from '../services/sessionService.js'
import { clearCommandsCache } from '../../commands.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'

// ============================================================================
// Test helpers
// ============================================================================

let tmpDir: string
let service: SessionService

/** Create a temporary config dir and configure the service to use it. */
async function setupTmpConfigDir(): Promise<string> {
  tmpDir = path.join(os.tmpdir(), `claude-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  return tmpDir
}

async function cleanupTmpDir(): Promise<void> {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
  delete process.env.CLAUDE_CONFIG_DIR
}

/** Write a JSONL session file with given entries. */
async function writeSessionFile(
  projectDir: string,
  sessionId: string,
  entries: Record<string, unknown>[]
): Promise<string> {
  const dir = path.join(tmpDir, 'projects', projectDir)
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${sessionId}.jsonl`)
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await fs.writeFile(filePath, content, 'utf-8')
  return filePath
}

async function writeSkill(
  rootDir: string,
  skillName: string,
  description: string,
): Promise<void> {
  const skillDir = path.join(rootDir, skillName)
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    ['---', `description: ${description}`, '---', '', `# ${skillName}`].join('\n'),
    'utf-8',
  )
}

// Sample entries matching real CLI format
function makeSnapshotEntry(): Record<string, unknown> {
  return {
    type: 'file-history-snapshot',
    messageId: crypto.randomUUID(),
    snapshot: {
      messageId: crypto.randomUUID(),
      trackedFileBackups: {},
      timestamp: '2026-01-01T00:00:00.000Z',
    },
    isSnapshotUpdate: false,
  }
}

function makeUserEntry(content: string, uuid?: string): Record<string, unknown> {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content },
    uuid: uuid || crypto.randomUUID(),
    timestamp: '2026-01-01T00:01:00.000Z',
    userType: 'external',
    cwd: '/tmp/test',
    sessionId: 'test-session',
  }
}

function makeAssistantEntry(content: string, parentUuid?: string): Record<string, unknown> {
  return {
    parentUuid: parentUuid || null,
    isSidechain: false,
    type: 'assistant',
    message: {
      model: 'claude-opus-4-7',
      id: `msg_${crypto.randomUUID().slice(0, 20)}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: content }],
    },
    uuid: crypto.randomUUID(),
    timestamp: '2026-01-01T00:02:00.000Z',
  }
}

function makeMetaUserEntry(): Record<string, unknown> {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: '<local-command-caveat>internal</local-command-caveat>' },
    isMeta: true,
    uuid: crypto.randomUUID(),
    timestamp: '2026-01-01T00:00:30.000Z',
  }
}

function makeSessionMetaEntry(workDir: string): Record<string, unknown> {
  return {
    type: 'session-meta',
    isMeta: true,
    workDir,
    timestamp: '2026-01-01T00:00:00.000Z',
  }
}

// ============================================================================
// SessionService tests
// ============================================================================

describe('SessionService', () => {
  beforeEach(async () => {
    await setupTmpConfigDir()
    service = new SessionService()
  })

  afterEach(async () => {
    clearCommandsCache()
    await cleanupTmpDir()
  })

  // --------------------------------------------------------------------------
  // listSessions
  // --------------------------------------------------------------------------

  it('should return empty list when no sessions exist', async () => {
    const result = await service.listSessions()
    expect(result.sessions).toEqual([])
    expect(result.total).toBe(0)
  })

  it('should list sessions from JSONL files', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-testproject', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Hello Claude'),
      makeAssistantEntry('Hi there!'),
    ])

    const result = await service.listSessions()
    expect(result.total).toBe(1)
    expect(result.sessions).toHaveLength(1)

    const session = result.sessions[0]!
    expect(session.id).toBe(sessionId)
    expect(session.title).toBe('Hello Claude')
    expect(session.messageCount).toBe(2) // 1 user + 1 assistant
    expect(session.projectPath).toBe('-tmp-testproject')
  })

  it('should paginate results with limit and offset', async () => {
    // Create 3 sessions
    for (let i = 0; i < 3; i++) {
      const id = `0000000${i}-bbbb-cccc-dddd-eeeeeeeeeeee`
      await writeSessionFile('-tmp-test', id, [
        makeSnapshotEntry(),
        makeUserEntry(`Message ${i}`),
      ])
    }

    const page1 = await service.listSessions({ limit: 2, offset: 0 })
    expect(page1.total).toBe(3)
    expect(page1.sessions).toHaveLength(2)

    const page2 = await service.listSessions({ limit: 2, offset: 2 })
    expect(page2.total).toBe(3)
    expect(page2.sessions).toHaveLength(1)
  })

  it('should filter sessions by project', async () => {
    const id1 = 'aaaaaaaa-1111-cccc-dddd-eeeeeeeeeeee'
    const id2 = 'aaaaaaaa-2222-cccc-dddd-eeeeeeeeeeee'

    await writeSessionFile('-project-a', id1, [makeSnapshotEntry(), makeUserEntry('In A')])
    await writeSessionFile('-project-b', id2, [makeSnapshotEntry(), makeUserEntry('In B')])

    const resultA = await service.listSessions({ project: '/project/a' })
    expect(resultA.total).toBe(1)
    expect(resultA.sessions[0]!.id).toBe(id1)
  })

  // --------------------------------------------------------------------------
  // getSession
  // --------------------------------------------------------------------------

  it('should return null for non-existent session', async () => {
    const result = await service.getSession('00000000-0000-0000-0000-000000000000')
    expect(result).toBeNull()
  })

  it('should return session detail with messages', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const userUuid = crypto.randomUUID()
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Tell me a joke', userUuid),
      makeAssistantEntry('Why did the chicken cross the road?', userUuid),
    ])

    const detail = await service.getSession(sessionId)
    expect(detail).not.toBeNull()
    expect(detail!.id).toBe(sessionId)
    expect(detail!.title).toBe('Tell me a joke')
    expect(detail!.messages).toHaveLength(2)
    expect(detail!.messages[0]!.type).toBe('user')
    expect(detail!.messages[1]!.type).toBe('assistant')
  })

  it('should skip meta entries in messages', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeMetaUserEntry(),
      makeUserEntry('Real message'),
    ])

    const detail = await service.getSession(sessionId)
    expect(detail!.messages).toHaveLength(1)
    expect(detail!.messages[0]!.content).toBe('Real message')
  })

  // --------------------------------------------------------------------------
  // getSessionMessages
  // --------------------------------------------------------------------------

  it('should throw for non-existent session messages', async () => {
    expect(
      service.getSessionMessages('00000000-0000-0000-0000-000000000000')
    ).rejects.toThrow('Session not found')
  })

  it('should return messages only', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Hello'),
      makeAssistantEntry('World'),
    ])

    const messages = await service.getSessionMessages(sessionId)
    expect(messages).toHaveLength(2)
  })

  it('should reconstruct parent agent tool linkage from parentUuid chains', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const userUuid = crypto.randomUUID()
    const agentAssistantUuid = crypto.randomUUID()
    const childAssistantUuid = crypto.randomUUID()

    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Inspect the codebase', userUuid),
      {
        parentUuid: userUuid,
        isSidechain: false,
        type: 'assistant',
        message: {
          model: 'claude-opus-4-7',
          id: `msg_${crypto.randomUUID().slice(0, 20)}`,
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Agent',
              id: 'agent-tool-1',
              input: { description: 'Inspect src/components' },
            },
          ],
        },
        uuid: agentAssistantUuid,
        timestamp: '2026-01-01T00:02:00.000Z',
      },
      {
        parentUuid: agentAssistantUuid,
        isSidechain: true,
        type: 'assistant',
        message: {
          model: 'claude-opus-4-7',
          id: `msg_${crypto.randomUUID().slice(0, 20)}`,
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Read',
              id: 'read-tool-1',
              input: { file_path: 'src/components/App.tsx' },
            },
          ],
        },
        uuid: childAssistantUuid,
        timestamp: '2026-01-01T00:02:30.000Z',
      },
      {
        parentUuid: childAssistantUuid,
        isSidechain: true,
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'read-tool-1',
              content: 'ok',
              is_error: false,
            },
          ],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:03:00.000Z',
        userType: 'external',
        cwd: '/tmp/test',
        sessionId: 'test-session',
      },
    ])

    const messages = await service.getSessionMessages(sessionId)

    expect(messages[1]).toMatchObject({
      type: 'tool_use',
      parentToolUseId: undefined,
    })
    expect(messages[2]).toMatchObject({
      type: 'tool_use',
      parentToolUseId: 'agent-tool-1',
    })
    expect(messages[3]).toMatchObject({
      type: 'tool_result',
      parentToolUseId: 'agent-tool-1',
    })
  })

  it('should recover workDir from session-meta entries', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry('/tmp/from-meta'),
      makeUserEntry('Hello'),
    ])

    const workDir = await service.getSessionWorkDir(sessionId)
    expect(workDir).toBe('/tmp/from-meta')
  })

  it('should recover workDir from transcript cwd when session-meta is missing', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      {
        ...makeUserEntry('Hello'),
        cwd: '/tmp/from-cwd',
      },
    ])

    const workDir = await service.getSessionWorkDir(sessionId)
    expect(workDir).toBe('/tmp/from-cwd')
  })

  // --------------------------------------------------------------------------
  // createSession
  // --------------------------------------------------------------------------

  it('should create a new session file', async () => {
    const workDir = path.join(tmpDir, 'workspace', 'my-project')
    await fs.mkdir(workDir, { recursive: true })
    const { sessionId } = await service.createSession(workDir)
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )

    // Verify the file was created
    const sanitized = sanitizePath(workDir)
    const filePath = path.join(tmpDir, 'projects', sanitized, `${sessionId}.jsonl`)
    const stat = await fs.stat(filePath)
    expect(stat.isFile()).toBe(true)

    // Verify the file starts with the initial snapshot entry
    const content = await fs.readFile(filePath, 'utf-8')
    const entry = JSON.parse(content.trim().split('\n')[0]!)
    expect(entry.type).toBe('file-history-snapshot')
  })

  it('should create a Windows-safe project directory name', async () => {
    if (process.platform !== 'win32') return

    const workDir = process.cwd()
    const { sessionId } = await service.createSession(workDir)
    const sanitized = sanitizePath(workDir)
    const projectDir = path.join(tmpDir, 'projects', sanitized)

    expect(sanitized.includes(':')).toBe(false)
    const stat = await fs.stat(path.join(projectDir, `${sessionId}.jsonl`))
    expect(stat.isFile()).toBe(true)
  })

  it('should default to the user home directory when workDir is missing', async () => {
    const { sessionId } = await service.createSession('')
    const filePath = path.join(
      tmpDir,
      'projects',
      sanitizePath(os.homedir()),
      `${sessionId}.jsonl`,
    )

    const stat = await fs.stat(filePath)
    expect(stat.isFile()).toBe(true)
  })

  it('should throw when workDir does not exist', async () => {
    expect(service.createSession('/tmp/definitely-missing-claude-code-haha')).rejects.toThrow(
      'Working directory does not exist'
    )
  })

  // --------------------------------------------------------------------------
  // deleteSession
  // --------------------------------------------------------------------------

  it('should delete an existing session', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const filePath = await writeSessionFile('-tmp-project', sessionId, [makeSnapshotEntry()])

    await service.deleteSession(sessionId)

    // File should no longer exist
    expect(fs.access(filePath)).rejects.toThrow()
  })

  it('should throw when deleting non-existent session', async () => {
    expect(
      service.deleteSession('00000000-0000-0000-0000-000000000000')
    ).rejects.toThrow('Session not found')
  })

  // --------------------------------------------------------------------------
  // renameSession
  // --------------------------------------------------------------------------

  it('should rename a session by appending custom-title entry', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const filePath = await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Original message'),
    ])

    await service.renameSession(sessionId, 'My Custom Title')

    // Read the file and check the last entry
    const content = await fs.readFile(filePath, 'utf-8')
    const lines = content.trim().split('\n')
    const lastEntry = JSON.parse(lines[lines.length - 1]!)
    expect(lastEntry.type).toBe('custom-title')
    expect(lastEntry.customTitle).toBe('My Custom Title')

    // Verify the title is now returned in list
    const detail = await service.getSession(sessionId)
    expect(detail!.title).toBe('My Custom Title')
  })

  it('should throw when renaming non-existent session', async () => {
    expect(
      service.renameSession('00000000-0000-0000-0000-000000000000', 'Title')
    ).rejects.toThrow('Session not found')
  })

  // --------------------------------------------------------------------------
  // Title extraction
  // --------------------------------------------------------------------------

  it('should use first user message as title when no custom title', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeMetaUserEntry(),
      makeUserEntry('This is my first real question'),
    ])

    const detail = await service.getSession(sessionId)
    expect(detail!.title).toBe('This is my first real question')
  })

  it('should truncate long titles to 80 chars', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const longMessage = 'A'.repeat(120)
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry(longMessage),
    ])

    const detail = await service.getSession(sessionId)
    expect(detail!.title.length).toBe(83) // 80 + '...'
    expect(detail!.title.endsWith('...')).toBe(true)
  })

  it('should fall back to "Untitled Session" when no user message', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [makeSnapshotEntry()])

    const detail = await service.getSession(sessionId)
    expect(detail!.title).toBe('Untitled Session')
  })

  it('should detect placeholder launch info for desktop-created sessions', async () => {
    const { sessionId } = await service.createSession(os.tmpdir())

    const launchInfo = await service.getSessionLaunchInfo(sessionId)
    expect(launchInfo).not.toBeNull()
    expect(launchInfo!.workDir).toBe(os.tmpdir())
    expect(launchInfo!.transcriptMessageCount).toBe(0)
    expect(launchInfo!.customTitle).toBeNull()
  })

  it('should detect resumable launch info for transcript sessions', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const userUuid = crypto.randomUUID()
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      { type: 'session-meta', isMeta: true, workDir: '/tmp/project', timestamp: '2026-01-01T00:00:00.000Z' },
      makeUserEntry('Hello again', userUuid),
      makeAssistantEntry('Welcome back', userUuid),
      { type: 'custom-title', customTitle: 'Saved chat', timestamp: '2026-01-01T00:03:00.000Z' },
    ])

    const launchInfo = await service.getSessionLaunchInfo(sessionId)
    expect(launchInfo).not.toBeNull()
    expect(launchInfo!.workDir).toBe('/tmp/project')
    expect(launchInfo!.transcriptMessageCount).toBe(2)
    expect(launchInfo!.customTitle).toBe('Saved chat')
  })
})

// ============================================================================
// Sessions API integration tests
// ============================================================================

describe('Sessions API', () => {
  let baseUrl: string
  let server: ReturnType<typeof Bun.serve> | null = null

  beforeEach(async () => {
    await setupTmpConfigDir()
    service = new SessionService()

    // Import and start a minimal test server
    const { handleSessionsApi } = await import('../api/sessions.js')
    const { handleConversationsApi } = await import('../api/conversations.js')

    const port = 30000 + Math.floor(Math.random() * 10000)
    baseUrl = `http://127.0.0.1:${port}`

    server = Bun.serve({
      port,
      hostname: '127.0.0.1',

      async fetch(req) {
        const url = new URL(req.url)
        const segments = url.pathname.split('/').filter(Boolean)

        if (segments[0] === 'api' && segments[1] === 'sessions') {
          // Route chat sub-resource to conversations handler
          if (segments[3] === 'chat') {
            return handleConversationsApi(req, url, segments)
          }
          return handleSessionsApi(req, url, segments)
        }

        return new Response('Not Found', { status: 404 })
      },
    })
  })

  afterEach(async () => {
    if (server) {
      server.stop(true)
      server = null
    }
    await cleanupTmpDir()
  })

  it('GET /api/sessions should return empty list', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { sessions: unknown[]; total: number }
    expect(body.sessions).toEqual([])
    expect(body.total).toBe(0)
  })

  it('POST /api/sessions should create a session', async () => {
    const workDir = await fs.mkdtemp(path.join(tmpDir, 'api-session-'))
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir }),
    })
    expect(res.status).toBe(201)

    const body = (await res.json()) as { sessionId: string }
    expect(body.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

  it('POST /api/sessions should create a session when workDir is omitted', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(201)

    const body = (await res.json()) as { sessionId: string }
    expect(body.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

  it('GET /api/sessions/:id should return session detail', async () => {
    // Create a session file
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('API test message'),
      makeAssistantEntry('API test response'),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { id: string; title: string; messages: unknown[] }
    expect(body.id).toBe(sessionId)
    expect(body.title).toBe('API test message')
    expect(body.messages).toHaveLength(2)
  })

  it('GET /api/sessions/:id should 404 for unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/00000000-0000-0000-0000-000000000000`)
    expect(res.status).toBe(404)
  })

  it('GET /api/sessions/:id/messages should return messages', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Hello'),
      makeAssistantEntry('World'),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { messages: unknown[] }
    expect(body.messages).toHaveLength(2)
  })

  it('DELETE /api/sessions/:id should delete the session', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-api-test', sessionId, [makeSnapshotEntry()])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)

    // Verify it's gone
    const res2 = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
    expect(res2.status).toBe(404)
  })

  it('PATCH /api/sessions/:id should rename the session', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Old title message'),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Custom Title' }),
    })
    expect(res.status).toBe(200)

    // Verify new title
    const detailRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
    const detail = (await detailRes.json()) as { title: string }
    expect(detail.title).toBe('New Custom Title')
  })

  it('GET /api/sessions/:id/slash-commands should include user and project skills before CLI init', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const workDir = path.join(tmpDir, 'workspace', 'app')

    await fs.mkdir(path.join(workDir, '.claude', 'skills'), { recursive: true })
    await fs.mkdir(path.join(tmpDir, 'skills'), { recursive: true })
    await writeSkill(path.join(tmpDir, 'skills'), 'user-skill', 'User skill description')
    await writeSkill(path.join(workDir, '.claude', 'skills'), 'project-skill', 'Project skill description')

    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry(workDir),
    ])

    clearCommandsCache()

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/slash-commands`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      commands: Array<{ name: string; description: string }>
    }

    expect(body.commands).toContainEqual(
      expect.objectContaining({ name: 'user-skill', description: 'User skill description' }),
    )
    expect(body.commands).toContainEqual(
      expect.objectContaining({ name: 'project-skill', description: 'Project skill description' }),
    )
  })

  // --------------------------------------------------------------------------
  // Conversations API via /api/sessions/:id/chat
  // --------------------------------------------------------------------------

  it('GET /api/sessions/:id/chat/status should return idle by default', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/chat/status`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { state: string }
    expect(body.state).toBe('idle')
  })

  it('POST /api/sessions/:id/chat should queue a message', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Previous'),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'New question' }),
    })
    expect(res.status).toBe(202)

    const body = (await res.json()) as { messageId: string; status: string }
    expect(body.status).toBe('queued')
    expect(body.messageId).toBeTruthy()
  })

  it('POST /api/sessions/:id/chat/stop should reset state to idle', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/chat/stop`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)

    // Verify state is idle
    const statusRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/chat/status`)
    const status = (await statusRes.json()) as { state: string }
    expect(status.state).toBe('idle')
  })
})
