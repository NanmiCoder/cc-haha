import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
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
  type TerminalWebContentsLike,
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

class FakeWebContents extends EventEmitter implements TerminalWebContentsLike {
  destroyed = false
  readonly send = vi.fn()

  isDestroyed() {
    return this.destroyed
  }

  destroy() {
    this.destroyed = true
    this.emit('destroyed')
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

    expect(terminalConfigPath(app, { CLAUDE_CONFIG_DIR: '/portable' }))
      .toBe(path.join('/portable', 'terminal-config.json'))
    expect(terminalConfigPath(app, {}))
      .toBe(path.join('/Users/test', '.claude', 'terminal-config.json'))
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

  it('falls back safely when persisted terminal settings have malformed runtime shapes', () => {
    const dir = tempDir()
    const settingsPath = path.join(dir, 'settings.json')
    const terminalPath = path.join(dir, 'terminal-config.json')
    const malformedSettings = JSON.stringify({ desktopTerminal: { startupShell: 42, customShellPath: {} } })
    const malformedTerminal = JSON.stringify({ bash_path: { bad: true }, preserved: 'value' })
    fs.writeFileSync(settingsPath, malformedSettings)
    fs.writeFileSync(terminalPath, malformedTerminal)

    const service = new ElectronTerminalService({
      env: { CLAUDE_CONFIG_DIR: dir, COMSPEC: 'powershell.exe' },
      platform: 'win32',
    })

    expect(service.getBashPath()).toBeNull()
    expect(service.resolveShell()).toBe('powershell.exe')
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(malformedSettings)
    expect(fs.readFileSync(terminalPath, 'utf8')).toBe(malformedTerminal)

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ desktopTerminal: { startupShell: 'custom', customShellPath: { bad: true } } }),
    )
    expect(service.resolveShell()).toBe('powershell.exe')

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ desktopTerminal: { startupShell: 'future-shell' } }),
    )
    expect(service.resolveShell()).toBe('powershell.exe')
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
    if (process.platform !== 'win32') {
      expect(fs.statSync(cache).mode & 0o077).toBe(0)
      expect(fs.statSync(path.join(cache, 'prebuilds', 'darwin-arm64', 'spawn-helper')).mode & 0o777).toBe(0o500)
    }
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
    const owner = new FakeWebContents()
    owner.send.mockImplementation((channel, payload) => sent.push({ channel, payload }))

    const session = await service.spawn(
      { cols: 10, rows: 4, cwd: dir },
      owner,
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

    service.write(1, 'echo hello\r', owner)
    service.resize(1, 12, 6, owner)
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
    expect(() => service.write(1, 'after exit', owner)).toThrow('terminal session is not running')
  })

  it('kills a running PTY session without failing when the session is already gone', async () => {
    const dir = tempDir()
    const fakePty = new FakePty()
    const service = new ElectronTerminalService({
      env: { HOME: dir, SHELL: '/bin/test-shell' },
      platform: 'linux',
      ptyFactory: { spawn: vi.fn(() => fakePty) },
    })
    const owner = new FakeWebContents()

    await service.spawn({ cols: 80, rows: 24, cwd: dir }, owner)
    service.kill(1, owner)
    service.kill(1, owner)

    expect(fakePty.killed).toBe(true)
  })

  it('binds a PTY session to the renderer that created it', async () => {
    const dir = tempDir()
    const fakePty = new FakePty()
    const service = new ElectronTerminalService({
      env: { HOME: dir, SHELL: '/bin/test-shell' },
      platform: 'linux',
      ptyFactory: { spawn: vi.fn(() => fakePty) },
    })
    const owner = new FakeWebContents()
    const otherRenderer = new FakeWebContents()

    await service.spawn({ cols: 80, rows: 24, cwd: dir }, owner)

    expect(() => service.write(1, 'foreign input', otherRenderer)).toThrow('owned by another renderer')
    expect(() => service.resize(1, 120, 40, otherRenderer)).toThrow('owned by another renderer')
    expect(() => service.kill(1, otherRenderer)).toThrow('owned by another renderer')
    expect(fakePty.killed).toBe(false)
    service.write(1, 'owner input', owner)
    expect(fakePty.writes).toEqual(['owner input'])
  })

  it('does not create a PTY when its renderer is destroyed before or during factory loading', async () => {
    const dir = tempDir()
    const factorySpawn = vi.fn(() => new FakePty())
    let resolveFactory: ((factory: TerminalPtyFactory) => void) | undefined
    const factoryPromise = new Promise<TerminalPtyFactory>((resolve) => {
      resolveFactory = resolve
    })
    const service = new ElectronTerminalService({
      env: { HOME: dir, SHELL: '/bin/test-shell' },
      platform: 'linux',
      ptyFactory: () => factoryPromise,
    })
    const destroyedBefore = new FakeWebContents()
    destroyedBefore.destroy()

    await expect(service.spawn({ cols: 80, rows: 24, cwd: dir }, destroyedBefore))
      .rejects.toThrow('terminal renderer is destroyed')

    const destroyedDuring = new FakeWebContents()
    const spawning = service.spawn({ cols: 80, rows: 24, cwd: dir }, destroyedDuring)
    destroyedDuring.destroy()
    resolveFactory?.({ spawn: factorySpawn })

    await expect(spawning).rejects.toThrow('terminal renderer is destroyed')
    expect(factorySpawn).not.toHaveBeenCalled()
  })

  it('kills a PTY when its renderer is destroyed during spawn or after startup', async () => {
    const dir = tempDir()
    const ptyDestroyedDuringSpawn = new FakePty()
    const ownerDestroyedDuringSpawn = new FakeWebContents()
    const spawnWhileDestroying = vi.fn(() => {
      ownerDestroyedDuringSpawn.destroy()
      return ptyDestroyedDuringSpawn
    })
    const serviceDestroyedDuringSpawn = new ElectronTerminalService({
      env: { HOME: dir, SHELL: '/bin/test-shell' },
      platform: 'linux',
      ptyFactory: { spawn: spawnWhileDestroying },
    })

    await expect(serviceDestroyedDuringSpawn.spawn(
      { cols: 80, rows: 24, cwd: dir },
      ownerDestroyedDuringSpawn,
    )).rejects.toThrow('terminal renderer is destroyed')
    expect(ptyDestroyedDuringSpawn.killed).toBe(true)

    const activePty = new FakePty()
    const activeOwner = new FakeWebContents()
    const activeService = new ElectronTerminalService({
      env: { HOME: dir, SHELL: '/bin/test-shell' },
      platform: 'linux',
      ptyFactory: { spawn: vi.fn(() => activePty) },
    })
    await activeService.spawn({ cols: 80, rows: 24, cwd: dir }, activeOwner)

    activeOwner.destroy()

    expect(activePty.killed).toBe(true)
    expect(() => activeService.write(1, 'after destroy', activeOwner))
      .toThrow('terminal session is not running')
    expect(() => activePty.emitData('late output')).not.toThrow()
    expect(() => activePty.emitExit({ exitCode: 0 })).not.toThrow()
    expect(activeOwner.send).not.toHaveBeenCalled()
  })

  // Regression: 'destroyed' was the only lifecycle subscription, and a reload does not
  // emit it. The app reloads the renderer deliberately — render-process-gone and
  // sustained-unresponsive recovery in rendererLifecycle.ts, plus the reload buttons in
  // ErrorBoundary and StartupErrorView — and the reload wipes the renderer-side session
  // map, so kill() could never name those PTYs again. Every shell and its children (dev
  // servers, watchers, builds) survived invisibly until before-quit.
  it('kills a PTY when its renderer replaces the document without being destroyed', async () => {
    const dir = tempDir()
    const pty = new FakePty()
    const owner = new FakeWebContents()
    const service = new ElectronTerminalService({
      env: { HOME: dir, SHELL: '/bin/test-shell' },
      platform: 'linux',
      ptyFactory: { spawn: vi.fn(() => pty) },
    })
    await service.spawn({ cols: 80, rows: 24, cwd: dir }, owner)

    // A navigation that starts but never commits must not touch a live shell.
    // installMainWindowNavigationGuards cancels external http(s) in `will-navigate`,
    // and Chromium dispatches DidStartNavigation before that throttle runs — so the
    // start event fires for navigation the user never actually goes through with.
    owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(pty.killed).toBe(false)

    owner.emit('did-navigate', {}, 'app://index.html', 200)

    expect(pty.killed).toBe(true)
    expect(owner.isDestroyed()).toBe(false)
    expect(() => service.write(1, 'after reload', owner)).toThrow('terminal session is not running')
  })

  it('stops watching navigation once the session is killed normally', async () => {
    const dir = tempDir()
    const pty = new FakePty()
    const owner = new FakeWebContents()
    const service = new ElectronTerminalService({
      env: { HOME: dir, SHELL: '/bin/test-shell' },
      platform: 'linux',
      ptyFactory: { spawn: vi.fn(() => pty) },
    })
    const { session_id } = await service.spawn({ cols: 80, rows: 24, cwd: dir }, owner)
    service.kill(session_id, owner)

    // Both listeners have to come off together, or a long-lived renderer accumulates
    // one navigation handler per terminal it ever opened.
    expect(owner.listenerCount('did-navigate')).toBe(0)
    expect(owner.listenerCount('destroyed')).toBe(0)
  })

  it('ignores a renderer destroyed during send but rethrows unrelated send errors', async () => {
    const dir = tempDir()
    const destroyedPty = new FakePty()
    const destroyedOwner = new FakeWebContents()
    destroyedOwner.send.mockImplementation(() => {
      throw new TypeError('Object has been destroyed')
    })
    const destroyedService = new ElectronTerminalService({
      env: { HOME: dir, SHELL: '/bin/test-shell' },
      platform: 'linux',
      ptyFactory: { spawn: vi.fn(() => destroyedPty) },
    })

    await destroyedService.spawn({ cols: 80, rows: 24, cwd: dir }, destroyedOwner)

    expect(() => destroyedPty.emitData('late output')).not.toThrow()
    expect(() => destroyedPty.emitExit({ exitCode: 0 })).not.toThrow()

    const failingPty = new FakePty()
    const failingOwner = new FakeWebContents()
    failingOwner.send.mockImplementation(() => {
      throw new Error('unexpected IPC failure')
    })
    const failingService = new ElectronTerminalService({
      env: { HOME: dir, SHELL: '/bin/test-shell' },
      platform: 'linux',
      ptyFactory: { spawn: vi.fn(() => failingPty) },
    })
    await failingService.spawn({ cols: 80, rows: 24, cwd: dir }, failingOwner)

    expect(() => failingPty.emitData('output')).toThrow('unexpected IPC failure')
  })

  it('ignores PTY events that arrive after killAll', async () => {
    const dir = tempDir()
    const fakePty = new FakePty()
    const send = vi.fn()
    const service = new ElectronTerminalService({
      env: { HOME: dir, SHELL: '/bin/test-shell' },
      platform: 'linux',
      ptyFactory: { spawn: vi.fn(() => fakePty) },
    })
    const owner = new FakeWebContents()

    owner.send.mockImplementation(send)
    await service.spawn({ cols: 80, rows: 24, cwd: dir }, owner)
    service.killAll()

    expect(fakePty.killed).toBe(true)
    expect(() => fakePty.emitData('late output')).not.toThrow()
    expect(() => fakePty.emitExit({ exitCode: 0 })).not.toThrow()
    expect(send).not.toHaveBeenCalled()
  })
})
