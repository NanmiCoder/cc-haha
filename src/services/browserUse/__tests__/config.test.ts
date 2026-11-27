import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  DEFAULT_BROWSER_USE_CONFIG,
  getBrowserUseConfigPath,
  getManagedChromeProfileDir,
  invalidateBrowserUseConfigCache,
  isBrowserUseEnabled,
  loadBrowserUseConfig,
  saveBrowserUseConfig,
} from '../config'

describe('browserUse/config', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'cc-haha-browser-config-'))
    invalidateBrowserUseConfigCache()
  })

  afterEach(() => {
    invalidateBrowserUseConfigCache()
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('resolves config path using CLAUDE_CONFIG_DIR or HOME', () => {
    const withExplicit = getBrowserUseConfigPath({
      CLAUDE_CONFIG_DIR: join(tempRoot, 'custom-claude'),
      HOME: join(tempRoot, 'home'),
    })
    expect(withExplicit).toBe(
      join(tempRoot, 'custom-claude', 'cc-haha', 'browser-use-config.json'),
    )

    const withHome = getBrowserUseConfigPath({
      HOME: join(tempRoot, 'home'),
    })
    expect(withHome).toBe(
      join(tempRoot, 'home', '.claude', 'cc-haha', 'browser-use-config.json'),
    )

    const managedDir = getManagedChromeProfileDir({
      CLAUDE_CONFIG_DIR: join(tempRoot, 'custom-claude'),
    })
    expect(managedDir).toBe(
      join(tempRoot, 'custom-claude', 'browser-profiles', 'managed-chrome'),
    )
  })

  it('fails closed with enabled: false when config is missing or malformed', () => {
    const env = { CLAUDE_CONFIG_DIR: join(tempRoot, 'cfg') }
    const missing = loadBrowserUseConfig({ env })
    expect(missing).toEqual(DEFAULT_BROWSER_USE_CONFIG)
    expect(isBrowserUseEnabled({ env })).toBe(false)

    const configPath = getBrowserUseConfigPath(env)
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '{ invalid json !!!', 'utf8')
    invalidateBrowserUseConfigCache()

    expect(loadBrowserUseConfig({ env }).enabled).toBe(false)
    expect(isBrowserUseEnabled({ env })).toBe(false)

    writeFileSync(configPath, '["not-an-object"]', 'utf8')
    invalidateBrowserUseConfigCache()
    expect(loadBrowserUseConfig({ env }).enabled).toBe(false)
  })

  it('saves atomically with 0o600 permissions and preserves unknown keys', () => {
    const env = { CLAUDE_CONFIG_DIR: join(tempRoot, 'cfg') }
    const configPath = getBrowserUseConfigPath(env)
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(
      configPath,
      JSON.stringify({
        enabled: false,
        futureFeatureFlag: 'keep-me',
        nestedUnknown: { a: 1, b: true },
      }),
      'utf8',
    )

    const saved = saveBrowserUseConfig(
      {
        enabled: true,
        preferredTarget: 'chrome',
        showCursorOverlay: false,
        blockedLoopbackPorts: [3456, 7890],
      },
      { env },
    )

    expect(saved.enabled).toBe(true)
    expect(saved.preferredTarget).toBe('chrome')
    expect(saved.showCursorOverlay).toBe(false)
    expect(saved.blockedLoopbackPorts).toEqual([3456, 7890])

    if (process.platform !== 'win32') {
      const mode = statSync(configPath).mode & 0o777
      expect(mode).toBe(0o600)
    }

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as Record<
      string,
      unknown
    >
    expect(onDisk.futureFeatureFlag).toBe('keep-me')
    expect(onDisk.nestedUnknown).toEqual({ a: 1, b: true })
    expect(onDisk.enabled).toBe(true)
  })

  it('caches config reads and invalidates cleanly on demand', () => {
    const env = { CLAUDE_CONFIG_DIR: join(tempRoot, 'cfg') }
    saveBrowserUseConfig({ enabled: true }, { env })
    expect(isBrowserUseEnabled({ env })).toBe(true)

    // External edit on disk while cached
    const configPath = getBrowserUseConfigPath(env)
    writeFileSync(configPath, JSON.stringify({ enabled: false }), 'utf8')
    expect(isBrowserUseEnabled({ env })).toBe(true)

    // Invalidating cache immediately reflects disk state
    invalidateBrowserUseConfigCache()
    expect(isBrowserUseEnabled({ env })).toBe(false)
  })
})
