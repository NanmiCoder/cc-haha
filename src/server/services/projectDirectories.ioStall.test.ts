import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { handleDesktopUiApi } from '../api/desktop-ui.js'
import { handleSessionsApi } from '../api/sessions.js'
import { getFsImplementation, setFsImplementation } from '../../utils/fsOperations.js'
import { setProjectDirectoryWorkerFactoryForTests } from '../../services/mcp/projectDirectoryIo.js'
import { DesktopUiPreferencesService } from './desktopUiPreferencesService.js'

const originalFs = getFsImplementation()
const fixtures: string[] = []
afterEach(async () => {
  setFsImplementation(originalFs)
  await setProjectDirectoryWorkerFactoryForTests()
  for (const fixture of fixtures.splice(0)) await rm(fixture, { recursive: true, force: true })
})

async function directoryRequest(project: string, additionalDirectories?: string[]) {
  const url = new URL('http://localhost/api/desktop-ui/preferences/project-directories')
  url.searchParams.set('workDir', project)
  const req = additionalDirectories ? new Request(url, { method: 'PUT', body: JSON.stringify({ workDir: project, additionalDirectories }) }) : new Request(url)
  return handleDesktopUiApi(req, url, url.pathname.split('/').filter(Boolean))
}

test.each([
  ['stat', 'preferences'], ['realpath', 'preferences'], ['access', 'preferences'],
  ['gitStat', 'preferences'], ['gitRead', 'preferences'], ['cliStat', 'preferences'],
  ['stat', 'session'], ['gitRead', 'repository'],
])(
  'a blocked %s in %s stays off the API event loop and never changes saved state', async (stage, surface) => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'directory-io-gate-')))
    fixtures.push(fixture)
    const project = join(fixture, 'project')
    const extra = join(fixture, 'extra')
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(extra)
    const oldConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(fixture, 'config')
    const gate = new Int32Array(new SharedArrayBuffer(8))
    const workers: Worker[] = []
    try {
      const service = new DesktopUiPreferencesService()
      await service.updateProjectDirectories({ workDir: project, additionalDirectories: [extra] })
      const preferencesFile = join(process.env.CLAUDE_CONFIG_DIR, 'cc-haha', 'desktop-ui.json')
      const before = await readFile(preferencesFile, 'utf8')
      await setProjectDirectoryWorkerFactoryForTests(script => {
        const worker = new Worker(`
          const { workerData } = require('node:worker_threads');
          const nativeFs = require('node:fs');
          const gate = new Int32Array(workerData.gate);
          const gitPath = require('node:path').join(workerData.project, '.git');
          for (const method of ['statSync', 'realpathSync', 'accessSync', 'readFileSync']) {
            const original = nativeFs[method];
            nativeFs[method] = function(path, ...args) {
              const stage = workerData.stage;
              const block = stage === 'stat' && method === 'statSync' && path === workerData.project ||
                stage === 'realpath' && method === 'realpathSync' && path === workerData.project ||
                stage === 'access' && method === 'accessSync' && path === workerData.project ||
                stage === 'gitStat' && method === 'statSync' && path === gitPath ||
                stage === 'gitRead' && method === 'readFileSync' && path === gitPath ||
                stage === 'cliStat' && method === 'statSync' && args[0]?.bigint;
              if (block) { Atomics.store(gate, 0, 1); Atomics.wait(gate, 1, 0); }
              return original.call(nativeFs, path, ...args);
            };
          }
          ${script}
        `, { eval: true, workerData: { gate: gate.buffer, stage, project } })
        workers.push(worker)
        return worker
      }, 750)
      let directorySettled = false
      const targetUrl = new URL(surface === 'repository' ? 'http://localhost/api/sessions/repository-context' : 'http://localhost/api/sessions')
      targetUrl.searchParams.set('workDir', project)
      const pending = (surface === 'preferences'
        ? directoryRequest(project, stage === 'cliStat' ? [extra] : undefined)
        : handleSessionsApi(surface === 'session'
          ? new Request(targetUrl, { method: 'POST', body: JSON.stringify({ workDir: project }) })
          : new Request(targetUrl), targetUrl, targetUrl.pathname.split('/').filter(Boolean))
      ).then(response => { directorySettled = true; return response })
      const enteredDeadline = performance.now() + 700
      while (!Atomics.load(gate, 0) && !directorySettled && performance.now() < enteredDeadline) await Bun.sleep(5)
      expect(Atomics.load(gate, 0)).toBe(1)
      const url = new URL('http://localhost/api/sessions?limit=1')
      const sessions = await Promise.race([
        handleSessionsApi(new Request(url), url, ['api', 'sessions']),
        Bun.sleep(300).then(() => { throw new Error('Independent session list was blocked by directory I/O') }),
      ])
      expect(sessions.status).toBe(200)
      expect(directorySettled).toBe(false)
      const response = await pending
      expect(response.status).toBe(surface === 'repository' ? 200 : 400)
      const body = await response.json() as { error?: string; message?: string }
      expect(surface === 'repository' ? body.error : body.message).toContain('timed out')
      expect(await readFile(preferencesFile, 'utf8')).toBe(before)
      if (surface === 'session') await expect(stat(join(process.env.CLAUDE_CONFIG_DIR, 'projects'))).rejects.toMatchObject({ code: 'ENOENT' })
      // Release the native stand-in only after the caller timed out. A late
      // result must neither retry nor overwrite the existing access scope.
      Atomics.store(gate, 1, 1)
      Atomics.notify(gate, 1)
      await Promise.all(workers.map(worker => worker.terminate()))
      expect(await readFile(preferencesFile, 'utf8')).toBe(before)
    } finally {
      Atomics.store(gate, 1, 1)
      Atomics.notify(gate, 1)
      await Promise.all(workers.map(worker => worker.terminate()))
      if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = oldConfig
    }
  }, 5_000,
)

test('a slow directory identity read does not delay an independent sessions response', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'directory-io-stall-'))
  fixtures.push(fixture)
  const project = join(fixture, 'project')
  await mkdir(project)
  setFsImplementation({ ...originalFs, statSync(target) {
    if (target === project) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)
    return originalFs.statSync(target)
  } })
  const url = new URL('http://localhost/api/desktop-ui/preferences/project-directories')
  url.searchParams.set('workDir', project)
  const started = performance.now()
  const pending = handleDesktopUiApi(new Request(url), url, url.pathname.split('/').filter(Boolean))
  const sessionsUrl = new URL('http://localhost/api/sessions?limit=1')
  const response = await handleSessionsApi(new Request(sessionsUrl), sessionsUrl, ['api', 'sessions'])
  const elapsed = performance.now() - started
  await pending
  expect(response.status).toBe(200)
  expect(elapsed).toBeLessThan(300)
})
