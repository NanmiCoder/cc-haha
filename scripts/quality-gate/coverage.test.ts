import { describe, expect, test } from 'bun:test'
import {
  evaluateChangedLineCoverage,
  evaluateThresholds,
  parseChangedLinesFromDiff,
  parseLcov,
  prefixRelativeLcovSourcePaths,
} from './coverage'

describe('coverage gate helpers', () => {
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
