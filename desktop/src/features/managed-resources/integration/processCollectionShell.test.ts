import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { parseProcessInspection, parseServiceProcesses, processInspectionCommand, processListCommand } from '../../../../electron/services/managedResources/serviceProcessProtocol'
import { remoteChecksumCommand } from '../../../../electron/services/managedResources/remoteFileChecksum'
import type { ProcessKind, ProcessProbe } from '../api/hostToolsApi'

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'
let dir: string
const posix = (p: string) => p.replaceAll('\\', '/')
const stat = (pid: number, start = '123456') => `${pid} (fixture (process)) ${Array.from({ length: 20 }, (_, i) => i === 19 ? start : i === 0 ? 'S' : '0').join(' ')}\n`
async function seed(pid: number, comm: string, argv: string) {
  const folder = path.join(dir, 'proc', String(pid))
  await fs.mkdir(path.join(folder, 'fd'), { recursive: true })
  await fs.writeFile(path.join(folder, 'stat'), stat(pid))
  await fs.writeFile(path.join(folder, 'comm'), comm + '\n')
  await fs.writeFile(path.join(folder, 'cmdline'), argv)
}
async function shim(name: string, text: string) { await fs.writeFile(path.join(dir, 'tools', name), '#!/bin/bash\n' + text, { mode: 0o755 }) }
function run(command: string, extra: Record<string, string> = {}) {
  // Only replace /proc with a disposable tree. The collector and shell grammar
  // are otherwise byte-for-byte production code, and top/ss are fixture programs.
  const code = 'export PATH="$FIXTURE_TOOLS:$PATH"; ' + command.replace(/\/proc(?=\/|$)/g, posix(path.join(dir, 'proc')))
  const result = spawnSync(bash, ['--noprofile', '--norc', '-c', code], { cwd: dir, timeout: 15000, maxBuffer: 2 * 1024 ** 2, encoding: 'utf8',
    env: { ...process.env, HOME: dir, BASH_ENV: '', FIXTURE_TOOLS: posix(path.join(dir, 'tools')).replace(/^([A-Za-z]):\//, (_, drive: string) => `/${drive.toLowerCase()}/`), FIXTURE_DIR: posix(dir), ...extra } })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'process-collector-'))
  await fs.mkdir(path.join(dir, 'tools'))
  await fs.mkdir(path.join(dir, 'proc', 'self'), { recursive: true })
  await seed(231, 'mysqld', '/usr/sbin/mysqld\0--port=3337\0')
  await seed(232, 'mariadbd', '/usr/sbin/mariadbd\0--port=3338\0')
  await seed(301, 'redis-server', 'redis-server 127.0.0.1:6379\0\0\0')
  await seed(302, 'redis-sentinel', 'redis-sentinel *:26379\0')
  await seed(999, 'bash', 'bash\0mysqld\0redis-server\0')
  await shim('top', 'printf "%s\\n" "$@" > "$FIXTURE_DIR/top-args"\nprintf "PID USER %%CPU %%MEM RES\\n231 fixture 25.0 2.0 128m\\n"\n')
  await shim('readlink', 'if [ "$FIXTURE_BAD_NS" = 1 ] && [[ "$1" != */self/* ]]; then echo other; else echo same; fi\n')
  await shim('ss', 'printf "%s\\n" "$@" > "$FIXTURE_DIR/ss-args"\ncat "$FIXTURE_DIR/sockets"\n')
  await fs.writeFile(path.join(dir, 'sockets'), 'tcp LISTEN 0 128 [::]:3337 [::]:* users:(("mysqld",pid=231,fd=9))\nudp UNCONN 0 0 0.0.0.0:3338 0.0.0.0:* users:(("mysqld",pid=231,fd=10))\ntcp ESTAB 0 0 a:1 b:2 users:(("other",pid=1231,fd=11))\n')
})
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

describe('real Bash executes process collectors against isolated /proc/tool fixtures', () => {
  it('recognizes MySQL/MariaDB and Redis/Sentinel by comm, keeps start identity and trims Redis argv padding', () => {
    const mysql = parseServiceProcesses(run(processListCommand('mysql')), 'mysql')
    expect(mysql.processes.map(p => p.pid)).toEqual([231, 232])
    expect(mysql.processes.every(p => p.startTime === '123456')).toBe(true)
    const redis = parseServiceProcesses(run(processListCommand('redis')), 'redis')
    expect(redis.processes.map(p => p.pid)).toEqual([301, 302])
    expect(redis.processes[0]!.commandLine).toBe('"redis-server 127.0.0.1:6379"')
  })
  it.each(['top', 'ports', 'connections'] as const)('collects %s for the exact PID, including IPv6/UDP without netstat', async probe => {
    const text = run(processInspectionCommand({ pid: 231, startTime: '123456', processKind: 'mysql', probe }))
    const value = parseProcessInspection(text, 231, probe)
    expect(value.truncated).toBe(false)
    if (probe === 'top') {
      expect(value.text).toContain('25.0 2.0 128m')
      expect(await fs.readFile(path.join(dir, 'top-args'), 'utf8')).toBe('-b\n-n\n2\n-d\n1\n-p\n231\n-w\n512\n')
    } else {
      expect(value.text).toContain('[::]:3337')
      expect(value.text).toContain('udp UNCONN')
      expect(value.text).not.toContain('pid=1231')
      expect(await fs.readFile(path.join(dir, 'ss-args'), 'utf8')).toBe(`-H\n-n\n-t\n-u\n-p\n${probe === 'ports' ? '-l' : '-a'}\n`)
    }
  })
  it('rejects PID reuse, missing processes, namespace changes and missing tools explicitly', async () => {
    for (const [pid, start, error] of [[231, '9', 'PROCESS_CHANGED'], [9999, '123456', 'PROCESS_EXITED']] as const) {
      const text = run(processInspectionCommand({ pid, startTime: start, processKind: 'mysql', probe: 'top' }))
      expect(() => parseProcessInspection(text, pid, 'top')).toThrow(error)
    }
    expect(await fs.stat(path.join(dir, 'top-args')).catch(() => null)).toBeNull()
    const input = { pid: 231, startTime: '123456', processKind: 'mysql' as ProcessKind, probe: 'ports' as ProcessProbe }
    expect(() => parseProcessInspection(run(processInspectionCommand(input), { FIXTURE_BAD_NS: '1' }), 231, 'ports')).toThrow('PROCESS_NAMESPACE_UNAVAILABLE')
    // Shadow command only for ss discovery so the remaining OS tool availability is unchanged.
    const missing = 'function command() { if [ "$1" = -v ] && [ "$2" = ss ]; then return 1; fi; builtin command "$@"; }; export -f command; '
    expect(() => parseProcessInspection(run(missing + processInspectionCommand(input)), 231, 'ports')).toThrow('PROCESS_TOOL_UNAVAILABLE')
  })
  it('bounds large socket output and returns an explicit truncation indication instead of a parser failure', async () => {
    await fs.writeFile(path.join(dir, 'sockets'), ('tcp ESTAB 0 0 [::]:1 [::]:2 ' + 'x'.repeat(180) + ' pid=231,fd=9\n').repeat(5000))
    const text = run(processInspectionCommand({ pid: 231, startTime: '123456', processKind: 'mysql', probe: 'connections' }))
    const result = parseProcessInspection(text, 231, 'connections')
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.text)).toBeLessThan(256 * 1024)
  })
  it('hashes a quoted path with real sha256sum without interpreting shell metacharacters', async () => {
    const file = path.join(dir, "archive's $(touch SHOULD_NOT_EXIST).bin")
    const bytes = Buffer.alloc(128 * 1024, 51)
    await fs.writeFile(file, bytes)
    const value = run(remoteChecksumCommand(posix(file)))
    expect(value).toContain(createHash('sha256').update(bytes).digest('hex'))
    expect(await fs.stat(path.join(dir, 'SHOULD_NOT_EXIST')).catch(() => null)).toBeNull()
  })
})
