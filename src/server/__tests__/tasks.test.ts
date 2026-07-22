/**
 * Unit tests for TaskService and Tasks API
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { TaskService } from '../services/taskService.js'

const taskFixture = (overrides: Record<string, unknown>) => ({
  id: '1',
  subject: 'Test task',
  description: '',
  status: 'pending',
  blocks: [],
  blockedBy: [],
  ...overrides,
})

async function rmWithRetry(targetPath: string): Promise<void> {
  await fs.rm(targetPath, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 5 : 0,
    retryDelay: 100,
  })
}

// ============================================================================
// TaskService unit tests
// ============================================================================

describe('TaskService', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-tasks-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    delete process.env.CLAUDE_CONFIG_DIR
  })

  it('should return empty list when no tasks dir', async () => {
    const svc = new TaskService()
    const tasks = await svc.listTasks()
    expect(tasks).toEqual([])
  })

  it('should list tasks from JSON files', async () => {
    const tasksDir = path.join(tmpDir, 'tasks', 'default-list')
    await fs.mkdir(tasksDir, { recursive: true })

    await fs.writeFile(path.join(tasksDir, '1.json'), JSON.stringify(taskFixture({
      id: 'task-001',
      subject: 'code-review',
      status: 'completed',
      description: 'Review PR #42',
    })))

    await fs.writeFile(path.join(tasksDir, '2.json'), JSON.stringify(taskFixture({
      id: 'task-002',
      subject: 'frontend-dev',
      status: 'in_progress',
      owner: 'ui-team',
    })))

    const svc = new TaskService()
    const tasks = await svc.listTasks()
    expect(tasks.length).toBe(2)
    expect(tasks[0].id).toBe('task-001')
    expect(tasks[1].id).toBe('task-002')
  })

  it('should scan nested team task directories', async () => {
    const teamDir = path.join(tmpDir, 'tasks', 'my-team')
    await fs.mkdir(teamDir, { recursive: true })

    await fs.writeFile(path.join(teamDir, 'member-1.json'), JSON.stringify(taskFixture({
      id: 'member-1',
      subject: 'Implement feature',
      status: 'completed',
    })))

    const svc = new TaskService()
    const tasks = await svc.listTasks()
    expect(tasks.length).toBe(1)
    expect(tasks[0].taskListId).toBe('my-team')
  })

  it('should get single task by ID', async () => {
    const tasksDir = path.join(tmpDir, 'tasks', 'default-list')
    await fs.mkdir(tasksDir, { recursive: true })

    await fs.writeFile(path.join(tasksDir, 'abc.json'), JSON.stringify(taskFixture({
      id: 'abc',
      subject: 'build',
      status: 'completed',
    })))

    const svc = new TaskService()
    const task = await svc.getTask('default-list', 'abc')
    expect(task).toBeDefined()
    expect(task!.status).toBe('completed')
  })

  it('should return null for unknown task', async () => {
    const svc = new TaskService()
    const task = await svc.getTask('nonexistent')
    expect(task).toBeNull()
  })

  it('should skip invalid JSON files gracefully', async () => {
    const tasksDir = path.join(tmpDir, 'tasks', 'default-list')
    await fs.mkdir(tasksDir, { recursive: true })
    await fs.writeFile(path.join(tasksDir, 'bad.json'), 'not json {{{')

    const svc = new TaskService()
    const tasks = await svc.listTasks()
    expect(tasks).toEqual([])
  })
})

// ============================================================================
// Tasks API integration tests
// ============================================================================

describe('Tasks API', () => {
  let server: any
  let baseUrl: string
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-tasks-api-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true })

    const { startServer } = await import('../../server/index.js')
    server = startServer(0, '127.0.0.1')
    baseUrl = `http://127.0.0.1:${server.port}`
  })

  afterEach(async () => {
    server?.stop(true)
    const { stopServerRuntimeForShutdown } = await import('../../server/index.js')
    await stopServerRuntimeForShutdown()
    await rmWithRetry(tmpDir)
    delete process.env.CLAUDE_CONFIG_DIR
  })

  it('should return empty tasks list', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`)
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.tasks).toEqual([])
  })

  it('should return tasks when files exist', async () => {
    const tasksDir = path.join(tmpDir, 'tasks', 'default-list')
    await fs.mkdir(tasksDir, { recursive: true })
    await fs.writeFile(path.join(tasksDir, 'test.json'), JSON.stringify(taskFixture({
      id: 'test',
      status: 'completed',
      subject: 'test-task',
    })))

    const res = await fetch(`${baseUrl}/api/tasks`)
    const data = await res.json()
    expect(data.tasks.length).toBe(1)
    expect(data.tasks[0].subject).toBe('test-task')
  })

  it('should return 404 for unknown task', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/lists/default-list/nonexistent`)
    expect(res.status).toBe(404)
  })

  it('should reset a persisted task list', async () => {
    const taskListDir = path.join(tmpDir, 'tasks', 'desktop-session-1')
    await fs.mkdir(taskListDir, { recursive: true })
    await fs.writeFile(path.join(taskListDir, '1.json'), JSON.stringify(taskFixture({
      id: '1',
      subject: 'First task',
      status: 'completed',
    })))
    await fs.writeFile(path.join(taskListDir, '2.json'), JSON.stringify(taskFixture({
      id: '2',
      subject: 'Second task',
      status: 'completed',
    })))

    const before = await fetch(`${baseUrl}/api/tasks/lists/desktop-session-1`)
    expect(before.status).toBe(200)
    expect((await before.json()).tasks).toHaveLength(2)

    const reset = await fetch(`${baseUrl}/api/tasks/lists/desktop-session-1/reset`, {
      method: 'POST',
    })
    expect(reset.status).toBe(200)
    expect(await reset.json()).toEqual({ ok: true })

    const after = await fetch(`${baseUrl}/api/tasks/lists/desktop-session-1`)
    expect(after.status).toBe(200)
    expect((await after.json()).tasks).toEqual([])
  })

  it('should reject non-GET methods', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, { method: 'POST' })
    expect(res.status).toBe(405)
  })
})
