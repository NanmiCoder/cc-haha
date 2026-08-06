#!/usr/bin/env bun

import { join } from 'node:path'
import { executeAgentFlow } from './execute'
import { selectScenarios, uncoveredSteps } from './scenarios'

function listArg(name: string) {
  const index = process.argv.indexOf(name)
  const value = process.argv[index + 1]
  if (index === -1 || !value || value.startsWith('--')) return []
  return value.split(',').map((entry) => entry.trim()).filter(Boolean)
}

const rootDir = process.cwd()
const artifactDir = process.argv.includes('--artifact-dir')
  ? String(process.argv[process.argv.indexOf('--artifact-dir') + 1])
  : join(rootDir, 'artifacts', 'agent-flow')

const scenarios = selectScenarios(listArg('--scenario'))

console.log('[agent-flow] deterministic agent QA — no provider, no credentials, no network')
console.log(`[agent-flow] runtime: mock SDK CLI (src/server/__tests__/fixtures/mock-sdk-cli.ts)`)
console.log(`[agent-flow] scenarios: ${scenarios.length}`)

const results = await executeAgentFlow({ rootDir, artifactDir, scenarios })

for (const result of results) {
  const suffix = result.error ? ` — ${result.error}` : ''
  console.log(`[agent-flow] ${result.status === 'passed' ? 'PASS' : 'FAIL'} ${result.id} (${result.durationMs}ms)${suffix}`)
}

const missing = uncoveredSteps(scenarios)
if (missing.length > 0) {
  console.log(`[agent-flow] user-flow steps not covered by this selection: ${missing.join(', ')}`)
}

const failed = results.filter((result) => result.status === 'failed')
console.log(`[agent-flow] summary: passed=${results.length - failed.length} failed=${failed.length} artifacts=${artifactDir}`)
process.exit(failed.length === 0 ? 0 : 1)
