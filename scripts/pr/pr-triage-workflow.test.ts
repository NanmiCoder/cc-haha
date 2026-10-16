import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('PR triage workflow comment', () => {
  test('keeps AI review out of the deterministic quality contract', () => {
    const workflow = readFileSync('.github/workflows/pr-triage.yml', 'utf8')

    expect(workflow).toContain('Hard merge gates come from the deterministic GitHub Actions contract lanes above.')
    expect(workflow).not.toContain('@dosubot')
  })

  test('does not execute untrusted PR code from pull_request_target', () => {
    const workflow = readFileSync('.github/workflows/pr-triage.yml', 'utf8')

    expect(workflow).toContain('pull_request_target:')
    expect(workflow).not.toContain('actions/checkout')
    expect(workflow).not.toContain('bun install')
    expect(workflow).not.toContain('pull_request.head.sha')
    expect(workflow).not.toContain('--allow-live')
    expect(workflow).not.toContain('secrets.')
  })

  test('exempts CODEOWNER-authored CLI core changes using base-branch CODEOWNERS', () => {
    const workflow = readFileSync('.github/workflows/pr-triage.yml', 'utf8')

    expect(workflow).toContain("path: '.github/CODEOWNERS', ref: context.payload.pull_request.base.ref")
    expect(workflow).toContain("const cliCoreApproved = currentLabels.has('allow-cli-core-change') || authorIsCodeOwner")
    expect(workflow).toContain('if (cliCoreFiles.length > 0 && !cliCoreApproved) {')
  })

  test('surfaces missing-test and coverage-baseline policy branches', () => {
    const workflow = readFileSync('.github/workflows/pr-triage.yml', 'utf8')

    expect(workflow).toContain("'allow-missing-tests': 'c2e0c6'")
    expect(workflow).toContain("'allow-coverage-baseline-change': 'c2e0c6'")
    expect(workflow).toContain('See `PR Quality / scope-plan`; it is the single source of truth for selected jobs.')
    expect(workflow).not.toContain('requiredChecks.push(')
    expect(workflow).toContain('Coverage baseline policy')
    expect(workflow).toContain('coveragePolicyFiles')
    expect(workflow).toContain('Root runtime product files changed without a matching root runtime test file in the PR.')
    expect(workflow).toContain('BLOCKING unless \\`allow-missing-tests\\` is applied')
  })
})
