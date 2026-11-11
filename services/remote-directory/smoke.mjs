import assert from 'node:assert/strict'
import { createPrivateKey, sign } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(await readFile(resolve(here, '../../src/shared/__fixtures__/remote-identity-v2.json'), 'utf8'))
const privateKey = createPrivateKey({ key: Buffer.from(fixture.privateKeyPkcs8, 'base64url'), format: 'der', type: 'pkcs8' })
const sandbox = await mkdtemp(join(tmpdir(), 'cc-haha-directory-'))
let child
let logs = ''
const listener = createServer()
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
const endpoint = `http://127.0.0.1:${port}`
const envFile = join(sandbox, 'empty.env')
await writeFile(envFile, '')

async function start() {
  child = spawn(process.execPath, [join(here, 'node_modules/wrangler/bin/wrangler.js'), 'dev',
    '--config', join(here, 'wrangler.jsonc'), '--local', '--ip', '127.0.0.1', '--port', String(port),
    '--inspector-port', '0', '--persist-to', join(sandbox, 'state'), '--env-file', envFile,
    '--show-interactive-dev-session=false', '--log-level', 'error'], {
    cwd: sandbox,
    env: { PATH: process.env.PATH, HOME: sandbox, XDG_CONFIG_HOME: join(sandbox, 'config'),
      XDG_CACHE_HOME: join(sandbox, 'cache'), WRANGLER_HOME: join(sandbox, 'wrangler'),
      WRANGLER_SEND_METRICS: 'false', CI: 'true', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', data => { logs += data })
  child.stderr.on('data', data => { logs += data })
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`workerd exited: ${logs}`)
    try {
      const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(500) })
      if (response.ok) {
        assert.equal((await response.json()).protocolVersion, 2)
        return
      }
    } catch {}
    await delay(100)
  }
  throw new Error(`workerd did not become ready: ${logs}`)
}

async function stop() {
  if (!child || child.exitCode !== null) return
  const closed = new Promise(resolve => child.once('close', resolve))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  await closed
  clearTimeout(timer)
}

function announcement(sequence, origin) {
  const value = { version: 2, hostId: fixture.hostId, publicKey: fixture.publicKey, origin, sequence, expiresAt: Date.now() + 600_000 }
  const canonical = ['cc-haha-remote-v2', 'announce', value.hostId, origin, String(sequence), String(value.expiresAt)].join('\n')
  return { ...value, signature: sign('sha256', Buffer.from(canonical), privateKey).toString('base64url') }
}

async function publish(value) {
  return fetch(`${endpoint}/v1/hosts/${fixture.hostId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
}

try {
  await start()
  const initial = announcement(1, 'https://before-restart.example')
  assert.equal((await publish(initial)).status, 201)
  await stop()
  await start()
  assert.deepEqual(await (await fetch(`${endpoint}/v1/hosts/${fixture.hostId}`)).json(), initial)
  const next = announcement(2, 'https://after-restart.example')
  assert.equal((await publish(next)).status, 200)
  assert.equal((await publish(initial)).status, 409)
  assert.equal((await publish({ ...next, origin: 'https://forged.example' })).status, 400)
  assert.deepEqual(await (await fetch(`${endpoint}/v1/hosts/${fixture.hostId}`)).json(), next)
  console.log('PASS: local workerd HTTP publication, SQLite persistence across restart, address rotation, rollback and forgery rejection')
} catch (error) {
  console.error(logs)
  throw error
} finally {
  await stop()
  await rm(sandbox, { recursive: true, force: true })
}
