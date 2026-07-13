import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildRootCoverageCommand,
  collectServerTestFiles,
  evaluateChangedLineCoverage,
  evaluateThresholds,
  hasUsableCoverageSummary,
  hasUsableLcov,
  parseBunTestFileCount,
  parseChangedLinesFromDiff,
  parseLcov,
  prefixRelativeLcovSourcePaths,
} from './coverage'

describe('coverage gate helpers', () => {
  test('collects root coverage with the transcript classifier build feature enabled', () => {
    expect(buildRootCoverageCommand('/tmp/coverage', ['src/example.test.ts'])).toEqual([
      'bun',
      '--no-env-file',
      '--feature=TRANSCRIPT_CLASSIFIER',
      'test',
      '--timeout=20000',
      '--coverage',
      '--coverage-reporter=lcov',
      '--coverage-reporter=text',
      '--coverage-dir',
      '/tmp/coverage/root-server',
      './src/example.test.ts',
    ])
  })

  test('parses lcov totals into percentages', () => {
    const summary = parseLcov([
      'TN:',
      'SF:src/a.ts',
      'FNF:4',
      'FNH:3',
      'BRF:10',
      'BRH:7',
      'LF:20',
      'LH:18',
      'end_of_record',
      'SF:src/b.ts',
      'FNF:1',
      'FNH:1',
      'LF:10',
      'LH:5',
      'end_of_record',
    ].join('\n'))

    expect(summary.lines.pct).toBe(76.67)
    expect(summary.functions.pct).toBe(80)
    expect(summary.branches.pct).toBe(70)
  })

  test('filters lcov records to an explicit source scope', () => {
    const summary = parseLcov([
      'TN:',
      'SF:/repo/src/server/routes.ts',
      'LF:10',
      'LH:8',
      'FNF:2',
      'FNH:2',
      'end_of_record',
      'SF:/repo/desktop/src-tauri/target/generated.js',
      'LF:100',
      'LH:0',
      'FNF:10',
      'FNH:0',
      'end_of_record',
    ].join('\n'), {
      rootDir: '/repo',
      scope: {
        id: 'server-api',
        title: 'Server/API',
        includePrefixes: ['src/server/'],
      },
    })

    expect(summary.lines.pct).toBe(80)
    expect(summary.functions.pct).toBe(100)
  })

  test('fails closed when lcov has no source-file records', () => {
    expect(hasUsableLcov('')).toBe(false)
    expect(hasUsableLcov('TN:\nend_of_record\n')).toBe(false)
    expect(hasUsableLcov('SF:src/server/empty.ts\nend_of_record\n')).toBe(false)
    expect(hasUsableLcov([
      'SF:src/server/routes.ts',
      'DA:1,1',
      'LF:1',
      'LH:1',
      'end_of_record',
    ].join('\n'))).toBe(true)
  })

  test('normalizes Windows lcov source paths into repository-relative scope paths', () => {
    const summary = parseLcov([
      'SF:C:\\repo\\src\\server\\routes.ts',
      'DA:1,1',
      'DA:2,0',
      'LF:2',
      'LH:1',
      'end_of_record',
    ].join('\n'), {
      rootDir: 'C:\\repo',
      scope: {
        id: 'server-api',
        title: 'Server/API',
        includePrefixes: ['src/server/'],
      },
    })

    expect(summary.lines.pct).toBe(50)
  })

  test('requires Bun coverage to report every discovered test file', () => {
    expect(parseBunTestFileCount('Ran 1605 tests across 141 files. [187.20s]')).toBe(141)
    expect(parseBunTestFileCount('Ran 1 test across 1 file. [10.00ms]')).toBe(1)
    expect(parseBunTestFileCount('process terminated before summary')).toBeNull()
  })

  test('rejects empty aggregate coverage summaries', () => {
    expect(hasUsableCoverageSummary({
      lines: { total: 0, covered: 0, pct: 100 },
      functions: { total: 0, covered: 0, pct: 100 },
      branches: { total: 0, covered: 0, pct: 100 },
      statements: { total: 0, covered: 0, pct: 100 },
    })).toBe(false)
  })

  test('prefixes package-relative lcov source paths for changed-line coverage', () => {
    const lcov = prefixRelativeLcovSourcePaths([
      'TN:',
      'SF:src/stores/updateStore.ts',
      'LF:1',
      'LH:1',
      'end_of_record',
      'SF:/repo/desktop/src/main.tsx',
      'LF:1',
      'LH:0',
      'end_of_record',
      'SF:desktop/src/App.tsx',
      'LF:1',
      'LH:1',
      'end_of_record',
    ].join('\n'), 'desktop')

    expect(lcov).toContain('SF:desktop/src/stores/updateStore.ts')
    expect(lcov).toContain('SF:/repo/desktop/src/main.tsx')
    expect(lcov).toContain('SF:desktop/src/App.tsx')
  })

  test('evaluates changed executable line coverage', () => {
    const changedLines = parseChangedLinesFromDiff([
      'diff --git a/src/server/routes.ts b/src/server/routes.ts',
      '--- a/src/server/routes.ts',
      '+++ b/src/server/routes.ts',
      '@@ -10,0 +11,2 @@',
      '+const covered = true',
      '+const uncovered = false',
    ].join('\n'))

    const failures = evaluateChangedLineCoverage(
      changedLines,
      new Map([
        ['src/server/routes.ts', {
          suiteId: 'server-api',
          executableLines: new Set([11, 12]),
          coveredLines: new Set([11]),
        }],
      ]),
      [{
        id: 'server-api',
        title: 'Server/API',
        includePrefixes: ['src/server/'],
      }],
      90,
    ).failures

    expect(failures).toEqual(['changed-lines: coverage 50% is below minimum 90%'])
  })

  test('excludes non-instrumented desktop styles from changed-line coverage', () => {
    const changedLines = parseChangedLinesFromDiff([
      'diff --git a/desktop/src/theme/globals.css b/desktop/src/theme/globals.css',
      '--- a/desktop/src/theme/globals.css',
      '+++ b/desktop/src/theme/globals.css',
      '@@ -10,0 +11,2 @@',
      '+.sidebar {',
      '+  color: var(--color-text-primary);',
      '+}',
      'diff --git a/desktop/src/main.tsx b/desktop/src/main.tsx',
      '--- a/desktop/src/main.tsx',
      '+++ b/desktop/src/main.tsx',
      '@@ -20,0 +21,1 @@',
      '+bootstrapDesktopApp()',
    ].join('\n'))

    const result = evaluateChangedLineCoverage(
      changedLines,
      new Map([
        ['desktop/src/main.tsx', {
          suiteId: 'desktop',
          executableLines: new Set([21]),
          coveredLines: new Set([21]),
        }],
      ]),
      [{
        id: 'desktop',
        title: 'Desktop',
        includePrefixes: ['desktop/src/'],
        excludeSuffixes: ['.css'],
      }],
      90,
    )

    expect(result.files).toEqual([{
      file: 'desktop/src/main.tsx',
      suiteId: 'desktop',
      covered: 1,
      total: 1,
      pct: 100,
    }])
    expect(result.failures).toEqual([])
  })

  test('excludes repository guidance from changed-line coverage', () => {
    const changedLines = parseChangedLinesFromDiff([
      'diff --git a/adapters/AGENTS.md b/adapters/AGENTS.md',
      '--- /dev/null',
      '+++ b/adapters/AGENTS.md',
      '@@ -0,0 +1,2 @@',
      '+# Adapter Instructions',
      '+Use deterministic tests.',
    ].join('\n'))

    const result = evaluateChangedLineCoverage(
      changedLines,
      new Map(),
      [{
        id: 'adapters',
        title: 'IM adapters',
        includePrefixes: ['adapters/'],
      }],
      90,
    )

    expect(result.files).toEqual([])
    expect(result.total).toBe(0)
    expect(result.failures).toEqual([])
  })

  test('enforces changed-line coverage for root runtime outside server, tools, and utils', () => {
    const changedLines = parseChangedLinesFromDiff([
      'diff --git a/src/services/api/client.ts b/src/services/api/client.ts',
      '--- a/src/services/api/client.ts',
      '+++ b/src/services/api/client.ts',
      '@@ -1,0 +1,2 @@',
      '+export const first = true',
      '+export const second = true',
    ].join('\n'))
    const coverageByFile = new Map([
      ['src/services/api/client.ts', {
        suiteId: 'root-runtime',
        executableLines: new Set([1, 2]),
        coveredLines: new Set([1]),
      }],
    ])

    const result = evaluateChangedLineCoverage(
      changedLines,
      coverageByFile,
      [{
        id: 'root-runtime',
        title: 'Root runtime',
        includePrefixes: ['src/'],
      }],
      90,
    )

    expect(result.total).toBe(2)
    expect(result.pct).toBe(50)
    expect(result.failures).toEqual([
      'changed-lines: coverage 50% is below minimum 90%',
    ])
  })

  test('reports minimum threshold failures', () => {
    const failures = evaluateThresholds([
      {
        id: 'root-server',
        title: 'Root',
        status: 'passed',
        command: ['bun', 'test'],
        durationMs: 1,
        logPath: 'coverage.log',
        summary: {
          lines: { total: 100, covered: 79, pct: 79 },
          functions: { total: 10, covered: 9, pct: 90 },
          branches: { total: 10, covered: 8, pct: 80 },
          statements: { total: 100, covered: 79, pct: 79 },
        },
      },
    ], {
      schemaVersion: 1,
      minimums: {
        'root-server': {
          lines: 80,
        },
      },
    })

    expect(failures).toEqual(['root-server: lines coverage 79% is below minimum 80%'])
  })

  test('treats failed suite execution as a coverage failure', () => {
    const failures = evaluateThresholds([
      {
        id: 'desktop',
        title: 'Desktop',
        status: 'failed',
        command: ['bun', 'run', 'test'],
        durationMs: 1,
        logPath: 'coverage.log',
        error: 'coverage command exited with 1',
      },
    ], {
      schemaVersion: 1,
      minimums: {},
    })

    expect(failures).toEqual(['desktop: coverage command exited with 1'])
  })

  test('collects non-quarantined server tests when review windows have expired', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-haha-coverage-'))
    try {
      mkdirSync(join(root, 'src/server/__tests__'), { recursive: true })
      mkdirSync(join(root, 'src/services'), { recursive: true })
      mkdirSync(join(root, 'src/tools'), { recursive: true })
      mkdirSync(join(root, 'src/utils'), { recursive: true })
      writeFileSync(join(root, 'src/server/__tests__/active.test.ts'), '')
      writeFileSync(join(root, 'src/server/__tests__/component.test.tsx'), '')
      writeFileSync(join(root, 'src/server/__tests__/quarantined.test.ts'), '')
      writeFileSync(join(root, 'src/services/runtime.test.ts'), '')

      const files = collectServerTestFiles(root, {
        quarantined: [
          {
            id: 'server:expired',
            path: 'src/server/__tests__/quarantined.test.ts',
            reason: 'Known instability under review.',
            owner: 'maintainers',
            reviewAfter: '2026-01-01',
            exitCriteria: 'Make deterministic or remove from quarantine.',
          },
        ],
      })

      expect(files).toEqual([
        'src/server/__tests__/active.test.ts',
        'src/server/__tests__/component.test.tsx',
        'src/services/runtime.test.ts',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('does not require every suite to exist in the ratchet baseline', () => {
    const failures = evaluateThresholds([
      {
        id: 'new-suite',
        title: 'New suite',
        status: 'passed',
        command: ['bun', 'test'],
        durationMs: 1,
        logPath: 'coverage.log',
        summary: {
          lines: { total: 100, covered: 90, pct: 90 },
          functions: { total: 10, covered: 9, pct: 90 },
          branches: { total: 10, covered: 8, pct: 80 },
          statements: { total: 100, covered: 90, pct: 90 },
        },
      },
    ], {
      schemaVersion: 1,
      minimums: {
        'new-suite': {
          branches: 85,
        },
      },
      ratchet: {
        baselinePath: 'scripts/quality-gate/coverage-baseline.json',
        allowedDropPercent: 0,
      },
    })

    expect(failures).toEqual(['new-suite: branches coverage 80% is below minimum 85%'])
  })
})
