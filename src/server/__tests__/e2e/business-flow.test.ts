/**
 * Business Flow E2E Tests
 *
 * 完整的业务流程测试：涵盖定时任务、权限模式、Agent 管理、
 * WebSocket 对话、搜索、会话历史互通等所有核心业务逻辑。
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

let server: ReturnType<typeof Bun.serve>
let baseUrl: string
let wsUrl: string
let tmpDir: string

async function startTestServer() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-biz-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true })
  await fs.mkdir(path.join(tmpDir, 'agents'), { recursive: true })

  const { startServer } = await import('../../index.js')
  const port = 14000 + Math.floor(Math.random() * 1000)
  server = startServer(port, '127.0.0.1')
  baseUrl = `http://127.0.0.1:${port}`
  wsUrl = `ws://127.0.0.1:${port}`
}

async function api(method: string, urlPath: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

describe('Business Flow: Scheduled Tasks', () => {
  beforeAll(startTestServer)
  afterAll(async () => {
    server?.stop()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // ==========================================================================
  // 定时任务完整生命周期
  // ==========================================================================

  it('should start with no scheduled tasks', async () => {
    const { status, data } = await api('GET', '/api/scheduled-tasks')
    expect(status).toBe(200)
    expect(data.tasks).toEqual([])
  })

  it('should create a daily task with all fields', async () => {
    const { status, data } = await api('POST', '/api/scheduled-tasks', {
      name: 'morning-standup',
      description: 'Generate standup report from yesterday',
      cron: '0 9 * * 1-5',
      prompt: 'Look at git log from yesterday, summarize changes, list blockers',
      recurring: true,
      permissionMode: 'default',
      model: 'claude-sonnet-4-6',
      folderPath: '/Users/dev/project',
      useWorktree: true,
    })
    expect(status).toBe(201)
    expect(data.task).toBeDefined()
    expect(data.task.id).toMatch(/^[0-9a-f]{8}$/)
    expect(data.task.name).toBe('morning-standup')
    expect(data.task.cron).toBe('0 9 * * 1-5')
    expect(data.task.prompt).toContain('git log')
    expect(data.task.recurring).toBe(true)
    expect(data.task.permissionMode).toBe('default')
    expect(data.task.model).toBe('claude-sonnet-4-6')
    expect(data.task.createdAt).toBeGreaterThan(0)
  })

  it('should create a second one-shot task', async () => {
    const { status, data } = await api('POST', '/api/scheduled-tasks', {
      cron: '30 14 5 4 *',
      prompt: 'Run security audit',
      recurring: false,
    })
    expect(status).toBe(201)
    expect(data.task.recurring).toBe(false)
  })

  it('should list both tasks', async () => {
    const { data } = await api('GET', '/api/scheduled-tasks')
    expect(data.tasks.length).toBe(2)
    expect(data.tasks[0].name).toBe('morning-standup')
  })

  it('should update task schedule', async () => {
    const { data: listData } = await api('GET', '/api/scheduled-tasks')
    const taskId = listData.tasks[0].id

    const { status, data } = await api('PUT', `/api/scheduled-tasks/${taskId}`, {
      cron: '0 8 * * 1-5',
      description: 'Updated: earlier standup',
    })
    expect(status).toBe(200)
    expect(data.task.cron).toBe('0 8 * * 1-5')
    expect(data.task.description).toBe('Updated: earlier standup')
    // Other fields should remain unchanged
    expect(data.task.name).toBe('morning-standup')
    expect(data.task.prompt).toContain('git log')
  })

  it('should reject creating task without cron', async () => {
    const { status, data } = await api('POST', '/api/scheduled-tasks', {
      prompt: 'missing cron field',
    })
    expect(status).toBe(400)
    expect(data.error).toBeDefined()
  })

  it('should reject creating task without prompt', async () => {
    const { status } = await api('POST', '/api/scheduled-tasks', {
      cron: '0 * * * *',
    })
    expect(status).toBe(400)
  })

  it('should reject updating non-existent task', async () => {
    const { status } = await api('PUT', '/api/scheduled-tasks/nonexistent', {
      cron: '0 * * * *',
    })
    expect(status).toBe(404)
  })

  it('should reject deleting non-existent task', async () => {
    const { status } = await api('DELETE', '/api/scheduled-tasks/nonexistent')
    expect(status).toBe(404)
  })

  it('should delete one task', async () => {
    const { data: listData } = await api('GET', '/api/scheduled-tasks')
    const taskId = listData.tasks[1].id

    const { status } = await api('DELETE', `/api/scheduled-tasks/${taskId}`)
    expect([200, 204]).toContain(status)

    const { data: afterDelete } = await api('GET', '/api/scheduled-tasks')
    expect(afterDelete.tasks.length).toBe(1)
  })

  it('should persist tasks to disk', async () => {
    const filePath = path.join(tmpDir, 'scheduled_tasks.json')
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed.tasks.length).toBe(1)
    expect(parsed.tasks[0].name).toBe('morning-standup')
  })
})

describe('Business Flow: Permission Modes', () => {
  beforeAll(startTestServer)
  afterAll(async () => {
    server?.stop()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const VALID_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk']

  it('should default to "default" mode', async () => {
    const { data } = await api('GET', '/api/permissions/mode')
    expect(data.mode).toBe('default')
  })

  for (const mode of VALID_MODES) {
    it(`should switch to "${mode}" mode and persist`, async () => {
      const { status, data } = await api('PUT', '/api/permissions/mode', { mode })
      expect(status).toBe(200)
      expect(data.mode).toBe(mode)

      // Verify it persisted
      const { data: verify } = await api('GET', '/api/permissions/mode')
      expect(verify.mode).toBe(mode)
    })
  }

  it('should reject invalid mode "auto"', async () => {
    const { status, data } = await api('PUT', '/api/permissions/mode', { mode: 'auto' })
    expect(status).toBe(400)
    expect(data.message).toContain('Invalid permission mode')
  })

  it('should reject missing mode field', async () => {
    const { status } = await api('PUT', '/api/permissions/mode', {})
    expect(status).toBe(400)
  })

  it('should persist mode to settings file', async () => {
    await api('PUT', '/api/permissions/mode', { mode: 'plan' })
    const settingsPath = path.join(tmpDir, 'settings.json')
    const raw = await fs.readFile(settingsPath, 'utf-8')
    const settings = JSON.parse(raw)
    expect(settings.defaultMode).toBe('plan')
  })
})

describe('Business Flow: Task Lists API', () => {
  beforeAll(startTestServer)
  afterAll(async () => {
    server?.stop()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('should reset a persisted task list through the API', async () => {
    const taskListDir = path.join(tmpDir, 'tasks', 'desktop-session-1')
    await fs.mkdir(taskListDir, { recursive: true })
    await fs.writeFile(
      path.join(taskListDir, '1.json'),
      JSON.stringify({
        id: '1',
        subject: 'First task',
        description: '',
        status: 'completed',
        blocks: [],
        blockedBy: [],
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(taskListDir, '2.json'),
      JSON.stringify({
        id: '2',
        subject: 'Second task',
        description: '',
        status: 'completed',
        blocks: [],
        blockedBy: [],
      }),
      'utf-8',
    )

    const { status: beforeStatus, data: beforeData } = await api(
      'GET',
      '/api/tasks/lists/desktop-session-1',
    )
    expect(beforeStatus).toBe(200)
    expect(beforeData.tasks).toHaveLength(2)

    const { status: resetStatus, data: resetData } = await api(
      'POST',
      '/api/tasks/lists/desktop-session-1/reset',
    )
    expect(resetStatus).toBe(200)
    expect(resetData.ok).toBe(true)

    const { status: afterStatus, data: afterData } = await api(
      'GET',
      '/api/tasks/lists/desktop-session-1',
    )
    expect(afterStatus).toBe(200)
    expect(afterData.tasks).toEqual([])
  })
})

describe('Business Flow: Agent Management', () => {
  beforeAll(startTestServer)
  afterAll(async () => {
    server?.stop()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('should start with shared active/all agent payload', async () => {
    const { data } = await api('GET', '/api/agents')
    expect(Array.isArray(data.activeAgents)).toBe(true)
    expect(Array.isArray(data.allAgents)).toBe(true)
    expect(data.activeAgents.length).toBeGreaterThan(0)
    expect(data.activeAgents.some((agent: any) => agent.source === 'built-in')).toBe(true)
  })

  it('should create a new agent with full config', async () => {
    const { status, data } = await api('POST', '/api/agents', {
      name: 'security-auditor',
      description: 'Audits code for security vulnerabilities',
      model: 'claude-opus-4-7',
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
      systemPrompt: 'You are a security expert. Focus on OWASP top 10.',
      color: 'red',
    })
    expect(status).toBe(201)
  })

  it('should create a second agent', async () => {
    const { status } = await api('POST', '/api/agents', {
      name: 'test-writer',
      description: 'Writes unit tests',
      model: 'claude-sonnet-4-6',
      tools: ['Read', 'Write', 'Bash'],
    })
    expect(status).toBe(201)
  })

  it('should list both created agents in CRUD detail endpoint while shared list stays source-based', async () => {
    const { data } = await api('GET', '/api/agents')
    expect(data.activeAgents.length).toBeGreaterThan(0)
    expect(data.activeAgents.some((agent: any) => agent.source === 'built-in')).toBe(true)
    expect(data.activeAgents.some((agent: any) => agent.agentType === 'security-auditor')).toBe(false)
    expect(data.activeAgents.some((agent: any) => agent.agentType === 'test-writer')).toBe(false)

    const securityAuditor = await api('GET', '/api/agents/security-auditor')
    const testWriter = await api('GET', '/api/agents/test-writer')
    expect(securityAuditor.data.agent.name).toBe('security-auditor')
    expect(testWriter.data.agent.name).toBe('test-writer')
  })

  it('should get agent details', async () => {
    const { data } = await api('GET', '/api/agents/security-auditor')
    expect(data.agent.name).toBe('security-auditor')
    expect(data.agent.description).toContain('security')
    expect(data.agent.model).toBe('claude-opus-4-7')
    expect(data.agent.systemPrompt).toContain('OWASP')
  })

  it('should update agent tools', async () => {
    const { status, data } = await api('PUT', '/api/agents/security-auditor', {
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch'],
      description: 'Updated: now with web access',
    })
    expect(status).toBe(200)
    expect(data.agent).toBeDefined()
    expect(data.agent.name).toBe('security-auditor')
    expect(data.agent.description).toBe('Updated: now with web access')
  })

  it('should reject creating duplicate agent', async () => {
    const { status, data } = await api('POST', '/api/agents', {
      name: 'security-auditor',
      description: 'duplicate',
    })
    expect(status).toBe(409)
    expect(data.error).toBe('CONFLICT')
  })

  it('should reject getting non-existent agent', async () => {
    const { status } = await api('GET', '/api/agents/nonexistent')
    expect(status).toBe(404)
  })

  it('should keep deleted agent out of shared active list while built-ins remain', async () => {
    const { status } = await api('DELETE', '/api/agents/test-writer')
    expect([200, 204]).toContain(status)

    const { data } = await api('GET', '/api/agents')
    expect(data.activeAgents.some((agent: any) => agent.agentType === 'test-writer')).toBe(false)
    expect(data.activeAgents.some((agent: any) => agent.source === 'built-in')).toBe(true)

    const deleted = await api('GET', '/api/agents/test-writer')
    expect(deleted.status).toBe(404)
  })

  it('should persist agent to YAML file on disk', async () => {
    const filePath = path.join(tmpDir, 'agents', 'security-auditor.yaml')
    const raw = await fs.readFile(filePath, 'utf-8')
    expect(raw).toContain('security-auditor')
    expect(raw).toContain('OWASP')
  })

  it('should reject deleting non-existent agent', async () => {
    const { status } = await api('DELETE', '/api/agents/nonexistent')
    expect(status).toBe(404)
  })
})

describe('Business Flow: Models & Effort', () => {
  beforeAll(startTestServer)
  afterAll(async () => {
    server?.stop()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('should return 4 available models', async () => {
    const { data } = await api('GET', '/api/models')
    expect(data.models.length).toBe(4)
    const names = data.models.map((m: any) => m.name)
    expect(names).toContain('Opus 4.7')
    expect(names).toContain('Opus 4.7 1M')
    expect(names).toContain('Sonnet 4.6')
    expect(names).toContain('Haiku 4.5')
  })

  it('should default to Sonnet model', async () => {
    const { data } = await api('GET', '/api/models/current')
    expect(data.model.id).toBe('claude-sonnet-4-6')
  })

  it('should switch to Opus 4.7', async () => {
    const { status } = await api('PUT', '/api/models/current', {
      modelId: 'claude-opus-4-7',
    })
    expect(status).toBe(200)

    const { data } = await api('GET', '/api/models/current')
    expect(data.model.id).toBe('claude-opus-4-7')
    expect(data.model.name).toBe('Opus 4.7')
  })

  it('should switch to Haiku 4.5', async () => {
    await api('PUT', '/api/models/current', { modelId: 'claude-haiku-4-5' })
    const { data } = await api('GET', '/api/models/current')
    expect(data.model.name).toBe('Haiku 4.5')
  })

  it('should reject empty model ID', async () => {
    const { status } = await api('PUT', '/api/models/current', { modelId: '' })
    expect(status).toBe(400)
  })

  it('should reject missing model ID', async () => {
    const { status } = await api('PUT', '/api/models/current', {})
    expect(status).toBe(400)
  })

  it('should default effort to medium', async () => {
    const { data } = await api('GET', '/api/effort')
    expect(data.level).toBe('medium')
    expect(data.available).toEqual(['low', 'medium', 'high', 'max'])
  })

  it('should set effort to max', async () => {
    const { status, data } = await api('PUT', '/api/effort', { level: 'max' })
    expect(status).toBe(200)
    expect(data.level).toBe('max')

    const { data: verify } = await api('GET', '/api/effort')
    expect(verify.level).toBe('max')
  })

  it('should set effort to low', async () => {
    await api('PUT', '/api/effort', { level: 'low' })
    const { data } = await api('GET', '/api/effort')
    expect(data.level).toBe('low')
  })

  it('should reject invalid effort level', async () => {
    const { status, data } = await api('PUT', '/api/effort', { level: 'extreme' })
    expect(status).toBe(400)
    expect(data.message).toContain('Invalid effort level')
  })

  it('should persist model and effort to settings file', async () => {
    await api('PUT', '/api/models/current', { modelId: 'claude-opus-4-7' })
    await api('PUT', '/api/effort', { level: 'high' })

    const settingsPath = path.join(tmpDir, 'settings.json')
    const raw = await fs.readFile(settingsPath, 'utf-8')
    const settings = JSON.parse(raw)
    expect(settings.model).toBe('claude-opus-4-7')
    expect(settings.effort).toBe('high')
  })
})

describe('Business Flow: Sessions & CLI Interop', () => {
  beforeAll(startTestServer)
  afterAll(async () => {
    server?.stop()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  let sessionId: string

  it('should create a session', async () => {
    const { status, data } = await api('POST', '/api/sessions', {
      workDir: '/Users/dev/my-project',
    })
    expect(status).toBe(201)
    expect(data.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    sessionId = data.sessionId
  })

  it('should create session JSONL file on disk (CLI compatible)', async () => {
    const projectDir = path.join(tmpDir, 'projects')
    const dirs = await fs.readdir(projectDir)
    expect(dirs.length).toBeGreaterThan(0)

    // Find the session file
    let found = false
    for (const dir of dirs) {
      const files = await fs.readdir(path.join(projectDir, dir))
      if (files.some((f) => f === `${sessionId}.jsonl`)) {
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })

  it('should simulate CLI writing messages (JSONL format)', async () => {
    // Simulate what CLI does: append JSONL entries
    const projectDir = path.join(tmpDir, 'projects')
    const dirs = await fs.readdir(projectDir)
    let sessionFile = ''
    for (const dir of dirs) {
      const candidate = path.join(projectDir, dir, `${sessionId}.jsonl`)
      try {
        await fs.access(candidate)
        sessionFile = candidate
        break
      } catch {}
    }
    expect(sessionFile).not.toBe('')

    // Append user message (mimicking CLI JSONL format - must include message.role)
    const userEntry = {
      type: 'user',
      uuid: 'msg-001',
      message: { role: 'user', content: [{ type: 'text', text: 'Hello from CLI' }] },
      timestamp: new Date().toISOString(),
      sessionId,
    }
    await fs.appendFile(sessionFile, JSON.stringify(userEntry) + '\n')

    // Append assistant message
    const assistantEntry = {
      type: 'assistant',
      uuid: 'msg-002',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello! How can I help you today?' }] },
      timestamp: new Date().toISOString(),
      sessionId,
      parentUuid: 'msg-001',
    }
    await fs.appendFile(sessionFile, JSON.stringify(assistantEntry) + '\n')
  })

  it('should read CLI-written messages via API', async () => {
    const { status, data } = await api('GET', `/api/sessions/${sessionId}/messages`)
    expect(status).toBe(200)
    expect(data.messages.length).toBe(2)
    expect(data.messages[0].type).toBe('user')
    expect(data.messages[0].content).toBeDefined()
    expect(data.messages[1].type).toBe('assistant')
  })

  it('should show CLI messages in session list', async () => {
    const { data } = await api('GET', '/api/sessions')
    const session = data.sessions.find((s: any) => s.id === sessionId)
    expect(session).toBeDefined()
    expect(session.messageCount).toBeGreaterThanOrEqual(2)
    expect(session.title).toContain('Hello from CLI')
  })

  it('should rename session and verify', async () => {
    await api('PATCH', `/api/sessions/${sessionId}`, { title: 'CLI Test Session' })
    const { data } = await api('GET', `/api/sessions/${sessionId}`)
    expect(data.title).toBe('CLI Test Session')
  })

  it('should rename be persisted as JSONL entry (CLI compatible)', async () => {
    const projectDir = path.join(tmpDir, 'projects')
    const dirs = await fs.readdir(projectDir)
    let sessionFile = ''
    for (const dir of dirs) {
      const candidate = path.join(projectDir, dir, `${sessionId}.jsonl`)
      try {
        await fs.access(candidate)
        sessionFile = candidate
        break
      } catch {}
    }

    const raw = await fs.readFile(sessionFile, 'utf-8')
    const lines = raw.trim().split('\n')
    const lastEntry = JSON.parse(lines[lines.length - 1])
    expect(lastEntry.type).toBe('custom-title')
    expect(lastEntry.customTitle).toBe('CLI Test Session')
  })
})

describe('Business Flow: Search', () => {
  beforeAll(async () => {
    await startTestServer()
    // Create test files to search
    const testDir = path.join(tmpDir, 'test-workspace')
    await fs.mkdir(testDir, { recursive: true })
    await fs.writeFile(path.join(testDir, 'main.ts'), 'export function startServer() {\n  console.log("starting")\n}\n')
    await fs.writeFile(path.join(testDir, 'utils.ts'), 'export function helper() { return 42 }\n')
    await fs.writeFile(path.join(testDir, 'config.json'), '{"port": 3456}\n')
  })
  afterAll(async () => {
    server?.stop()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('should find matches in workspace files', async () => {
    const { status, data } = await api('POST', '/api/search', {
      query: 'startServer',
      cwd: path.join(tmpDir, 'test-workspace'),
    })
    expect(status).toBe(200)
    expect(data.results.length).toBeGreaterThan(0)
    expect(data.results[0].text).toContain('startServer')
  })

  it('should respect maxResults', async () => {
    const { data } = await api('POST', '/api/search', {
      query: 'export',
      cwd: path.join(tmpDir, 'test-workspace'),
      maxResults: 1,
    })
    expect(data.results.length).toBeLessThanOrEqual(1)
  })

  it('should return empty for non-matching query', async () => {
    const { data } = await api('POST', '/api/search', {
      query: 'nonexistent_string_xyz123',
      cwd: path.join(tmpDir, 'test-workspace'),
    })
    expect(data.results.length).toBe(0)
  })

  it('should reject empty query', async () => {
    const { status } = await api('POST', '/api/search', {
      query: '',
      cwd: tmpDir,
    })
    expect(status).toBe(400)
  })
})

describe('Business Flow: WebSocket Chat', () => {
  beforeAll(startTestServer)
  afterAll(async () => {
    server?.stop()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('should establish WebSocket connection and receive connected event', async () => {
    const messages: any[] = []
    const ws = new WebSocket(`${wsUrl}/ws/ws-test-1`)

    await new Promise<void>((resolve) => {
      ws.onmessage = (event) => {
        messages.push(JSON.parse(event.data as string))
        if (messages.length >= 1) {
          ws.close()
          resolve()
        }
      }
      ws.onerror = () => { ws.close(); resolve() }
      setTimeout(() => { ws.close(); resolve() }, 3000)
    })

    expect(messages[0].type).toBe('connected')
    expect(messages[0].sessionId).toBe('ws-test-1')
  })

  it('should echo message and transition through states', async () => {
    const messages: any[] = []
    const ws = new WebSocket(`${wsUrl}/ws/ws-test-2`)

    await new Promise<void>((resolve) => {
      ws.onopen = () => {}
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string)
        messages.push(msg)
        if (msg.type === 'connected') {
          ws.send(JSON.stringify({ type: 'user_message', content: 'test message' }))
        }
        if (msg.type === 'status' && msg.state === 'idle' && messages.length > 3) {
          ws.close()
          resolve()
        }
      }
      ws.onerror = () => { ws.close(); resolve() }
      setTimeout(() => { ws.close(); resolve() }, 5000)
    })

    const types = messages.map((m) => m.type)
    expect(types).toContain('connected')
    expect(types).toContain('status')
    expect(types).toContain('content_start')
    expect(types).toContain('content_delta')
    expect(types).toContain('message_complete')

    // Should have thinking state first
    const statusMsgs = messages.filter((m) => m.type === 'status')
    expect(statusMsgs[0].state).toBe('thinking')
  })

  it('should handle ping/pong', async () => {
    const messages: any[] = []
    const ws = new WebSocket(`${wsUrl}/ws/ws-test-3`)

    await new Promise<void>((resolve) => {
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string)
        messages.push(msg)
        if (msg.type === 'connected') {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
        if (msg.type === 'pong') {
          ws.close()
          resolve()
        }
      }
      setTimeout(() => { ws.close(); resolve() }, 3000)
    })

    expect(messages.some((m) => m.type === 'pong')).toBe(true)
  })

  it('should handle stop_generation', async () => {
    const messages: any[] = []
    const ws = new WebSocket(`${wsUrl}/ws/ws-test-4`)

    await new Promise<void>((resolve) => {
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string)
        messages.push(msg)
        if (msg.type === 'connected') {
          ws.send(JSON.stringify({ type: 'stop_generation' }))
        }
        if (msg.type === 'status' && msg.state === 'idle') {
          ws.close()
          resolve()
        }
      }
      setTimeout(() => { ws.close(); resolve() }, 3000)
    })

    const idleStatus = messages.find((m) => m.type === 'status' && m.state === 'idle')
    expect(idleStatus).toBeDefined()
  })

  it('should handle invalid message gracefully', async () => {
    const messages: any[] = []
    const ws = new WebSocket(`${wsUrl}/ws/ws-test-5`)

    await new Promise<void>((resolve) => {
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string)
        messages.push(msg)
        if (msg.type === 'connected') {
          ws.send('not valid json {{{')
        }
        if (msg.type === 'error') {
          ws.close()
          resolve()
        }
      }
      setTimeout(() => { ws.close(); resolve() }, 3000)
    })

    const errorMsg = messages.find((m) => m.type === 'error')
    expect(errorMsg).toBeDefined()
    expect(errorMsg.code).toBe('PARSE_ERROR')
  })

  it('should reject invalid session ID in WebSocket URL', async () => {
    // Path traversal gets resolved by URL parser, so test with special chars
    const res = await fetch(`${baseUrl}/ws/invalid session!@#`, {
      headers: { 'Upgrade': 'websocket', 'Connection': 'Upgrade' },
    })
    // URL with special chars either returns 400 (invalid ID) or 404 (path resolution)
    expect([400, 404]).toContain(res.status)
  })
})

describe('Business Flow: Settings Persistence', () => {
  beforeAll(startTestServer)
  afterAll(async () => {
    server?.stop()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('should write and read complex settings', async () => {
    const settings = {
      theme: 'dark',
      model: 'claude-opus-4-7',
      effort: 'high',
      outputStyle: 'verbose',
      permissions: {
        allow: ['Bash(npm test)', 'Bash(npm run build)', 'Read'],
        deny: ['Bash(rm -rf /)'],
      },
    }

    await api('PUT', '/api/settings/user', settings)
    const { data } = await api('GET', '/api/settings/user')

    expect(data.theme).toBe('dark')
    expect(data.model).toBe('claude-opus-4-7')
    expect(data.permissions.allow).toContain('Read')
    expect(data.permissions.deny).toContain('Bash(rm -rf /)')
  })

  it('should merge settings (not overwrite)', async () => {
    // First write
    await api('PUT', '/api/settings/user', { theme: 'dark' })
    // Second write (should merge, not overwrite)
    await api('PUT', '/api/settings/user', { outputStyle: 'concise' })

    const { data } = await api('GET', '/api/settings/user')
    expect(data.theme).toBe('dark') // Should still be there
    expect(data.outputStyle).toBe('concise')
  })

  it('should support project-level settings', async () => {
    const projectRoot = path.join(tmpDir, 'test-project')
    await fs.mkdir(path.join(projectRoot, '.claude'), { recursive: true })

    await api('PUT', `/api/settings/project?projectRoot=${encodeURIComponent(projectRoot)}`, {
      permissions: { allow: ['Bash(make)'] },
    })

    const { data } = await api('GET', `/api/settings/project?projectRoot=${encodeURIComponent(projectRoot)}`)
    expect(data.permissions.allow).toContain('Bash(make)')
  })

  it('should merge user and project settings', async () => {
    await api('PUT', '/api/settings/user', { theme: 'light', model: 'claude-sonnet-4-6' })

    const { data } = await api('GET', '/api/settings')
    expect(data.theme).toBeDefined()
    expect(data.model).toBeDefined()
  })
})

describe('Business Flow: Status & Diagnostics', () => {
  beforeAll(startTestServer)
  afterAll(async () => {
    server?.stop()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('should return health with uptime', async () => {
    const { data } = await api('GET', '/api/status')
    expect(data.status).toBe('ok')
    expect(data.uptime).toBeGreaterThanOrEqual(0)
  })

  it('should return diagnostics with system info', async () => {
    const { data } = await api('GET', '/api/status/diagnostics')
    expect(data.platform).toBe(process.platform)
    expect(data.arch).toBe(process.arch)
    expect(data.configDir).toBe(tmpDir)
    expect(data.memory.rss).toBeGreaterThan(0)
  })

  it('should return usage stats', async () => {
    const { data } = await api('GET', '/api/status/usage')
    expect(data).toHaveProperty('totalInputTokens')
    expect(data).toHaveProperty('totalOutputTokens')
    expect(data).toHaveProperty('totalCost')
  })

  it('should return user info with project list', async () => {
    const { data } = await api('GET', '/api/status/user')
    expect(data.configDir).toBe(tmpDir)
    expect(Array.isArray(data.projects)).toBe(true)
  })

  it('should reject non-GET methods', async () => {
    const { status } = await api('POST', '/api/status')
    expect(status).toBe(405)
  })
})

describe('Business Flow: Error Handling', () => {
  beforeAll(startTestServer)
  afterAll(async () => {
    server?.stop()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('should return 404 for unknown API resource', async () => {
    const { status, data } = await api('GET', '/api/unknown')
    expect(status).toBe(404)
    expect(data.error).toBeDefined()
  })

  it('should return 404 for unknown session', async () => {
    const { status } = await api('GET', '/api/sessions/00000000-0000-0000-0000-000000000000')
    expect(status).toBe(404)
  })

  it('should handle malformed JSON body gracefully', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid json',
    })
    expect(res.status).toBe(400)
  })

  it('should return proper error structure', async () => {
    const { data } = await api('GET', '/api/sessions/nonexistent')
    expect(data).toHaveProperty('error')
    expect(data).toHaveProperty('message')
  })
})
