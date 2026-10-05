import { afterEach, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnWithParentProcessGuard } from './parentProcessGuard.js'

const directories: string[] = []
const children: ChildProcess[] = []
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

afterEach(() => {
  for (const child of children.splice(0)) {
    if (!child.pid) continue
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
    try { child.kill('SIGKILL') } catch {}
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'shell-parent-guard-'))
  directories.push(directory)
  return directory
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve, reject) => {
    child.once('exit', code => resolve(code))
    child.once('error', reject)
  })
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture process')
    await wait(10)
  }
}

function ticks(path: string): number {
  try { return readFileSync(path, 'utf8').trim().split('\n').length } catch { return 0 }
}

test.skipIf(process.platform === 'win32')('kills a detached shell and its descendants after the runtime receives SIGKILL', async () => {
  const directory = fixtureDirectory()
  const output = join(directory, 'ticks')
  const pidPath = join(directory, 'child-pid')
  const fixture = join(directory, 'runtime.ts')
  writeFileSync(fixture, `
    import { openSync, writeFileSync } from 'fs'
    import { spawnWithParentProcessGuard } from ${JSON.stringify(import.meta.dir + '/parentProcessGuard.ts')}
    const child = spawnWithParentProcessGuard('/bin/sh', ['-c', 'while true; do echo alive; sleep 0.02; done', 'shell'], {
      detached: true,
      stdio: ['pipe', openSync(${JSON.stringify(output)}, 'a'), 'ignore'],
    })
    writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))
    setInterval(() => {}, 1000)
  `)
  // Write through an inherited file fd, as background Shell.exec does. Pipe
  // output would stop when the CLI dies even if its shell kept running.
  const runtime = spawn(process.execPath, ['--no-env-file', fixture], {
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config') },
    detached: true,
    stdio: 'ignore',
  })
  children.push(runtime)
  let shellPid: number | undefined
  try {
    await waitUntil(() => ticks(output) >= 3)
    shellPid = Number(readFileSync(pidPath, 'utf8'))
    runtime.kill('SIGKILL')
    await exited(runtime)
    expect(runtime.signalCode).toBe('SIGKILL')
    await wait(150)
    const afterExit = ticks(output)
    await wait(150)
    expect(ticks(output)).toBe(afterExit)
  } finally {
    if (shellPid) {
      try { process.kill(-shellPid, 'SIGKILL') } catch {}
    }
  }
})

test.skipIf(process.platform === 'win32')('preserves stdin, arguments, bare wait, stdout, stderr and the exit code', async () => {
  const child = spawnWithParentProcessGuard('/bin/sh', ['-c',
    'IFS= read -r line; sleep 0.02 & wait; printf "%s|%s|%s\\n" "$line" "$1" "$GUARD_TEST_VALUE"; echo err >&2; exit 7',
    'sandbox-wrapper', 'literal $value `command` "quotes"',
  ], {
    detached: true,
    env: { ...process.env, GUARD_TEST_VALUE: 'env value' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', data => { stdout += data })
  child.stderr!.on('data', data => { stderr += data })
  child.stdin!.end('user input\n')
  expect(await exited(child)).toBe(7)
  expect(stdout).toBe('user input|literal $value `command` "quotes"|env value\n')
  expect(stderr).toBe('err\n')
})

test.skipIf(process.platform === 'win32')('preserves file output and leaves no process group after normal completion', async () => {
  const output = join(fixtureDirectory(), 'output')
  const fd = openSync(output, 'a')
  let child: ChildProcess
  try {
    child = spawnWithParentProcessGuard('/bin/sh', ['-c', 'echo stdout; echo stderr >&2; exit 0'], {
      detached: true,
      stdio: ['pipe', fd, fd],
    })
    children.push(child)
  } finally {
    closeSync(fd)
  }
  expect(await exited(child)).toBe(0)
  expect(readFileSync(output, 'utf8')).toBe('stdout\nstderr\n')
  expect(() => process.kill(-child.pid!, 0)).toThrow()
})

test.skipIf(process.platform === 'win32')('preserves an existing sandbox wrapper and does not expose the lifetime fd to commands', async () => {
  const child = spawnWithParentProcessGuard('/bin/sh', ['-c',
    'exec /bin/sh -c "$1" "$2" "$3"', 'sandbox-wrapper',
    'if (: <&3) 2>/dev/null; then echo leaked; exit 1; fi; printf "%s\\n" "$1"',
    'inner-shell', 'literal $arg `command` "quoted"',
  ], {
    detached: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  let stdout = ''
  child.stdout!.on('data', data => { stdout += data })
  expect(await exited(child)).toBe(0)
  expect(stdout).toBe('literal $arg `command` "quoted"\n')
})

for (const action of ['terminate', 'abort'] as const) {
  test.skipIf(process.platform === 'win32')(`reaps the target and guardian when the supervisor is ${action === 'abort' ? 'aborted' : 'terminated'}`, async () => {
    const output = join(fixtureDirectory(), 'ticks')
    const fd = openSync(output, 'a')
    const controller = new AbortController()
    let child: ChildProcess
    try {
      child = spawnWithParentProcessGuard('/bin/sh', ['-c', 'while true; do echo alive; sleep 0.02; done'], {
        detached: true,
        signal: controller.signal,
        stdio: ['pipe', fd, fd],
      })
      children.push(child)
    } finally {
      closeSync(fd)
    }
    const errors: Error[] = []
    child.on('error', error => { errors.push(error) })
    const exit = new Promise(resolve => child.once('exit', resolve))
    await waitUntil(() => ticks(output) >= 3)
    if (action === 'abort') controller.abort()
    else child.kill('SIGTERM')
    await exit
    await waitUntil(() => {
      try { process.kill(-child.pid!, 0); return false } catch { return true }
    })
    const afterExit = ticks(output)
    await wait(75)
    expect(ticks(output)).toBe(afterExit)
    if (action === 'abort') expect(errors[0]?.name).toBe('AbortError')
    else expect(errors).toHaveLength(0)
  })
}
