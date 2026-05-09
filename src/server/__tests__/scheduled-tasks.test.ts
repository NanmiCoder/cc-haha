/**
 * Unit tests for CronService, SearchService, and Scheduled Tasks API
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { CronService } from '../services/cronService.js'
import { SearchService } from '../services/searchService.js'

// ─── Test helpers ───────────────────────────────────────────────────────────

let tmpDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

async function createTmpDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `claude-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function cleanupTmpDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

// ─── CronService tests ─────────────────────────────────────────────────────

describe('CronService', () => {
  let service: CronService

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    service = new CronService()
  })

  afterEach(async () => {
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    await cleanupTmpDir(tmpDir)
  })

  it('should return empty list when no tasks file exists', async () => {
    const tasks = await service.listTasks()
    expect(tasks).toEqual([])
  })

  it('should create a task with generated id and createdAt', async () => {
    const task = await service.createTask({
      cron: '0 9 * * *',
      prompt: 'Review commits',
      recurring: true,
    })

    expect(task.id).toBeDefined()
    expect(task.id).toHaveLength(8) // 4 bytes hex
    expect(task.cron).toBe('0 9 * * *')
    expect(task.prompt).toBe('Review commits')
    expect(task.recurring).toBe(true)
    expect(task.createdAt).toBeGreaterThan(0)
  })

  it('should persist tasks to file', async () => {
    await service.createTask({ cron: '0 9 * * *', prompt: 'Task 1' })
    await service.createTask({ cron: '30 18 * * 5', prompt: 'Task 2' })

    const tasks = await service.listTasks()
    expect(tasks).toHaveLength(2)
    expect(tasks[0].prompt).toBe('Task 1')
    expect(tasks[1].prompt).toBe('Task 2')
  })

  it('should update an existing task', async () => {
    const created = await service.createTask({
      cron: '0 9 * * *',
      prompt: 'Original prompt',
    })

    const updated = await service.updateTask(created.id, {
      prompt: 'Updated prompt',
      recurring: true,
    })

    expect(updated.id).toBe(created.id)
    expect(updated.prompt).toBe('Updated prompt')
    expect(updated.recurring).toBe(true)
    expect(updated.createdAt).toBe(created.createdAt)
  })

  it('should throw when updating a non-existent task', async () => {
    await expect(
      service.updateTask('nonexistent', { prompt: 'x' }),
    ).rejects.toThrow('Task not found')
  })

  it('should delete a task', async () => {
    const created = await service.createTask({
      cron: '0 9 * * *',
      prompt: 'To delete',
    })

    await service.deleteTask(created.id)
    const tasks = await service.listTasks()
    expect(tasks).toHaveLength(0)
  })

  it('should throw when deleting a non-existent task', async () => {
    await expect(service.deleteTask('nonexistent')).rejects.toThrow(
      'Task not found',
    )
  })

  it('should generate unique IDs', async () => {
    const ids = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const task = await service.createTask({
        cron: '* * * * *',
        prompt: `Task ${i}`,
      })
      ids.add(task.id)
    }
    expect(ids.size).toBe(20)
  })

  it('should reject create when cron or prompt is missing', async () => {
    await expect(
      service.createTask({ cron: '', prompt: 'something' }),
    ).rejects.toThrow()

    await expect(
      service.createTask({ cron: '* * * * *', prompt: '' }),
    ).rejects.toThrow()
  })

  it('should retry the atomic write when rename returns ENOENT', async () => {
    const originalRename = fs.rename
    let renameCalls = 0

    const renameSpy = spyOn(fs, 'rename')
    renameSpy.mockImplementation(async (...args) => {
      renameCalls += 1

      if (renameCalls === 1) {
        const error = new Error(
          'ENOENT: no such file or directory, rename tmp -> scheduled_tasks.json',
        ) as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }

      return originalRename(...args)
    })

    try {
      const task = await service.createTask({
        cron: '0 9 * * *',
        prompt: 'Retry rename once',
      })

      const tasks = await service.listTasks()
      expect(task.id).toBeDefined()
      expect(tasks).toHaveLength(1)
      expect(tasks[0]?.prompt).toBe('Retry rename once')
      expect(renameCalls).toBe(2)
    } finally {
      renameSpy.mockRestore()
    }
  })
})

// ─── SearchService tests ────────────────────────────────────────────────────

describe('SearchService', () => {
  let service: SearchService
  let searchDir: string

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    service = new SearchService()

    // 创建搜索用的临时文件
    searchDir = path.join(tmpDir, 'workspace')
    await fs.mkdir(searchDir, { recursive: true })
    await fs.writeFile(
      path.join(searchDir, 'hello.txt'),
      'Hello World\nThis is a test\nAnother line\n',
    )
    await fs.writeFile(
      path.join(searchDir, 'code.ts'),
      'function greet() {\n  return "hello"\n}\n',
    )
  })

  afterEach(async () => {
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    await cleanupTmpDir(tmpDir)
  })

  it('should find matches in workspace files', async () => {
    const results = await service.searchWorkspace('Hello', { cwd: searchDir })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].text).toContain('Hello')
  })

  it('should return empty results when nothing matches', async () => {
    const results = await service.searchWorkspace('ZZZZNONEXISTENT', {
      cwd: searchDir,
    })
    expect(results).toHaveLength(0)
  })

  it('should respect maxResults limit', async () => {
    // 写入多行匹配
    const lines = Array.from({ length: 50 }, (_, i) => `match line ${i}`).join(
      '\n',
    )
    await fs.writeFile(path.join(searchDir, 'many.txt'), lines)

    const results = await service.searchWorkspace('match', {
      cwd: searchDir,
      maxResults: 5,
    })
    expect(results.length).toBeLessThanOrEqual(5)
  })

  it('should reject empty query', async () => {
    await expect(service.searchWorkspace('')).rejects.toThrow()
  })

  it('should return empty session results when no projects dir exists', async () => {
    const results = await service.searchSessions('test')
    expect(results).toEqual([])
  })
})

// ─── Scheduled Tasks API integration ────────────────────────────────────────

describe('Scheduled Tasks API', () => {
  // 直接测试 handler 函数，不需要启动完整服务器
  let handleScheduledTasksApi: (
    req: Request,
    url: URL,
    segments: string[],
  ) => Promise<Response>

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir

    // 动态导入以获取最新的环境变量
    const mod = await import('../api/scheduled-tasks.js')
    handleScheduledTasksApi = mod.handleScheduledTasksApi
  })

  afterEach(async () => {
    if (originalConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    await cleanupTmpDir(tmpDir)
  })

  it('should list empty tasks via GET', async () => {
    const req = new Request('http://localhost/api/scheduled-tasks', {
      method: 'GET',
    })
    const url = new URL(req.url)
    const resp = await handleScheduledTasksApi(req, url, [
      'api',
      'scheduled-tasks',
    ])
    const body = (await resp.json()) as { tasks: unknown[] }
    expect(resp.status).toBe(200)
    expect(body.tasks).toEqual([])
  })

  it('should create a task via POST', async () => {
    const req = new Request('http://localhost/api/scheduled-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cron: '0 9 * * *',
        prompt: 'Daily review',
        recurring: true,
        model: 'provider-fast',
        providerId: 'provider-a',
      }),
    })
    const url = new URL(req.url)
    const resp = await handleScheduledTasksApi(req, url, [
      'api',
      'scheduled-tasks',
    ])
    const body = (await resp.json()) as {
      task: { id: string; prompt: string; model?: string; providerId?: string }
    }
    expect(resp.status).toBe(201)
    expect(body.task.id).toBeDefined()
    expect(body.task.prompt).toBe('Daily review')
    expect(body.task.model).toBe('provider-fast')
    expect(body.task.providerId).toBe('provider-a')
  })

  it('should CRUD a full lifecycle', async () => {
    // Create
    const createReq = new Request('http://localhost/api/scheduled-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cron: '0 9 * * *', prompt: 'Test task' }),
    })
    const createResp = await handleScheduledTasksApi(
      createReq,
      new URL(createReq.url),
      ['api', 'scheduled-tasks'],
    )
    const { task } = (await createResp.json()) as {
      task: { id: string; prompt: string }
    }

    // Update
    const updateReq = new Request(
      `http://localhost/api/scheduled-tasks/${task.id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Updated task' }),
      },
    )
    const updateResp = await handleScheduledTasksApi(
      updateReq,
      new URL(updateReq.url),
      ['api', 'scheduled-tasks', task.id],
    )
    const updated = (await updateResp.json()) as {
      task: { id: string; prompt: string }
    }
    expect(updated.task.prompt).toBe('Updated task')

    // Delete
    const deleteReq = new Request(
      `http://localhost/api/scheduled-tasks/${task.id}`,
      { method: 'DELETE' },
    )
    const deleteResp = await handleScheduledTasksApi(
      deleteReq,
      new URL(deleteReq.url),
      ['api', 'scheduled-tasks', task.id],
    )
    expect(deleteResp.status).toBe(200)

    // Verify empty
    const listReq = new Request('http://localhost/api/scheduled-tasks', {
      method: 'GET',
    })
    const listResp = await handleScheduledTasksApi(
      listReq,
      new URL(listReq.url),
      ['api', 'scheduled-tasks'],
    )
    const list = (await listResp.json()) as { tasks: unknown[] }
    expect(list.tasks).toHaveLength(0)
  })
})
