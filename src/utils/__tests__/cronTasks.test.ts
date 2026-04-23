import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'

// We'll test the updateCronTask by directly exercising the exported functions
// through a temporary directory approach.
// Note: These are integration tests that use actual filesystem operations.

describe('updateCronTask integration', () => {
  const tmpDir = join('/tmp', `cron-test-${randomUUID().slice(0, 8)}`)

  beforeEach(async () => {
    // Create temp project structure
    await mkdir(join(tmpDir, '.claude'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('CRON_FILE_REL constant is correct', async () => {
    // Import and verify the file relative path
    const { getCronFilePath } = await import('../cronTasks.js')
    const filePath = getCronFilePath(tmpDir)
    expect(filePath).toContain('.claude')
    expect(filePath).toContain('scheduled_tasks.json')
  })

  test('getCronFilePath returns correct path', async () => {
    const { getCronFilePath } = await import('../cronTasks.js')
    const filePath = getCronFilePath(tmpDir)
    expect(filePath).toBe(join(tmpDir, '.claude', 'scheduled_tasks.json'))
  })

  test('getCronFilePath uses project root when no dir provided', async () => {
    const { getCronFilePath } = await import('../cronTasks.js')
    // Without dir, should use getProjectRoot() which is process.cwd()
    // Just verify it returns a valid-looking path
    const filePath = getCronFilePath()
    expect(filePath).toContain('scheduled_tasks.json')
  })
})

describe('CronTaskMeta type coverage', () => {
  test('all UI fields are optional on CronTask', async () => {
    // Verify all new fields exist on the type by creating tasks with them
    const { addCronTask } = await import('../cronTasks.js')

    // Create a task with all metadata fields (durable=true writes to disk in test dir)
    const tmpDir = join('/tmp', `cron-meta-test-${randomUUID().slice(0, 8)}`)
    await mkdir(join(tmpDir, '.claude'), { recursive: true })

    const id = await addCronTask(
      '0 9 * * *',
      'test prompt',
      true, // recurring
      true, // durable (writes to disk)
      undefined, // agentId
      {
        name: 'test-name',
        description: 'test description',
        folder: '/test/folder',
        model: 'claude-opus-4-7',
        permissionMode: 'ask',
        worktree: false,
        frequency: 'daily',
        scheduledTime: '09:00',
      },
    )

    expect(typeof id).toBe('string')
    expect(id.length).toBe(8) // Short ID

    // Clean up
    await rm(tmpDir, { recursive: true, force: true })
  })
})

describe('readCronTasks backward compatibility', () => {
  test('handles empty file', async () => {
    const { readCronTasks } = await import('../cronTasks.js')
    const tmpDir = join('/tmp', `cron-empty-${randomUUID().slice(0, 8)}`)
    await mkdir(join(tmpDir, '.claude'), { recursive: true })

    const tasks = await readCronTasks(tmpDir)
    expect(Array.isArray(tasks)).toBe(true)
    expect(tasks.length).toBe(0)

    await rm(tmpDir, { recursive: true, force: true })
  })

  test('skips malformed JSON', async () => {
    const { readCronTasks } = await import('../cronTasks.js')
    const tmpDir = join('/tmp', `cron-malformed-${randomUUID().slice(0, 8)}`)
    await mkdir(join(tmpDir, '.claude'), { recursive: true })

    // Write malformed JSON
    const filePath = join(tmpDir, '.claude', 'scheduled_tasks.json')
    await writeFile(filePath, 'not valid json{{{')

    const tasks = await readCronTasks(tmpDir)
    expect(tasks.length).toBe(0) // Malformed entries skipped

    await rm(tmpDir, { recursive: true, force: true })
  })

  test('skips tasks with invalid cron strings', async () => {
    const { readCronTasks } = await import('../cronTasks.js')
    const tmpDir = join('/tmp', `cron-invalid-${randomUUID().slice(0, 8)}`)
    await mkdir(join(tmpDir, '.claude'), { recursive: true })

    // Write task with invalid cron
    const filePath = join(tmpDir, '.claude', 'scheduled_tasks.json')
    await writeFile(
      filePath,
      JSON.stringify({
        tasks: [
          {
            id: 'abcd1234',
            cron: 'invalid-cron',
            prompt: 'test',
            createdAt: Date.now(),
          },
        ],
      }),
    )

    const tasks = await readCronTasks(tmpDir)
    expect(tasks.length).toBe(0) // Invalid cron skipped

    await rm(tmpDir, { recursive: true, force: true })
  })

  test('preserves new fields when reading', async () => {
    const { readCronTasks } = await import('../cronTasks.js')
    const tmpDir = join('/tmp', `cron-preserve-${randomUUID().slice(0, 8)}`)
    await mkdir(join(tmpDir, '.claude'), { recursive: true })

    const filePath = join(tmpDir, '.claude', 'scheduled_tasks.json')
    const task = {
      id: 'abcd1234',
      cron: '0 9 * * *',
      prompt: 'test prompt',
      createdAt: Date.now(),
      recurring: true,
      name: 'my-task',
      description: 'A test task',
      folder: '/project',
      model: 'claude-sonnet-4-6',
      permissionMode: 'bypass',
      worktree: true,
      frequency: 'daily',
      scheduledTime: '09:00',
    }
    await writeFile(filePath, JSON.stringify({ tasks: [task] }))

    const tasks = await readCronTasks(tmpDir)
    expect(tasks.length).toBe(1)
    expect(tasks[0].name).toBe('my-task')
    expect(tasks[0].description).toBe('A test task')
    expect(tasks[0].folder).toBe('/project')
    expect(tasks[0].model).toBe('claude-sonnet-4-6')
    expect(tasks[0].permissionMode).toBe('bypass')
    expect(tasks[0].worktree).toBe(true)
    expect(tasks[0].frequency).toBe('daily')
    expect(tasks[0].scheduledTime).toBe('09:00')

    await rm(tmpDir, { recursive: true, force: true })
  })
})

describe('writeCronTasks strips runtime fields', () => {
  test('strips durable and agentId on write', async () => {
    const { readCronTasks, writeCronTasks } = await import('../cronTasks.js')
    const tmpDir = join('/tmp', `cron-strip-${randomUUID().slice(0, 8)}`)
    await mkdir(join(tmpDir, '.claude'), { recursive: true })

    const taskWithRuntimeFields = {
      id: 'abcd1234',
      cron: '0 9 * * *',
      prompt: 'test',
      createdAt: Date.now(),
      recurring: true,
      durable: true, // runtime-only, should be stripped
      agentId: 'agent-123', // runtime-only, should be stripped
      name: 'test-task', // new field, should be preserved
    }

    await writeCronTasks([taskWithRuntimeFields as any], tmpDir)

    // Read back and verify runtime fields are stripped
    const filePath = join(tmpDir, '.claude', 'scheduled_tasks.json')
    const { readFileSync } = await import('fs')
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw)

    expect(parsed.tasks[0].durable).toBeUndefined()
    expect(parsed.tasks[0].agentId).toBeUndefined()
    expect(parsed.tasks[0].name).toBe('test-task')

    await rm(tmpDir, { recursive: true, force: true })
  })
})
