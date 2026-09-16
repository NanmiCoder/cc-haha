import { afterEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { connect, createServer, type NetConnectOpts, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComputerUseRepl, createComputerUseReplSandboxCommand } from './replRuntime.js'

const directories: string[] = []
const children = new Set<ChildProcess>()
const servers: Server[] = []
const runtimes: ComputerUseRepl[] = []

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
  await Promise.all(runtimes.splice(0).map(runtime => runtime.reset()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cu-repl-sandbox-test-')))
  directories.push(directory)
  return directory
}

async function verifyListening(options: NetConnectOpts) {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(options)
    let connected = false
    const deadline = setTimeout(() => { socket.destroy(); reject(new Error('Fixture listener did not accept the control connection')) }, 1000)
    socket.once('error', error => { clearTimeout(deadline); reject(error) })
    socket.once('connect', () => { connected = true })
    // The fixture server closes only after recording its accepted connection.
    socket.once('close', () => {
      clearTimeout(deadline)
      if (connected) resolve()
      else reject(new Error('Fixture control connection closed before connecting'))
    })
  })
}

function runSandbox(command: string, directory: string) {
  return new Promise<{ code: number | null, stdout: string, stderr: string }>((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', `exec ${command}`], {
      cwd: directory,
      stdio: 'pipe',
      env: {
        HOME: directory, TMPDIR: directory, TMP: directory, TEMP: directory,
        PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', BUN_OPTIONS: '--no-env-file',
        CLAUDE_CONFIG_DIR: join(directory, '.claude'),
      },
    })
    children.add(child)
    let stdout = ''
    let stderr = ''
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000)
    child.stdout?.on('data', chunk => { stdout += chunk.toString() })
    child.stderr?.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', error => { clearTimeout(deadline); children.delete(child); reject(error) })
    child.once('close', code => {
      clearTimeout(deadline)
      children.delete(child)
      resolve({ code, stdout, stderr })
    })
    child.stdin?.end()
  })
}

const suite = process.platform === 'darwin' ? describe : describe.skip
suite('Computer Use OS sandbox', () => {
  test('production child receives a private and usable temporary directory', async () => {
    const directory = join(await temporaryDirectory(), "child's temporary directory")
    await mkdir(directory)
    const script = join(directory, 'temporary-directory-probe.mjs')
    await writeFile(script, `
      import fs from 'node:fs'
      import os from 'node:os'
      import path from 'node:path'
      const expected = ${JSON.stringify(directory)}
      const result = {
        TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
        osTmpdir: os.tmpdir(), temporaryFile: 'not attempted outside fixture',
      }
      // Do not write a test file if the sandbox wrapper redirected temp state
      // anywhere outside this disposable directory (for example /tmp/claude).
      if ([result.TMPDIR, result.TMP, result.TEMP, result.osTmpdir].every(value => value === expected)) {
        const created = fs.mkdtempSync(path.join(os.tmpdir(), 'private-temp-'))
        const file = path.join(created, 'sentinel.txt')
        fs.writeFileSync(file, 'private temporary file')
        result.temporaryFile = fs.readFileSync(file, 'utf8')
        // afterEach owns the whole fixture directory, including this child.
      }
      console.log(JSON.stringify(result))
    `)
    const executable = await realpath(process.execPath)
    const command = createComputerUseReplSandboxCommand({
      args: [executable, '--no-env-file', script], readable: [executable, directory], directory,
    })
    const output = await runSandbox(command, directory)
    expect(output.code, output.stderr).toBe(0)
    expect(JSON.parse(output.stdout.trim())).toEqual({
      TMPDIR: directory, TMP: directory, TEMP: directory, osTmpdir: directory,
      temporaryFile: 'private temporary file',
    })
  }, 15000)

  test('production profile denies external files, symlink and Data-volume aliases, and local network', async () => {
    const inside = await temporaryDirectory()
    const outside = await temporaryDirectory()
    const sentinel = join(outside, 'sentinel.txt')
    await writeFile(sentinel, 'disposable outside sentinel')
    let dataVolumeAlias: string | undefined = `/System/Volumes/Data${sentinel}`
    try {
      // Probe only this disposable file. Confirm the alias is the same inode
      // before using it to test the sandbox's handling of APFS firmlinks.
      expect(await readFile(dataVolumeAlias, 'utf8')).toBe('disposable outside sentinel')
      const [original, alias] = await Promise.all([stat(sentinel), stat(dataVolumeAlias)])
      expect({ device: alias.dev, inode: alias.ino }).toEqual({ device: original.dev, inode: original.ino })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      dataVolumeAlias = undefined
    }
    const link = join(inside, 'escape-link')
    await symlink(sentinel, link)

    let accepted = 0
    const tcp = createServer(socket => { accepted++; socket.destroy() })
    const unix = createServer(socket => { accepted++; socket.destroy() })
    servers.push(tcp, unix)
    await new Promise<void>((resolve, reject) => { tcp.once('error', reject); tcp.listen(0, '127.0.0.1', resolve) })
    const address = tcp.address()
    if (!address || typeof address === 'string') throw new Error('missing loopback fixture address')
    const unixPath = join(inside, 'server.sock')
    await new Promise<void>((resolve, reject) => { unix.once('error', reject); unix.listen(unixPath, resolve) })
    await verifyListening({ host: '127.0.0.1', port: address.port })
    await verifyListening({ path: unixPath })
    expect(accepted).toBe(2)
    accepted = 0

    const script = join(inside, 'probe.mjs')
    await writeFile(script, `
      import fs from 'node:fs'
      import net from 'node:net'
      const attempt = operation => { try { operation(); return 'allowed' } catch (error) { return error.code } }
      const connect = options => new Promise(resolve => {
        const socket = net.connect(options)
        const finish = value => { clearTimeout(timer); socket.destroy(); resolve(value) }
        const timer = setTimeout(() => finish('timeout'), 1000)
        socket.once('connect', () => finish('allowed'))
        socket.once('error', error => finish(error.code))
      })
      const result = {
        started: true,
        read: attempt(() => fs.readFileSync(${JSON.stringify(sentinel)}, 'utf8')),
        write: attempt(() => fs.writeFileSync(${JSON.stringify(sentinel)}, 'changed')),
        symlinkRead: attempt(() => fs.readFileSync(${JSON.stringify(link)}, 'utf8')),
        symlinkWrite: attempt(() => fs.writeFileSync(${JSON.stringify(link)}, 'changed')),
        dataVolumeRead: ${dataVolumeAlias ? `attempt(() => fs.readFileSync(${JSON.stringify(dataVolumeAlias)}, 'utf8'))` : "'unavailable'"},
        dataVolumeWrite: ${dataVolumeAlias ? `attempt(() => fs.writeFileSync(${JSON.stringify(dataVolumeAlias)}, 'changed'))` : "'unavailable'"},
        internalWrite: attempt(() => fs.writeFileSync(${JSON.stringify(join(inside, 'allowed.txt'))}, 'ok')),
        unixExists: fs.statSync(${JSON.stringify(unixPath)}).isSocket(),
        tcp: await connect({host:'127.0.0.1', port:${address.port}}),
        unix: await connect({path:${JSON.stringify(unixPath)}}),
      }
      console.log(JSON.stringify(result))
    `)
    const executable = await realpath(process.execPath)
    const command = createComputerUseReplSandboxCommand({
      args: [executable, '--no-env-file', script], readable: [executable, inside], directory: inside,
    })
    const output = await runSandbox(command, inside)
    expect(output.code, output.stderr).toBe(0)
    const result = JSON.parse(output.stdout.trim())
    expect(result.started).toBe(true)
    expect(result.internalWrite).toBe('allowed')
    expect(result.unixExists).toBe(true)
    for (const operation of ['read', 'write', 'symlinkRead', 'symlinkWrite']) {
      expect(['EPERM', 'EACCES'], `${operation}: ${result[operation]}`).toContain(result[operation])
    }
    console.info(`[sandbox Data-volume alias] control=${dataVolumeAlias ? 'same inode' : 'unavailable'}, read=${result.dataVolumeRead}, write=${result.dataVolumeWrite}`)
    if (dataVolumeAlias) {
      for (const operation of ['dataVolumeRead', 'dataVolumeWrite']) {
        expect(['EPERM', 'EACCES'], `${operation}: ${result[operation]}`).toContain(result[operation])
      }
    }
    // macOS can report sandbox-denied connect as ECONNREFUSED. The controls
    // above prove both listeners are live, and neither may receive this probe.
    for (const operation of ['tcp', 'unix']) {
      expect(['EPERM', 'EACCES', 'ECONNREFUSED', 'ENOENT'], `${operation}: ${result[operation]}`).toContain(result[operation])
    }
    expect(accepted).toBe(0)
    expect(await readFile(sentinel, 'utf8')).toBe('disposable outside sentinel')
    expect(await readFile(join(inside, 'allowed.txt'), 'utf8')).toBe('ok')
  }, 15000)

})

describe('Computer Use OS sandbox availability', () => {
  test('actual worker bootstraps on macOS and fails closed on unsupported platforms', async () => {
    const runtime = new ComputerUseRepl()
    runtimes.push(runtime)
    let invoked = false
    const result = await runtime.run({ code: 'nodeRepl.write("sandbox worker ready")', timeoutMs: 5000 }, async () => {
      invoked = true
      return { content: [] }
    })
    if (process.platform === 'darwin') {
      expect(result.isError).not.toBe(true)
      expect(result.content).toContainEqual({ type: 'text', text: 'sandbox worker ready' })
    } else {
      expect(result.isError).toBe(true)
      expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('available on macOS only') }])
    }
    expect(invoked).toBe(false)
  }, 15000)
})
