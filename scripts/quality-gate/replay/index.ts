#!/usr/bin/env bun
/**
 * `bun run check:agent-replay` — the real agent loop against recorded traffic.
 *
 *   desktop client protocol → real server → real CLI (→ server proxy) → replayed provider
 *
 * The mock-LLM lane scripts the model by hand, so it streams what its author
 * imagined a model sends. This lane serves what DeepSeek actually sent: thinking
 * blocks, tool input split across many fragments, real usage numbers, OpenAI
 * Chat chunks through the proxy. No network, no credentials, deterministic.
 *
 * Usage: bun run check:agent-replay [-- --only <id>[,<id>]] [--list]
 * Re-record a scenario: bun run quality:record-cassettes -- --allow-live --only <id>
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { replayScenarios, type ReplayLaneResult } from './lane'
import { REPLAY_SCENARIOS, selectScenarios } from './scenarios'

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--list')) {
    for (const scenario of REPLAY_SCENARIOS) console.log(`  ${scenario.id.padEnd(30)} ${scenario.format.padEnd(12)} ${scenario.title}`)
    return
  }
  const onlyIndex = argv.indexOf('--only')
  const only = onlyIndex === -1 ? [] : (argv[onlyIndex + 1] ?? '').split(',').map((id) => id.trim()).filter(Boolean)
  const scenarios = selectScenarios(only)
  const rootDir = resolve(import.meta.dir, '../../..')
  const artifactDir = join(rootDir, 'artifacts', 'agent-e2e', 'replay')
  mkdirSync(artifactDir, { recursive: true })
  console.log('[agent-replay] real server + real CLI + recorded provider traffic — no network, no credentials')

  const results: ReplayLaneResult[] = []
  for (const format of ['anthropic', 'openai_chat'] as const) {
    const group = scenarios.filter((scenario) => scenario.format === format)
    if (group.length === 0) continue
    results.push(...await replayScenarios({ rootDir, artifactDir: join(artifactDir, format), format, scenarios: group }))
  }

  const drift = new Set<string>()
  for (const result of results) {
    console.log(`[agent-replay] ${result.status === 'passed' ? 'PASS' : 'FAIL'} ${result.id} (${result.durationMs}ms)${result.detail ? ` — ${result.detail}` : ''}`)
    for (const line of result.report?.drift ?? []) drift.add(`${result.id}: ${line}`)
  }
  writeFileSync(join(artifactDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
  if (drift.size > 0) {
    const text = [
      '# Replay drift',
      '',
      'These replays still passed, but the app now sends something different from the recording.',
      'Re-record when the difference matters: `bun run quality:record-cassettes -- --allow-live --only <id>`.',
      '',
      ...[...drift].map((line) => `- ${line}`),
      '',
    ].join('\n')
    writeFileSync(join(artifactDir, 'drift.md'), text)
    console.log(`[agent-replay] drift: ${drift.size} note(s), see ${join(artifactDir, 'drift.md')}`)
  }
  const failed = results.filter((result) => result.status === 'failed')
  console.log(`[agent-replay] summary: passed=${results.length - failed.length} failed=${failed.length} artifacts=${artifactDir}`)
  if (failed.length > 0) process.exitCode = 1
}

/**
 * The verdict is final once main() settles. If something the run started still
 * keeps the process alive (it once held a CI job until its timeout), name it in
 * the log and exit with the verdict instead of hanging. The timer is unref'd,
 * so a clean run exits on its own without waiting for it.
 */
function exitIfStillRunning(afterMs: number) {
  setTimeout(() => {
    const listing = Bun.spawnSync(['ps', '-eo', 'pid,ppid,pgid,etime,args'], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString()
    const lingering = listing.split('\n').filter((line) => /\bbun\b|claude-haha|inventory-mcp/.test(line))
    console.warn(`[agent-replay] still running ${afterMs / 1000}s after finishing (pid ${process.pid}); exiting with the verdict. Processes:\n${lingering.join('\n')}`)
    process.exit(process.exitCode ?? 0)
  }, afterMs).unref()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
}).finally(() => exitIfStillRunning(15_000))
