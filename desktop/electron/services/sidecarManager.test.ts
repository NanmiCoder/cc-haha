import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  buildSidecarEnv,
  createAdapterPlan,
  createServerPlan,
  httpToWebSocketUrl,
  killSidecar,
  mergeProxyEnv,
  proxyUrlFromElectronProxyRules,
  pushStartupLog,
  resolveHostTriple,
  windowsPowerShellOverride,
  type SidecarChild,
} from './sidecarManager'

function fakeChild(pid = 4321) {
  return { pid, kill: vi.fn() } as unknown as SidecarChild & { kill: ReturnType<typeof vi.fn> }
}

describe('Electron sidecar manager', () => {
  it('maps host platform to existing sidecar target triples', () => {
    expect(resolveHostTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin')
    expect(resolveHostTriple('darwin', 'x64')).toBe('x86_64-apple-darwin')
    expect(resolveHostTriple('win32', 'x64')).toBe('x86_64-pc-windows-msvc')
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
  })

  it('does not override explicit sidecar proxy environment', () => {
    const env = mergeProxyEnv(
      { HTTPS_PROXY: 'http://manual.example:8080' },
      'http://system.example:8080',
    )

    expect(env).toEqual({ HTTPS_PROXY: 'http://manual.example:8080' })
  })

  it('keeps startup logs bounded', () => {
    const logs: string[] = []
    for (let index = 0; index < 85; index++) {
      pushStartupLog(logs, `line ${index}`)
    }
    expect(logs).toHaveLength(80)
    expect(logs[0]).toBe('line 5')
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
    expect(spawnAsync).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '777'], { stdio: 'ignore' })
    expect(spawnSyncFn).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('uses synchronous taskkill on Windows during shutdown to avoid orphaned sidecars', () => {
    const child = fakeChild(777)
    const spawnAsync = vi.fn()
    const spawnSyncFn = vi.fn()
    killSidecar(child, true, { platform: 'win32', spawnAsync: spawnAsync as never, spawnSyncFn: spawnSyncFn as never })
    expect(spawnSyncFn).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '777'], { stdio: 'ignore' })
    expect(spawnAsync).not.toHaveBeenCalled()
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
})
