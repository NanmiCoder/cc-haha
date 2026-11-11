import assert from 'node:assert/strict'
import { createPrivateKey, sign } from 'node:crypto'
import { join, resolve } from 'node:path'
import { createQualityGateSandbox } from '../../scripts/quality-gate/sandbox'
import fixture from '../../src/shared/__fixtures__/remote-identity-v2.json'
import { announcementBytes } from '../../src/shared/remoteIdentityProtocol'

const sandbox = createQualityGateSandbox({
  label: 'private-directory',
  seedProviders: false,
  // This deterministic lane needs only the runtime path, never proxy/provider
  // passthrough from the live-lane helper. Its write guard checks user metadata.
  source: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR },
})
const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
const port = probe.port!
await probe.stop(true)
const origin = `http://127.0.0.1:${port}`
const endpoint = `${origin}/v1/hosts/${fixture.hostId}`
const privateKey = createPrivateKey({ key: Buffer.from(fixture.privateKeyPkcs8, 'base64url'), format: 'der', type: 'pkcs8' })
const command = process.argv[2] ? [resolve(process.argv[2])] : [process.execPath, '--no-env-file', resolve(import.meta.dir, '../../src/remote/directory/selfHostedMain.ts')]
const env = {
  ...sandbox.env,
  CC_HAHA_DIRECTORY_STATE_DIR: join(sandbox.home, 'state'),
  CC_HAHA_DIRECTORY_ALLOWED_HOST_IDS: fixture.hostId,
  CC_HAHA_DIRECTORY_PORT: String(port),
}
let child: ReturnType<typeof Bun.spawn> | undefined
let logs = Promise.resolve('')

async function start() {
  child = Bun.spawn(command, { env, cwd: sandbox.home, stdout: 'pipe', stderr: 'pipe' })
  logs = Promise.all([new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text()]).then(parts => parts.join('\n'))
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Directory exited before readiness: ${await logs}`)
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) })
      if (response.ok) {
        assert.deepEqual(await response.json(), { service: 'cc-haha-remote-directory', protocolVersion: 2, access: 'private' })
        return
      }
    } catch {}
    await Bun.sleep(50)
  }
  throw new Error('Directory readiness timed out')
}

async function stop(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
  if (!child || child.exitCode !== null) return
  const current = child
  current.kill(signal)
  const timeout = setTimeout(() => current.kill('SIGKILL'), 5000)
  await current.exited
  clearTimeout(timeout)
}

function signed(sequence: number, address: string, expiresAt = Date.now() + 600_000) {
  const value = { version: 2, hostId: fixture.hostId, publicKey: fixture.publicKey, origin: address, sequence, expiresAt }
  return { ...value, signature: sign('sha256', announcementBytes(value), privateKey).toString('base64url') }
}

async function publish(value: unknown, hostId = fixture.hostId) {
  return fetch(`${origin}/v1/hosts/${hostId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
}

try {
  const denied = Bun.spawn(command, { cwd: sandbox.home, env: { ...env, CC_HAHA_DIRECTORY_ALLOWED_HOST_IDS: '' }, stdout: 'pipe', stderr: 'pipe' })
  assert.equal(await denied.exited, 1, 'An unconfigured private server must refuse startup')
  assert.match(await new Response(denied.stderr).text(), /allowed host ID/)
  await start()
  const initial = signed(20, 'https://before-restart.example', Date.now() + 2000)
  assert.equal((await publish(initial)).status, 201)
  assert.equal((await publish(initial)).status, 200)
  await stop('SIGKILL')
  await start()
  assert.deepEqual(await (await fetch(endpoint)).json(), initial, 'Last durable publication survives a hard process stop')
  await Bun.sleep(Math.max(0, initial.expiresAt - Date.now() + 25))
  assert.equal((await fetch(endpoint)).status, 410)
  await stop()
  await start()
  assert.equal((await publish(signed(19, 'https://rollback.example'))).status, 409, 'Expired tombstone survives process restart')
  const rotated = signed(21, 'https://after-restart.example')
  assert.equal((await publish(rotated)).status, 200)
  assert.equal((await publish({ ...rotated, origin: 'https://forged.example' })).status, 400)
  assert.equal((await publish(rotated, 'a'.repeat(64))).status, 403)
  assert.equal((await fetch(`${origin}/v1/hosts/${'a'.repeat(64)}`)).status, 403)
  assert.deepEqual(await (await fetch(endpoint)).json(), rotated)
} finally {
  try {
    await stop()
    await logs
    assert.deepEqual(sandbox.detectUserStateMutations(), [], 'Directory smoke must not mutate real user configuration')
  } finally { sandbox.cleanup() }
}
console.log('PASS: private allowlist, signed publication, hard-stop persistence, expired tombstone after restart, address rotation, rollback and forgery rejection; user-state write guard clean')
