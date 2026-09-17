import fs from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment'

if (process.platform !== 'win32') {
  console.log('SKIPPED: native context fixture targets Windows 10/11 only')
  process.exit(0)
}
const desktop = path.resolve(import.meta.dir, '..')
const root = path.resolve(desktop, '..')
const source = path.join(import.meta.dir, 'fixtures', 'managed-context-ui')
const output = path.resolve(process.argv[2] ?? path.join(root, 'artifacts', 'managed-context-native'))
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-context-native-'))
const capturePath = path.join(sandbox, 'sdk-inputs.json')
const resumePath = path.join(sandbox, 'private-mock-sdk-transcript.jsonl')
const captures: unknown[] = []
let server: ReturnType<typeof Bun.spawn> | undefined
let native: ReturnType<typeof Bun.spawn> | undefined
let mock: ReturnType<typeof Bun.serve> | undefined
const logs: number[] = []
let result = 1
const token = 'native-fixture-' + crypto.randomUUID()
const parentPath = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
const env = createSandboxedTestEnvironment(sandbox, {
  PATH: `${path.dirname(process.execPath)};${parentPath}`,
  CLAUDE_CLI_PATH: path.join(root, 'src', 'server', '__tests__', 'fixtures', 'mock-sdk-cli.ts'),
  CC_HAHA_LOCAL_ACCESS_TOKEN: token,
  CC_HAHA_DISABLE_TERMINAL_SHELL_ENV: '1', CC_HAHA_SKIP_DOTENV: '1',
  CLAUDE_CODE_EAGER_FLUSH: '1',
  MOCK_SDK_RESUME_TRANSCRIPT_PATH: resumePath,
})
delete env.ELECTRON_RUN_AS_NODE
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.createServer()
    socket.on('error', reject)
    socket.listen(0, '127.0.0.1', () => { const port = (socket.address() as net.AddressInfo).port; socket.close(() => resolve(port)) })
  })
}
try {
  await fs.mkdir(output, { recursive: true })
  await fs.mkdir(path.join(sandbox, 'work'), { recursive: true })
  await fs.writeFile(resumePath, '')
  await fs.writeFile(capturePath, '[]')
  mock = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== '/sdk-input' || request.method !== 'POST') return new Response('fixture only', { status: 404 })
    captures.push(await request.json())
    await fs.writeFile(capturePath, JSON.stringify(captures))
    return new Response('fixture accepted')
  } })
  env.MOCK_SDK_RESUME_UPSTREAM_URL = `http://127.0.0.1:${mock.port}/sdk-input`
  // Any incidental SDK-side HTTP is still constrained to the owned loopback fixture.
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.port}`
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const serverLog = openSync(path.join(output, 'server.log'), 'wx')
  logs.push(serverLog)
  server = Bun.spawn([process.execPath, '--no-env-file', 'run', 'src/server/index.ts', '--host', '127.0.0.1', '--port', String(port)], { cwd: root, env: { ...env, SERVER_PORT: String(port) }, stdout: serverLog, stderr: serverLog })
  const until = Date.now() + 60_000
  let healthy = false
  while (Date.now() < until) {
    try { healthy = (await fetch(url + '/health')).ok; if (healthy) break } catch { /* startup */ }
    await Bun.sleep(100)
  }
  if (!healthy) throw new Error('Isolated server startup failed')
  await build({ configFile: false, root: source, base: './', plugins: [react(), tailwindcss()], resolve: { alias: { '@': path.join(desktop, 'src') } }, build: { outDir: path.join(sandbox, 'ui'), emptyOutDir: false, target: 'es2021', chunkSizeWarningLimit: 3000 } })
  for (const file of ['main', 'preload']) {
    const built = await Bun.build({ entrypoints: [path.join(source, file + '.ts')], target: 'node', format: 'cjs', naming: 'context-' + file + '.cjs', outdir: sandbox, external: ['electron', 'node-pty'] })
    if (!built.success) throw new Error('Native context bundle failed: ' + file)
  }
  const nativeLog = openSync(path.join(output, 'electron.log'), 'wx')
  logs.push(nativeLog)
  native = Bun.spawn([path.join(desktop, 'node_modules', 'electron', 'dist', 'electron.exe'), path.join(sandbox, 'context-main.cjs')], { cwd: desktop, env: { ...env, CONTEXT_UI_SANDBOX: sandbox, CONTEXT_UI_OUTPUT: output, CONTEXT_UI_SERVER: url, NODE_PATH: path.join(desktop, 'node_modules') }, stdout: nativeLog, stderr: nativeLog })
  const timer = setTimeout(() => { if (native) Bun.spawn(['taskkill', '/PID', String(native.pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' }) }, 160_000)
  try { result = await native.exited } finally { clearTimeout(timer) }
  const record = JSON.parse(await fs.readFile(path.join(output, 'result.json'), 'utf8'))
  console.log(JSON.stringify(record))
  if (record.status !== 'passed') result = 1
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Native context fixture failed')
} finally {
  if (server) { server.kill(); await server.exited.catch(() => undefined) }
  mock?.stop(true)
  for (const log of logs) closeSync(log)
  // Inputs can contain fake passwords and live only in this owned temporary directory.
  await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 15, retryDelay: 250 })
}
process.exit(result)
