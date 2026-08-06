/**
 * `bun run check:agent-flow:live -- --provider <name> --yes`
 *
 * Local and manual by design. Nothing in CI calls this, and it takes no fallback:
 * without an explicit provider and an explicit --yes it prints what it *would* do and
 * exits without sending anything upstream.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describeLiveTarget, executeLiveAgentFlow, resolveLiveTarget } from './live.ts'
import { LIVE_AGENT_FLOW_SCENARIOS, LIVE_FLOW_EXCLUSIONS } from './liveScenarios.ts'

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = argv[index + 1]
  return value && !value.startsWith('--') ? value : ''
}

async function main() {
  const argv = process.argv.slice(2)

  if (argv.includes('--list')) {
    console.log('Live agent-flow scenarios:')
    for (const scenario of LIVE_AGENT_FLOW_SCENARIOS) {
      console.log(`  ${scenario.id.padEnd(24)} ${scenario.title}`)
    }
    console.log('\nDeliberately not covered live:')
    for (const [key, reason] of Object.entries(LIVE_FLOW_EXCLUSIONS)) {
      console.log(`  ${key.padEnd(24)} ${reason}`)
    }
    return
  }

  const rootDir = resolve(import.meta.dir, '../../..')
  const only = flag(argv, 'only')
  const target = resolveLiveTarget(flag(argv, 'provider'), { modelId: flag(argv, 'model') || undefined })
  const selected = only
    ? LIVE_AGENT_FLOW_SCENARIOS.filter((scenario) => scenario.id === only)
    : LIVE_AGENT_FLOW_SCENARIOS

  if (selected.length === 0) {
    throw new Error(`--only ${only} matches no scenario. Use --list to see them.`)
  }

  if (!argv.includes('--yes')) {
    console.log(describeLiveTarget(target, selected.length))
    process.exitCode = 1
    return
  }

  const artifactDir = join(rootDir, 'artifacts', 'agent-flow-live')
  mkdirSync(artifactDir, { recursive: true })

  console.log(`Running ${selected.length} live scenario(s) against ${target.providerName} (${target.modelId})\n`)
  const results = await executeLiveAgentFlow({
    rootDir,
    artifactDir,
    target,
    only: selected.map((scenario) => scenario.id),
  })

  for (const result of results) {
    const mark = result.status === 'passed' ? 'PASS' : 'FAIL'
    console.log(`  ${mark}  ${result.id.padEnd(24)} ${(result.durationMs / 1000).toFixed(1)}s`)
    if (result.detail) console.log(`        ${result.detail}`)
  }

  writeFileSync(join(artifactDir, 'results.json'), `${JSON.stringify({ target, results }, null, 2)}\n`)

  const failed = results.filter((result) => result.status === 'failed')
  console.log(`\n${results.length - failed.length}/${results.length} passed. Artifacts: ${artifactDir}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
