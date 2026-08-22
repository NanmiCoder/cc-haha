import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  buildDesktopSmokeBrowserEnv,
  DESKTOP_SMOKE_COMPOSER_SELECTOR,
  DESKTOP_SMOKE_RUN_SELECTOR,
  desktopSmokeAppUrl,
  desktopSmokeTextShowsProject,
  resolveAgentBrowserExecutable,
  resolveDesktopSmokeRuntimeSelection,
  resolveDesktopViteExecutable,
} from './execute'

test('uses localhost for the browser origin so Windows proxy bypass applies to Vite modules', () => {
  expect(desktopSmokeAppUrl(5173)).toBe('http://localhost:5173')
})

test('targets the ProseMirror composer rendered by the desktop chat input', () => {
  expect(DESKTOP_SMOKE_COMPOSER_SELECTOR).toBe('[data-composer-editor]')
  expect(readFileSync('desktop/src/components/chat/MentionComposer.tsx', 'utf8'))
    .toContain("'data-composer-editor': 'true'")
})

test('submits through the visible Run control instead of relying on cross-process focus', () => {
  expect(DESKTOP_SMOKE_RUN_SELECTOR).toContain('button[aria-label="Run"]')
  expect(DESKTOP_SMOKE_RUN_SELECTOR).toContain('button[aria-label="运行"]')
  const component = readFileSync('desktop/src/components/chat/ChatInput.tsx', 'utf8')
  const smoke = readFileSync('scripts/quality-gate/desktop-smoke/execute.ts', 'utf8')
  expect(component).toContain("t('common.run')")
  expect(smoke).toContain("['type', DESKTOP_SMOKE_COMPOSER_SELECTOR, PROMPT]")
})

test('normalizes changed fixture paths before enforcing the file allowlist', () => {
  const source = readFileSync('scripts/quality-gate/desktop-smoke/execute.ts', 'utf8')
  expect(source).toContain("changedFiles(originalDir, projectDir).map((file) => file.replaceAll('\\\\', '/'))")
})

test('stops spawned process trees before removing the Windows fixture directory', () => {
  const source = readFileSync('scripts/quality-gate/desktop-smoke/execute.ts', 'utf8')
  expect(source).toContain("stopDesktopSmokeProcess(server, 'server', serverLogPath)")
  expect(source).toContain("stopDesktopSmokeProcess(vite, 'Vite', viteLogPath)")
  expect(source.indexOf('stopDesktopSmokeProcess(server'))
    .toBeLessThan(source.lastIndexOf('removeDesktopSmokeTree(workRoot)'))
})

describe('desktop smoke Vite executable resolution', () => {
  test('uses Bun\'s Windows executable shim when vite.cmd is absent', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'cc-haha-vite-shim-'))
    const binDir = join(rootDir, 'desktop', 'node_modules', '.bin')
    mkdirSync(binDir, { recursive: true })
    const executable = join(binDir, 'vite.exe')
    writeFileSync(executable, '')

    try {
      expect(resolveDesktopViteExecutable(rootDir, 'win32')).toBe(executable)
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  test('falls back to npm\'s Windows command shim', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'cc-haha-vite-shim-'))
    const binDir = join(rootDir, 'desktop', 'node_modules', '.bin')
    mkdirSync(binDir, { recursive: true })
    const executable = join(binDir, 'vite.cmd')
    writeFileSync(executable, '')

    try {
      expect(resolveDesktopViteExecutable(rootDir, 'win32')).toBe(executable)
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })
})

describe('desktop smoke agent-browser executable resolution', () => {
  test('unwraps the npm command shim to the native Windows executable', () => {
    const npmDir = mkdtempSync(join(tmpdir(), 'cc-haha-agent-browser-'))
    const commandShim = join(npmDir, 'agent-browser.cmd')
    const executable = join(
      npmDir,
      'node_modules',
      'agent-browser',
      'bin',
      'agent-browser-win32-x64.exe',
    )
    mkdirSync(dirname(executable), { recursive: true })
    writeFileSync(commandShim, '')
    writeFileSync(executable, '')

    try {
      expect(resolveAgentBrowserExecutable(commandShim, 'win32', 'x64')).toBe(executable)
    } finally {
      rmSync(npmDir, { recursive: true, force: true })
    }
  })

  test('reports a command shim without its native binary as unavailable', () => {
    expect(resolveAgentBrowserExecutable('C:\\npm\\agent-browser.cmd', 'win32', 'x64')).toBeNull()
  })
})

describe('desktop smoke runtime selection', () => {
  test('lets current-runtime use the desktop default active provider', () => {
    expect(resolveDesktopSmokeRuntimeSelection({
      providerId: null,
      modelId: 'current',
      label: 'current-runtime',
    })).toBeNull()
  })

  test('keeps explicit official and saved provider selections scoped to the session', () => {
    expect(resolveDesktopSmokeRuntimeSelection({
      providerId: null,
      modelId: 'claude-sonnet-4-6',
      label: 'official-sonnet',
    })).toEqual({
      providerId: null,
      modelId: 'claude-sonnet-4-6',
    })

    expect(resolveDesktopSmokeRuntimeSelection({
      providerId: 'provider-a',
      modelId: 'model-a',
      label: 'provider-a-main',
    })).toEqual({
      providerId: 'provider-a',
      modelId: 'model-a',
    })
  })
})

describe('desktop smoke browser environment', () => {
  test('scopes agent-browser to a temporary session and bypasses loopback proxy traffic', () => {
    expect(buildDesktopSmokeBrowserEnv('session-a', '/tmp/profile-a', {
      NO_PROXY: 'internal.example.com',
    })).toEqual({
      AGENT_BROWSER_SESSION: 'session-a',
      AGENT_BROWSER_PROFILE: '/tmp/profile-a',
      NO_PROXY: 'internal.example.com,127.0.0.1,localhost,::1,[::1]',
      no_proxy: 'internal.example.com,127.0.0.1,localhost,::1,[::1]',
    })
  })

  test('deduplicates existing lowercase no_proxy loopback entries', () => {
    expect(buildDesktopSmokeBrowserEnv('session-b', '/tmp/profile-b', {
      no_proxy: 'localhost,127.0.0.1',
    })).toEqual({
      AGENT_BROWSER_SESSION: 'session-b',
      AGENT_BROWSER_PROFILE: '/tmp/profile-b',
      NO_PROXY: 'localhost,127.0.0.1,::1,[::1]',
      no_proxy: 'localhost,127.0.0.1,::1,[::1]',
    })
  })
})

describe('desktop smoke restored session detection', () => {
  test('waits for the target project chip instead of the first empty-session textarea', () => {
    expect(desktopSmokeTextShowsProject([
      '新建会话',
      '随便问点什么...',
      'folder_open 选择项目...',
    ].join('\n'), 'project')).toBe(false)

    expect(desktopSmokeTextShowsProject([
      'Untitled Session',
      '让 Claude 编辑、调试或解释代码...',
      'folder',
      'project',
    ].join('\n'), 'project')).toBe(true)

    expect(desktopSmokeTextShowsProject([
      'Untitled Session',
      'folder',
      'C:\\isolated\\fixture\\project',
    ].join('\n'), 'C:\\isolated\\fixture\\project')).toBe(true)
  })
})
