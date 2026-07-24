import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateChangePolicy } from './change-policy'

describe('evaluateChangePolicy', () => {
  test('blocks CLI core changes without an override label', () => {
    const result = evaluateChangePolicy([
      'src/commands/help.ts',
      'desktop/src/pages/Settings.tsx',
    ])

    expect(result.blocked).toBe(true)
    expect(result.areas).toContain('cli-core')
    expect(result.areas).toContain('desktop')
    expect(result.areaLabels).toContain('area:cli-core')
    expect(result.areaLabels).toContain('area:desktop')
    expect(result.cliCoreFiles).toEqual(['src/commands/help.ts'])
  })

  test('allows CLI core changes with a maintainer override label', () => {
    const result = evaluateChangePolicy(
      ['src/tools/WebSearchTool/backend.ts'],
      ['allow-cli-core-change', 'allow-missing-tests'],
    )

    expect(result.blocked).toBe(false)
    expect(result.areas).toEqual(['cli-core'])
    expect(result.checks.server).toBe(true)
  })

  test('keeps docs-only changes on the docs lane', () => {
    const result = evaluateChangePolicy([
      'docs/index.md',
      'site/src/App.tsx',
      'README.md',
    ])

    expect(result.blocked).toBe(false)
    expect(result.areas).toEqual(['docs'])
    expect(result.checks.docs).toBe(true)
    expect(result.checks.coverage).toBe(false)
    expect(result.checks.desktop).toBe(false)
    expect(result.checks.desktopNative).toBe(false)
  })

  test('routes desktop and server changes without escalating renderer code to native packaging', () => {
    const result = evaluateChangePolicy([
      'desktop/src/pages/Settings.tsx',
      'src/server/ws/handler.ts',
    ])

    expect(result.areas).toEqual(['desktop', 'server'])
    expect(result.checks.desktop).toBe(true)
    expect(result.checks.server).toBe(true)
    expect(result.checks.desktopNative).toBe(false)
    expect(result.checks.chatContract).toBe(true)
    expect(result.checks.coverage).toBe(true)
    expect(result.missingTestSignals).toContain('Desktop product files changed without a desktop test file in the PR.')
    expect(result.missingTestSignals).toContain('Server product files changed without a server test file in the PR.')
  })

  test('keeps adapter changes off the desktop native packaging lane', () => {
    const result = evaluateChangePolicy(['adapters/telegram/index.ts'])

    expect(result.areas).toEqual(['adapters'])
    expect(result.checks.adapters).toBe(true)
    expect(result.checks.desktopNative).toBe(false)
    expect(result.checks.coverage).toBe(true)
    expect(result.blocked).toBe(true)
    expect(result.missingTestSignals).toEqual(['Adapter product files changed without an adapter test file in the PR.'])
  })

  test('allows production changes when matching tests are included', () => {
    const result = evaluateChangePolicy([
      'desktop/src/pages/Settings.tsx',
      'desktop/src/pages/Settings.test.tsx',
    ])

    expect(result.blocked).toBe(false)
    expect(result.missingTestSignals).toEqual([])
  })

  test('routes Electron and packaging changes to the native lane', () => {
    const result = evaluateChangePolicy([
      'desktop/electron/main.ts',
      'desktop/electron/main.test.ts',
    ])

    expect(result.checks.desktop).toBe(false)
    expect(result.checks.desktopNative).toBe(true)
  })

  test('routes provider runtime changes to the offline provider contract', () => {
    const result = evaluateChangePolicy([
      'src/server/services/providerRuntimeEnv.ts',
      'src/server/__tests__/provider-runtime-env.test.ts',
    ])

    expect(result.checks.server).toBe(true)
    expect(result.checks.providerContract).toBe(true)
    expect(result.checks.chatContract).toBe(false)
  })

  test('routes persistence and policy changes to their dedicated checks', () => {
    const result = evaluateChangePolicy([
      'desktop/src/lib/persistenceMigrations.ts',
      'desktop/src/lib/persistenceMigrations.test.ts',
      '.github/workflows/pr-quality.yml',
    ])

    expect(result.checks.desktop).toBe(true)
    expect(result.checks.persistence).toBe(true)
    expect(result.checks.policy).toBe(true)
  })

  test('routes desktop UI preference schema changes to the persistence check', () => {
    const result = evaluateChangePolicy([
      'src/server/services/desktopUiPreferencesService.ts',
      'src/server/__tests__/desktop-ui-preferences.test.ts',
    ])

    expect(result.checks.server).toBe(true)
    expect(result.checks.persistence).toBe(true)
  })

  test('keeps quality ownership and contributor contracts on the policy lane', () => {
    const result = evaluateChangePolicy([
      '.github/CODEOWNERS',
      '.github/copilot-instructions.md',
      'docs/guide/contributing.md',
    ])

    expect(result.checks.policy).toBe(true)
    expect(result.checks.docs).toBe(true)
  })

  test('routes root and nested agent guidance only to the policy lane', () => {
    const result = evaluateChangePolicy([
      'AGENTS.md',
      '.github/AGENTS.md',
      'src/AGENTS.md',
      'desktop/AGENTS.md',
      'adapters/AGENTS.md',
      'docs/AGENTS.md',
    ])

    expect(result.areas).toEqual([])
    expect(result.checks.policy).toBe(true)
    expect(result.checks.desktop).toBe(false)
    expect(result.checks.server).toBe(false)
    expect(result.checks.adapters).toBe(false)
    expect(result.checks.docs).toBe(false)
    expect(result.checks.coverage).toBe(false)
  })

  test('does not require a test file for non-executable desktop assets', () => {
    const result = evaluateChangePolicy([
      'desktop/src/styles/chat.css',
      'desktop/src/assets/logo.svg',
    ])

    expect(result.blocked).toBe(false)
    expect(result.missingTestSignals).toEqual([])
    expect(result.checks.desktop).toBe(true)
    expect(result.checks.coverage).toBe(false)
  })

  test('covers root runtime code outside src/server with tests and coverage', () => {
    const missing = evaluateChangePolicy(['src/services/api/client.ts'])
    expect(missing.checks.server).toBe(true)
    expect(missing.checks.providerContract).toBe(true)
    expect(missing.checks.coverage).toBe(true)
    expect(missing.missingTestSignals).toContain('Root runtime product files changed without a matching root runtime test file in the PR.')

    const covered = evaluateChangePolicy([
      'src/services/api/client.ts',
      'src/services/api/client.test.ts',
    ])
    expect(covered.blocked).toBe(false)
    expect(covered.missingTestSignals).toEqual([])
  })

  test('accepts root runtime regression tests across service and utility seams', () => {
    const result = evaluateChangePolicy(
      [
        'src/utils/messages.ts',
        'src/services/api/streamRetry.test.ts',
      ],
      ['allow-cli-core-change'],
    )

    expect(result.missingTestSignals).toEqual([])
    expect(result.blocked).toBe(false)
  })

  test('blocks coverage baseline and threshold changes without maintainer override', () => {
    const result = evaluateChangePolicy([
      'scripts/quality-gate/coverage-baseline.json',
      'scripts/quality-gate/coverage-thresholds.json',
    ])

    expect(result.blocked).toBe(true)
    expect(result.coveragePolicyFiles).toEqual([
      'scripts/quality-gate/coverage-baseline.json',
      'scripts/quality-gate/coverage-thresholds.json',
    ])
    expect(result.blockingReasons).toContain('Coverage baseline or threshold changes require the allow-coverage-baseline-change label and maintainer approval.')
  })

  test('allows coverage baseline changes with maintainer override', () => {
    const result = evaluateChangePolicy(
      ['scripts/quality-gate/coverage-baseline.json'],
      ['allow-coverage-baseline-change'],
    )

    expect(result.blocked).toBe(false)
  })

  test('normalizes relative and windows-style paths before classification', () => {
    const result = evaluateChangePolicy([
      './desktop\\src\\pages\\Settings.tsx',
      './desktop\\src\\pages\\Settings.test.tsx',
      './scripts\\quality-gate\\coverage.ts',
    ])

    expect(result.files).toContain('desktop/src/pages/Settings.tsx')
    expect(result.files).toContain('scripts/quality-gate/coverage.ts')
    expect(result.areas).toContain('desktop')
    expect(result.checks.coverage).toBe(true)
    expect(result.blocked).toBe(false)
  })

  test('plan-only mode publishes a blocked scope without preventing product jobs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'change-policy-plan-'))
    try {
      const filesPath = join(dir, 'files.txt')
      const labelsPath = join(dir, 'labels.txt')
      const outputPath = join(dir, 'github-output.txt')
      writeFileSync(filesPath, 'desktop/src/pages/Settings.tsx\n')
      writeFileSync(labelsPath, '')

      const proc = Bun.spawn([
        'bun',
        'run',
        'scripts/pr/change-policy.ts',
        '--files',
        filesPath,
        '--labels-file',
        labelsPath,
        '--plan-only',
      ], {
        cwd: process.cwd(),
        env: { ...process.env, GITHUB_OUTPUT: outputPath },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(await proc.exited).toBe(0)
      const outputs = readFileSync(outputPath, 'utf8')
      expect(outputs).toContain('blocked=true')
      expect(outputs).toContain('desktop_checks=true')
      expect(outputs).toContain('desktop_native_checks=false')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
