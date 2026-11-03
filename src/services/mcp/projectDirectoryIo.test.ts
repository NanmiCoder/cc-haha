import { afterEach, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { readProjectDirectory, setProjectDirectoryWorkerFactoryForTests } from './projectDirectoryIo.js'
import { resolveProjectMcpDirectory } from './config.js'

const fixtures: string[] = []
afterEach(async () => {
  await setProjectDirectoryWorkerFactoryForTests()
  for (const fixture of fixtures.splice(0)) await rm(fixture, { recursive: true, force: true })
})

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'project-directory-worker-')))
  fixtures.push(directory)
  return directory
}

test('async MCP resolution rejects native realpath substitution to a different inode inside the worker', async () => {
  const root = await fixture()
  const requested = join(root, 'requested')
  const substitute = join(root, 'substitute')
  await mkdir(requested)
  await mkdir(substitute)
  await setProjectDirectoryWorkerFactoryForTests(script => new Worker(`
    const { workerData } = require('node:worker_threads');
    const nativeFs = require('node:fs');
    const original = nativeFs.realpathSync;
    nativeFs.realpathSync = path => path === workerData.requested ? workerData.substitute : original(path);
    ${script}
  `, { eval: true, workerData: { requested, substitute } }))
  await expect(resolveProjectMcpDirectory(requested)).rejects.toThrow('Project directory identity could not be verified')
  expect(await resolveProjectMcpDirectory(substitute)).toBe(substitute)
})

class StuckWorker extends EventEmitter {
  requests: Array<{ id: number }> = []
  terminations = 0
  private done!: (code: number) => void
  private termination = new Promise<number>(resolve => { this.done = resolve })
  postMessage(request: { id: number }) { this.requests.push(request) }
  ref() { return this }
  unref() { return this }
  terminate() { this.terminations++; return this.termination }
  finish() { this.emit('exit', 1); this.done(1) }
}

test('deadlines include queueing, late results are ignored and stuck threads cannot grow without bound', async () => {
  const workers: StuckWorker[] = []
  await setProjectDirectoryWorkerFactoryForTests(() => {
    const worker = new StuckWorker()
    workers.push(worker)
    return worker as unknown as Worker
  }, 40)
  const requests = Array.from({ length: 18 }, () => readProjectDirectory({ kind: 'identity', path: '/fixture' }).catch(error => error))
  try {
    await expect(readProjectDirectory({ kind: 'identity', path: '/overflow' })).rejects.toThrow('busy')
    expect(workers).toHaveLength(2)
    const failures = await Promise.all(requests)
    expect(failures.every(error => error.kind === 'timeout')).toBe(true)
    expect(workers.every(worker => worker.terminations === 1)).toBe(true)
    for (const worker of workers) worker.emit('message', { id: worker.requests[0]!.id, result: { directory: '/late' } })
    await expect(readProjectDirectory({ kind: 'identity', path: '/after-timeout' })).rejects.toThrow('timed out')
    expect(workers).toHaveLength(2)
    expect(workers.reduce((count, worker) => count + worker.requests.length, 0)).toBe(2)
  } finally {
    workers.forEach(worker => worker.finish())
    await Promise.resolve()
  }
})

test('inline directory worker resolves authenticated worktrees in a minified compiled executable without source assets', async () => {
  const root = await fixture()
  const main = join(root, 'main')
  const worktree = join(root, 'worktree')
  const entry = join(main, '.git', 'worktrees', 'fixture')
  await mkdir(entry, { recursive: true })
  await mkdir(worktree)
  await writeFile(join(worktree, '.git'), `gitdir: ${entry}\n`)
  await writeFile(join(entry, 'commondir'), '../..\n')
  await writeFile(join(entry, 'gitdir'), join(worktree, '.git') + '\n')
  const script = join(root, 'entry.ts')
  const executable = join(root, process.platform === 'win32' ? 'compiled-directory-worker.exe' : 'compiled-directory-worker')
  const module = fileURLToPath(new URL('./projectDirectoryIo.ts', import.meta.url))
  await writeFile(script, `
    import { readProjectDirectory } from ${JSON.stringify(module)}
    const result = await readProjectDirectory({ kind: 'project', path: process.argv[2] })
    console.log(JSON.stringify(result))
  `)
  const build = Bun.spawn([process.execPath, 'build', '--compile', '--minify', script, '--outfile', executable], { stdout: 'pipe', stderr: 'pipe' })
  const [buildCode, error] = await Promise.all([build.exited, new Response(build.stderr).text()])
  expect({ code: buildCode, error: buildCode ? error : '' }).toEqual({ code: 0, error: '' })
  if (process.platform === 'darwin') {
    for (const args of [['--remove-signature', executable], ['--sign', '-', '--force', executable]]) {
      const sign = Bun.spawn(['codesign', ...args], { stdout: 'pipe', stderr: 'pipe' })
      const [code, stderr] = await Promise.all([sign.exited, new Response(sign.stderr).text()])
      expect({ code, error: code ? stderr : '' }).toEqual({ code: 0, error: '' })
    }
  }
  await rm(script)
  const run = Bun.spawn([executable, worktree], { stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()])
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  expect(JSON.parse(stdout)).toEqual({ directory: worktree, root: main, gitRoot: worktree })
}, 30_000)
