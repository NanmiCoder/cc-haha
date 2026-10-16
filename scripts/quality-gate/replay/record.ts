#!/usr/bin/env bun
/**
 * `bun run quality:record-cassettes -- --allow-live [--only <id>[,<id>]]`
 *
 * Records replay scenarios against real DeepSeek providers the maintainer has
 * configured in the desktop app, then replays each new cassette once to prove
 * it works before it is committed. This spends real quota, so it refuses to run
 * without `--allow-live`, and it is never part of CI.
 *
 * The provider's key is read once from the real provider config and held in
 * the recording proxy's memory. The server and CLI under test run in a
 * throwaway sandbox with a fake key; nothing is written to the real config.
 *
 * Options:
 *   --anthropic-provider <name>  saved provider for Anthropic-format scenarios (default: DeepSeek)
 *   --openai-provider <name>     saved provider for OpenAI Chat scenarios (default: Custom-DeepSeek-OpenAI)
 */

import { readFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'

import { getProviderIndexPath } from '../providerTargets'
import { REPLAYED_PROVIDER_FIELDS } from './cassette'
import { recordScenarios, replayScenarios, type ReplayLaneResult } from './lane'
import { selectScenarios } from './scenarios'
import type { ApiFormat } from './wire'

type SavedProvider = { id: string; name: string; apiKey?: string; baseUrl?: string; apiFormat?: string; models?: { main?: string } } & Record<string, unknown>

function arg(argv: string[], name: string) {
  const index = argv.indexOf(name)
  const value = argv[index + 1]
  return index === -1 || !value || value.startsWith('--') ? undefined : value
}

function savedProvider(name: string, format: ApiFormat): SavedProvider {
  const index = JSON.parse(readFileSync(getProviderIndexPath(), 'utf8')) as { providers?: SavedProvider[] }
  const matches = (index.providers ?? []).filter((provider) => provider.name === name || provider.id === name)
  if (matches.length !== 1) throw new Error(`expected exactly one saved provider named ${name}, found ${matches.length}`)
  const provider = matches[0]!
  if ((provider.apiFormat ?? 'anthropic') !== format) throw new Error(`${name} uses ${provider.apiFormat}, not ${format}`)
  if (!provider.apiKey || !provider.baseUrl) throw new Error(`${name} has no key or base URL`)
  if (!/deepseek/i.test(`${provider.baseUrl} ${provider.models?.main ?? ''}`)) {
    throw new Error(`${name} is not a DeepSeek provider; recordings use DeepSeek Flash only`)
  }
  return provider
}

function printResults(prefix: string, results: ReplayLaneResult[]) {
  for (const result of results) {
    console.log(`[${prefix}] ${result.status === 'passed' ? 'PASS' : 'FAIL'} ${result.id} (${result.durationMs}ms)${result.detail ? ` — ${result.detail}` : ''}`)
  }
}

async function main() {
  const argv = process.argv.slice(2)
  if (!argv.includes('--allow-live')) {
    console.error('This records against a real provider and spends quota. Re-run with --allow-live.')
    process.exitCode = 2
    return
  }
  const only = (arg(argv, '--only') ?? '').split(',').map((id) => id.trim()).filter(Boolean)
  const scenarios = selectScenarios(only)
  const rootDir = resolve(import.meta.dir, '../../..')
  const artifactDir = join(rootDir, 'artifacts', 'agent-e2e', 'replay-record')
  const providerNames: Record<ApiFormat, string> = {
    anthropic: arg(argv, '--anthropic-provider') ?? 'DeepSeek',
    openai_chat: arg(argv, '--openai-provider') ?? 'Custom-DeepSeek-OpenAI',
  }

  let failed = false
  // One recording run per (format, saved provider): most scenarios use the
  // format's default provider; a scenario can name another (a vision model).
  const runs = [...new Map(scenarios.map((scenario) => {
    const name = scenario.recordProvider ?? providerNames[scenario.format]
    return [`${scenario.format}\u0000${name}`, { format: scenario.format, name }] as const
  })).values()]
  for (const { format, name } of runs) {
    const group = scenarios.filter((scenario) => scenario.format === format && (scenario.recordProvider ?? providerNames[format]) === name)
    const provider = savedProvider(name, format)
    const model = provider.models?.main ?? ''
    console.log(`[record] ${format}: ${group.length} scenario(s) against ${provider.name} (${model}) at ${new URL(provider.baseUrl!).host}`)
    const providerConfig = Object.fromEntries(REPLAYED_PROVIDER_FIELDS.filter((field) => provider[field] !== undefined).map((field) => [field, provider[field]]))
    const upstreamBase = format === 'openai_chat' ? provider.baseUrl!.replace(/\/+$/, '').replace(/\/v1$/, '') : provider.baseUrl!
    const recorded = await recordScenarios({
      rootDir,
      artifactDir: join(artifactDir, format),
      format,
      scenarios: group,
      upstreamBase,
      apiKey: provider.apiKey!,
      providerName: provider.name,
      providerConfig,
      model,
      forbidden: [provider.apiKey!, homedir(), userInfo().username].filter((value) => value.length >= 4),
    })
    printResults('record', recorded)
    const kept = group.filter((scenario) => recorded.find((result) => result.id === scenario.id)?.status === 'passed')
    failed ||= kept.length !== group.length
    if (kept.length === 0) continue
    // A cassette is only worth committing if it replays.
    const replayed = await replayScenarios({ rootDir, artifactDir: join(artifactDir, `${format}-self-check`), format, scenarios: kept })
    printResults('self-check', replayed)
    failed ||= replayed.some((result) => result.status === 'failed')
  }
  if (failed) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
