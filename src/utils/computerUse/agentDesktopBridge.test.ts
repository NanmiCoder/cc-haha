import { afterEach, describe, expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAgentDesktopBackend, getAgentDesktopStatus, resolveAgentDesktopBinary } from './agentDesktopBridge.js'
import { runAgentDesktopProcess, type AgentDesktopProcessRequest } from './agentDesktopProcess.js'

const roots: string[] = []
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(extra: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-desktop-bridge-'))
  roots.push(root)
  const configRoot = path.join(root, 'config')
  const script = path.join(root, 'native-fixture.mjs')
  const log = path.join(root, 'calls.jsonl')
  const userHome = path.join(root, 'user-home')
  await mkdir(userHome)
  await writeFile(script, `
import fs from 'node:fs'
import path from 'node:path'
const argv = process.argv.slice(2)
let cursor = 0
let session = null
let agent = null
while (argv[cursor]?.startsWith('--')) {
  if (argv[cursor] === '--session') { session = argv[cursor + 1]; cursor += 2 }
  else if (argv[cursor] === '--agent-id') { agent = argv[cursor + 1]; cursor += 2 }
  else if (argv[cursor] === '--headed') cursor++
  else break
}
const command = argv[cursor++]
const args = argv.slice(cursor)
fs.appendFileSync(process.env.CCH_DESKTOP_TEST_LOG, JSON.stringify({ argv, command, args, session, agent, cwd: process.cwd(), home: process.env.AGENT_DESKTOP_HOME, inheritedSession: process.env.AGENT_DESKTOP_SESSION, lease: process.env.AGENT_DESKTOP_INTERACTION_LEASE_FD }) + '\\n')
function output(data, ok = true) { console.log(JSON.stringify({ version: '2.5', ok, command, ...(ok ? { data } : { error: data }) })) }
function image(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, Buffer.from('${png}', 'base64'))
  return { path: filename, format: 'png', width: 1, height: 1, scale_factor: 1 }
}
if (args.slice(0, args.indexOf('--') < 0 ? undefined : args.indexOf('--')).includes('--help')) { console.log('Usage: agent-desktop ' + command + ' [OPTIONS]'); process.exit(0) }
if (args.includes('--bogus')) { console.error('error: unexpected argument --bogus; Usage: agent-desktop ' + command); process.exit(2) }
if (command === 'session' && args[0] === 'start') {
  const name = args[args.indexOf('--name') + 1]
  const count = fs.readFileSync(process.env.CCH_DESKTOP_TEST_LOG, 'utf8').trim().split('\\n').map(line => JSON.parse(line)).filter(call => call.command === 'session' && call.args[0] === 'start').length
  output({ session_id: name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50) + '-' + count, name })
} else if (command === 'status') {
  const storageError = process.env.CCH_DESKTOP_TEST_STORAGE_ERROR
  const storage = args.includes('--check-session-storage') ? { session_storage: storageError ? { ready: false, message: storageError } : { ready: true } } : {}
  output({ platform: 'linux', session_id: session, supported_surfaces: JSON.parse(process.env.CCH_DESKTOP_TEST_SURFACES ?? '["window"]'), permissions: { accessibility: { state: 'granted' } }, ...storage })
} else if (command === 'cursor-overlay') {
  output({ cursor_overlay: { enabled: args[0] === 'enable' } })
} else if (command === 'screenshot') {
  output(image(args.at(-1)))
} else if (command === 'clipboard-get') {
  output({ ...image(args[args.indexOf('--out') + 1]), type: 'image' })
} else if (command === 'batch') {
  const entries = JSON.parse(args.find(value => value.startsWith('[')))
  output({ results: entries.map(entry => entry.command === 'click' && entry.args.ref_id === '@stale'
    ? { ok: false, command: entry.command, error: { code: 'STALE_REF', disposition: { delivery: 'delivery_uncertain', retry: 'unsafe' } } }
    : { ok: true, command: entry.command, data: entry.command === 'screenshot' ? image(entry.args.output_path) : { session: entry.session, args: entry.args } }) })
} else if (command === 'click' && args[0] === '@stale') {
  output({ code: 'STALE_REF', message: 'Fixture target changed after delivery', disposition: { delivery: 'delivered_unverified', retry: 'unsafe' }, details: { evidence: 'native-fixture' } }, false)
  process.exitCode = 1
} else if (command === 'wait' && args[0] === 'hang') {
  setInterval(() => {}, 1000)
} else if (command === 'trace' && args[0] === 'export') {
  const filename = args[args.indexOf('--out') + 1]
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, '<html>fixture trace</html>')
  output({ path: filename })
} else output({ args, session, agent })
`)
  const environment = {
    ...process.env,
    HOME: userHome,
    USERPROFILE: userHome,
    CLAUDE_CONFIG_DIR: configRoot,
    AGENT_DESKTOP_HOME: path.join(root, 'wrong-state'),
    AGENT_DESKTOP_SESSION: 'foreign-session',
    AGENT_DESKTOP_INTERACTION_LEASE_FD: '1234',
    CCH_DESKTOP_TEST_LOG: log,
    ...extra,
  }
  const requests: AgentDesktopProcessRequest[] = []
  const options = {
    platform: 'darwin' as const,
    binaryPath: process.execPath,
    configRoot,
    environment,
    getCwd: () => root,
    isDisabled: () => false,
    registerCleanup: () => () => {},
    getSessionId: () => 'product-session',
    getAgentId: () => 'main',
    runner: (request: AgentDesktopProcessRequest) => {
      requests.push(request)
      return runAgentDesktopProcess({ ...request, binaryPath: process.execPath, args: [script, ...request.args] })
    },
  }
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { root, options, requests, calls, userHome, configRoot }
}

function text(result: Awaited<ReturnType<ReturnType<typeof createAgentDesktopBackend>['execute']>>) {
  const content = result.content.find(block => block.type === 'text')
  return content && content.type === 'text' ? JSON.parse(content.text) : null
}

describe('native desktop binary resolution', () => {
  test('packaged installs only use unpacked packaged executables', () => {
    const candidates: string[] = []
    const expected = path.join('/app/resources/app.asar.unpacked', 'src-tauri', 'binaries', 'agent-desktop.exe')
    expect(resolveAgentDesktopBinary({
      platform: 'win32', appRoot: '/app/resources/app.asar', projectRoot: '/dev/source',
      exists: candidate => { candidates.push(candidate); return candidate.includes('app.asar.unpacked') },
    })).toBe(expected)
    expect(candidates).toEqual([expected])
    expect(resolveAgentDesktopBinary({ platform: 'linux', appRoot: '/app/app.asar', exists: () => false })).toBeNull()
  })

  test('finds explicit-target and host development builds with native names', () => {
    const expected = path.join('/source', 'native', 'agent-desktop', 'target', 'aarch64-unknown-linux-gnu', 'release', 'agent-desktop')
    expect(resolveAgentDesktopBinary({ platform: 'linux', arch: 'arm64', projectRoot: '/source', appRoot: '', exists: value => value === expected })).toBe(expected)
    const host = path.join('/source', 'native', 'agent-desktop', 'target', 'debug', 'agent-desktop.exe')
    expect(resolveAgentDesktopBinary({ platform: 'win32', projectRoot: '/source', appRoot: '', exists: value => value === host })).toBe(host)
  })
})

describe('native desktop CLI bridge', () => {
  test('owns state, shares native session, forwards literal argv and identifies concurrent agents', async () => {
    const f = await fixture({ AGENT_DESKTOP_CURSOR_IDLE_MS: '1' })
    const backend = createAgentDesktopBackend(f.options)
    const literal = 'literal $(touch NO_SHELL) `touch NO_SHELL` ; & | < >'
    const results = await Promise.all([
      backend.execute({ command: 'click', args: ['@ref', literal] }, undefined, 'writer'),
      backend.execute({ command: 'mouse-click', args: ['--xy', '10,20'], headed: true }, undefined, 'reviewer'),
    ])
    expect(results.every(result => !result.isError)).toBe(true)
    const calls = await f.calls()
    expect(calls.filter(call => call.command === 'session' && call.args[0] === 'start')).toHaveLength(1)
    const actions = calls.filter(call => ['click', 'mouse-click'].includes(call.command))
    expect(actions.map(call => call.agent).sort()).toEqual(['reviewer', 'writer'])
    expect(new Set(actions.map(call => call.session)).size).toBe(1)
    expect(actions.find(call => call.command === 'click').args).toEqual(['@ref', literal])
    expect(actions.find(call => call.command === 'mouse-click').argv).toContain('--headed')
    for (const call of calls) {
      expect(call.home).toBe(path.join(f.configRoot, '.runtime', 'agent-desktop'))
      expect(call.cwd).toBe(await realpath(f.root))
      expect(call.inheritedSession).toBeUndefined()
      expect(call.lease).toBeUndefined()
    }
    expect(await access(path.join(f.userHome, '.agent-desktop')).then(() => true, () => false)).toBe(false)
    expect(await access(path.join(f.root, 'NO_SHELL')).then(() => true, () => false)).toBe(false)
    expect(f.requests.every(request => request.env.AGENT_DESKTOP_CURSOR_IDLE_MS === undefined)).toBe(true)
    const style = calls.find(call => call.command === 'cursor-overlay')
    expect(style.args).toEqual(['enable', '--multi-agent', '--fill', '#0075F2', '--rim', '#FFFFFF', '--accent', '#4D9EFF', '--size', '1'])
  })

  test('preserves the native JSON error and unsafe delivery disposition without retry', async () => {
    const f = await fixture()
    const result = await createAgentDesktopBackend(f.options).execute({ command: 'click', args: ['@stale'] })
    expect(result.isError).toBe(true)
    expect(text(result).error).toEqual({ code: 'STALE_REF', message: 'Fixture target changed after delivery', disposition: { delivery: 'delivered_unverified', retry: 'unsafe' }, details: { evidence: 'native-fixture' } })
    expect((await f.calls()).filter(call => call.command === 'click')).toHaveLength(1)
  })

  test('literal option-looking text after -- remains part of the scoped command', async () => {
    const f = await fixture()
    const result = await createAgentDesktopBackend(f.options).execute({ command: 'type', args: ['@ref', '--', '--help'] })
    expect(result.isError).toBeUndefined()
    expect(text(result).data).toMatchObject({ session: 'cc-haha-product-session-1', args: ['@ref', '--', '--help'] })
    expect((await f.calls()).some(call => call.command === 'session')).toBe(true)
  })

  test('native argument errors expose the actual CLI usage and prove no dispatch', async () => {
    const f = await fixture()
    const result = await createAgentDesktopBackend(f.options).execute({ command: 'click', args: ['--bogus'] })
    expect(result.isError).toBe(true)
    expect(text(result).error).toMatchObject({ code: 'INVALID_ARGS', disposition: { delivery: 'not_delivered', retry: 'safe' } })
    expect(text(result).error.message).toContain('Usage: agent-desktop click')
    expect((await f.calls()).filter(call => call.command === 'click')).toHaveLength(1)
  })

  test('delivers screenshot and clipboard bytes as MCP images from host-owned artifacts', async () => {
    const f = await fixture()
    const backend = createAgentDesktopBackend(f.options)
    for (const command of ['screenshot', 'clipboard-get']) {
      const target = path.join(f.root, 'must-not-write.png')
      const result = await backend.execute({ command, args: command === 'screenshot' ? ['--app', 'Fixture', target] : ['--out', target] })
      expect(result.isError).toBeUndefined()
      expect(result.content).toContainEqual({ type: 'image', data: png, mimeType: 'image/png' })
      expect(text(result).data).toMatchObject({ image_delivered: true, width: 1, height: 1 })
      expect(text(result).data.data).toBeUndefined()
      expect(text(result).data.path).toBeUndefined()
      expect(await access(target).then(() => true, () => false)).toBe(false)
    }
  })

  test('batch retains all native commands, owns each namespace and delivers image entries', async () => {
    const f = await fixture()
    const result = await createAgentDesktopBackend(f.options).execute({ command: 'batch', args: [JSON.stringify([
      { command: 'screenshot', args: { output_path: path.join(f.root, 'foreign.png') } },
      { command: 'set-value', args: { ref_id: '@s:e1', value: 'hello' } },
    ]), '--stop-on-error'] })
    expect(result.isError).toBeUndefined()
    expect(result.content).toContainEqual({ type: 'image', data: png, mimeType: 'image/png' })
    const batch = (await f.calls()).find(call => call.command === 'batch')
    const entries = JSON.parse(batch.args[0])
    expect(entries.every((entry: { session: string }) => entry.session === batch.session)).toBe(true)
    expect(entries[0].args.output_path).toContain(path.join(f.configRoot, '.runtime', 'agent-desktop', 'artifacts'))
    expect(text(result).data.results[0].data.image_delivered).toBe(true)
  })

  test('partial batch failure retains successful images and each native delivery disposition', async () => {
    const f = await fixture()
    const result = await createAgentDesktopBackend(f.options).execute({ command: 'batch', args: [JSON.stringify([
      { command: 'screenshot' },
      { command: 'click', args: { ref_id: '@stale' } },
    ])] })
    expect(result.isError).toBeUndefined()
    expect(result.content).toContainEqual({ type: 'image', data: png, mimeType: 'image/png' })
    expect(text(result)).toMatchObject({ ok: true, command: 'batch' })
    expect(text(result).data.results[1]).toEqual({ ok: false, command: 'click', error: { code: 'STALE_REF', disposition: { delivery: 'delivery_uncertain', retry: 'unsafe' } } })
  })

  test('rejects managed global flags and cross-session batch commands before action dispatch', async () => {
    const f = await fixture()
    const backend = createAgentDesktopBackend(f.options)
    for (const arg of ['--session=foreign', '--agent-id', '--headed', '--trace=/outside']) {
      const result = await backend.execute({ command: 'click', args: [arg] })
      expect(text(result).error.disposition).toEqual({ delivery: 'not_delivered', retry: 'safe' })
    }
    expect(await f.calls()).toEqual([])
    for (const entries of [
      [{ command: 'click', session: 'foreign', args: { ref_id: '@s:e1' } }],
      [{ command: 'session', args: { action: 'end', id: 'foreign' } }],
      [{ command: 'click', args: { session: 'foreign' } }],
    ]) {
      const result = await backend.execute({ command: 'batch', args: [JSON.stringify(entries)] })
      expect(text(result).error.code).toBe('INVALID_ARGS')
    }
    expect((await f.calls()).some(call => call.command === 'batch')).toBe(false)
  })

  test('help and API health probes do not create UI sessions; absent bus is unavailable', async () => {
    const f = await fixture()
    const backend = createAgentDesktopBackend(f.options)
    const help = await backend.execute({ command: 'snapshot', args: ['--help'] })
    expect(help.content).toEqual([{ type: 'text', text: 'Usage: agent-desktop snapshot [OPTIONS]\n' }])
    expect(await getAgentDesktopStatus(f.options)).toMatchObject({ available: true, reason: null, binaryPath: process.execPath })
    expect((await f.calls()).map(call => call.command)).toEqual(['snapshot', 'status'])
    expect(await getAgentDesktopStatus({ ...f.options, environment: { ...f.options.environment, CCH_DESKTOP_TEST_SURFACES: '[]' } })).toMatchObject({ available: false, reason: 'accessibility_bus_unavailable' })
    expect(await getAgentDesktopStatus({ ...f.options, binaryPath: path.join(f.root, 'missing') })).toEqual({ available: false, binaryPath: null, reason: 'binary_missing' })
  })

  test('Windows status checks native-created private storage and leaves the legacy runtime untouched', async () => {
    const f = await fixture({ CCH_DESKTOP_TEST_STORAGE_ERROR: 'private file DACL grants an untrusted principal' })
    const legacy = path.join(f.configRoot, '.runtime', 'agent-desktop')
    const privateRoot = path.join(f.configRoot, '.runtime', 'agent-desktop-private')
    await mkdir(legacy, { recursive: true })
    await writeFile(path.join(legacy, 'old-trace'), 'fixture')
    const options = { ...f.options, platform: 'win32' as const }

    expect(await getAgentDesktopStatus(options)).toMatchObject({
      available: false,
      reason: 'session_storage_unavailable',
      message: 'private file DACL grants an untrusted principal',
    })
    expect(await getAgentDesktopStatus({
      ...options, environment: { ...options.environment, CCH_DESKTOP_TEST_STORAGE_ERROR: '' },
    })).toMatchObject({ available: true, reason: null })
    expect((await f.calls()).map(call => [call.command, call.args, call.home])).toEqual([
      ['status', ['--check-session-storage'], privateRoot],
      ['status', ['--check-session-storage'], privateRoot],
    ])
    await expect(access(privateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path.join(legacy, 'old-trace'), 'utf8')).toBe('fixture')
  })

  test('cursor configuration failure is reported separately from the successful action', async () => {
    const f = await fixture()
    const backend = createAgentDesktopBackend({
      ...f.options,
      runner: request => request.args.includes('cursor-overlay')
        ? Promise.resolve({
          stdout: JSON.stringify({ ok: false, command: 'cursor-overlay', error: { code: 'ACTION_FAILED', message: 'fixture cursor config failed' } }),
          stderr: '',
          exitCode: 1,
        })
        : f.options.runner(request),
    })

    const outcome = await backend.execute({ command: 'click', args: ['@s:e1'] })
    expect(outcome.isError).toBeUndefined()
    expect(text(outcome).cursor_overlay).toEqual({
      configured: null, attempted: false, rendered: null,
      warning: { code: 'ACTION_FAILED', message: 'fixture cursor config failed' },
    })
    expect((await f.calls()).filter(call => call.command === 'click')).toHaveLength(1)
  })

  test('explicit cursor commands use session scope and disable stays in effect until enable', async () => {
    const f = await fixture()
    const backend = createAgentDesktopBackend(f.options)

    const disabled = await backend.execute({ command: 'cursor-overlay', args: ['disable'] }, undefined, 'reviewer')
    expect(text(disabled).cursor_overlay).toMatchObject({ configured: false, attempted: false })
    await backend.cleanup()
    expect(text(await backend.execute({ command: 'click', args: ['@ref'] })).cursor_overlay.configured).toBe(false)
    const enabled = await backend.execute({ command: 'cursor-overlay', args: ['enable', '--multi-agent'] }, undefined, 'reviewer')
    expect(text(enabled).cursor_overlay).toMatchObject({ configured: true, attempted: false, rendered: null })
    const cursorCalls = (await f.calls()).filter(call => call.command === 'cursor-overlay')
    expect(cursorCalls.map(call => [call.args, call.agent])).toEqual([
      [['disable'], null], [['enable', '--multi-agent'], null],
    ])
  })

  test('turn cleanup hides the cursor and the next action reenables the same style and session', async () => {
    const f = await fixture({ AGENT_DESKTOP_CURSOR_IDLE_MS: '1' })
    await mkdir(path.join(f.configRoot, '.runtime', 'agent-desktop-private'), { recursive: true })
    const backend = createAgentDesktopBackend({ ...f.options, platform: 'win32' })
    await backend.execute({ command: 'click', args: ['@ref'] })
    await backend.cleanup()
    await backend.cleanup()
    await backend.execute({ command: 'click', args: ['@ref'] })
    const calls = await f.calls()
    const cursorCalls = calls.filter(call => call.command === 'cursor-overlay')
    expect(cursorCalls.map(call => call.args[0])).toEqual(['enable', 'disable', 'enable'])
    expect(cursorCalls[0].args.slice(-2)).toEqual(['--label', 'Agent'])
    expect(cursorCalls[2].args).toEqual(cursorCalls[0].args)
    expect(f.requests.every(request => request.env.AGENT_DESKTOP_CURSOR_IDLE_MS === '45000')).toBe(true)
    expect(calls.filter(call => call.command === 'session')).toHaveLength(1)
    expect(new Set(calls.filter(call => call.command === 'click').map(call => call.session)).size).toBe(1)
  })

  test('starting another host-owned session hides the previous cursor before replacing its owner', async () => {
    const f = await fixture()
    const backend = createAgentDesktopBackend(f.options)
    await backend.execute({ command: 'click', args: ['@ref'] })
    const restarted = await backend.execute({ command: 'session', args: ['start'] })
    expect(restarted.isError).toBeUndefined()
    await backend.execute({ command: 'snapshot' })
    await backend.cleanup()
    const calls = await f.calls()
    const disables = calls.filter(call => call.command === 'cursor-overlay' && call.args[0] === 'disable')
    expect(disables.map(call => call.session)).toEqual(['cc-haha-product-session-1', 'cc-haha-product-session-2'])
    expect(calls.find(call => call.command === 'snapshot').session).toBe('cc-haha-product-session-2')
    const oldDisable = calls.findIndex(call => call.command === 'cursor-overlay' && call.args[0] === 'disable')
    const secondStart = calls.findLastIndex(call => call.command === 'session' && call.args[0] === 'start')
    expect(oldDisable).toBeLessThan(secondStart)
  })

  test('a failed cursor teardown preserves the previous session owner and does not start a replacement', async () => {
    const f = await fixture()
    const backend = createAgentDesktopBackend({
      ...f.options,
      runner: async request => request.args.includes('disable')
        ? { stdout: JSON.stringify({ ok: false, command: 'cursor-overlay', error: { code: 'ACTION_FAILED', message: 'fixture cursor teardown failed', disposition: { delivery: 'delivery_uncertain', retry: 'unsafe' } } }), stderr: '', exitCode: 1 }
        : f.options.runner(request),
    })
    await backend.execute({ command: 'snapshot' })
    const restarted = await backend.execute({ command: 'session', args: ['start'] })
    expect(restarted.isError).toBe(true)
    expect(text(restarted).error.disposition).toEqual({ delivery: 'delivery_uncertain', retry: 'unsafe' })
    await backend.execute({ command: 'snapshot' })
    const calls = await f.calls()
    expect(calls.filter(call => call.command === 'session')).toHaveLength(1)
    expect(new Set(calls.filter(call => call.command === 'snapshot').map(call => call.session)).size).toBe(1)
  })

  test('batch cannot change the lifecycle of the host-owned session', async () => {
    const f = await fixture()
    const backend = createAgentDesktopBackend(f.options)
    await backend.execute({ command: 'snapshot' })
    for (const action of ['start', 'end']) {
      const result = await backend.execute({ command: 'batch', args: [JSON.stringify([{ command: 'session', args: { action } }])] })
      expect(text(result).error).toMatchObject({ code: 'INVALID_ARGS', disposition: { delivery: 'not_delivered', retry: 'safe' } })
    }
    await backend.execute({ command: 'snapshot' })
    const calls = await f.calls()
    expect(calls.some(call => call.command === 'batch')).toBe(false)
    expect(new Set(calls.filter(call => call.command === 'snapshot').map(call => call.session)).size).toBe(1)
  })

  test('trace exports are placed under the runtime artifact directory', async () => {
    const f = await fixture()
    const target = path.join(f.root, 'outside.html')
    const result = await createAgentDesktopBackend(f.options).execute({ command: 'trace', args: ['export', '--out', target] })
    expect(result.isError).toBeUndefined()
    const generated = text(result).data.path
    expect(generated).toContain(path.join(f.configRoot, '.runtime', 'agent-desktop', 'artifacts'))
    expect(await readFile(generated, 'utf8')).toBe('<html>fixture trace</html>')
    expect(await access(target).then(() => true, () => false)).toBe(false)
  })

  test('an untrusted native image path is never read or deleted outside the artifact directory', async () => {
    const f = await fixture()
    const external = path.join(f.root, 'external.png')
    await writeFile(external, Buffer.from(png, 'base64'))
    const result = await createAgentDesktopBackend({
      ...f.options,
      runner: async request => {
        if (request.args.includes('screenshot')) return { stdout: JSON.stringify({ ok: true, command: 'screenshot', data: { path: external, format: 'png' } }), stderr: '', exitCode: 0 }
        return f.options.runner(request)
      },
    }).execute({ command: 'screenshot' })
    expect(result.isError).toBe(true)
    expect(text(result).error.disposition).toEqual({ delivery: 'delivery_uncertain', retry: 'unsafe' })
    expect(result.content.some(block => block.type === 'image')).toBe(false)
    expect((await readFile(external)).toString('base64')).toBe(png)
  })

  test('a crashed native initialization retains exit diagnostics and never claims a known delivery outcome', async () => {
    const f = await fixture()
    const result = await createAgentDesktopBackend({
      ...f.options,
      runner: async () => ({ stdout: '', stderr: 'fixture native dependency could not load', exitCode: 1 }),
    }).execute({ command: 'snapshot' })
    expect(result.isError).toBe(true)
    expect(text(result).error.message).toContain('exited with code 1')
    expect(text(result).error.message).toContain('fixture native dependency could not load')
    expect(text(result).error.disposition).toEqual({ delivery: 'delivery_uncertain', retry: 'unsafe' })
  })

  test('timeout or cancellation reports unknown execution and never retries a dispatched action', async () => {
    const f = await fixture()
    const backend = createAgentDesktopBackend({ ...f.options, timeoutMs: 500 })
    await backend.execute({ command: 'snapshot' })
    const timedOut = await backend.execute({ command: 'wait', args: ['hang'] })
    expect(text(timedOut).error).toMatchObject({ code: 'TIMEOUT', disposition: { delivery: 'delivery_uncertain', retry: 'unsafe' } })
    const abort = new AbortController()
    const request = backend.execute({ command: 'wait', args: ['hang'] }, abort.signal)
    const firstWaits = (await f.calls()).filter(call => call.command === 'wait').length
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await f.calls()).filter(call => call.command === 'wait').length > firstWaits) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    abort.abort()
    const cancelled = await request
    expect(text(cancelled).error.disposition).toEqual({ delivery: 'delivery_uncertain', retry: 'unsafe' })
    expect((await f.calls()).filter(call => call.command === 'wait')).toHaveLength(2)
    const before = (await f.calls()).length
    const alreadyAborted = await backend.execute({ command: 'click', args: ['@ref'] }, abort.signal)
    expect(text(alreadyAborted).error.disposition).toEqual({ delivery: 'not_delivered', retry: 'safe' })
    expect((await f.calls()).length).toBe(before)
  })
})
