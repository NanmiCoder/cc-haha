import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { applicationScriptCommand } from '../../../../electron/services/managedResources/applicationScriptCommand'
import { JAVA_PROCESS_SCRIPT, parseJavaProcesses } from '../../../../electron/services/managedResources/javaProcessProtocol'

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'
let dir: string
const posix = (value: string) => value.replaceAll('\\', '/')
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-tools-shell-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

describe('production commands executed by real Bash with isolated identity/process fixtures', () => {
  it('collects NUL-delimited Java argv with real base64 and rejects non-Java processes without executing them', async () => {
    expect(existsSync(bash)).toBe(true)
    const proc = posix(path.join(dir, 'proc'))
    await fs.mkdir(path.join(proc, 'self'), { recursive: true })
    const processes: Array<[number, string[]]> = [[12, ['/jdk/bin/java', '-Xms512m', '-Xmx2g', '-jar', 'space 服务.jar']], [42, ['java', 'Main']], [51, ['node', 'java']], [53, ['/usr/bin/bash', 'echo dangerous']]]
    for (const [pid, args] of processes) {
      await fs.mkdir(path.join(proc, String(pid)))
      await fs.writeFile(path.join(proc, String(pid), 'cmdline'), args.join('\0') + '\0')
    }
    const result = spawnSync(bash, ['--noprofile', '--norc', '-c', JAVA_PROCESS_SCRIPT.replaceAll('/proc', proc)], { cwd: dir, encoding: 'utf8', timeout: 8000, env: { ...process.env, HOME: dir, BASH_ENV: '' } })
    expect(result.status, result.stderr).toBe(0)
    expect(parseJavaProcesses(result.stdout)).toMatchObject({ unreadable: 0, processes: [{ pid: 12, xmx: '2g', xms: '512m' }, { pid: 42, xmx: null, xms: null }] })
    expect(result.stdout).not.toContain('dangerous')
  })

  it.each([
    { name: 'root switches user', uid: '0', user: 'root', target: 'deploy', suFail: '0', status: 0, executed: 'deploy', su: true },
    { name: 'su failure never falls back to root', uid: '0', user: 'root', target: 'deploy', suFail: '1', status: 19, executed: null, su: true },
    { name: 'different non-root is refused', uid: '1001', user: 'viewer', target: 'deploy', suFail: '0', status: 126, executed: null, su: false },
    { name: 'same non-root user runs without su', uid: '1001', user: 'deploy', target: 'deploy', suFail: '0', status: 0, executed: 'deploy', su: false },
    { name: 'empty configuration preserves old path', uid: '0', user: 'root', target: '', suFail: '0', status: 0, executed: 'root', su: false },
  ])('$name', async sample => {
    expect(existsSync(bash)).toBe(true)
    const bin = path.join(dir, 'tools')
    const cwd = path.join(dir, "app's folder")
    await fs.mkdir(bin); await fs.mkdir(cwd)
    const writeExecutable = async (name: string, content: string) => { await fs.writeFile(path.join(bin, name), content, { mode: 0o755 }) }
    await writeExecutable('id', '#!/bin/bash\ncase "$1" in -u) echo "$FIXTURE_UID";; -un) echo "$FIXTURE_USER";; *) exit 1;; esac\n')
    await writeExecutable('su', '#!/bin/bash\nprintf "%s\\n" "$@" > "$SU_ARGS"\n[ "$SU_FAIL" = 1 ] && exit 19\n[ "$1" = - ] && [ "$3" = -s ] && [ "$5" = -c ] || exit 20\nexport FIXTURE_UID=1001 FIXTURE_USER="$2"\ncd /\nexec /bin/bash --noprofile --norc -c "$6"\n')
    const marker = path.join(dir, 'executed')
    const argsFile = path.join(dir, 'su-args')
    await fs.writeFile(path.join(cwd, 'service script.sh'), 'printf "%s\\n" "$(id -un)" "$PWD" > "$MARKER"\n')
    // Set PATH inside Bash: Windows environment names are case-insensitive and Git Bash
    // rewrites the inherited PATH. Identity shims must precede the real OS tools.
    const fixtureBin = posix(bin).replace(/^([A-Za-z]):\//, (_, drive: string) => `/${drive.toLowerCase()}/`)
    const command = 'export PATH="$FIXTURE_BIN:$PATH"; ' + applicationScriptCommand(posix(cwd), 'service script.sh', sample.target)
    const result = spawnSync(bash, ['--noprofile', '--norc', '-c', command], {
      cwd: dir, encoding: 'utf8', timeout: 8000,
      env: { ...process.env, HOME: dir, BASH_ENV: '', PATH: `${bin}${path.delimiter}${process.env.PATH}`, FIXTURE_BIN: fixtureBin, FIXTURE_UID: sample.uid, FIXTURE_USER: sample.user, SU_FAIL: sample.suFail, SU_ARGS: posix(argsFile), MARKER: posix(marker) },
    })
    expect(result.status, result.stderr).toBe(sample.status)
    expect(existsSync(argsFile)).toBe(sample.su)
    expect(existsSync(marker)).toBe(sample.executed !== null)
    if (sample.executed) {
      const recorded = await fs.readFile(marker, 'utf8')
      expect(recorded.split('\n')[0]).toBe(sample.executed)
      expect(recorded).toContain("app's folder")
    }
  })
})
