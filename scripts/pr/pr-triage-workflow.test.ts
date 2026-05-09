import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const DOSU_PROMPT = '@dosubot review this PR for changed-area risk, missing tests, docs impact, desktop startup risk, and CLI core impact.'

function extractCommentBodyEntries(workflow: string) {
  const match = workflow.match(/const body = \[([\s\S]*?)\n\s*\]\.join\('\\n'\)/)
  if (!match) {
    throw new Error('Could not find PR triage comment body array')
  }

  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith("'") || line.startsWith('`'))
}

describe('PR triage workflow comment', () => {
  test('ends with a plain-text Dosu mention so the bot is triggered', () => {
    const workflow = readFileSync('.github/workflows/pr-triage.yml', 'utf8')
    const entries = extractCommentBodyEntries(workflow)
    const nonEmptyEntries = entries.filter((entry) => !/^['`]['`],?$/.test(entry))
    const lastEntry = nonEmptyEntries.at(-1)

    expect(lastEntry).toBe(`'${DOSU_PROMPT}',`)
    expect(workflow).not.toContain(`\`${DOSU_PROMPT}\``)
  })

  test('surfaces missing-test, coverage-check, and coverage-baseline policy branches', () => {
    const workflow = readFileSync('.github/workflows/pr-triage.yml', 'utf8')

    expect(workflow).toContain("'allow-missing-tests': 'c2e0c6'")
    expect(workflow).toContain("'allow-coverage-baseline-change': 'c2e0c6'")
    expect(workflow).toContain("requiredChecks.push('coverage-checks')")
    expect(workflow).toContain('Coverage baseline policy')
    expect(workflow).toContain('coveragePolicyFiles')
    expect(workflow).toContain('BLOCKING unless \\`allow-missing-tests\\` is applied')
  })
})
