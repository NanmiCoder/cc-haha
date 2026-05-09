import { describe, expect, test } from 'bun:test'
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
      'README.md',
    ])

    expect(result.blocked).toBe(false)
    expect(result.areas).toEqual(['docs'])
    expect(result.checks.docs).toBe(true)
    expect(result.checks.coverage).toBe(false)
    expect(result.checks.desktop).toBe(false)
    expect(result.checks.desktopNative).toBe(false)
  })

  test('routes desktop and server changes to desktop and native checks', () => {
    const result = evaluateChangePolicy([
      'desktop/src/pages/Settings.tsx',
      'src/server/ws/handler.ts',
    ])

    expect(result.areas).toEqual(['desktop', 'server'])
    expect(result.checks.desktop).toBe(true)
    expect(result.checks.server).toBe(true)
    expect(result.checks.desktopNative).toBe(true)
    expect(result.checks.coverage).toBe(true)
    expect(result.missingTestSignals).toContain('Desktop product files changed without a desktop test file in the PR.')
    expect(result.missingTestSignals).toContain('Server product files changed without a server test file in the PR.')
  })

  test('routes adapter changes to adapter and native checks', () => {
    const result = evaluateChangePolicy(['adapters/telegram/index.ts'])

    expect(result.areas).toEqual(['adapters'])
    expect(result.checks.adapters).toBe(true)
    expect(result.checks.desktopNative).toBe(true)
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
})
