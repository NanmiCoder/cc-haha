import { describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import http from 'node:http'
import path from 'node:path'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import {
  appendHostDiagnostic,
  buildSidecarEnv,
  createAdapterPlan,
  createServerPlan,
  electronHostDiagnosticsFile,
  httpToWebSocketUrl,
  HOST_DIAGNOSTICS_BYTE_LIMIT,
  HOST_DIAGNOSTICS_LINE_LIMIT,
  killSidecar,
  mergeProxyEnv,
  parseH5FixedPort,
  preferredServerPorts,
  proxyUrlFromElectronProxyRules,
  pushStartupLog,
  readH5FixedPort,
  readLastServerPort,
  reserveLocalPort,
  reserveServerPort,
  resolveHostTriple,
  SERVER_STATE_FILE,
  spawnSidecar,
  waitForServer,
  windowsPowerShellOverride,
  writeLastServerPort,
  type SidecarChild,
} from './sidecarManager'

function fakeChild(pid = 4321) {
  return { pid, kill: vi.fn() } as unknown as SidecarChild & { kill: ReturnType<typeof vi.fn> }
}

function listen(server: http.Server, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Could not resolve HTTP test port'))
        return
      }
      resolve(address.port)
    })
  })
}

function close(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()))
}

describe('Electron sidecar manager', () => {
  it('places the Electron host log in the active server diagnostics directory', () => {
    const portableDir = path.join(tmpdir(), 'cc-haha-portable-diagnostics')

    expect(electronHostDiagnosticsFile(
      { CLAUDE_CONFIG_DIR: portableDir },
      path.join(tmpdir(), 'unused-home'),
    )).toBe(path.join(portableDir, 'cc-haha', 'diagnostics', 'electron-host.log'))
  })

  it('resolves the default Electron host log without consulting real user state', () => {
    const isolatedHome = path.resolve(path.sep, '__cc_haha_injected_test_home__')

    expect(electronHostDiagnosticsFile({}, isolatedHome)).toBe(
      path.join(isolatedHome, '.claude', 'cc-haha', 'diagnostics', 'electron-host.log'),
    )
  })

  it('maps host platform to existing sidecar target triples', () => {
    expect(resolveHostTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin')
    expect(resolveHostTriple('darwin', 'x64')).toBe('x86_64-apple-darwin')
    expect(resolveHostTriple('win32', 'x64')).toBe('x86_64-pc-windows-msvc')
    expect(resolveHostTriple('win32', 'arm64')).toBe('aarch64-pc-windows-msvc')
    expect(resolveHostTriple('linux', 'arm64')).toBe('aarch64-unknown-linux-gnu')
  })

  it('builds server sidecar args without changing the REST/WebSocket boundary', () => {
    const plan = createServerPlan({
      desktopRoot: '/app/desktop',
      appRoot: '/app',
      port: 49321,
      env: {},
    })

    expect(plan.args).toEqual([
      'server',
      '--app-root',
      '/app',
      '--host',
      '0.0.0.0',
      '--port',
      '49321',
    ])
    expect(plan.env.CLAUDE_H5_AUTO_PUBLIC_URL).toBe('1')
    expect(plan.env.CLAUDE_H5_DIST_DIR).toBe(path.join('/app/desktop', 'dist'))
  })

  it('can keep sidecar binaries and H5 assets unpacked while pointing app-root at app.asar', () => {
    const plan = createServerPlan({
      desktopRoot: '/Applications/App.app/Contents/Resources/app.asar.unpacked',
      appRoot: '/Applications/App.app/Contents/Resources/app.asar',
      h5DistDir: '/Applications/App.app/Contents/Resources/app.asar.unpacked/dist',
      port: 49321,
      env: {},
    })

    expect(plan.command).toContain('/Applications/App.app/Contents/Resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-')
    expect(plan.args).toContain('/Applications/App.app/Contents/Resources/app.asar')
    expect(plan.env.CLAUDE_H5_DIST_DIR).toBe('/Applications/App.app/Contents/Resources/app.asar.unpacked/dist')
  })

  it('passes portable config and adapter server URL through the sidecar env', () => {
    const configDir = mkdtempSync(path.join(tmpdir(), 'cc-haha-config-'))
    try {
      const env = buildSidecarEnv({ CLAUDE_CONFIG_DIR: configDir }, '/app/dist')
      expect(env.CLAUDE_CONFIG_DIR).toBe(configDir)
      expect(env.XDG_CACHE_HOME).toBe(path.join(configDir, 'Cache'))

      const adapter = createAdapterPlan({
        desktopRoot: '/app/desktop',
        appRoot: '/app',
        serverUrl: 'http://127.0.0.1:4567',
        flag: '--telegram',
        env: { CLAUDE_CONFIG_DIR: configDir },
      })
      expect(adapter.env.ADAPTER_SERVER_URL).toBe('ws://127.0.0.1:4567')
      expect(adapter.args).toEqual(['adapters', '--app-root', '/app', '--telegram'])

      const whatsappAdapter = createAdapterPlan({
        desktopRoot: '/app/desktop',
        appRoot: '/app',
        serverUrl: 'http://127.0.0.1:4567',
        flag: '--whatsapp',
        env: { CLAUDE_CONFIG_DIR: configDir },
      })
      expect(whatsappAdapter.args).toEqual(['adapters', '--app-root', '/app', '--whatsapp'])
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  it('converts Electron system proxy rules into sidecar proxy env', () => {
    expect(proxyUrlFromElectronProxyRules('DIRECT')).toBeUndefined()
    expect(proxyUrlFromElectronProxyRules('SOCKS5 127.0.0.1:7891; DIRECT')).toBeUndefined()
    expect(proxyUrlFromElectronProxyRules('PROXY 127.0.0.1:7897; DIRECT')).toBe('http://127.0.0.1:7897')
    expect(proxyUrlFromElectronProxyRules('HTTPS proxy.example:8443; DIRECT')).toBe('https://proxy.example:8443')

    const env = mergeProxyEnv({}, 'http://127.0.0.1:7897')
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7897')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7897')
    expect(env.http_proxy).toBe('http://127.0.0.1:7897')
    expect(env.https_proxy).toBe('http://127.0.0.1:7897')
    expect(env.NO_PROXY).toContain('127.0.0.1')
    expect(env.no_proxy).toContain('localhost')
  })

  it('does not override explicit sidecar proxy environment and still preserves loopback bypasses', () => {
    const env = mergeProxyEnv(
      { HTTPS_PROXY: 'http://manual.example:8080', NO_PROXY: '.corp.local' },
      'http://system.example:8080',
    )

    expect(env.HTTPS_PROXY).toBe('http://manual.example:8080')
    expect(env.HTTP_PROXY).toBeUndefined()
    expect(env.NO_PROXY).toBe('.corp.local,localhost,127.0.0.1,::1')
    expect(env.no_proxy).toBe('.corp.local,localhost,127.0.0.1,::1')
  })

  it('keeps startup logs bounded', () => {
    const logs: string[] = []
    for (let index = 0; index < 85; index++) {
      pushStartupLog(logs, `line ${index}`)
    }
    expect(logs).toHaveLength(80)
    expect(logs[0]).toBe('line 5')
  })

  it('sanitizes the bounded startup tail before it reaches an error surface', () => {
    const logs: string[] = []
    pushStartupLog(
      logs,
      `Bearer startup.secret sk-proj-STARTUPSECRETVALUE https://alice:password@example.com ${homedir()}/project`,
    )

    expect(logs[0]).toContain('Bearer [REDACTED]')
    expect(logs[0]).toContain('https://[REDACTED]@example.com/')
    expect(logs[0]).toContain('[HOME]/project')
    expect(logs[0]).not.toContain('startup.secret')
    expect(logs[0]).not.toContain('sk-proj-STARTUPSECRETVALUE')
    expect(logs[0]).not.toContain(homedir())
  })

  it('appends only a bounded sanitized Electron host-log tail', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cc-haha-electron-host-'))
    const logPath = path.join(dir, 'electron-host.log')
    const homeDir = path.join(dir, 'private-home')
    try {
      for (let index = 0; index < HOST_DIAGNOSTICS_LINE_LIMIT + 5; index++) {
        appendHostDiagnostic(logPath, `line ${index}`, { homeDir })
      }
      appendHostDiagnostic(
        logPath,
        `Authorization: Bearer bearer.secret api_key=sk-ant-api03-PRIVATE ANTHROPIC_API_KEY=anthropic-secret OPENAI_API_KEY="openai-secret" MINIMAX_AUTH_TOKEN='minimax-secret' https://alice:password@example.com/private ${homeDir}/project`,
        { homeDir },
      )

      const contents = readFileSync(logPath, 'utf-8')
      const lines = contents.trimEnd().split('\n')
      expect(contents).toContain('Bearer [REDACTED]')
      expect(contents).toContain('api_key=[REDACTED]')
      expect(contents).toContain('ANTHROPIC_API_KEY=[REDACTED]')
      expect(contents).toContain('OPENAI_API_KEY=[REDACTED]')
      expect(contents).toContain('MINIMAX_AUTH_TOKEN=[REDACTED]')
      expect(contents).toContain('https://[REDACTED]@example.com/private')
      expect(contents).toContain('[HOME]/project')
      expect(contents).not.toContain('bearer.secret')
      expect(contents).not.toContain('sk-ant-api03-PRIVATE')
      expect(contents).not.toContain('anthropic-secret')
      expect(contents).not.toContain('openai-secret')
      expect(contents).not.toContain('minimax-secret')
      expect(contents).not.toContain('alice:password')
      expect(contents).not.toContain(homeDir)
      expect(lines).toHaveLength(HOST_DIAGNOSTICS_LINE_LIMIT)
      expect(lines[0]).toBe('line 6')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('bounds and re-sanitizes an oversized pre-existing host diagnostics file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cc-haha-electron-host-existing-'))
    const logPath = path.join(dir, 'electron-host.log')
    const homeDir = path.join(dir, 'private-home')
    try {
      writeFileSync(
        logPath,
        `${'oversized-old-data '.repeat(HOST_DIAGNOSTICS_BYTE_LIMIT)}\nOPENAI_API_KEY=old-secret ${homeDir}/private\n`,
        'utf-8',
      )

      appendHostDiagnostic(logPath, 'latest safe diagnostic', { homeDir })

      const contents = readFileSync(logPath, 'utf-8')
      expect(statSync(logPath).size).toBeLessThanOrEqual(HOST_DIAGNOSTICS_BYTE_LIMIT)
      expect(contents.trimEnd().split('\n').length).toBeLessThanOrEqual(HOST_DIAGNOSTICS_LINE_LIMIT)
      expect(contents).toContain('latest safe diagnostic')
      expect(contents).toContain('OPENAI_API_KEY=[REDACTED]')
      expect(contents).not.toContain('old-secret')
      expect(contents).not.toContain(homeDir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not crash Electron when the host diagnostics destination cannot be written', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cc-haha-electron-host-failure-'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(() => appendHostDiagnostic(dir, 'sidecar failed')).not.toThrow()
      expect(errorSpy).toHaveBeenCalledWith('[desktop] failed to persist Electron host diagnostics')
    } finally {
      errorSpy.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maps http urls to adapter websocket urls', () => {
    expect(httpToWebSocketUrl('http://127.0.0.1:3456')).toBe('ws://127.0.0.1:3456')
    expect(httpToWebSocketUrl('https://example.com')).toBe('wss://example.com')
  })

  it('kills non-Windows sidecars with a signal', () => {
    const child = fakeChild()
    const spawnAsync = vi.fn()
    const spawnSyncFn = vi.fn()
    killSidecar(child, false, { platform: 'darwin', spawnAsync: spawnAsync as never, spawnSyncFn: spawnSyncFn as never })
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(spawnAsync).not.toHaveBeenCalled()
    expect(spawnSyncFn).not.toHaveBeenCalled()
  })

  it('uses async taskkill on Windows by default', () => {
    const child = fakeChild(777)
    const spawnAsync = vi.fn()
    const spawnSyncFn = vi.fn()
    killSidecar(child, false, { platform: 'win32', spawnAsync: spawnAsync as never, spawnSyncFn: spawnSyncFn as never })
    expect(spawnAsync).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '777'], { stdio: 'ignore', windowsHide: true })
    expect(spawnSyncFn).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('uses synchronous taskkill on Windows during shutdown to avoid orphaned sidecars', () => {
    const child = fakeChild(777)
    const spawnAsync = vi.fn()
    const spawnSyncFn = vi.fn()
    killSidecar(child, true, { platform: 'win32', spawnAsync: spawnAsync as never, spawnSyncFn: spawnSyncFn as never })
    expect(spawnSyncFn).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '777'], { stdio: 'ignore', windowsHide: true })
    expect(spawnAsync).not.toHaveBeenCalled()
  })

  it('hides Windows console windows when launching sidecars', () => {
    const spawned = {} as SidecarChild
    const spawnFn = vi.fn(() => spawned)
    const existsSyncFn = vi.fn(() => true)
    const plan = {
      command: '/app/desktop/src-tauri/binaries/claude-sidecar-x86_64-pc-windows-msvc.exe',
      args: ['server', '--port', '49321'],
      env: { CLAUDE_H5_AUTO_PUBLIC_URL: '1' },
    }

    expect(spawnSidecar(plan, { existsSyncFn, spawnFn: spawnFn as never })).toBe(spawned)
    expect(existsSyncFn).toHaveBeenCalledWith(plan.command)
    expect(spawnFn).toHaveBeenCalledWith(plan.command, plan.args, {
      env: plan.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  })

  it('forwards a PowerShell shell choice to the sidecar only on Windows', () => {
    expect(windowsPowerShellOverride('pwsh.exe', 'win32')).toBe('pwsh.exe')
    expect(windowsPowerShellOverride('powershell.exe', 'win32')).toBe('powershell.exe')
    expect(windowsPowerShellOverride('C:\\tools\\PowerShell\\pwsh.exe', 'win32')).toBe('C:\\tools\\PowerShell\\pwsh.exe')
    // non-PowerShell selections must not be reported as a PowerShell override
    expect(windowsPowerShellOverride('cmd.exe', 'win32')).toBeNull()
    expect(windowsPowerShellOverride('C:\\bin\\bash.exe', 'win32')).toBeNull()
    expect(windowsPowerShellOverride(null, 'win32')).toBeNull()
    // never applies off Windows
    expect(windowsPowerShellOverride('pwsh', 'darwin')).toBeNull()
    expect(windowsPowerShellOverride('powershell.exe', 'linux')).toBeNull()
  })

  it('parses only browser-safe in-range integer h5Access.fixedPort values', () => {
    expect(parseH5FixedPort('{"h5Access":{"fixedPort":28670}}')).toBe(28670)
    for (const port of [
      1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
      6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
    ]) {
      expect(parseH5FixedPort(`{"h5Access":{"fixedPort":${port}}}`)).toBeNull()
    }
    expect(parseH5FixedPort('{"h5Access":{"fixedPort":5062}}')).toBe(5062)
    expect(parseH5FixedPort('{"h5Access":{"fixedPort":80}}')).toBeNull()
    expect(parseH5FixedPort('{"h5Access":{"fixedPort":70000}}')).toBeNull()
    expect(parseH5FixedPort('{"h5Access":{"fixedPort":"3456"}}')).toBeNull()
    expect(parseH5FixedPort('{"h5Access":{"fixedPort":null}}')).toBeNull()
    expect(parseH5FixedPort('{"h5Access":{}}')).toBeNull()
    expect(parseH5FixedPort('{}')).toBeNull()
    expect(parseH5FixedPort('not json')).toBeNull()
  })

  it('persists and prioritizes preferred server ports from the config dir', () => {
    const configDir = mkdtempSync(path.join(tmpdir(), 'cchh-server-state-'))
    const env = { CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv
    try {
      // Nothing stored yet: no preferred ports.
      expect(preferredServerPorts(env)).toEqual([])

      // A browser-blocked port persisted by an older build is ignored.
      writeFileSync(
        path.join(configDir, SERVER_STATE_FILE),
        JSON.stringify({ lastPort: 5061 }),
        'utf-8',
      )
      expect(readLastServerPort(env)).toBeNull()
      expect(preferredServerPorts(env)).toEqual([])

      // Sticky port from the previous run.
      writeLastServerPort(50123, env)
      expect(readLastServerPort(env)).toBe(50123)
      expect(preferredServerPorts(env)).toEqual([50123])

      // An explicit fixed port wins over the sticky port.
      mkdirSync(path.join(configDir, 'cc-haha'), { recursive: true })
      writeFileSync(
        path.join(configDir, 'cc-haha', 'settings.json'),
        JSON.stringify({ h5Access: { fixedPort: 28670 } }),
        'utf-8',
      )
      expect(readH5FixedPort(env)).toBe(28670)
      expect(preferredServerPorts(env)).toEqual([28670, 50123])

      // Identical fixed and sticky ports are not duplicated.
      writeLastServerPort(28670, env)
      expect(preferredServerPorts(env)).toEqual([28670])
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  it('reserves a free preferred port and falls back when it is taken', async () => {
    // Reserve a random free port, verify preference picks it while free.
    const freePort = await reserveLocalPort('127.0.0.1')
    await expect(reserveServerPort('127.0.0.1', [freePort])).resolves.toBe(freePort)

    // Occupy it and verify the fallback hands out a different port.
    const blocker = net.createServer()
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(freePort, '127.0.0.1', () => resolve())
    })
    try {
      const fallback = await reserveServerPort('127.0.0.1', [freePort])
      expect(fallback).not.toBe(freePort)
    } finally {
      await new Promise<void>(resolve => blocker.close(() => resolve()))
    }

    // Invalid entries are skipped without throwing.
    await expect(reserveServerPort('127.0.0.1', [0, -1, 1.5, 70000])).resolves.toBeGreaterThan(0)
  })

  it('skips preferred ports blocked by browser fetch', async () => {
    const port = await reserveServerPort('127.0.0.1', [5061])
    expect(port).not.toBe(5061)
  })

  it('retries when the OS assigns a browser-blocked random port', async () => {
    const reserveCandidate = vi.fn()
      .mockResolvedValueOnce(5061)
      .mockResolvedValueOnce(5062)

    await expect(reserveLocalPort('127.0.0.1', { reserveCandidate })).resolves.toBe(5062)
    expect(reserveCandidate).toHaveBeenCalledTimes(2)
  })

  it('stops retrying after repeated browser-blocked random ports', async () => {
    const reserveCandidate = vi.fn().mockResolvedValue(5061)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await expect(reserveLocalPort('127.0.0.1', { reserveCandidate }))
        .rejects.toThrow('Could not reserve a browser-safe local port')
      expect(reserveCandidate).toHaveBeenCalledTimes(128)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('propagates random port reservation errors', async () => {
    const reserveCandidate = vi.fn().mockRejectedValue(new Error('bind failed'))

    await expect(reserveLocalPort('127.0.0.1', { reserveCandidate }))
      .rejects.toThrow('bind failed')
    expect(reserveCandidate).toHaveBeenCalledTimes(1)
  })

  it('does not treat a raw TCP accept as server readiness without healthy /health', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'starting' }))
    })
    const port = await listen(server)

    try {
      await expect(waitForServer('127.0.0.1', port, 300)).rejects.toThrow(
        /desktop server did not report healthy at http:\/\/127\.0\.0\.1:\d+\/health/,
      )
    } finally {
      await close(server)
    }
  })
})
