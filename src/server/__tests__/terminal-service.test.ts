import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  TerminalService,
  defaultShell,
  resolveDesktopTerminalShell,
  resolveTerminalCwd,
} from '../services/terminalService.js'
import { isTrustedLocalSourceHost } from '../h5AccessPolicy.js'
import {
  projectRemoteSettings,
  validateRemoteSettingsPatch,
} from '../remoteBrowserPolicy.js'

// 与 TerminalPtyProcess 形状一致的假 PTY：捕获 service 注册的 onData/onExit。
class FakePty {
  onDataHandler: ((data: string) => void) | null = null
  onExitHandler: ((event: { exitCode: number; signal?: number | string | null }) => void) | null = null
  written: string[] = []
  cols = 80
  rows = 24
  killed = false

  write(data: string): void { this.written.push(data) }
  resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows }
  kill(): void { this.killed = true }
  onData(handler: (data: string) => void): unknown { this.onDataHandler = handler; return undefined }
  onExit(handler: (event: { exitCode: number; signal?: number | string | null }) => void): unknown {
    this.onExitHandler = handler
    return undefined
  }
}

function createFakeSocket() {
  const sends: string[] = []
  return { sends, send: (data: string) => { sends.push(data) } }
}

describe('TerminalService', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-service-test-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('spawns with clamped dimensions and streams output through the owning socket', async () => {
    let pty: FakePty | null = null
    let spawnCwd = ''
    let spawnCols = 0
    let spawnRows = 0
    const service = new TerminalService({
      ptyFactory: {
        spawn: (_shell: string, _args: string[], options: { cwd: string; cols: number; rows: number }) => {
          const created = new FakePty()
          pty = created
          spawnCwd = options.cwd
          spawnCols = options.cols
          spawnRows = options.rows
          return created
        },
      },
    })
    const socket = createFakeSocket()

    const result = await service.spawn(socket, { cols: 4, rows: 2, cwd: tmpDir, requestId: 'r-1' })

    expect(result.session_id).toBe(1)
    expect(spawnCwd).toBe(tmpDir)
    expect(spawnCols).toBe(MIN_TERMINAL_COLS)
    expect(spawnRows).toBe(MIN_TERMINAL_ROWS)

    // 触发 service 在 spawn 时注册的 onData：输出帧应带 requestId 与 session_id
    pty!.onDataHandler!('hello')
    const frame = JSON.parse(socket.sends[0])
    expect(frame.requestId).toBe('r-1')
    expect(frame.session_id).toBe(1)
    expect(frame.data).toBe('hello')
  })

  test('write/resize pass through and clamp; unknown sessions throw', async () => {
    const pty = new FakePty()
    const service = new TerminalService({ ptyFactory: { spawn: () => pty } })
    const socket = createFakeSocket()

    await service.spawn(socket, { cols: 80, rows: 24, cwd: tmpDir })
    service.write(socket, 1, 'ls\n')
    service.resize(socket, 1, 100, 50)
    expect(pty.written).toContain('ls\n')
    expect(pty.cols).toBe(100)
    expect(pty.rows).toBe(50)

    service.resize(socket, 1, 5, 3)
    expect(pty.cols).toBe(MIN_TERMINAL_COLS)
    expect(pty.rows).toBe(MIN_TERMINAL_ROWS)

    expect(() => service.write(socket, 99, 'x')).toThrow('terminal session is not running')
    expect(() => service.resize(socket, 99, 80, 24)).toThrow('terminal session is not running')
  })

  test('kill removes the session and kills the pty without an error frame', async () => {
    const pty = new FakePty()
    const service = new TerminalService({ ptyFactory: { spawn: () => pty } })
    const socket = createFakeSocket()

    await service.spawn(socket, { cols: 80, rows: 24, cwd: tmpDir })
    service.kill(socket, 1)

    expect(pty.killed).toBe(true)
    expect(service.listSessions()).toHaveLength(0)
    expect(socket.sends.some(s => s.includes('"terminal_error"'))).toBe(false)
  })

  test('detach stops forwarding and grace-kills the pty', async () => {
    const pty = new FakePty()
    const service = new TerminalService({ ptyFactory: { spawn: () => pty }, graceMs: 40 })
    const socket = createFakeSocket()

    await service.spawn(socket, { cols: 80, rows: 24, cwd: tmpDir })
    service.detach(socket)

    // owner 置空后输出不再转发
    pty.onDataHandler!('late')
    expect(socket.sends).toHaveLength(0)

    expect(pty.killed).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(pty.killed).toBe(true)
    expect(service.listSessions()).toHaveLength(0)
  })

  test('attach re-owns live sessions and sends terminal_sync', async () => {
    const pty = new FakePty()
    const service = new TerminalService({ ptyFactory: { spawn: () => pty }, graceMs: 500 })
    const first = createFakeSocket()
    const second = createFakeSocket()

    await service.spawn(first, { cols: 80, rows: 24, cwd: tmpDir })
    service.detach(first)
    service.attach(second)

    const sync = second.sends.find(s => s.includes('"terminal_sync"'))
    expect(sync).toBeDefined()
    const payload = JSON.parse(sync!)
    expect(payload.sessions).toHaveLength(1)
    expect(payload.sessions[0].session_id).toBe(1)
    expect(pty.killed).toBe(false)
  })

  test('getBashPath/setBashPath persist through terminal-config.json', async () => {
    const bashFile = path.join(tmpDir, 'bash')
    await fs.writeFile(bashFile, '#!/bin/sh\n')
    const service = new TerminalService()
    expect(service.getBashPath()).toBeNull()

    service.setBashPath(bashFile)
    expect(service.getBashPath()).toBe(bashFile)

    const fresh = new TerminalService()
    expect(fresh.getBashPath()).toBe(bashFile)

    service.setBashPath(null)
    expect(service.getBashPath()).toBeNull()
  })
})

describe('terminal shell/cwd pure helpers', () => {
  test('defaultShell honours SHELL then falls back to zsh/bash on non-win32', () => {
    expect(defaultShell('linux', { SHELL: '/bin/fish' })).toBe('/bin/fish')
    expect(defaultShell('linux', {})).toMatch(/\/bin\/(zsh|bash)/)
  })

  test('resolveTerminalCwd throws when the directory is missing', async () => {
    const missing = path.join(os.tmpdir(), 'cc-haha-terminal-does-not-exist-xyz')
    expect(() => resolveTerminalCwd(missing)).toThrow('terminal cwd does not exist')
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-terminal-cwd-'))
    try {
      expect(resolveTerminalCwd(tmp)).toBe(tmp)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  test('resolveDesktopTerminalShell only applies on win32', () => {
    expect(resolveDesktopTerminalShell('win32', { startupShell: 'powershell' })).toBe('powershell.exe')
    expect(resolveDesktopTerminalShell('linux', { startupShell: 'powershell' })).toBeNull()
    expect(() => resolveDesktopTerminalShell('win32', { startupShell: 'custom', customShellPath: '   ' }))
      .toThrow('custom terminal shell path is empty')
  })

  test('isTrustedLocalSourceHost matches loopback, private LAN and ULA only', () => {
    expect(isTrustedLocalSourceHost('127.0.0.1')).toBe(true)
    expect(isTrustedLocalSourceHost('192.168.0.44')).toBe(true)
    expect(isTrustedLocalSourceHost('fd12:3456:789a::1')).toBe(true)
    expect(isTrustedLocalSourceHost('8.8.8.8')).toBe(false)
    expect(isTrustedLocalSourceHost('fd9a::7f')).toBe(false)
    expect(isTrustedLocalSourceHost('')).toBe(false)
  })
})

describe('remote browser policy desktopTerminal', () => {
  test('validates and projects desktopTerminal patches', () => {
    expect(validateRemoteSettingsPatch({ desktopTerminal: { startupShell: 'system' } })).toBe(true)
    expect(validateRemoteSettingsPatch({ desktopTerminal: { startupShell: 'custom', customShellPath: '/bin/zsh' } })).toBe(true)
    expect(validateRemoteSettingsPatch({ desktopTerminal: { startupShell: 'custom' } })).toBe(false)
    expect(validateRemoteSettingsPatch({ desktopTerminal: { startupShell: 'bogus' } })).toBe(false)
    expect(validateRemoteSettingsPatch({ desktopTerminal: { startupShell: 5 } })).toBe(false)

    const projected = projectRemoteSettings({
      language: 'zh',
      desktopTerminal: { startupShell: 'custom', customShellPath: '/bin/zsh' },
      effortLevel: 3,
    })
    expect(projected.desktopTerminal).toEqual({ startupShell: 'custom', customShellPath: '/bin/zsh' })
    expect(projected.language).toBe('zh')
    expect('effortLevel' in projected).toBe(false)
  })
})
