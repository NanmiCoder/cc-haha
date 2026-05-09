import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lanesForMode } from './modes'
import { renderJUnitReport, renderMarkdownReport } from './reporter'
import { runQualityGate, runQualityGateLanes } from './runner'
import type { LaneDefinition, QualityGateReport } from './types'

describe('quality gate modes', () => {
  test('pr mode includes existing path-aware PR checks', () => {
    const lanes = lanesForMode('pr').map((lane) => lane.id)
    expect(lanes).toContain('impact-report')
    expect(lanes).toContain('policy-checks')
    expect(lanes).toContain('desktop-checks')
    expect(lanes).toContain('server-checks')
    expect(lanes).toContain('adapter-checks')
    expect(lanes).toContain('native-checks')
    expect(lanes).toContain('docs-checks')
    expect(lanes).toContain('persistence-upgrade')
    expect(lanes).toContain('quarantine')
    expect(lanes).toContain('coverage')
    expect(lanes.some((lane) => lane.startsWith('baseline:'))).toBe(false)
  })

  test('baseline mode includes live baseline cases but not native checks', () => {
    const lanes = lanesForMode('baseline').map((lane) => lane.id)
    expect(lanes).toContain('baseline-catalog')
    expect(lanes).toContain('quarantine')
    expect(lanes).toContain('coverage')
    expect(lanes).toContain('baseline:failing-unit:current-runtime')
    expect(lanes).toContain('provider-smoke:current-runtime')
    expect(lanes).toContain('baseline:multi-file-api:current-runtime')
    expect(lanes).toContain('desktop-smoke:agent-browser-chat:current-runtime')
    expect(lanes).not.toContain('native-checks')
  })

  test('release mode composes PR, baseline, and native lanes', () => {
    const lanes = lanesForMode('release').map((lane) => lane.id)
    expect(lanes).toContain('policy-checks')
    expect(lanes).toContain('persistence-upgrade')
    expect(lanes).toContain('quarantine')
    expect(lanes).toContain('coverage')
    expect(lanes).toContain('baseline:failing-unit:current-runtime')
    expect(lanes).toContain('provider-smoke:current-runtime')
    expect(lanes).toContain('desktop-smoke:agent-browser-chat:current-runtime')
    expect(lanes).toContain('native-checks')
  })

  test('baseline mode expands cases across explicit provider/model targets', () => {
    const lanes = lanesForMode('baseline', [
      { providerId: 'provider-a', modelId: 'model-a', label: 'provider-a-model-a' },
      { providerId: 'provider-b', modelId: 'model-b', label: 'provider-b-model-b' },
    ]).map((lane) => lane.id)

    expect(lanes).toContain('baseline:failing-unit:provider-a-model-a')
    expect(lanes).toContain('baseline:failing-unit:provider-b-model-b')
    expect(lanes).toContain('baseline:multi-file-api:provider-a-model-a')
    expect(lanes).toContain('baseline:multi-file-api:provider-b-model-b')
    expect(lanes).toContain('provider-smoke:provider-a-model-a')
    expect(lanes).toContain('provider-smoke:provider-b-model-b')
    expect(lanes).toContain('desktop-smoke:agent-browser-chat:provider-a-model-a')
    expect(lanes).toContain('desktop-smoke:agent-browser-chat:provider-b-model-b')
  })
})

describe('runQualityGate', () => {
  test('writes dry-run reports without executing expensive commands', async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), 'quality-gate-test-'))
    try {
      const { report, outputDir } = await runQualityGate({
        mode: 'baseline',
        dryRun: true,
        allowLive: false,
        baselineTargets: [],
        rootDir: process.cwd(),
        artifactsDir,
        runId: 'dry-run-test',
      })

      expect(report.mode).toBe('baseline')
      expect(report.summary.failed).toBe(0)
      expect(report.summary.skipped).toBeGreaterThan(0)
      expect(report.results.find((result) => result.id === 'coverage')?.category).toBe('coverage')
      expect(report.results.find((result) => result.id.startsWith('baseline:'))?.live).toBe(true)
      expect(readFileSync(join(outputDir, 'report.json'), 'utf8')).toContain('"mode": "baseline"')
      expect(readFileSync(join(outputDir, 'report.md'), 'utf8')).toContain('# Quality Gate Report')
      expect(readFileSync(join(outputDir, 'report.md'), 'utf8')).toContain('## Result Matrix')
      expect(readFileSync(join(outputDir, 'junit.xml'), 'utf8')).toContain('<testsuite name="quality-gate.baseline"')
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true })
    }
  })

  test('continues through later lanes after a failure so reports show full impact', async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), 'quality-gate-test-'))
    const lanes: LaneDefinition[] = [
      {
        id: 'first-lane',
        title: 'First lane',
        description: 'Fails intentionally',
        kind: 'command',
        command: ['false'],
        requiredForModes: ['pr'],
      },
      {
        id: 'second-lane',
        title: 'Second lane',
        description: 'Still runs',
        kind: 'command',
        command: ['true'],
        requiredForModes: ['pr'],
      },
    ]

    try {
      const { report } = await runQualityGateLanes({
        mode: 'pr',
        dryRun: false,
        allowLive: false,
        baselineTargets: [],
        rootDir: process.cwd(),
        artifactsDir,
        runId: 'continue-after-failure-test',
      }, lanes, async (lane) => ({
        id: lane.id,
        title: lane.title,
        status: lane.id === 'first-lane' ? 'failed' : 'passed',
        command: lane.command,
        durationMs: 1,
        exitCode: lane.id === 'first-lane' ? 1 : 0,
      }))

      expect(report.results.map((result) => result.id)).toEqual(['first-lane', 'second-lane'])
      expect(report.summary).toEqual({
        passed: 1,
        failed: 1,
        skipped: 0,
      })
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true })
    }
  })

  test('filters lanes by exact id or prefix selector', async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), 'quality-gate-test-'))
    try {
      const { report } = await runQualityGate({
        mode: 'baseline',
        dryRun: true,
        allowLive: false,
        baselineTargets: [],
        rootDir: process.cwd(),
        artifactsDir,
        runId: 'filter-lanes-test',
        onlyLaneSelectors: ['provider-smoke:*'],
      })

      expect(report.results.length).toBe(1)
      expect(report.results[0].id).toBe('provider-smoke:current-runtime')
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true })
    }
  })

  test('command lanes persist per-lane logs', async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), 'quality-gate-test-'))
    const lanes: LaneDefinition[] = [
      {
        id: 'log-lane',
        title: 'Log lane',
        description: 'Writes output',
        kind: 'command',
        command: ['bun', '--version'],
        requiredForModes: ['pr'],
      },
    ]

    try {
      const { report } = await runQualityGateLanes({
        mode: 'pr',
        dryRun: false,
        allowLive: false,
        baselineTargets: [],
        rootDir: process.cwd(),
        artifactsDir,
        runId: 'command-log-test',
      }, lanes)

      const logPath = report.results[0].logPath
      expect(report.results[0].status).toBe('passed')
      expect(logPath).toBeTruthy()
      expect(readFileSync(logPath!, 'utf8')).toContain('$ bun --version')
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true })
    }
  })

  test('skips PR local check lanes when the impact report does not require them', async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), 'quality-gate-test-'))
    const lanes: LaneDefinition[] = [
      {
        id: 'impact-report',
        title: 'Impact report',
        description: 'Writes selected local checks',
        kind: 'command',
        command: ['bash', '-lc', [
          'printf "%s\\n"',
          '"# PR impact report"',
          '""',
          '"Changed files: 1"',
          '"Areas: server"',
          '"Labels: none"',
          '"Blocked: no"',
          '""',
          '"## Required local checks"',
          '"- bun run check:server"',
        ].join(' ')],
        requiredForModes: ['pr'],
      },
      {
        id: 'desktop-checks',
        title: 'Desktop checks',
        description: 'Should be skipped',
        kind: 'command',
        command: ['bash', '-lc', 'exit 7'],
        impactRequiredCheck: 'bun run check:desktop',
        requiredForModes: ['pr'],
      },
    ]

    try {
      const { report } = await runQualityGateLanes({
        mode: 'pr',
        dryRun: false,
        allowLive: false,
        baselineTargets: [],
        rootDir: process.cwd(),
        artifactsDir,
        runId: 'impact-selected-skip-test',
      }, lanes)

      expect(report.results.map((result) => result.status)).toEqual(['passed', 'skipped'])
      expect(report.results[1].skipReason).toContain('not required by impact report')
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true })
    }
  })

  test('runs PR local check lanes selected by the impact report', async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), 'quality-gate-test-'))
    const lanes: LaneDefinition[] = [
      {
        id: 'impact-report',
        title: 'Impact report',
        description: 'Writes selected local checks',
        kind: 'command',
        command: ['bash', '-lc', [
          'printf "%s\\n"',
          '"# PR impact report"',
          '""',
          '"Changed files: 1"',
          '"Areas: desktop"',
          '"Labels: none"',
          '"Blocked: no"',
          '""',
          '"## Required local checks"',
          '"- bun run check:desktop"',
        ].join(' ')],
        requiredForModes: ['pr'],
      },
      {
        id: 'desktop-checks',
        title: 'Desktop checks',
        description: 'Should run',
        kind: 'command',
        command: ['bash', '-lc', 'exit 0'],
        impactRequiredCheck: 'bun run check:desktop',
        requiredForModes: ['pr'],
      },
    ]

    try {
      const { report } = await runQualityGateLanes({
        mode: 'pr',
        dryRun: false,
        allowLive: false,
        baselineTargets: [],
        rootDir: process.cwd(),
        artifactsDir,
        runId: 'impact-selected-run-test',
      }, lanes)

      expect(report.results.map((result) => result.status)).toEqual(['passed', 'passed'])
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true })
    }
  })

  test('hydrates impact and coverage summaries from generated command artifacts', async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), 'quality-gate-test-'))
    const coverageDir = join(artifactsDir, 'coverage-output')
    mkdirSync(coverageDir, { recursive: true })
    writeFileSync(join(coverageDir, 'coverage-report.md'), '# Coverage Report\n')
    writeFileSync(join(coverageDir, 'coverage-report.json'), JSON.stringify({
      suites: [
        {
          id: 'desktop',
          title: 'Desktop React',
          status: 'passed',
          summary: {
            lines: { pct: 88, covered: 88, total: 100 },
            functions: { pct: 80, covered: 8, total: 10 },
            branches: { pct: 75, covered: 15, total: 20 },
            statements: { pct: 88, covered: 88, total: 100 },
          },
        },
      ],
      failures: [],
    }) + '\n')

    const lanes: LaneDefinition[] = [
      {
        id: 'impact-report',
        title: 'Impact report',
        description: 'Summarize changed areas',
        kind: 'command',
        command: ['bun', 'run', 'check:impact'],
        requiredForModes: ['pr'],
        category: 'scope',
      },
      {
        id: 'coverage',
        title: 'Coverage gate',
        description: 'Run coverage',
        kind: 'command',
        command: ['bun', 'run', 'check:coverage'],
        requiredForModes: ['pr'],
        category: 'coverage',
      },
    ]

    try {
      const { report } = await runQualityGateLanes({
        mode: 'pr',
        dryRun: false,
        allowLive: false,
        baselineTargets: [],
        rootDir: process.cwd(),
        artifactsDir,
        runId: 'artifact-summary-test',
      }, lanes, async (lane, options) => {
        const logPath = join(options.runOutputDir!, 'logs', `${lane.id}.log`)
        mkdirSync(join(options.runOutputDir!, 'logs'), { recursive: true })
        if (lane.id === 'impact-report') {
          writeFileSync(logPath, [
            '# PR impact report',
            '',
            'Changed files: 2',
            'Areas: desktop, server',
            'Labels: none',
            'Blocked: no',
            '',
            '## Required local checks',
            '- `bun run check:desktop`',
            '',
            '## Test coverage signals',
            '- No obvious missing-test signal from changed paths.',
            '',
            '## Risk notes',
            '- Desktop state/API layer changed.',
          ].join('\n'))
        } else {
          writeFileSync(logPath, `Coverage report: ${join(coverageDir, 'coverage-report.md')}\nSummary: passed=1 failed=0\n`)
        }
        return {
          id: lane.id,
          title: lane.title,
          status: 'passed',
          command: lane.command,
          durationMs: 1,
          exitCode: 0,
          logPath,
        }
      })

      expect(report.impact?.changedFiles).toBe(2)
      expect(report.impact?.requiredChecks).toEqual(['`bun run check:desktop`'])
      expect(report.coverage?.suites[0].lines?.pct).toBe(88)
      expect(report.artifacts.map((artifact) => artifact.path)).toContain(join(coverageDir, 'coverage-report.md'))
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true })
    }
  })

  test('release mode treats skipped live lanes as failures', async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), 'quality-gate-test-'))
    const lanes: LaneDefinition[] = [
      {
        id: 'live-lane',
        title: 'Live lane',
        description: 'Requires release evidence',
        kind: 'provider-smoke',
        live: true,
        requiredForModes: ['release'],
      },
    ]

    try {
      const { report } = await runQualityGateLanes({
        mode: 'release',
        dryRun: false,
        allowLive: false,
        baselineTargets: [],
        rootDir: process.cwd(),
        artifactsDir,
        runId: 'release-live-skipped-test',
      }, lanes, async (lane) => ({
        id: lane.id,
        title: lane.title,
        status: 'skipped',
        durationMs: 1,
        skipReason: 'missing credentials',
      }))

      expect(report.summary).toEqual({
        passed: 0,
        failed: 1,
        skipped: 0,
      })
      expect(report.results[0].error).toBe('missing credentials')
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true })
    }
  })
})

describe('renderMarkdownReport', () => {
  test('renders command, skip reason, and summary', () => {
    const report: QualityGateReport = {
      schemaVersion: 1,
      runId: 'example',
      mode: 'pr',
      dryRun: true,
      allowLive: false,
      startedAt: '2026-05-02T00:00:00.000Z',
      finishedAt: '2026-05-02T00:00:01.000Z',
      rootDir: process.cwd(),
      git: {
        sha: 'abc123',
        dirty: true,
      },
      results: [
        {
          id: 'impact-report',
          title: 'Impact report',
          description: 'Summarize changed areas.',
          category: 'scope',
          live: false,
          status: 'skipped',
          command: ['bun', 'run', 'check:impact'],
          durationMs: 1,
          skipReason: 'dry run',
          logPath: '/tmp/impact-report.log',
        },
      ],
      summary: {
        passed: 0,
        failed: 0,
        skipped: 1,
      },
      artifacts: [],
    }

    const markdown = renderMarkdownReport(report)
    expect(markdown).toContain('Skipped: 1')
    expect(markdown).toContain('Test scope')
    expect(markdown).toContain('`bun run check:impact`')
    expect(markdown).toContain('dry run')
    expect(markdown).toContain('/tmp/impact-report.log')
  })

  test('renders impact and coverage summaries in one markdown report', () => {
    const report: QualityGateReport = {
      schemaVersion: 1,
      runId: 'example',
      mode: 'pr',
      dryRun: false,
      allowLive: false,
      startedAt: '2026-05-02T00:00:00.000Z',
      finishedAt: '2026-05-02T00:00:03.000Z',
      rootDir: process.cwd(),
      git: {
        sha: 'abc123',
        dirty: false,
      },
      results: [
        {
          id: 'coverage',
          title: 'Coverage gate',
          category: 'coverage',
          live: false,
          status: 'passed',
          command: ['bun', 'run', 'check:coverage'],
          durationMs: 2500,
          logPath: '/tmp/coverage.log',
        },
      ],
      impact: {
        changedFiles: 3,
        areas: ['desktop', 'server'],
        labels: ['allow-cli-core-change'],
        blocked: false,
        requiredChecks: ['`bun run check:desktop`', '`bun run check:coverage`'],
        testCoverageSignals: ['No obvious missing-test signal from changed paths.'],
        riskNotes: ['Session runtime changed.'],
      },
      coverage: {
        reportPath: '/tmp/coverage-report.md',
        failures: [],
        suites: [
          {
            id: 'desktop',
            title: 'Desktop React',
            status: 'passed',
            lines: { pct: 82, covered: 82, total: 100 },
            functions: { pct: 80, covered: 8, total: 10 },
            branches: { pct: 75, covered: 15, total: 20 },
            statements: { pct: 82, covered: 82, total: 100 },
          },
        ],
      },
      artifacts: [{ title: 'Coverage report markdown', path: '/tmp/coverage-report.md' }],
      summary: {
        passed: 1,
        failed: 0,
        skipped: 0,
      },
    }

    const markdown = renderMarkdownReport(report)
    expect(markdown).toContain('Changed files: 3')
    expect(markdown).toContain('| Desktop React | passed | 82% (82/100)')
    expect(markdown).toContain('Coverage report markdown: /tmp/coverage-report.md')
  })

  test('renders JUnit report for CI test-summary consumers', () => {
    const report: QualityGateReport = {
      schemaVersion: 1,
      runId: 'example',
      mode: 'release',
      dryRun: false,
      allowLive: true,
      startedAt: '2026-05-02T00:00:00.000Z',
      finishedAt: '2026-05-02T00:00:02.000Z',
      rootDir: process.cwd(),
      git: {
        sha: 'abc123',
        dirty: false,
      },
      results: [
        {
          id: 'provider-smoke:example',
          title: 'Provider smoke',
          category: 'smoke',
          live: true,
          status: 'failed',
          durationMs: 500,
          error: 'API <error>',
          logPath: '/tmp/provider.log',
        },
      ],
      summary: {
        passed: 0,
        failed: 1,
        skipped: 0,
      },
      artifacts: [],
    }

    const junit = renderJUnitReport(report)
    expect(junit).toContain('testsuite name="quality-gate.release"')
    expect(junit).toContain('failures="1"')
    expect(junit).toContain('API &lt;error&gt;')
    expect(junit).toContain('/tmp/provider.log')
  })
})
