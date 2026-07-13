import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ELECTRON_EVENT_CHANNELS } from '../ipc/channels'
import {
  ElectronTerminalService,
  defaultShell,
  desktopTerminalSettingsPath,
  ensureUtf8Locale,
  normalizeTerminalBashPath,
  parseEnvBlock,
  prepareNodePtyRuntime,
  resolveDesktopTerminalShell,
  terminalConfigPath,
  type TerminalPtyFactory,
  type TerminalPtyProcess,
} from './terminal'

class FakePty implements TerminalPtyProcess {
  writes: string[] = []
  resizes: Array<{ cols: number, rows: number }> = []
  killed = false
  private dataHandler: ((data: string) => void) | null = null
  private exitHandler: ((event: { exitCode: number, signal?: number | string | null }) => void) | null = null

  write(data: string) {
    this.writes.push(data)
  }

  resize(cols: number, rows: number) {
    this.resizes.push({ cols, rows })
  }

  kill() {
    this.killed = true
  }

  onData(handler: (data: string) => void) {
    this.dataHandler = handler
  }

  onExit(handler: (event: { exitCode: number, signal?: number | string | null }) => void) {
    this.exitHandler = handler
  }

  emitData(data: string) {
    this.dataHandler?.(data)
  }

  emitExit(event: { exitCode: number, signal?: number | string | null }) {
    this.exitHandler?.(event)
  }
}

const tempDirs: string[] = []
const itOnDarwin = process.platform === 'darwin' ? it : it.skip

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-haha-terminal-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe('Electron terminal service', () => {
  it('uses the custom terminal config path before the standard ~/.claude path', () => {
    const app = { getPath: vi.fn(() => '/Users/test') }

    expect(terminalConfigPath(app, { CLAUDE_CONFIG_DIR: '/portable' })).toBe('/portable/terminal-config.json')
    expect(terminalConfigPath(app, {})).toBe('/Users/test/.claude/terminal-config.json')
  })

  it('reads an old userData terminal config but writes future changes to ~/.claude', () => {
    const root = tempDir()
    const home = path.join(root, 'home')
    const userData = path.join(root, 'user-data')
    const legacyBash = path.join(root, 'legacy-bash.exe')
    const newBash = path.join(root, 'new-bash.exe')
    fs.mkdirSync(userData, { recursive: true })
    fs.writeFileSync(legacyBash, '')
    fs.writeFileSync(newBash, '')
    fs.writeFileSync(path.join(userData, 'terminal-config.json'), JSON.stringify({ bash_path: legacyBash }))
    const service = new ElectronTerminalService({
      app: { getPath: name => name === 'home' ? home : userData },
      env: {},
      isFile: filePath => filePath === legacyBash || filePath === newBash,
    })

    expect(service.getBashPath()).toBe(legacyBash)
    service.setBashPath(newBash)
    expect(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'terminal-config.json'), 'utf8'))).toEqual({
      bash_path: newBash,
    })
    expect(JSON.parse(fs.readFileSync(path.join(userData, 'terminal-config.json'), 'utf8'))).toEqual({
      bash_path: legacyBash,
    })
  })

  it('persists the legacy bash path config and validates saved paths', () => {
    const dir = tempDir()
    const bash = path.join(dir, 'bash.exe')
    fs.writeFileSync(bash, '')
    const service = new ElectronTerminalService({
      env: { CLAUDE_CONFIG_DIR: dir },
      isFile: filePath => filePath === bash,
    })

    service.setBashPath(` ${bash} `)
    expect(service.getBashPath()).toBe(bash)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'terminal-config.json'), 'utf8'))).toEqual({
      bash_path: bash,
    })
    expect(() => service.setBashPath('/missing/bash')).toThrow('terminal bash path does not exist')
    expect(normalizeTerminalBashPath('   ', () => false)).toBeNull()
  })

  it('resolves platform-specific shells from the same settings shape as Tauri', () => {
    expect(resolveDesktopTerminalShell('win32', { startupShell: 'pwsh' })).toBe('pwsh.exe')
    expect(resolveDesktopTerminalShell('win32', { startupShell: 'powershell' })).toBe('powershell.exe')
    expect(resolveDesktopTerminalShell('win32', { startupShell: 'cmd' })).toBe('cmd.exe')
    expect(resolveDesktopTerminalShell('win32', { startupShell: 'custom', customShellPath: ' C:\\Tools\\shell.exe ' })).toBe('C:\\Tools\\shell.exe')
    expect(() => resolveDesktopTerminalShell('win32', { startupShell: 'custom' })).toThrow('custom terminal shell path is empty')
    expect(resolveDesktopTerminalShell('darwin', { startupShell: 'pwsh' })).toBeNull()
  })

  it('prefers Windows custom bash when valid and falls back to COMSPEC', () => {
    expect(defaultShell('win32', { COMSPEC: 'cmd.exe' }, 'C:\\Git\\bin\\bash.exe', file => file.endsWith('bash.exe'))).toBe(
      'C:\\Git\\bin\\bash.exe',
    )
    expect(defaultShell('win32', { COMSPEC: 'cmd.exe' }, 'C:\\missing\\bash.exe', () => false)).toBe('cmd.exe')
    expect(defaultShell('linux', { SHELL: '/bin/fish' }, null, () => false)).toBe('/bin/fish')
  })

  it('reads desktop terminal settings from the Claude config directory', () => {
    const dir = tempDir()
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.claude', 'settings.json'),
      JSON.stringify({ desktopTerminal: { startupShell: 'cmd' } }),
    )

    const ignoredHome = tempDir()
    const service = new ElectronTerminalService({
      env: { HOME: ignoredHome, USERPROFILE: dir, COMSPEC: 'powershell.exe' },
      platform: 'win32',
    })

    expect(desktopTerminalSettingsPath({ HOME: ignoredHome, USERPROFILE: dir }, 'win32'))
      .toBe(path.join(dir, '.claude', 'settings.json'))
    expect(desktopTerminalSettingsPath({ HOME: dir }, 'darwin'))
      .toBe(path.join(dir, '.claude', 'settings.json'))
    expect(service.resolveShell()).toBe('cmd.exe')
  })

  it('normalizes terminal environment data to UTF-8 locale', () => {
    expect(parseEnvBlock(Buffer.from('A=1\0B=two=2\0\0'))).toEqual({ A: '1', B: 'two=2' })
    expect(ensureUtf8Locale({ LANG: 'C' }, 'darwin')).toMatchObject({
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    })
  })

  it('copies packaged node-pty to a writable runtime cache and restores helper executable bits', () => {
    const source = tempDir()
    const cache = path.join(tempDir(), 'node-pty-cache')
    const helper = path.join(source, 'prebuilds', 'darwin-arm64', 'spawn-helper')
    fs.mkdirSync(path.dirname(helper), { recursive: true })
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'node-pty', main: 'index.js' }))
    fs.writeFileSync(path.join(source, 'index.js'), 'module.exports = { spawn() {} }\n')
    fs.writeFileSync(helper, 'helper')
    fs.chmodSync(helper, 0o644)

    expect(prepareNodePtyRuntime(source, cache)).toBe(cache)
    expect(fs.existsSync(path.join(cache, 'index.js'))).toBe(true)
    expect(fs.statSync(cache).mode & 0o077).toBe(0)
    expect(fs.statSync(path.join(cache, 'prebuilds', 'darwin-arm64', 'spawn-helper')).mode & 0o777).toBe(0o500)
    expect(fs.existsSync(path.join(cache, '.cc-haha-node-pty-manifest.json'))).toBe(true)
  })

  it('rebuilds the packaged node-pty runtime cache when cached files are tampered', () => {
    const source = tempDir()
    const cache = path.join(tempDir(), 'node-pty-cache')
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'node-pty', main: 'index.js' }))
    fs.writeFileSync(path.join(source, 'index.js'), 'module.exports = { spawn() { return "source" } }\n')

    prepareNodePtyRuntime(source, cache)
    fs.writeFileSync(path.join(cache, 'index.js'), 'module.exports = { spawn() { return "tampered" } }\n')

    prepareNodePtyRuntime(source, cache)

    expect(fs.readFileSync(path.join(cache, 'index.js'), 'utf8')).toBe('module.exports = { spawn() { return "source" } }\n')
  })

  itOnDarwin('removes stale macOS quarantine attributes from the node-pty runtime cache', () => {
    const source = tempDir()
    const cache = path.join(tempDir(), 'node-pty-cache')
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'node-pty', main: 'index.js' }))
    fs.writeFileSync(path.join(source, 'index.js'), 'module.exports = { spawn() { return "source" } }\n')

    prepareNodePtyRuntime(source, cache)

    const cachedEntry = path.join(cache, 'index.js')
    execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0381;00000000;Chrome;CC-HAHA-TEST', cachedEntry])
    execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', cachedEntry], { stdio: 'ignore' })
    fs.chmodSync(cachedEntry, 0o500)

    prepareNodePtyRuntime(source, cache)

    expect(() => execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', cachedEntry], { stdio: 'ignore' })).toThrow()
    expect(fs.statSync(cachedEntry).mode & 0o777).toBe(0o500)
  })

  it('spawns a PTY, forwards events, and controls the active session', async () => {
    const dir = tempDir()
    const fakePty = new FakePty()
    const spawn = vi.fn(() => fakePty)
    const sent: Array<{ channel: string, payload: unknown }> = []
    const service = new ElectronTerminalService({
      env: { HOME: dir, SHELL: '/bin/test-shell' },
      platform: 'linux',
      ptyFactory: { spawn } satisfies TerminalPtyFactory,
      fileExists: filePath => filePath === '/bin/test-shell',
    })

    const session = await service.spawn(
      { cols: 10, rows: 4, cwd: dir },
      { send: (channel, payload) => sent.push({ channel, payload }) },
    )

    expect(session).toEqual({ session_id: 1, shell: '/bin/test-shell', cwd: dir })
    expect(spawn).toHaveBeenCalledWith('/bin/test-shell', [], expect.objectContaining({
      name: 'xterm-256color',
      cols: 20,
      rows: 8,
      cwd: dir,
      env: expect.objectContaining({
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      }),
    }))

    service.write(1, 'echo hello\r')
    service.resize(1, 12, 6)
    fakePty.emitData('hello\r\n')
    fakePty.emitExit({ exitCode: 0 })

    expect(fakePty.writes).toEqual(['echo hello\r'])
    expect(fakePty.resizes).toEqual([{ cols: 20, rows: 8 }])
    expect(sent).toEqual([
      {
        channel: ELECTRON_EVENT_CHANNELS.terminalOutput,
        payload: { session_id: 1, data: 'hello\r\n' },
      },
      {
        channel: ELECTRON_EVENT_CHANNELS.terminalExit,
        payload: { session_id: 1, code: 0, signal: null },
      },
    ])
    expect(() => service.write(1, 'after exit')).toThrow('terminal session is not running')
  })

  it('kills a running PTY session without failing when the session is already gone', async () => {
    const dir = tempDir()
    const fakePty = new FakePty()
    const service = new ElectronTerminalService({
      env: { HOME: dir, SHELL: '/bin/test-shell' },
      platform: 'linux',
      ptyFactory: { spawn: vi.fn(() => fakePty) },
    })

    await service.spawn({ cols: 80, rows: 24, cwd: dir }, { send: vi.fn() })
    service.kill(1)
    service.kill(1)

    expect(fakePty.killed).toBe(true)
  })
})
