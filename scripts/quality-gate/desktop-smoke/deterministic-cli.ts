#!/usr/bin/env bun

import { join } from 'node:path'
import { executeDeterministicDesktopSmoke } from './deterministic'

const rootDir = process.cwd()
const artifactDir = process.argv.includes('--artifact-dir')
  ? String(process.argv[process.argv.indexOf('--artifact-dir') + 1])
  : join(rootDir, 'artifacts', 'desktop-ui-smoke')

console.log('[desktop-ui-smoke] real desktop UI against the mock SDK CLI — no provider, no credentials, no network')

const result = await executeDeterministicDesktopSmoke(
  rootDir,
  artifactDir,
  'desktop-ui-smoke',
  'Deterministic desktop UI smoke',
)

if (result.status === 'skipped') {
  console.log(`[desktop-ui-smoke] SKIPPED: ${result.skipReason}`)
  process.exit(0)
}

console.log(`[desktop-ui-smoke] ${result.status.toUpperCase()} (${result.durationMs}ms) artifacts=${result.artifactDir}`)
if (result.error) {
  console.error(`[desktop-ui-smoke] ${result.error}`)
}
process.exit(result.status === 'passed' ? 0 : 1)
