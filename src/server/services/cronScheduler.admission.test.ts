import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import * as os from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { setProjectDirectoryWorkerFactoryForTests } from '../../services/mcp/projectDirectoryIo.js'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { migrationMaintenance } from '../migrationMaintenance.js'
import { CronService, type CronTask } from './cronService.js'
import { CronScheduler, type TaskRun } from './cronScheduler.js'
import { resetScheduledRunReadModelForTests } from './localIndex/scheduledRunReadModel.js'
import { configureScheduledTaskHost } from './scheduledTaskHost.js'
import { sessionService } from './sessionService.js'
import * as handler from '../ws/handler.js'
import * as catalog from './sessionModelCatalog.js'
import { emitSessionTurnEvent } from './sessionTurnEvents.js'
import { DesktopUiPreferencesService } from './desktopUiPreferencesService.js'

let root: string
let savedEnv: NodeJS.ProcessEnv
const restores: Array<() => void> = []

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(os.tmpdir(), 'cron-admission-')))
  savedEnv = { ...process.env }
  const environment = createSandboxedTestEnvironment(root, {
    CC_HAHA_LOCAL_INDEX: 'off',
    CLAUDE_CLI_PATH: join(root, 'fixture-cli.ts'),
  })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, environment)
  const home = spyOn(os, 'homedir').mockReturnValue(root)
  const fetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Forbidden network call'))
  restores.push(() => home.mockRestore(), () => fetch.mockRestore())
})

afterEach(async () => {
  await migrationMaintenance.drain()
  for (const restore of restores.splice(0).reverse()) restore()
  await setProjectDirectoryWorkerFactoryForTests()
  await resetScheduledRunReadModelForTests()
  migrationMaintenance.resetForTests()
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  await rm(root, { recursive: true, force: true })
})

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function until(check: () => boolean) {
  const deadline = performance.now() + 4_000
  while (!check() && performance.now() < deadline) await Bun.sleep(5)
  expect(check()).toBe(true)
}

async function tasks(cron: CronService, recurring: boolean, kind?: 'new-session' | 'session', prefix = 'project') {
  const created: CronTask[] = []
  for (let i = 0; i < 24; i++) {
    const folderPath = join(root, `${prefix}-${i}`)
    await mkdir(folderPath)
    created.push(await cron.createTask({
      cron: '* * * * *', prompt: 'fixture only', recurring, folderPath,
      notification: { enabled: false, channels: [] },
      ...(kind ? {
        execution: kind === 'session' ? { kind, targetSessionId: `target-${i}` } : { kind },
        sourceSessionId: kind === 'new-session' ? 'fixture-source' : undefined,
      } : {}),
    }))
  }
  return created
}

function stubCli(scheduler: CronScheduler, completion = deferred<number>()) {
  const launched: string[] = []
  const environment = spyOn(scheduler as any, 'buildTaskChildEnv').mockResolvedValue({ HOME: root, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR })
  const spawn = spyOn(Bun, 'spawn').mockImplementation(((_args: unknown, options: { cwd: string }) => {
    launched.push(options.cwd)
    return {
      pid: -1,
      stdin: { write() {}, end() {} },
      stdout: new ReadableStream({ async start(controller) {
        await completion.promise
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'result', is_error: false, result: 'fixture only' }) + '\n'))
        controller.close()
      } }),
      stderr: new ReadableStream({ start(controller) { controller.close() } }),
      exited: completion.promise,
      kill() { completion.resolve(0) },
    }
  }) as any)
  restores.push(() => environment.mockRestore(), () => spawn.mockRestore())
  return { launched, completion }
}

function observeStandalone(scheduler: CronScheduler) {
  const pending: Promise<TaskRun>[] = []
  const finished: TaskRun[] = []
  const execute = scheduler.executeTask.bind(scheduler)
  const spy = spyOn(scheduler, 'executeTask').mockImplementation((...args) => {
    const result = execute(...args)
    pending.push(result)
    void result.then(run => finished.push(run), () => {})
    return result
  })
  restores.push(() => spy.mockRestore())
  return { pending, finished }
}

async function holdDirectoryWorkers() {
  const gate = new Int32Array(new SharedArrayBuffer(8))
  await setProjectDirectoryWorkerFactoryForTests(script => new Worker(`
    const { workerData } = require('node:worker_threads');
    const nativeFs = require('node:fs');
    const gate = new Int32Array(workerData.gate);
    const original = nativeFs.statSync;
    nativeFs.statSync = function(path, ...args) {
      Atomics.store(gate, 0, 1);
      Atomics.wait(gate, 1, 0);
      return original.call(nativeFs, path, ...args);
    };
    ${script}
  `, { eval: true, workerData: { gate: gate.buffer } }))
  return {
    entered: () => !!Atomics.load(gate, 0),
    release: () => { Atomics.store(gate, 1, 1); Atomics.notify(gate, 1) },
  }
}

test.each([true, false])('one tick admits all valid standalone tasks while their CLI remains concurrent (recurring=%s)', async recurring => {
  const cron = new CronService()
  const scheduler = new CronScheduler(cron)
  const created = await tasks(cron, recurring)
  const cli = stubCli(scheduler)
  const observed = observeStandalone(scheduler)
  const now = new Date()
  try {
    await scheduler.tick(now)
    expect(observed.pending).toHaveLength(created.length)
    expect(scheduler.hasActiveWork()).toBe(true)
    await scheduler.tick(now)
    expect(observed.pending).toHaveLength(created.length)
    await until(() => cli.launched.length + observed.finished.length === created.length)
    // Every CLI starts before any CLI is released: only preparation may queue.
    expect(cli.launched.toSorted()).toEqual(created.map(task => task.folderPath!).toSorted())
    expect(observed.finished).toHaveLength(0)
    cli.completion.resolve(0)
    expect((await Promise.all(observed.pending)).every(run => run.status === 'completed')).toBe(true)
    expect((await cron.listTasks()).every(task => recurring ? task.enabled !== false : task.enabled === false)).toBe(true)
    await scheduler.tick(now)
    // A separate scheduler must honor the persisted lastFiredAt as well.
    await new CronScheduler(cron).tick(now)
    expect(cli.launched).toHaveLength(created.length)
    await until(() => !scheduler.hasActiveWork())
    expect(await scheduler.getRecentRuns(100)).toHaveLength(created.length)
  } finally {
    cli.completion.resolve(0)
    await Promise.allSettled(observed.pending)
    scheduler.stop()
  }
})

function installSessionHost(blockProcesses = true) {
  const blockSpawn = blockProcesses ? spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('Forbidden process spawn') }) : undefined
  const state = spyOn(handler, 'getSessionTurnState').mockReturnValue('idle')
  const runtime = spyOn(handler, 'getCollaborationRuntime').mockResolvedValue({ providerId: 'fixture', modelId: 'fixture-model' })
  const validate = spyOn(catalog, 'validateSessionRuntime').mockImplementation(async value => value)
  const resolve = spyOn(catalog, 'resolveSessionRuntime').mockResolvedValue({ providerId: 'fixture', modelId: 'fixture-model' } as any)
  const source = spyOn(sessionService, 'getSessionLaunchInfo').mockImplementation(async () => ({ workDir: root, permissionMode: 'default' }) as any)
  const summary = spyOn(sessionService, 'getSessionSummary').mockResolvedValue({ id: 'fixture-target' } as any)
  const directory = spyOn(sessionService, 'getSessionWorkDir').mockResolvedValue(root)
  const deliveries: Array<() => void> = []
  const send = spyOn(handler, 'submitScheduledTaskTurn').mockImplementation(async (id, _content, options) => {
    emitSessionTurnEvent({ type: 'output', sessionId: id, message: { type: 'system', subtype: 'session_message_receipt', message_id: options.messageId, status: 'consumed' } })
    deliveries.push(() => emitSessionTurnEvent({ type: 'output', sessionId: id, message: { type: 'result', is_error: false, result: 'fixture only' } }))
    return { status: 'queued' }
  })
  restores.push(...[state, runtime, validate, resolve, source, summary, directory, send].map(spy => () => spy.mockRestore()))
  restores.push(configureScheduledTaskHost('127.0.0.1', 1))
  if (blockSpawn) restores.push(() => blockSpawn.mockRestore())
  return { deliveries, blockSpawn }
}

test.each(['new-session', 'session'] as const)('one tick admits all %s tasks through the real session host without serializing turns', async kind => {
  const cron = new CronService()
  const scheduler = new CronScheduler(cron)
  const created = await tasks(cron, true, kind)
  const { deliveries, blockSpawn } = installSessionHost()
  const workers = kind === 'new-session' ? await holdDirectoryWorkers() : undefined
  const create = spyOn(sessionService, 'createSession')
  restores.push(() => create.mockRestore())
  try {
    await scheduler.tick(new Date())
    expect(scheduler.hasActiveWork()).toBe(true)
    if (workers) {
      await until(workers.entered)
      // Give receipt/history I/O time to expose every competing preparation.
      await Bun.sleep(150)
      expect(create).toHaveBeenCalledTimes(1)
      workers.release()
    }
    await until(() => deliveries.length === created.length || !scheduler.hasActiveWork())
    expect(deliveries).toHaveLength(created.length)
    expect((await scheduler.getRecentRuns(100)).every(run => run.status === 'running')).toBe(true)
    deliveries.forEach(deliver => deliver())
    await migrationMaintenance.drain()
    const runs = await scheduler.getRecentRuns(100)
    expect(runs).toHaveLength(created.length)
    expect(runs.every(run => run.status === 'completed' && !!run.sessionId)).toBe(true)
    expect(blockSpawn).not.toHaveBeenCalled()
    expect(scheduler.hasActiveWork()).toBe(false)
  } finally {
    workers?.release()
    deliveries.forEach(deliver => deliver())
    scheduler.stop()
    await migrationMaintenance.drain()
  }
})

test('standalone and new-session preparations share admission across scheduler instances', async () => {
  const cron = new CronService()
  const standalone = new CronScheduler(cron)
  const sessions = new CronScheduler(cron)
  const standaloneTasks = await tasks(cron, true)
  const sessionTasks = await tasks(cron, true, 'new-session', 'session-project')
  const { deliveries } = installSessionHost(false)
  const cli = stubCli(standalone)
  const pending = standaloneTasks.map(task => standalone.executeTask(task))
  const sessionPending = sessionTasks.map(task => sessions.executeTask(task))
  try {
    await until(() => cli.launched.length === standaloneTasks.length && deliveries.length === sessionTasks.length)
    expect(standalone.hasActiveWork()).toBe(true)
    expect(sessions.hasActiveWork()).toBe(true)
    cli.completion.resolve(0)
    deliveries.forEach(deliver => deliver())
    const runs = await Promise.all([...pending, ...sessionPending])
    expect(runs.every(run => run.status === 'completed')).toBe(true)
    await migrationMaintenance.drain()
    expect(await standalone.getRecentRuns(100)).toHaveLength(48)
  } finally {
    cli.completion.resolve(0)
    deliveries.forEach(deliver => deliver())
    standalone.stop()
    sessions.stop()
    await Promise.allSettled([...pending, ...sessionPending])
  }
})

test.each(['stop', 'migration'] as const)('%s revokes queued new-session creation and cannot deliver a late turn', async mode => {
  const cron = new CronService()
  const scheduler = new CronScheduler(cron)
  const created = await tasks(cron, false, 'new-session')
  const { deliveries, blockSpawn } = installSessionHost()
  const workers = await holdDirectoryWorkers()
  const create = spyOn(sessionService, 'createSession')
  restores.push(() => create.mockRestore())
  let stopped: Promise<void> | undefined
  try {
    await scheduler.tick(new Date())
    await until(workers.entered)
    expect(scheduler.hasActiveWork()).toBe(true)
    let drained = false
    if (mode === 'migration') {
      migrationMaintenance.begin()
      stopped = scheduler.stopAndWait().then(() => { drained = true })
    } else scheduler.stop()
    await Bun.sleep(20)
    expect(drained).toBe(false)
    expect(scheduler.hasActiveWork()).toBe(true)
    workers.release()
    await stopped
    await migrationMaintenance.drain()
    expect(create).toHaveBeenCalledTimes(1)
    expect(deliveries).toHaveLength(0)
    expect(blockSpawn).not.toHaveBeenCalled()
    const runs = await scheduler.getRecentRuns(100)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.status).not.toBe('running')
    const untouched = (await cron.listTasks()).filter(task => !task.lastFiredAt)
    expect(untouched).toHaveLength(created.length - 1)
    expect(untouched.every(task => task.enabled !== false)).toBe(true)
    expect(scheduler.hasActiveWork()).toBe(false)
  } finally {
    workers.release()
    scheduler.stop()
    await stopped
    await migrationMaintenance.drain()
  }
})

test.each(['stop', 'migration'] as const)('%s cancels queued standalone preparation and waits for admission bookkeeping', async mode => {
  const cron = new CronService()
  const scheduler = new CronScheduler(cron)
  const created = await tasks(cron, false)
  const cli = stubCli(scheduler)
  const gate = deferred()
  let entered = false
  const original = DesktopUiPreferencesService.prototype.getProjectDirectories
  const preferences = spyOn(DesktopUiPreferencesService.prototype, 'getProjectDirectories').mockImplementation(async function(workDir) {
    entered = true
    await gate.promise
    return original.call(this, workDir)
  })
  const create = spyOn((scheduler as any).sessionService, 'createSession')
  restores.push(() => preferences.mockRestore(), () => create.mockRestore())
  const pending = created.map(task => scheduler.executeTask(task, { createSession: true }))
  const results = Promise.allSettled(pending)
  let stopped: Promise<void> | undefined
  try {
    await until(() => entered)
    expect(scheduler.hasActiveWork()).toBe(true)
    let drained = false
    if (mode === 'migration') {
      migrationMaintenance.begin()
      stopped = scheduler.stopAndWait().then(() => { drained = true })
    } else scheduler.stop()
    await Bun.sleep(20)
    expect(scheduler.hasActiveWork()).toBe(true)
    expect(drained).toBe(false)
    gate.resolve()
    await stopped
    expect((await results).every(result => result.status === 'rejected')).toBe(true)
    await migrationMaintenance.drain()
    expect(scheduler.hasActiveWork()).toBe(false)
    expect(cli.launched).toHaveLength(0)
    expect(create).not.toHaveBeenCalled()
    expect((await cron.listTasks()).every(task => task.enabled !== false && !task.lastFiredAt)).toBe(true)
    expect(await scheduler.getRecentRuns()).toHaveLength(0)
  } finally {
    gate.resolve()
    cli.completion.resolve(0)
    await results
    await stopped
    scheduler.stop()
  }
})

test('stop while tick is loading tasks cannot enqueue later preparation', async () => {
  const cron = new CronService()
  const scheduler = new CronScheduler(cron)
  await tasks(cron, true)
  const gate = deferred()
  const original = cron.listTasks.bind(cron)
  const list = spyOn(cron, 'listTasks').mockImplementation(async () => { await gate.promise; return original() })
  restores.push(() => list.mockRestore())
  const cli = stubCli(scheduler)
  const tick = scheduler.tick(new Date())
  scheduler.stop()
  gate.resolve()
  await tick
  await migrationMaintenance.drain()
  expect(cli.launched).toHaveLength(0)
  expect(scheduler.hasActiveWork()).toBe(false)
})

test('a later minute cannot enqueue standalone tasks again while their preparation is pending', async () => {
  const cron = new CronService()
  const scheduler = new CronScheduler(cron)
  const created = await tasks(cron, true)
  const workers = await holdDirectoryWorkers()
  const cli = stubCli(scheduler)
  const observed = observeStandalone(scheduler)
  const now = new Date()
  try {
    await scheduler.tick(now)
    await until(workers.entered)
    await scheduler.tick(new Date(now.getTime() + 60_000))
    expect(observed.pending).toHaveLength(created.length)
    // A concurrent manual request also joins the reserved task.
    expect(scheduler.executeTask(created[0]!)).toBe(observed.pending[0])
    workers.release()
    await until(() => cli.launched.length === created.length)
    expect(cli.launched.toSorted()).toEqual(created.map(task => task.folderPath!).toSorted())
    cli.completion.resolve(0)
    expect((await Promise.all(observed.pending)).every(run => run.status === 'completed')).toBe(true)
  } finally {
    workers.release()
    cli.completion.resolve(0)
    scheduler.stop()
    await Promise.allSettled(observed.pending)
  }
})

test.each(['stop', 'migration'] as const)('%s after a running log is persisted finalizes without a late CLI launch', async mode => {
  const cron = new CronService()
  const scheduler = new CronScheduler(cron)
  const project = join(root, 'project')
  await mkdir(project)
  const task = await cron.createTask({ cron: '* * * * *', prompt: 'fixture only', recurring: false, folderPath: project })
  const cli = stubCli(scheduler)
  const gate = deferred()
  let entered = false
  const env = spyOn(scheduler as any, 'buildTaskChildEnv').mockImplementation(async () => {
    entered = true
    await gate.promise
    return { HOME: root }
  })
  restores.push(() => env.mockRestore())
  const pending = scheduler.executeTask(task)
  let stopped: Promise<void> | undefined
  try {
    await until(() => entered)
    expect((await scheduler.getTaskRuns(task.id))[0]?.status).toBe('running')
    let drained = false
    if (mode === 'migration') {
      migrationMaintenance.begin()
      stopped = scheduler.stopAndWait().then(() => { drained = true })
    } else scheduler.stop()
    await Bun.sleep(20)
    expect(drained).toBe(false)
    expect(scheduler.hasActiveWork()).toBe(true)
    gate.resolve()
    const run = await pending
    await stopped
    expect(run.status).toBe('failed')
    expect(run.error).toContain(mode === 'migration' ? 'migration' : 'stopped')
    expect((await scheduler.getTaskRuns(task.id))[0]).toEqual(run)
    expect((await cron.getTask(task.id))?.enabled).not.toBe(false)
    expect(cli.launched).toHaveLength(0)
    await migrationMaintenance.drain()
    expect(scheduler.hasActiveWork()).toBe(false)
  } finally {
    gate.resolve()
    cli.completion.resolve(0)
    await pending
    await stopped
    scheduler.stop()
  }
})
