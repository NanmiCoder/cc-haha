/**
 * Runs replay scenarios through the real server and real CLI, either recording
 * against a real provider or replaying committed cassettes. Both modes go
 * through `executeAgentFlowAgainstProvider`, the same harness as the live and
 * mock-LLM lanes, so they can only differ in what sits behind the provider URL.
 */

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sanitizePath } from '../../../src/utils/sessionStoragePortable'

import { executeAgentFlowAgainstProvider, type LiveAgentFlowResult, type LiveContext } from '../agent-flow/live'
import { loadCassette, saveCassette, type Cassette } from './cassette'
import { pathVariants, type PlaceholderTable } from './normalize'
import { buildCassette, scanForSecrets, startRecorder, type RawInteraction } from './recorder'
import { startReplayServer, type ReplayReport } from './replayServer'
import type { ReplayContext, ReplayScenario } from './scenarios'
import { fingerprintRequest, responseFeatures, type ApiFormat } from './wire'

const STEP_TIMEOUT_MS = { record: 180_000, replay: 60_000 }

function allSpellings(path: string) {
  let real = path
  try { real = realpathSync(path) } catch { /* not created yet */ }
  return [...new Set([real, path, ...pathVariants(real), ...pathVariants(path)])]
}

/**
 * Everything run-specific a model can see and repeat: the work dir, the
 * sandbox config dir (memory and transcripts live there), the project's
 * directory name under it, the sessions the scenario created, and the date.
 */
export function placeholderTable(ctx: Pick<LiveContext, 'workRoot' | 'configDir'>, scenarioId: string, sessionIds: string[] = [], date = new Date()): PlaceholderTable {
  const workRoot = allSpellings(join(ctx.workRoot, scenarioId))
  return [
    { name: 'WORK_ROOT', values: workRoot },
    { name: 'CONFIG_DIR', values: allSpellings(ctx.configDir) },
    { name: 'PROJECT_SLUG', values: [...new Set(workRoot.map(sanitizePath))] },
    ...sessionIds.map((id, index) => ({ name: `SESSION_ID_${index + 1}`, values: [id] })),
    { name: 'DATE', values: [date.toISOString().slice(0, 10)] },
    // Fallback for paths a model abbreviates or garbles in prose (a compaction
    // summary): anything under the temp dir loses the machine-specific prefix.
    // The trailing separator keeps a short /tmp from matching unrelated text.
    { name: 'TMP', values: allSpellings(tmpdir()).map((path) => `${path.replace(/\/+$/, '')}/`) },
    { name: 'TMP_SLUG', values: [...new Set(allSpellings(tmpdir()).map((path) => `${sanitizePath(path.replace(/\/+$/, ''))}-`))] },
  ]
}

/** What a recording must contain before it is committed. */
export function unmetRequirements(scenario: ReplayScenario, raw: RawInteraction[]): string[] {
  const features = raw.map((interaction) => responseFeatures(scenario.format, interaction.response.events ?? []))
  const problems: string[] = []
  if (scenario.requires.thinking && !features.some((feature) => feature.thinking)) problems.push('no thinking in any response')
  if (scenario.requires.fragmentedToolInput && !features.some((feature) => feature.fragmentedToolInput)) problems.push('no tool input arrived in more than one fragment')
  const called = new Set(features.flatMap((feature) => feature.toolNames))
  for (const tool of scenario.requires.toolsUsed ?? []) if (!called.has(tool)) problems.push(`the model never called ${tool}`)
  if (scenario.requires.parallelToolCalls && !features.some((feature) => feature.toolNames.length > 1)) problems.push('no response called more than one tool at once')
  if (scenario.requires.toolError && !raw.some((interaction) => requestCarriesToolError(scenario.format, interaction.body))) problems.push('no tool call failed and went back to the model')
  if (scenario.requires.agentLoops) {
    const loops = new Set(raw
      .map((interaction) => fingerprintRequest(scenario.format, interaction.body))
      .filter((fingerprint) => fingerprint.toolNames.length > 0)
      .map((fingerprint) => fingerprint.firstUserText))
    if (loops.size < scenario.requires.agentLoops) problems.push(`only ${loops.size} agent loop(s) called the model, expected ${scenario.requires.agentLoops}`)
  }
  if (raw.some((interaction) => interaction.response.status === 599)) problems.push('the recorder could not reach the provider')
  return problems
}

function requestCarriesToolError(format: ApiFormat, body: Record<string, unknown>) {
  const messages = Array.isArray(body.messages) ? body.messages as Array<{ role?: string; content?: unknown }> : []
  if (format === 'anthropic') {
    return messages.some((message) => Array.isArray(message.content) && (message.content as Array<{ type?: string; is_error?: boolean }>).some((part) => part.type === 'tool_result' && part.is_error === true))
  }
  return messages.some((message) => message.role === 'tool' && /error|failed|not found/i.test(typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
}

/** Settings this scenario runs with: the saved provider's, plus the scenario's own overrides. */
export function scenarioProviderConfig(base: Record<string, unknown>, scenario: ReplayScenario) {
  return { ...base, ...scenario.providerOverrides }
}

/**
 * Registers the scenario's provider and pins every session the scenario opens
 * to it, so per-scenario settings (a small auto-compact window) apply.
 */
async function scenarioContext(ctx: LiveContext, scenario: ReplayScenario, upstreamUrl: string, config: Record<string, unknown>, sessionIds: string[]): Promise<ReplayContext> {
  const providerId = await registerProvider(ctx.baseUrl, upstreamUrl, `${scenario.id} provider`, config)
  const modelId = String((config.models as { main?: string } | undefined)?.main ?? ctx.target.modelId)
  return {
    ...ctx,
    sessionIds,
    target: { ...ctx.target, providerId, modelId },
    pinRuntime(socket) {
      socket.send({ type: 'set_runtime_config', providerId, modelId })
    },
  }
}

async function registerProvider(baseUrl: string, upstreamUrl: string, name: string, config: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...config, name, apiKey: 'replay-fake-key', baseUrl: upstreamUrl }),
  })
  if (!response.ok) throw new Error(`registering ${name} failed: ${response.status} ${await response.text()}`)
  const body = await response.json() as { provider?: { id?: string }; id?: string }
  const id = body.provider?.id ?? body.id
  if (!id) throw new Error(`provider create returned no id: ${JSON.stringify(body)}`)
  return id
}

export type ReplayLaneResult = LiveAgentFlowResult & { report?: ReplayReport; unmet?: string[] }

export async function recordScenarios(options: {
  rootDir: string
  artifactDir: string
  format: ApiFormat
  scenarios: ReplayScenario[]
  upstreamBase: string
  apiKey: string
  providerName: string
  providerConfig: Record<string, unknown>
  model: string
  /** Values a cassette must never contain (the key, the real home dir, the user name). */
  forbidden: string[]
  cassetteDir?: string
}): Promise<ReplayLaneResult[]> {
  const recorder = startRecorder({ format: options.format, upstreamBase: options.upstreamBase, apiKey: options.apiKey })
  const extra = new Map<string, { unmet: string[] }>()
  const rawDir = join(options.artifactDir, 'raw')
  mkdirSync(rawDir, { recursive: true })
  try {
    const results = await executeAgentFlowAgainstProvider({
      rootDir: options.rootDir,
      artifactDir: options.artifactDir,
      label: `agent-replay-record-${options.format}`,
      seedProviders: false,
      stepTimeoutMs: STEP_TIMEOUT_MS.record,
      scenarios: options.scenarios,
      runners: Object.fromEntries(options.scenarios.map((scenario) => [scenario.id, async (ctx: LiveContext) => {
        await recorder.settle(500)
        recorder.take()
        const sessionIds: string[] = []
        const providerConfig = scenarioProviderConfig(options.providerConfig, scenario)
        let raw: RawInteraction[] = []
        try {
          await scenario.run(await scenarioContext(ctx, scenario, recorder.url, providerConfig, sessionIds))
        } finally {
          await recorder.settle()
          // Kept for a failed run too: the raw traffic is how a rejected recording is diagnosed.
          raw = recorder.take()
          writeFileSync(join(rawDir, `${scenario.id}.json`), `${JSON.stringify(raw, null, 1)}\n`)
        }
        const unmet = unmetRequirements(scenario, raw)
        extra.set(scenario.id, { unmet })
        if (unmet.length > 0) throw new Error(`recording rejected: ${unmet.join('; ')}`)
        const cassette = buildCassette({
          id: scenario.id,
          format: options.format,
          provider: options.providerName,
          model: options.model,
          providerConfig,
          raw,
          table: placeholderTable(ctx, scenario.id, sessionIds),
        })
        const problems = scanForSecrets(JSON.stringify(cassette), [...options.forbidden, tmpdir(), ...allSpellings(tmpdir())])
        if (problems.length > 0) throw new Error(`recording rejected, cassette ${problems.join('; ')}`)
        saveCassette(cassette, options.cassetteDir)
      }])),
      async resolveTarget({ baseUrl }) {
        const providerId = await registerProvider(baseUrl, recorder.url, `${options.providerName} (recording)`, options.providerConfig)
        return { providerId, providerName: options.providerName, modelId: options.model, host: options.upstreamBase, source: 'scripts/quality-gate/replay/record.ts' }
      },
    })
    return results.map((result) => ({ ...result, ...extra.get(result.id) }))
  } finally {
    await recorder.stop()
  }
}

export async function replayScenarios(options: {
  rootDir: string
  artifactDir: string
  format: ApiFormat
  scenarios: ReplayScenario[]
  cassetteDir?: string
}): Promise<ReplayLaneResult[]> {
  const cassettes = new Map<string, Cassette>()
  for (const scenario of options.scenarios) {
    const cassette = loadCassette(scenario.id, options.cassetteDir)
    if (!cassette) throw new Error(`no cassette for ${scenario.id}; record it with: bun run quality:record-cassettes -- --allow-live --only ${scenario.id}`)
    if (cassette.format !== options.format) throw new Error(`${scenario.id} was recorded as ${cassette.format}, not ${options.format}`)
    cassettes.set(scenario.id, cassette)
  }
  const first = cassettes.values().next().value as Cassette | undefined
  if (!first) return []
  const replay = startReplayServer({ format: options.format })
  const reports = new Map<string, ReplayReport>()
  try {
    const results = await executeAgentFlowAgainstProvider({
      rootDir: options.rootDir,
      artifactDir: options.artifactDir,
      label: `agent-replay-${options.format}`,
      seedProviders: false,
      stepTimeoutMs: STEP_TIMEOUT_MS.replay,
      scenarios: options.scenarios,
      runners: Object.fromEntries(options.scenarios.map((scenario) => [scenario.id, async (ctx: LiveContext) => {
        const sessionIds: string[] = []
        const cassette = cassettes.get(scenario.id)!
        replay.load(cassette, () => placeholderTable(ctx, scenario.id, sessionIds), { pacing: scenario.replayPacing })
        let runError: unknown
        try {
          await scenario.run(await scenarioContext(ctx, scenario, replay.url, cassette.providerConfig, sessionIds))
        } catch (error) {
          runError = error
        }
        // Let trailing side calls (a session title) reach the replay before judging.
        await Bun.sleep(300)
        const report = replay.finish()
        reports.set(scenario.id, report)
        writeFileSync(join(options.artifactDir, `${scenario.id}.report.json`), `${JSON.stringify(report, null, 2)}\n`)
        const problems = [
          ...report.mismatches.map((mismatch) => `mismatch at ${mismatch.seq ?? 'extra request'} (${mismatch.queue}): ${mismatch.reason}`),
          ...report.unused.map((unused) => `recorded request ${unused.seq} was never made`),
        ]
        if (problems.length > 0) throw new Error(`${problems.join('; ')}${runError ? `; run: ${runError instanceof Error ? runError.message : String(runError)}` : ''}`)
        if (runError) throw runError
      }])),
      async resolveTarget({ baseUrl }) {
        const providerId = await registerProvider(baseUrl, replay.url, 'Replay', first.providerConfig)
        return { providerId, providerName: 'Replay', modelId: first.recordedWith.model, host: replay.url, source: 'scripts/quality-gate/replay/cassettes' }
      },
    })
    return results.map((result) => ({ ...result, report: reports.get(result.id) }))
  } finally {
    await replay.stop()
  }
}
