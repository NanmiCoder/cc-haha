#!/usr/bin/env bun
/**
 * `bun run check:agent-e2e` — the whole agent loop, with only the model faked.
 *
 *   desktop client protocol → real server → real CLI → loopback Anthropic endpoint
 *
 * The mock-CLI lane (`check:agent-flow`) proves the server's protocol; the live lane
 * proves a real model, but needs credentials and money. This lane sits between them:
 * the real CLI runs its real agent loop, real tools touch a real (throwaway) disk,
 * and the model is a script. No credentials, no network, deterministic — so it can
 * gate every pull request.
 *
 * Usage: bun run check:agent-e2e [-- --only <scenario-id>[,<id>]] [--list]
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { executeAgentFlowAgainstProvider, LIVE_SCENARIO_RUNNERS } from '../agent-flow/live'
import { startMockLlmServer } from './server'
import { createMockOnlyRunners, describeRequests, MOCK_AGENT_SCENARIOS } from './scenarios'

const MOCK_MODEL = 'mock-model'
const STEP_TIMEOUT_MS = 60_000

function listArg(argv: string[], name: string) {
  const index = argv.indexOf(name)
  const value = argv[index + 1]
  if (index === -1 || !value || value.startsWith('--')) return []
  return value.split(',').map((entry) => entry.trim()).filter(Boolean)
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--list')) {
    for (const scenario of MOCK_AGENT_SCENARIOS) console.log(`  ${scenario.id.padEnd(32)} ${scenario.title}`)
    return
  }

  const only = listArg(argv, '--only')
  const scenarios = only.length > 0
    ? MOCK_AGENT_SCENARIOS.filter((scenario) => only.includes(scenario.id))
    : MOCK_AGENT_SCENARIOS
  if (scenarios.length === 0) throw new Error(`--only ${only.join(',')} matches no scenario. Use --list.`)

  const rootDir = resolve(import.meta.dir, '../../..')
  const artifactDir = join(rootDir, 'artifacts', 'agent-e2e')
  mkdirSync(artifactDir, { recursive: true })

  const upstream = startMockLlmServer()
  console.log('[agent-e2e] real server + real CLI + scripted model — no provider, no credentials, no network')
  console.log(`[agent-e2e] mock upstream: ${upstream.url}`)
  console.log(`[agent-e2e] scenarios: ${scenarios.length}`)

  let results
  try {
    results = await executeAgentFlowAgainstProvider({
      rootDir,
      artifactDir,
      label: 'agent-e2e',
      seedProviders: false,
      stepTimeoutMs: STEP_TIMEOUT_MS,
      scenarios,
      runners: { ...LIVE_SCENARIO_RUNNERS, ...createMockOnlyRunners(upstream.requests) },
      // Registered through the same endpoint the desktop "add provider" form uses,
      // so the provider → CLI env wiring is part of what this lane exercises.
      async resolveTarget({ baseUrl }) {
        const response = await fetch(`${baseUrl}/api/providers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            presetId: 'custom',
            name: 'Mock LLM',
            apiKey: 'mock-api-key',
            baseUrl: upstream.url,
            apiFormat: 'anthropic',
            models: { main: MOCK_MODEL, haiku: MOCK_MODEL, sonnet: MOCK_MODEL, opus: MOCK_MODEL },
          }),
        })
        if (!response.ok) throw new Error(`registering the mock provider failed: ${response.status} ${await response.text()}`)
        const body = await response.json() as { provider?: { id?: string }; id?: string }
        const providerId = body.provider?.id ?? body.id
        if (!providerId) throw new Error(`provider create returned no id: ${JSON.stringify(body)}`)
        return {
          providerId,
          providerName: 'Mock LLM',
          modelId: MOCK_MODEL,
          host: upstream.url,
          source: 'scripts/quality-gate/mock-llm',
        }
      },
    })
  } finally {
    writeFileSync(join(artifactDir, 'upstream-requests.json'), `${JSON.stringify(describeRequests(upstream.requests), null, 2)}\n`)
    await upstream.stop()
  }

  for (const result of results) {
    const suffix = result.detail ? ` — ${result.detail}` : ''
    console.log(`[agent-e2e] ${result.status === 'passed' ? 'PASS' : 'FAIL'} ${result.id} (${result.durationMs}ms)${suffix}`)
  }
  writeFileSync(join(artifactDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)

  const failed = results.filter((result) => result.status === 'failed')
  console.log(`[agent-e2e] summary: passed=${results.length - failed.length} failed=${failed.length} upstream_requests=${upstream.requests.length} artifacts=${artifactDir}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
