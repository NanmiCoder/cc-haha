import { expect, test } from 'bun:test'
import { CronScheduler } from './cronScheduler.js'
import { migrationMaintenance } from '../migrationMaintenance.js'
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spyOn } from 'bun:test'
import { CronService } from './cronService.js'
import { resetScheduledRunReadModelForTests } from './localIndex/scheduledRunReadModel.js'

test('migration uses the CLI control stream and waits for scheduled-task exit', async () => {
  const scheduler = new CronScheduler() as any
  let release!: (code: number) => void
  const exited = new Promise<number>(resolve => { release = resolve })
  const messages: any[] = []
  let ended = false
  scheduler.runningTasks.set('task', { proc: {
    stdin: { write: (line: string) => { messages.push(JSON.parse(line)) }, end: () => { ended = true } },
    exited,
    kill: () => { throw new Error('Force termination is unsafe before flush') },
  } })
  let completed = false
  const stopped = scheduler.stopAndWait().then(() => { completed = true })
  await Promise.resolve()
  expect(messages[0].request).toEqual({ subtype: 'end_session', reason: 'data_migration' })
  expect(ended).toBe(true)
  expect(completed).toBe(false)
  release(0)
  await stopped
})

test('maintenance rejects scheduled execution before any provider or filesystem work', async () => {
  migrationMaintenance.begin()
  try {
    await expect(new CronScheduler().executeTask({ id: 'blocked' } as any)).rejects.toThrow('Data migration')
  } finally { migrationMaintenance.resetForTests() }
})

test('a gracefully interrupted scheduled turn is saved as failed and remains available for its next schedule', async () => {
  const root = await mkdtemp(join(tmpdir(), 'migration-cron-process-'))
  const oldRoot = process.env.CLAUDE_CONFIG_DIR
  const oldCli = process.env.CLAUDE_CLI_PATH
  process.env.CLAUDE_CONFIG_DIR = root
  const cli = join(root, 'fixture.ts')
  const ready = join(root, 'ready')
  await writeFile(cli, `
    import { writeFileSync } from 'node:fs'
    writeFileSync(${JSON.stringify(ready)}, 'ready')
    let buffer = ''
    process.stdin.on('data', chunk => {
      buffer += chunk.toString()
      const lines = buffer.split('\\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (JSON.parse(line).request?.subtype !== 'end_session') continue
        process.stdout.write(JSON.stringify({ type: 'result', is_error: true }) + '\\n', () => process.exit(0))
      }
    })
    setInterval(() => {}, 1000)
  `)
  process.env.CLAUDE_CLI_PATH = cli
  const cron = new CronService()
  const scheduler = new CronScheduler(cron) as any
  // The script launcher runs `bun` by name, and Bun.spawn resolves it from the
  // child env's PATH: without it the fixture never starts.
  const childEnv = spyOn(scheduler, 'buildTaskChildEnv').mockResolvedValue({ CLAUDE_CONFIG_DIR: root, PATH: process.env.PATH ?? '' })
  try {
    const task = await cron.createTask({ name: 'Migration fixture', prompt: 'Fixture only', cron: '* * * * *', folderPath: root, enabled: true, recurring: false })
    const execution = scheduler.executeTask(task)
    let finished: unknown
    execution.then(run => { finished = run }, error => { finished = error })
    // Bun cold start on a loaded CI runner can take seconds; a run that ends
    // before the fixture is ready is reported as itself, not as a missing file.
    for (let attempt = 0; attempt < 2_000 && finished === undefined; attempt++) {
      if (await stat(ready).then(() => true, () => false)) break
      await Bun.sleep(5)
    }
    expect(finished).toBeUndefined()
    await stat(ready)
    await scheduler.stopAndWait()
    expect(await execution).toMatchObject({ status: 'failed', error: 'Interrupted for data migration', exitCode: 0 })
    expect((await cron.listTasks()).find(candidate => candidate.id === task.id)?.enabled).toBe(true)
  } finally {
    scheduler.stop()
    await resetScheduledRunReadModelForTests()
    childEnv.mockRestore()
    if (oldRoot === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = oldRoot
    if (oldCli === undefined) delete process.env.CLAUDE_CLI_PATH
    else process.env.CLAUDE_CLI_PATH = oldCli
    await rm(root, { recursive: true, force: true })
  }
})
