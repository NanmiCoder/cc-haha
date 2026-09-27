import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createElectronDevEnv, DEFAULT_RENDERER_URL, mergeNoProxy, resolveElectronExecutable } from './electron-dev'

// resolveElectronExecutable 依赖 node_modules/electron/dist 真实存在,
// 但 bun 默认不执行 electron 的 postinstall 下载,dist 在本机/CI 经常缺席。
// 测试用自带夹具 desktopRoot,不依赖环境安装状态。
function createDesktopRootFixture(withExecutables = true) {
  const root = mkdtempSync(path.join(tmpdir(), 'cc-haha-dev-launcher-'))
  if (!withExecutables) return root
  const dist = path.join(root, 'node_modules', 'electron', 'dist')
  mkdirSync(path.join(dist, 'Electron.app', 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(path.join(dist, 'electron.exe'), '')
  writeFileSync(path.join(dist, 'electron'), '')
  writeFileSync(path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron'), '')
  return root
}

describe('desktop dev launcher environment', () => {
  it('uses localhost and bypasses proxies for local renderer startup', () => {
    const env = createElectronDevEnv({
      HTTPS_PROXY: 'http://proxy.example',
      NO_PROXY: 'example.com',
    })

    expect(env.ELECTRON_RENDERER_URL).toBe(DEFAULT_RENDERER_URL)
    expect(env.CC_HAHA_TRUSTED_RENDERER_ORIGIN).toBe(DEFAULT_RENDERER_URL)
    expect(env.NO_PROXY).toBe('example.com,localhost,127.0.0.1,::1')
    expect(env.no_proxy).toBe(env.NO_PROXY)
  })

  it('preserves explicit renderer URL while adding missing local no_proxy entries', () => {
    const env = createElectronDevEnv({
      ELECTRON_RENDERER_URL: 'http://localhost:1777',
      no_proxy: 'localhost',
    })

    expect(env.ELECTRON_RENDERER_URL).toBe('http://localhost:1777')
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1')
    expect(env.no_proxy).toBe(env.NO_PROXY)
  })

  it('derives the exact trusted origin from the validated renderer URL', () => {
    const env = createElectronDevEnv({
      ELECTRON_RENDERER_URL: ' http://localhost:1777/app?dev=1 ',
      CC_HAHA_TRUSTED_RENDERER_ORIGIN: 'https://untrusted.example',
    })
    expect(env.CC_HAHA_TRUSTED_RENDERER_ORIGIN).toBe('http://localhost:1777')
    expect(() => createElectronDevEnv({ ELECTRON_RENDERER_URL: 'https://untrusted.example' })).toThrow('Refusing non-local')
  })

  it('deduplicates no_proxy entries', () => {
    expect(mergeNoProxy('localhost,127.0.0.1')).toBe('localhost,127.0.0.1,::1')
  })

  it.each([
    ['win32', /electron\.exe$/],
    ['darwin', /Electron\.app[\\/]Contents[\\/]MacOS[\\/]Electron$/],
    ['linux', /dist[\\/]electron$/],
  ] as const)('resolves the %s Electron executable directly instead of shelling through bunx', (platform, pattern) => {
    expect(resolveElectronExecutable(createDesktopRootFixture(), platform)).toMatch(pattern)
  })

  it('throws an actionable error when the Electron executable is missing', () => {
    expect(() => resolveElectronExecutable(createDesktopRootFixture(false), 'linux')).toThrow(/Electron executable not found/)
  })
})