import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DESKTOP_UI_SMOKE_ALLOW_SELECTOR,
  DESKTOP_UI_SMOKE_LOCALE,
  buildDesktopUiSmokeBootstrap,
  buildDesktopUiSmokePrompt,
  describeDesktopUiSmokePrerequisites,
  seedDesktopUiSmokeProvider,
} from './deterministic'

describe('deterministic desktop UI smoke setup', () => {
  test('pins the locale so the approval button label is stable for every contributor', () => {
    const bootstrap = buildDesktopUiSmokeBootstrap('session-1')

    expect(bootstrap).toContain(`localStorage.setItem('cc-haha-locale', "${DESKTOP_UI_SMOKE_LOCALE}")`)
    expect(bootstrap).toContain('cc-haha-open-tabs')
    expect(bootstrap).toContain('session-1')
    // No per-session runtime is pinned: the lane uses its isolated active provider.
    expect(bootstrap).toContain("localStorage.removeItem('cc-haha-session-runtime')")
  })

  test('matches the approval button the desktop actually renders', () => {
    const dialog = readFileSync('desktop/src/components/chat/PermissionDialog.tsx', 'utf8')
    const english = readFileSync('desktop/src/i18n/locales/en.ts', 'utf8')

    // The selector is derived from the production aria-label and the pinned locale;
    // if either changes, this test fails before the lane starts timing out.
    expect(dialog).toContain("aria-label={`${t('permission.allow')}: ${permissionContext}`}")
    expect(english).toContain("'permission.allow': 'Allow'")
    expect(DESKTOP_UI_SMOKE_ALLOW_SELECTOR).toBe('button[aria-label^="Allow: "]')
  })

  test('asks the mock runtime to write inside the fixture copy only', () => {
    const projectDir = '/tmp/fixture-copy'
    const { target, prompt } = buildDesktopUiSmokePrompt(projectDir)

    expect(target).toBe(join(projectDir, 'ui-smoke-output.txt'))
    expect(prompt.startsWith('MOCK_TOOL ')).toBe(true)
    const payload = JSON.parse(prompt.slice('MOCK_TOOL '.length))
    expect(payload.tool).toBe('Write')
    expect(payload.write.path).toBe(target)
    expect(payload.write.content).toBe('written-through-the-desktop-ui')
  })

  test('seeds only a fake provider inside the sandbox', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'cc-haha-ui-smoke-provider-'))
    try {
      seedDesktopUiSmokeProvider(configDir)
      const index = JSON.parse(readFileSync(join(configDir, 'cc-haha', 'providers.json'), 'utf8'))
      expect(index.activeId).toBe('desktop-ui-smoke-provider')
      expect(index.providers).toHaveLength(1)
      expect(index.providers[0]).toMatchObject({
        apiKey: 'desktop-ui-smoke-fake-key',
        baseUrl: 'http://127.0.0.1:1',
      })
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('skips with an actionable reason instead of failing when prerequisites are missing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'cc-haha-ui-smoke-prereq-'))
    try {
      expect(describeDesktopUiSmokePrerequisites(empty)).toContain('desktop dependencies')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test('runs the real UI against the mock runtime with a sandboxed config dir', () => {
    const source = readFileSync('scripts/quality-gate/desktop-smoke/deterministic.ts', 'utf8')

    expect(source).toContain('src/server/__tests__/fixtures/mock-sdk-cli.ts')
    expect(source).toContain('CLAUDE_CLI_PATH')
    expect(source).toContain('seedProviders: false')
    expect(source).toContain('seedDesktopUiSmokeProvider(sandbox.configDir)')
    expect(source).toContain('...sandbox.env')
    expect(source).toContain('applyUserStateGuard')
    // The lane must answer the permission through the UI. Flipping the global
    // permission mode is what made the old smoke both unsafe and blind to the
    // approval screen.
    expect(source).toContain(DESKTOP_UI_SMOKE_ALLOW_SELECTOR)
    expect(source).toContain("['type', DESKTOP_SMOKE_COMPOSER_SELECTOR, prompt]")
    expect(source).toContain("['click', DESKTOP_SMOKE_RUN_SELECTOR]")
    // No global permission-mode switch: the old smoke PUT bypassPermissions on the
    // settings API, which both skipped the approval screen and mutated user state.
    expect(source).not.toContain('/api/permissions/mode')
    expect(source).not.toContain('setPermissionMode')
    expect(source).toContain('before the permission dialog was answered')
  })
})
