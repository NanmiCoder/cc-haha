import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import {
  ChromeConnectionManager,
  detectInstalledBrowsers,
  parseDevToolsActivePortContent,
  type BrowserDiscoveryFs,
} from '../chromeDiscovery'
import { MockCdpTransport } from './mockCdpTransport'

function createMemoryFs(initialFiles: Record<string, string>): {
  fs: BrowserDiscoveryFs
  files: Map<string, string>
  dirs: Set<string>
} {
  const files = new Map<string, string>(Object.entries(initialFiles))
  const dirs = new Set<string>()
  const fs: BrowserDiscoveryFs = {
    existsSync(path: string) {
      return files.has(path) || dirs.has(path)
    },
    readFileSync(path: string) {
      const content = files.get(path)
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`)
      }
      return content
    },
    unlinkSync(path: string) {
      files.delete(path)
    },
    mkdirSync(path: string) {
      dirs.add(path)
    },
  }
  return { fs, files, dirs }
}

describe('browserUse/chromeDiscovery', () => {
  it('detects installed browsers across macOS, Windows, and Linux', () => {
    const macFs = createMemoryFs({
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome': '',
      '/Users/tester/Library/Application Support/Google/Chrome/DevToolsActivePort':
        '51234\n/devtools/browser/abc\n',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser': '',
    })
    const mac = detectInstalledBrowsers({
      platform: 'darwin',
      env: { HOME: '/Users/tester' },
      fs: macFs.fs,
    })
    expect(mac.map(b => b.id)).toEqual(['chrome', 'brave'])
    expect(mac[0]?.hasDevToolsActivePort).toBe(true)
    expect(mac[1]?.hasDevToolsActivePort).toBe(false)

    const winFs = createMemoryFs({
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe': '',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe': '',
    })
    const win = detectInstalledBrowsers({
      platform: 'win32',
      env: {
        PROGRAMFILES: 'C:\\Program Files',
        'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
        LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      },
      fs: winFs.fs,
    })
    expect(win.map(b => b.id)).toEqual(['chrome', 'edge'])

    const linuxFs = createMemoryFs({
      '/usr/bin/google-chrome-stable': '',
      '/usr/bin/chromium': '',
    })
    const linux = detectInstalledBrowsers({
      platform: 'linux',
      env: { HOME: '/home/tester' },
      fs: linuxFs.fs,
    })
    expect(linux.map(b => b.id)).toEqual(['chrome', 'chromium'])
  })

  it('parses DevToolsActivePort content safely', () => {
    expect(
      parseDevToolsActivePortContent('55123\n/devtools/browser/uuid-123\n'),
    ).toEqual({
      port: 55123,
      wsPath: '/devtools/browser/uuid-123',
      wsEndpoint: 'ws://127.0.0.1:55123/devtools/browser/uuid-123',
    })
    expect(parseDevToolsActivePortContent('not-a-port\n/foo')).toBeNull()
    expect(parseDevToolsActivePortContent('9222\nrelative-path')).toBeNull()
  })

  it('Tier 1 Live Attach connects via DevToolsActivePort, supports tab pinning, and detaches without closing Chrome', async () => {
    const activePortPath =
      '/Users/tester/Library/Application Support/Google/Chrome/DevToolsActivePort'
    const { fs } = createMemoryFs({
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome': '',
      [activePortPath]: '54321\n/devtools/browser/live-1\n',
    })

    const mockTransport = new MockCdpTransport('chrome')
    mockTransport.onCommand('Browser.getVersion', () => ({
      product: 'Chrome/144.0.7500.0',
    }))

    let connectedUrl = ''
    const manager = new ChromeConnectionManager({
      platform: 'darwin',
      env: { HOME: '/Users/tester' },
      fs,
      transportFactory: async url => {
        connectedUrl = url
        return mockTransport
      },
    })

    const state = await manager.connectLiveAttach()
    expect(connectedUrl).toBe('ws://127.0.0.1:54321/devtools/browser/live-1')
    expect(state.mode).toBe('live_attach')
    expect(state.browserVersion).toBe('Chrome/144.0.7500.0')

    manager.pinTab('target-agent-1')
    expect(manager.isTabPinned('target-agent-1')).toBe(true)
    expect(manager.getPinnedTabIds()).toEqual(['target-agent-1'])

    const disconnected = await manager.disconnect()
    expect(disconnected.mode).toBe('disconnected')
    // Must NEVER send Browser.close on live_attach disconnect
    expect(
      mockTransport.commands.some(c => c.method === 'Browser.close'),
    ).toBe(false)
  })

  it('Tier 1 returns awaiting_approval immediately on timeout without retrying', async () => {
    const activePortPath =
      '/Users/tester/Library/Application Support/Google/Chrome/DevToolsActivePort'
    const { fs } = createMemoryFs({
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome': '',
      [activePortPath]: '54321\n/devtools/browser/live-modal\n',
    })

    let connectAttempts = 0
    const mockTransport = new MockCdpTransport('chrome')
    mockTransport.onCommand('Browser.getVersion', () => {
      throw new Error('CDP command "Browser.getVersion" timed out after 30000ms')
    })

    const manager = new ChromeConnectionManager({
      platform: 'darwin',
      env: { HOME: '/Users/tester' },
      fs,
      approvalTimeoutMs: 50,
      transportFactory: async () => {
        connectAttempts += 1
        return mockTransport
      },
    })

    const state = await manager.connectLiveAttach()
    expect(state.mode).toBe('awaiting_approval')
    expect(connectAttempts).toBe(1)
    expect(fs.existsSync(activePortPath)).toBe(true)
  })

  it('Tier 1 cleans dead DevToolsActivePort on ECONNREFUSED and returns Tier 3 remote_debugging_not_enabled', async () => {
    const activePortPath =
      '/Users/tester/Library/Application Support/Google/Chrome/DevToolsActivePort'
    const { fs } = createMemoryFs({
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome': '',
      [activePortPath]: '54321\n/devtools/browser/stale\n',
    })

    const manager = new ChromeConnectionManager({
      platform: 'darwin',
      env: { HOME: '/Users/tester' },
      fs,
      transportFactory: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:54321')
      },
    })

    const state = await manager.connectLiveAttach()
    expect(state.mode).toBe('remote_debugging_not_enabled')
    expect(fs.existsSync(activePortPath)).toBe(false)
    expect(state.guidance).toContain('chrome://inspect/#remote-debugging')
  })

  it('Tier 2 spawns Managed Isolated Chrome with ephemeral port 0 and isolated profile dir', async () => {
    const { fs } = createMemoryFs({
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome': '',
    })

    let spawnedCmd = ''
    let spawnedArgs: string[] = []
    let killed = false

    const fakeChild = new EventEmitter() as ChildProcess & {
      stderr: PassThrough
      killed: boolean
      exitCode: number | null
      pid: number
    }
    fakeChild.stderr = new PassThrough()
    fakeChild.killed = false
    fakeChild.exitCode = null
    fakeChild.pid = 0 // 0 avoids calling real process.kill(-pid) in unit test
    fakeChild.kill = (() => {
      killed = true
      fakeChild.killed = true
      fakeChild.exitCode = 0
      queueMicrotask(() => fakeChild.emit('exit', 0, null))
      return true
    }) as ChildProcess['kill']

    const mockTransport = new MockCdpTransport('chrome')
    mockTransport.onCommand('Browser.getVersion', () => ({
      product: 'Chrome/144.0-managed',
    }))

    const manager = new ChromeConnectionManager({
      platform: 'darwin',
      env: {
        HOME: '/Users/tester',
        CLAUDE_CONFIG_DIR: '/tmp/test-claude-cfg',
      },
      fs,
      spawnFn: ((cmd: string, args: string[]) => {
        spawnedCmd = cmd
        spawnedArgs = args
        setTimeout(() => {
          fakeChild.stderr.write(
            'DevTools listening on ws://127.0.0.1:59876/devtools/browser/managed-uuid\n',
          )
        }, 10)
        return fakeChild
      }) as typeof import('node:child_process').spawn,
      transportFactory: async () => mockTransport,
    })

    const state = await manager.launchManagedChrome()
    expect(state.mode).toBe('managed')
    expect(state.port).toBe(59876)
    expect(fakeChild.stderr.listenerCount('data')).toBe(0)
    expect(spawnedCmd).toContain('Google Chrome')
    expect(spawnedArgs).toContain('--remote-debugging-port=0')
    expect(spawnedArgs).not.toContain('--remote-debugging-port=9222')
    expect(
      spawnedArgs.some(a =>
        a.startsWith(
          '--user-data-dir=/tmp/test-claude-cfg/browser-profiles/managed-chrome',
        ),
      ),
    ).toBe(true)

    await manager.disconnect()
    expect(killed).toBe(true)
  })

  it('resets state on unexpected disconnect/exit and supports runtime updateOptions', async () => {
    const activePortPath =
      '/Users/tester/Library/Application Support/Google/Chrome/DevToolsActivePort'
    const { fs } = createMemoryFs({
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome': '',
      '/custom/bin/chromium': '',
      [activePortPath]: '54321\n/devtools/browser/live-drop\n',
    })

    const mockTransport = new MockCdpTransport('chrome')
    mockTransport.onCommand('Browser.getVersion', () => ({
      product: 'Chrome/144.0',
    }))

    const manager = new ChromeConnectionManager({
      platform: 'darwin',
      env: { HOME: '/Users/tester' },
      fs,
      transportFactory: async () => mockTransport,
    })

    const attached = await manager.connectLiveAttach()
    expect(attached.mode).toBe('live_attach')

    // Simulate user closing Chrome -> transport disconnect resets state automatically
    mockTransport.simulateDisconnect('browser closed')
    expect(manager.getState().mode).toBe('disconnected')
    expect(manager.getTransport()).toBeNull()

    // Runtime updateOptions reflects newly configured custom binary without restart
    manager.updateOptions({
      customExecutablePath: '/custom/bin/chromium',
      customUserDataDir: '/custom/profile',
    })
    const browsers = manager.detectBrowsers()
    expect(browsers.some(b => b.executablePath === '/custom/bin/chromium')).toBe(
      true,
    )
  })
})
