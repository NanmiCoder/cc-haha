import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LaneCategory, QualityGateReport } from './types'

const categoryLabels: Record<LaneCategory, string> = {
  scope: 'Test scope',
  governance: 'Governance',
  unit: 'Unit/local',
  coverage: 'Coverage',
  integration: 'Integration',
  smoke: 'Smoke/live',
  native: 'Native',
  docs: 'Docs',
}

export function writeReport(report: QualityGateReport, outputDir: string) {
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(outputDir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  writeFileSync(join(outputDir, 'report.md'), renderMarkdownReport(report))
  writeFileSync(join(outputDir, 'junit.xml'), renderJUnitReport(report))
}

function escapeMarkdownTable(value: string | number | boolean | undefined) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>')
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatMetric(metric: { pct: number; covered: number; total: number } | undefined) {
  return metric ? `${metric.pct}% (${metric.covered}/${metric.total})` : '-'
}

function renderSummaryList(lines: string[], title: string, items: string[]) {
  lines.push(`### ${title}`, '')
  if (items.length === 0) {
    lines.push('- none', '')
    return
  }
  for (const item of items) {
    lines.push(`- ${item}`)
  }
  lines.push('')
}

export function renderMarkdownReport(report: QualityGateReport) {
  const lines = [
    `# Quality Gate Report`,
    '',
    `- Run: ${report.runId}`,
    `- Mode: ${report.mode}`,
    `- Dry run: ${report.dryRun ? 'yes' : 'no'}`,
    `- Live checks allowed: ${report.allowLive ? 'yes' : 'no'}`,
    `- Git SHA: ${report.git.sha ?? 'unknown'}`,
    `- Dirty worktree: ${report.git.dirty ? 'yes' : 'no'}`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    '',
    `## Summary`,
    '',
    `- Passed: ${report.summary.passed}`,
    `- Failed: ${report.summary.failed}`,
    `- Skipped: ${report.summary.skipped}`,
    '',
    `## Test Scope`,
    '',
  ]

  if (report.impact) {
    lines.push(`- Changed files: ${report.impact.changedFiles ?? 'unknown'}`)
    lines.push(`- Areas: ${report.impact.areas.length ? report.impact.areas.join(', ') : 'none'}`)
    lines.push(`- Labels: ${report.impact.labels.length ? report.impact.labels.join(', ') : 'none'}`)
    lines.push(`- Blocked by policy: ${report.impact.blocked === undefined ? 'unknown' : report.impact.blocked ? 'yes' : 'no'}`)
    lines.push('')
    renderSummaryList(lines, 'Required Local Checks', report.impact.requiredChecks)
    renderSummaryList(lines, 'Test Coverage Signals', report.impact.testCoverageSignals)
    renderSummaryList(lines, 'Risk Notes', report.impact.riskNotes)
  } else {
    lines.push('- Impact summary unavailable; inspect the impact-report lane log.', '')
  }

  lines.push('## Result Matrix', '')
  lines.push('| Category | Lane | Status | Live | Duration | Evidence |')
  lines.push('| --- | --- | --- | --- | ---: | --- |')
  for (const result of report.results) {
    const evidence = result.artifactDir ? result.artifactDir : result.logPath ?? ''
    lines.push(`| ${[
      escapeMarkdownTable(result.category ? categoryLabels[result.category] : 'Other'),
      escapeMarkdownTable(result.title),
      escapeMarkdownTable(result.status),
      escapeMarkdownTable(result.live ? 'yes' : 'no'),
      escapeMarkdownTable(formatDuration(result.durationMs)),
      escapeMarkdownTable(evidence),
    ].join(' | ')} |`)
  }
  lines.push('')

  lines.push('## Coverage', '')
  if (report.coverage) {
    lines.push(`- Report: ${report.coverage.reportPath}`, '')
    lines.push('| Suite | Status | Lines | Functions | Branches | Statements |')
    lines.push('| --- | --- | ---: | ---: | ---: | ---: |')
    for (const suite of report.coverage.suites) {
      lines.push(`| ${[
        escapeMarkdownTable(suite.title),
        escapeMarkdownTable(suite.status),
        escapeMarkdownTable(formatMetric(suite.lines)),
        escapeMarkdownTable(formatMetric(suite.functions)),
        escapeMarkdownTable(formatMetric(suite.branches)),
        escapeMarkdownTable(formatMetric(suite.statements)),
      ].join(' | ')} |`)
    }
    lines.push('')
    renderSummaryList(lines, 'Coverage Failures', report.coverage.failures)
  } else {
    lines.push('- Coverage summary unavailable; inspect the coverage lane log.', '')
  }

  lines.push('## Artifacts', '')
  for (const artifact of report.artifacts) {
    lines.push(`- ${artifact.title}: ${artifact.path}`)
  }
  lines.push('', `## Lanes`, '')

  for (const result of report.results) {
    lines.push(`### ${result.title}`)
    lines.push('')
    lines.push(`- ID: ${result.id}`)
    if (result.category) {
      lines.push(`- Category: ${categoryLabels[result.category]}`)
    }
    lines.push(`- Live: ${result.live ? 'yes' : 'no'}`)
    if (result.description) {
      lines.push(`- Description: ${result.description}`)
    }
    lines.push(`- Status: ${result.status}`)
    lines.push(`- Duration: ${formatDuration(result.durationMs)}`)
    if (result.command) {
      lines.push(`- Command: \`${result.command.join(' ')}\``)
    }
    if (result.exitCode !== undefined) {
      lines.push(`- Exit code: ${result.exitCode}`)
    }
    if (result.skipReason) {
      lines.push(`- Skip reason: ${result.skipReason}`)
    }
    if (result.error) {
      lines.push(`- Error: ${result.error}`)
    }
    if (result.artifactDir) {
      lines.push(`- Artifacts: ${result.artifactDir}`)
    }
    if (result.logPath) {
      lines.push(`- Log: ${result.logPath}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function renderJUnitReport(report: QualityGateReport) {
  const failures = report.results.filter((result) => result.status === 'failed').length
  const skipped = report.results.filter((result) => result.status === 'skipped').length
  const durationSeconds = Math.max(0, (Date.parse(report.finishedAt) - Date.parse(report.startedAt)) / 1000)
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="quality-gate.${escapeXml(report.mode)}" tests="${report.results.length}" failures="${failures}" skipped="${skipped}" time="${durationSeconds.toFixed(3)}">`,
  ]

  for (const result of report.results) {
    const testcaseTime = Math.max(0, result.durationMs / 1000).toFixed(3)
    lines.push(`  <testcase classname="quality-gate.${escapeXml(report.mode)}" name="${escapeXml(result.id)}" time="${testcaseTime}">`)
    if (result.status === 'failed') {
      const message = result.error ?? (result.exitCode === undefined ? 'lane failed' : `exit code ${result.exitCode}`)
      lines.push(`    <failure message="${escapeXml(message)}">${escapeXml([
        `Title: ${result.title}`,
        result.command ? `Command: ${result.command.join(' ')}` : null,
        result.logPath ? `Log: ${result.logPath}` : null,
        result.artifactDir ? `Artifacts: ${result.artifactDir}` : null,
      ].filter(Boolean).join('\n'))}</failure>`)
    }
    if (result.status === 'skipped') {
      lines.push(`    <skipped message="${escapeXml(result.skipReason ?? 'skipped')}"/>`)
    }
    lines.push('  </testcase>')
  }

  lines.push('</testsuite>')
  return lines.join('\n') + '\n'
}
