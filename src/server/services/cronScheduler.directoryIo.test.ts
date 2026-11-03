import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as nativeFs from 'node:fs'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as os from 'node:os'
import { join, relative } from 'node:path'
import { Worker } from 'node:worker_threads'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { readProjectDirectory, setProjectDirectoryWorkerFactoryForTests } from '../../services/mcp/projectDirectoryIo.js'
import { handleSessionsApi } from '../api/sessions.js'
import { CronService } from './cronService.js'
import { CronScheduler } from './cronScheduler.js'
import { resetScheduledRunReadModelForTests } from './localIndex/scheduledRunReadModel.js'

let root: string
let savedEnv: NodeJS.ProcessEnv
const restores: Array<() => void> = []

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'cron-directory-io-')))
  const home = spyOn(os, 'homedir').mockReturnValue(root)
  restores.push(() => home.mockRestore())
  savedEnv = { ...process.env }
  const environment = createSandboxedTestEnvironment(root, {
    CC_HAHA_LOCAL_INDEX: 'off',
    CLAUDE_CLI_PATH: join(root, 'fixture-cli.ts'),
  })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, environment)
})

afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore()
  await setProjectDirectoryWorkerFactoryForTests()
  await resetScheduledRunReadModelForTests()
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  await rm(root, { recursive: true, force: true })
})

function stubCli(scheduler: CronScheduler) {
  const launched: string[] = []
  const environment = spyOn(scheduler as any, 'buildTaskChildEnv').mockResolvedValue({ HOME: root, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR })
  const spawn = spyOn(Bun, 'spawn').mockImplementation(((_args: unknown, options: { cwd: string }) => {
    launched.push(options.cwd)
    return {
      pid: -1,
      stdin: { write() {}, end() {} },
      stdout: new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fixture only' }) + '\n'))
        controller.close()
      } }),
      stderr: new ReadableStream({ start(controller) { controller.close() } }),
      exited: Promise.resolve(0),
      kill() {},
    }
  }) as any)
  restores.push(() => environment.mockRestore(), () => spawn.mockRestore())
  return { launched, spawn, environment }
}

test.each(['statSync', 'realpathSync'] as const)('cron %s directory admission stays off the API event loop and timeout cannot launch in HOME', async method => {
  const project = join(root, 'project')
  await mkdir(project)
  const gate = new Int32Array(new SharedArrayBuffer(8))
  const workers: Worker[] = []
  await setProjectDirectoryWorkerFactoryForTests(script => {
    const worker = new Worker(`
      const { workerData } = require('node:worker_threads');
      const nativeFs = require('node:fs');
      const gate = new Int32Array(workerData.gate);
      const original = nativeFs[workerData.method];
      nativeFs[workerData.method] = function(path, ...args) {
        if (path === workerData.project) {
          Atomics.store(gate, 0, 1);
          Atomics.wait(gate, 1, 0);
        }
        return original.call(nativeFs, path, ...args);
      };
      ${script}
    `, { eval: true, workerData: { gate: gate.buffer, method, project } })
    workers.push(worker)
    return worker
  }, 500)
  const original = nativeFs[method]
  let mainThreadCalls = 0
  const nativeRead = spyOn(nativeFs, method).mockImplementation(((target: unknown, ...args: unknown[]) => {
    if (target === project) mainThreadCalls++
    return (original as (...args: any[]) => any)(target, ...args)
  }) as any)
  restores.push(() => nativeRead.mockRestore())
  const cron = new CronService()
  const scheduler = new CronScheduler(cron)
  const cli = stubCli(scheduler)
  const createSession = spyOn((scheduler as any).sessionService, 'createSession')
  restores.push(() => createSession.mockRestore())
  const task = await cron.createTask({ cron: '* * * * *', prompt: 'fixture only', recurring: true, folderPath: project })
  const pending = scheduler.executeTask(task, { createSession: true })
  try {
    const deadline = performance.now() + 450
    while (!Atomics.load(gate, 0) && performance.now() < deadline) await Bun.sleep(5)
    expect(Atomics.load(gate, 0)).toBe(1)
    expect(mainThreadCalls).toBe(0)
    const url = new URL('http://localhost/api/sessions?limit=1')
    const response = await Promise.race([
      handleSessionsApi(new Request(url), url, ['api', 'sessions']),
      Bun.sleep(200).then(() => { throw new Error('Cron directory admission blocked session listing') }),
    ])
    expect(response.status).toBe(200)
    const run = await pending
    expect(run).toMatchObject({ status: 'failed', error: expect.stringContaining('timed out') })
    expect(run.sessionId).toBeUndefined()
    expect(createSession).not.toHaveBeenCalled()
    expect(cli.spawn).not.toHaveBeenCalled()
    expect(cli.environment).not.toHaveBeenCalled()
    expect((await cron.getTask(task.id))?.enabled).not.toBe(false)
  } finally {
    Atomics.store(gate, 1, 1)
    Atomics.notify(gate, 1)
    await pending
    await Promise.all(workers.map(worker => worker.terminate()))
  }
})

test('cron retains canonical cwd and only missing/non-directory paths fall back to the isolated home', async () => {
  const project = join(root, 'project')
  const alias = join(root, 'alias')
  const file = join(root, 'file')
  await mkdir(project)
  await symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(file, 'fixture only')
  const cron = new CronService()
  const scheduler = new CronScheduler(cron)
  const cli = stubCli(scheduler)
  for (const folderPath of [alias, relative(process.cwd(), project), join(root, 'missing'), file]) {
    const task = await cron.createTask({ cron: '* * * * *', prompt: 'fixture only', recurring: true, folderPath })
    expect((await scheduler.executeTask(task)).status).toBe('completed')
  }
  expect(cli.launched).toEqual([project, project, root, root])
})

test('an inaccessible cron directory fails without falling back or creating a session', async () => {
  const project = join(root, 'project')
  await mkdir(project)
  await setProjectDirectoryWorkerFactoryForTests(script => new Worker(`
    const { workerData } = require('node:worker_threads');
    const nativeFs = require('node:fs');
    const original = nativeFs.statSync;
    nativeFs.statSync = function(path, ...args) {
      if (path === workerData.project) throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
      return original.call(nativeFs, path, ...args);
    };
    ${script}
  `, { eval: true, workerData: { project } }))
  const cron = new CronService()
  const scheduler = new CronScheduler(cron)
  const cli = stubCli(scheduler)
  const createSession = spyOn((scheduler as any).sessionService, 'createSession')
  restores.push(() => createSession.mockRestore())
  const task = await cron.createTask({ cron: '* * * * *', prompt: 'fixture only', recurring: true, folderPath: project })
  expect(await scheduler.executeTask(task, { createSession: true })).toMatchObject({ status: 'failed', error: 'Project directory is unavailable' })
  expect(createSession).not.toHaveBeenCalled()
  expect(cli.spawn).not.toHaveBeenCalled()
})

test('a full directory worker queue cannot make cron fall back to HOME', async () => {
  const project = join(root, 'project')
  await mkdir(project)
  const gate = new Int32Array(new SharedArrayBuffer(4))
  const workers: Worker[] = []
  await setProjectDirectoryWorkerFactoryForTests(script => {
    const worker = new Worker(`
      const { workerData } = require('node:worker_threads');
      const nativeFs = require('node:fs');
      const gate = new Int32Array(workerData.gate);
      const original = nativeFs.statSync;
      nativeFs.statSync = function(path, ...args) {
        if (path === workerData.project) Atomics.wait(gate, 0, 0);
        return original.call(nativeFs, path, ...args);
      };
      ${script}
    `, { eval: true, workerData: { gate: gate.buffer, project } })
    workers.push(worker)
    return worker
  }, 1_000)
  const cron = new CronService()
  const scheduler = new CronScheduler(cron)
  const cli = stubCli(scheduler)
  const task = await cron.createTask({ cron: '* * * * *', prompt: 'fixture only', recurring: true, folderPath: project })
  const pending = Array.from({ length: 18 }, () => readProjectDirectory({ kind: 'identity', path: project }).catch(error => error))
  try {
    expect(await scheduler.executeTask(task, { createSession: true })).toMatchObject({ status: 'failed', error: expect.stringContaining('busy') })
    expect(cli.spawn).not.toHaveBeenCalled()
    expect(cli.environment).not.toHaveBeenCalled()
  } finally {
    Atomics.store(gate, 0, 1)
    Atomics.notify(gate, 0)
    await Promise.all(pending)
    await Promise.all(workers.map(worker => worker.terminate()))
  }
})

test('manual cron session creation cannot swallow a later directory timeout and launch a CLI', async () => {
  const project = join(root, 'project')
  await mkdir(project)
  const gate = new Int32Array(new SharedArrayBuffer(12))
  const workers: Worker[] = []
  await setProjectDirectoryWorkerFactoryForTests(script => {
    const worker = new Worker(`
      const { workerData } = require('node:worker_threads');
      const nativeFs = require('node:fs');
      const gate = new Int32Array(workerData.gate);
      const original = nativeFs.statSync;
      nativeFs.statSync = function(path, ...args) {
        if (path === workerData.project && Atomics.load(gate, 0)) {
          Atomics.store(gate, 1, 1);
          Atomics.wait(gate, 2, 0);
        }
        return original.call(nativeFs, path, ...args);
      };
      ${script}
    `, { eval: true, workerData: { gate: gate.buffer, project } })
    workers.push(worker)
    return worker
  }, 200)
  const cron = new CronService()
  const scheduler = new CronScheduler(cron)
  const cli = stubCli(scheduler)
  const service = (scheduler as any).sessionService
  const original = service.createSession.bind(service)
  const create = spyOn(service, 'createSession').mockImplementation((...args: unknown[]) => {
    Atomics.store(gate, 0, 1)
    return original(...args)
  })
  restores.push(() => create.mockRestore())
  const task = await cron.createTask({ cron: '* * * * *', prompt: 'fixture only', recurring: true, folderPath: project })
  const pending = scheduler.executeTask(task, { createSession: true })
  try {
    const run = await pending
    expect(Atomics.load(gate, 1)).toBe(1)
    expect(run).toMatchObject({ status: 'failed', error: expect.stringContaining('timed out') })
    expect(run.sessionId).toBeUndefined()
    expect(cli.spawn).not.toHaveBeenCalled()
    expect(cli.environment).not.toHaveBeenCalled()
    Atomics.store(gate, 2, 1)
    Atomics.notify(gate, 2)
    await Promise.all(workers.map(worker => worker.terminate()))
    expect(cli.spawn).not.toHaveBeenCalled()
  } finally {
    Atomics.store(gate, 2, 1)
    Atomics.notify(gate, 2)
    await pending
    await Promise.all(workers.map(worker => worker.terminate()))
  }
})
