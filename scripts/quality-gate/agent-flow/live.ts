/**
 * Agent-flow scenarios driven by a provider the user actually configured.
 *
 * `check:agent-flow` proves the protocol is wired correctly using the mock CLI. It
 * cannot prove the thing this product is: a desktop agent talking to a real model.
 * That only runs where the credentials are — the maintainer's machine — so this lane
 * is local and manual by construction. It is registered in no CI mode and no
 * `requiredForModes`, and `check:policy` fails if that changes.
 *
 * Real provider means real spend, so the run refuses to start until it has printed
 * exactly which provider, model and host it is about to talk to and been told to go
 * ahead. All user state is copied into a throwaway config dir first: the run reads
 * the real `~/.claude` once and never writes to it.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { createQualityGateSandbox } from '../sandbox.ts'
import { loadProviderIndex, getProviderIndexPath } from '../providerTargets.ts'
import { getPort, pipeToFile, runTurn, SessionSocket, waitForHttp } from './execute.ts'
import { LIVE_AGENT_FLOW_SCENARIOS } from './liveScenarios.ts'

const FIXTURE = 'scripts/quality-gate/agent-flow/fixtures/workspace'
/** Live turns wait on a real model, so every step gets far longer than the mock lane. */
const LIVE_STEP_TIMEOUT_MS = 180_000

export type LiveAgentFlowResult = {
  id: string
  title: string
  status: 'passed' | 'failed'
  detail?: string
  durationMs: number
}

export type ResolvedLiveTarget = {
  providerId: string
  providerName: string
  modelId: string
  effortLevel?: string
  /** Applied only to the copied provider config used by this live run. */
  disableExperimentalBetas?: boolean
  /** Host only. The full base URL can carry a key in its query string. */
  host: string
  source: string
}

/**
 * Picks the provider to run against. Never guesses: an ambiguous or missing selector
 * is an error, because the failure mode of guessing is spending someone's money on a
 * provider they did not choose.
 */
export function resolveLiveTarget(
  selector: string | undefined,
  options: {
    configDir?: string
    modelId?: string
    effortLevel?: string
    disableExperimentalBetas?: boolean
  } = {},
): ResolvedLiveTarget {
  const configDir = options.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const index = loadProviderIndex(configDir)
  const indexPath = getProviderIndexPath(configDir)

  if (index.providers.length === 0) {
    throw new Error(
      `No providers configured in ${indexPath}. Add one in the desktop app first — this lane deliberately has no built-in fallback.`,
    )
  }

  if (!selector) {
    const names = index.providers.map((provider) => provider.name).join(', ')
    throw new Error(
      `--provider is required. This lane spends real quota, so it will not fall back to the active provider.\nConfigured: ${names}`,
    )
  }

  const needle = selector.trim().toLowerCase()
  const matches = index.providers.filter(
    (provider) => provider.id.toLowerCase() === needle || provider.name.toLowerCase() === needle,
  )
  const loose = matches.length > 0
    ? matches
    : index.providers.filter((provider) => provider.name.toLowerCase().includes(needle))

  if (loose.length === 0) {
    throw new Error(`No configured provider matches "${selector}". Configured: ${index.providers.map((p) => p.name).join(', ')}`)
  }
  if (loose.length > 1) {
    throw new Error(
      `${selector} matches ${loose.length} providers (${loose.map((p) => p.name).join(', ')}). Pass an exact name or id.`,
    )
  }

  const provider = loose[0]!
  const modelId = options.modelId ?? provider.models?.main ?? 'current'
  return {
    providerId: provider.id,
    providerName: provider.name,
    modelId,
    ...(options.effortLevel ? { effortLevel: options.effortLevel } : {}),
    ...(options.disableExperimentalBetas ? { disableExperimentalBetas: true } : {}),
    host: 'resolved by the server from the sandboxed provider config',
    source: indexPath,
  }
}

export function applyLiveTargetSandboxOverrides(
  configDir: string,
  target: ResolvedLiveTarget,
): void {
  if (!target.disableExperimentalBetas) return

  const indexPath = getProviderIndexPath(configDir)
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
    providers?: Array<Record<string, unknown>>
  }
  const provider = index.providers?.find((candidate) => candidate.id === target.providerId)
  if (!provider) {
    throw new Error(`Provider ${target.providerId} is missing from sandboxed provider config`)
  }
  provider.disableExperimentalBetas = true
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`)
}

/** The banner the operator has to read before anything is sent upstream. */
export function describeLiveTarget(target: ResolvedLiveTarget, scenarioCount: number): string {
  return [
    '',
    '  This lane talks to a real provider. That may cost real money.',
    '',
    `    provider   ${target.providerName}  (${target.providerId})`,
    `    model      ${target.modelId}`,
    ...(target.effortLevel ? [`    effort     ${target.effortLevel}`] : []),
    ...(target.disableExperimentalBetas
      ? ['    beta mode  disabled in the sandbox copy only']
      : []),
    `    read from  ${target.source}`,
    `    scenarios  ${scenarioCount}`,
    '',
    '  User state is copied into a throwaway config dir; the real ~/.claude is never written to.',
    '  Re-run with --yes to proceed.',
    '',
  ].join('\n')
}

export type LiveContext = {
  baseUrl: string
  workRoot: string
  artifactDir: string
  target: ResolvedLiveTarget
  stepTimeoutMs: number
  createSession(): Promise<string>
  openSocket(sessionId: string): Promise<SessionSocket>
  pinRuntime(socket: SessionSocket): void
}

export type LiveScenarioRunner = (ctx: LiveContext) => Promise<void>

export type LiveEffortField = {
  path: string
  value: string
}

export function collectLiveEffortFields(value: unknown, path = 'request.body'): LiveEffortField[] {
  if (!value || typeof value !== 'object') return []

  const snapshot = value as { contentType?: unknown; preview?: unknown }
  if (snapshot.contentType === 'json' && typeof snapshot.preview === 'string') {
    try {
      return collectLiveEffortFields(JSON.parse(snapshot.preview), path)
    } catch {
      const fields: LiveEffortField[] = []
      const pattern = /"(effort|reasoning_effort)"\s*:\s*"([^"]+)"/g
      for (const match of snapshot.preview.matchAll(pattern)) {
        fields.push({ path: `${path}.preview.${match[1]}`, value: match[2]! })
      }
      return fields
    }
  }

  const fields: LiveEffortField[] = []
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`
    if ((key === 'effort' || key === 'reasoning_effort') && typeof child === 'string') {
      fields.push({ path: childPath, value: child })
    }
    fields.push(...collectLiveEffortFields(child, childPath))
  }
  return fields
}

async function captureLiveEffortEvidence(ctx: LiveContext, sessionId: string): Promise<void> {
  const expected = ctx.target.effortLevel
  if (!expected) return

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const traceResponse = await fetch(`${ctx.baseUrl}/api/sessions/${sessionId}/trace`)
    if (traceResponse.ok) {
      const trace = await traceResponse.json() as { calls?: Array<{ id?: string }> }
      for (const item of [...(trace.calls ?? [])].reverse()) {
        if (!item.id) continue
        const detailResponse = await fetch(
          `${ctx.baseUrl}/api/sessions/${sessionId}/trace/calls/${encodeURIComponent(item.id)}`,
        )
        if (!detailResponse.ok) continue
        const detail = await detailResponse.json() as {
          call?: {
            source?: string
            model?: string
            request?: { headers?: Record<string, unknown>; body?: unknown }
            response?: { status?: number }
          }
        }
        const call = detail.call
        const effortFields = collectLiveEffortFields(call?.request?.body)
        if (!effortFields.some((field) => field.value === expected)) continue

        const requestHeaderNames = Object.keys(call?.request?.headers ?? {}).map((name) => name.toLowerCase())
        const anthropicBetaHeaderPresent = requestHeaderNames.includes('anthropic-beta')
        if (ctx.target.disableExperimentalBetas && anthropicBetaHeaderPresent) {
          throw new Error('sandbox requested disabled experimental betas, but the live request still sent anthropic-beta')
        }

        writeFileSync(join(ctx.artifactDir, 'effort-evidence.json'), `${JSON.stringify({
          providerName: ctx.target.providerName,
          modelId: call?.model ?? ctx.target.modelId,
          requestedEffort: expected,
          disableExperimentalBetas: ctx.target.disableExperimentalBetas === true,
          traceSource: call?.source ?? null,
          effortFields,
          anthropicBetaHeaderPresent,
          responseStatus: call?.response?.status ?? null,
        }, null, 2)}\n`)
        return
      }
    }
    await Bun.sleep(200)
  }

  throw new Error(`live request completed but no captured request body carried effort=${expected}`)
}

function assistantTextCount(socket: SessionSocket) {
  return socket.messages.filter((message) => message.type === 'content_start').length
}

export const LIVE_SCENARIO_RUNNERS: Record<string, LiveScenarioRunner> = {
  async 'live-first-turn'(ctx) {
    const sessionId = await ctx.createSession()
    const socket = await ctx.openSocket(sessionId)
    try {
      ctx.pinRuntime(socket)
      const turn = await runTurn(socket, 'Reply with a single short sentence confirming you are ready.', ctx.stepTimeoutMs)
      const streamed = turn.filter((message) => message.type === 'content_delta' && String(message.text ?? '').trim())
      if (streamed.length === 0) {
        throw new Error(`no assistant text streamed; saw ${turn.map((m) => m.type).join(', ')}`)
      }
      await captureLiveEffortEvidence(ctx, sessionId)
    } finally {
      socket.close()
    }
  },

  async 'live-permission-allow'(ctx) {
    const socket = await ctx.openSocket(await ctx.createSession())
    const target = join(ctx.workRoot, 'live-allowed.txt')
    try {
      ctx.pinRuntime(socket)
      const start = socket.messages.length
      socket.send({
        type: 'user_message',
        content: `Create a file called live-allowed.txt in the current directory. Its entire contents must be the single word ALLOWED. Use your file writing tool, then stop.`,
      })

      const request = await socket.waitFor(
        (message) => message.type === 'permission_request',
        ctx.stepTimeoutMs,
        'permission_request',
        start,
      )
      if (existsSync(target)) {
        throw new Error('the file appeared before the permission request was answered')
      }
      socket.send({ type: 'permission_response', requestId: request.requestId, allowed: true, rule: 'agent-flow-live' })
      await socket.waitFor((m) => m.type === 'message_complete', ctx.stepTimeoutMs, 'message_complete', start)

      if (!existsSync(target)) {
        throw new Error(`approved write never landed. Tool was ${request.toolName}`)
      }
      if (!readFileSync(target, 'utf8').toUpperCase().includes('ALLOWED')) {
        throw new Error('approved write landed but the content is not what was asked for')
      }
    } finally {
      socket.close()
    }
  },

  async 'live-permission-deny'(ctx) {
    const socket = await ctx.openSocket(await ctx.createSession())
    const target = join(ctx.workRoot, 'live-denied.txt')
    try {
      ctx.pinRuntime(socket)
      const start = socket.messages.length
      socket.send({
        type: 'user_message',
        content: `Create a file called live-denied.txt in the current directory containing the word DENIED. Use your file writing tool, then stop.`,
      })

      const request = await socket.waitFor(
        (message) => message.type === 'permission_request',
        ctx.stepTimeoutMs,
        'permission_request',
        start,
      )
      socket.send({ type: 'permission_response', requestId: request.requestId, allowed: false, rule: 'agent-flow-live' })
      await socket.waitFor((m) => m.type === 'message_complete', ctx.stepTimeoutMs, 'message_complete', start)

      if (existsSync(target)) {
        throw new Error('a denied write still reached the disk')
      }
    } finally {
      socket.close()
    }
  },

  async 'live-interrupt'(ctx) {
    const socket = await ctx.openSocket(await ctx.createSession())
    try {
      ctx.pinRuntime(socket)
      const start = socket.messages.length
      socket.send({
        type: 'user_message',
        content: 'Count from 1 to 300, writing each number on its own line. Do not stop early.',
      })
      await socket.waitFor((m) => m.type === 'content_delta', ctx.stepTimeoutMs, 'first content_delta', start)

      socket.send({ type: 'stop_generation' })
      await socket.waitFor(
        (m) => m.type === 'message_complete' || m.type === 'session_state_changed',
        ctx.stepTimeoutMs,
        'stream to settle after stop',
        start,
      )

      // The real check is that it goes quiet: a stop that only flips a flag while the
      // model keeps streaming is the failure this scenario exists for.
      const settled = socket.messages.length
      await Bun.sleep(3_000)
      const arrivedAfter = socket.messages.slice(settled).filter((m) => m.type === 'content_delta')
      if (arrivedAfter.length > 0) {
        throw new Error(`${arrivedAfter.length} content_delta frames arrived 3s after the stream was stopped`)
      }
    } finally {
      socket.close()
    }
  },

  async 'live-reconnect'(ctx) {
    const sessionId = await ctx.createSession()
    const first = await ctx.openSocket(sessionId)
    let second: SessionSocket | null = null
    try {
      ctx.pinRuntime(first)
      await runTurn(first, 'Reply with one short sentence.', ctx.stepTimeoutMs)
      const before = assistantTextCount(first)
      first.close()

      second = await ctx.openSocket(sessionId)
      await Bun.sleep(3_000)
      const replayed = assistantTextCount(second)
      if (replayed > before) {
        throw new Error(`reconnect replayed ${replayed - before} extra assistant message(s)`)
      }
    } finally {
      first.close()
      second?.close()
    }
  },

  async 'live-session-recovery'(ctx) {
    const sessionId = await ctx.createSession()
    const socket = await ctx.openSocket(sessionId)
    try {
      ctx.pinRuntime(socket)
      await runTurn(socket, 'Reply with one short sentence.', ctx.stepTimeoutMs)
      const seen = assistantTextCount(socket)

      const response = await fetch(`${ctx.baseUrl}/api/sessions/${sessionId}/messages`)
      if (!response.ok) throw new Error(`history fetch failed: ${response.status}`)
      const body = await response.json() as { messages?: Array<{ type?: string }> }
      const persisted = (body.messages ?? []).filter((message) => message.type === 'assistant').length
      if (persisted < seen) {
        throw new Error(`socket delivered ${seen} assistant message(s) but the transcript kept ${persisted}`)
      }
    } finally {
      socket.close()
    }
  },
}

export type AgentFlowAgainstProviderOptions = {
  rootDir: string
  artifactDir: string
  /** Sandbox label, also the prefix of the throwaway dirs. */
  label: string
  /** Copy the user's saved providers into the sandbox (live lane only). */
  seedProviders: boolean
  stepTimeoutMs: number
  scenarios: ReadonlyArray<{ id: string; title: string }>
  runners: Record<string, LiveScenarioRunner>
  /**
   * Picks the provider the scenarios pin. Runs after the server is up, so a lane can
   * register its provider through the same API the desktop app uses.
   */
  resolveTarget(server: { baseUrl: string; configDir: string }): Promise<ResolvedLiveTarget>
}

/**
 * Real server, real CLI, one provider. Shared by the live lane (a provider the user
 * configured) and the mock-LLM lane (a scripted loopback provider), so the two can
 * only differ in what sits behind the CLI.
 */
export async function executeAgentFlowAgainstProvider(
  options: AgentFlowAgainstProviderOptions,
): Promise<LiveAgentFlowResult[]> {
  const { rootDir, artifactDir } = options
  mkdirSync(artifactDir, { recursive: true })
  const serverLogPath = join(artifactDir, 'server.log')
  rmSync(join(artifactDir, 'effort-evidence.json'), { force: true })
  writeFileSync(serverLogPath, '')

  const port = await getPort()
  const baseUrl = `http://127.0.0.1:${port}`
  const workRoot = await mkdtemp(join(tmpdir(), `cc-haha-${options.label}-`))
  cpSync(join(rootDir, FIXTURE), workRoot, { recursive: true })

  // Every write the run makes lands in the throwaway dir. CLAUDE_CLI_PATH is
  // deliberately left alone — unlike the mock-CLI lane, this one wants the real CLI.
  const sandbox = createQualityGateSandbox({
    label: options.label,
    seedProviders: options.seedProviders,
    envOverrides: { CC_HAHA_DISABLE_TERMINAL_SHELL_ENV: '1' },
  })

  const server = Bun.spawn(['bun', 'run', 'src/server/index.ts', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: rootDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...sandbox.env, SERVER_PORT: String(port) },
  })
  const pumps = [pipeToFile(server.stdout, serverLogPath), pipeToFile(server.stderr, serverLogPath)]

  const results: LiveAgentFlowResult[] = []
  try {
    await waitForHttp(`${baseUrl}/health`, 60_000)
    const target = await options.resolveTarget({ baseUrl, configDir: sandbox.configDir })

    const ctx: LiveContext = {
      baseUrl,
      workRoot,
      artifactDir,
      target,
      stepTimeoutMs: options.stepTimeoutMs,
      async createSession() {
        const response = await fetch(`${baseUrl}/api/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workDir: workRoot }),
        })
        if (!response.ok) throw new Error(`session create failed: ${response.status}`)
        const body = await response.json() as { id?: string; sessionId?: string }
        const id = body.id ?? body.sessionId
        if (!id) throw new Error(`session create returned no id: ${JSON.stringify(body)}`)
        return id
      },
      async openSocket(sessionId) {
        return await new SessionSocket(baseUrl, sessionId).open()
      },
      pinRuntime(socket) {
        socket.send({
          type: 'set_runtime_config',
          providerId: target.providerId,
          modelId: target.modelId,
          ...(target.effortLevel ? { effortLevel: target.effortLevel } : {}),
        })
      },
    }

    for (const scenario of options.scenarios) {
      const runner = options.runners[scenario.id]
      const started = Date.now()
      try {
        if (!runner) throw new Error(`no runner registered for scenario ${scenario.id}`)
        await runner(ctx)
        results.push({ id: scenario.id, title: scenario.title, status: 'passed', durationMs: Date.now() - started })
      } catch (error) {
        results.push({
          id: scenario.id,
          title: scenario.title,
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - started,
        })
      }
    }
  } finally {
    server.kill()
    await Promise.allSettled(pumps)
    // Checked before teardown: a run that wrote to the real config dir has to be loud,
    // not quietly cleaned up.
    const mutations = sandbox.detectUserStateMutations()
    sandbox.cleanup()
    rmSync(workRoot, { recursive: true, force: true })
    if (mutations.length > 0) {
      throw new Error(`${options.label} mutated real user state:\n  ${mutations.join('\n  ')}`)
    }
  }

  return results
}

export async function executeLiveAgentFlow(options: {
  rootDir: string
  artifactDir: string
  target: ResolvedLiveTarget
  only?: string[]
}): Promise<LiveAgentFlowResult[]> {
  const { target } = options
  const scenarios = options.only?.length
    ? LIVE_AGENT_FLOW_SCENARIOS.filter((scenario) => options.only!.includes(scenario.id))
    : LIVE_AGENT_FLOW_SCENARIOS

  return await executeAgentFlowAgainstProvider({
    rootDir: options.rootDir,
    artifactDir: options.artifactDir,
    label: 'agent-flow-live',
    // Seeded, not shared: the sandbox gets a copy of the real provider config so the
    // server can reach the chosen provider.
    seedProviders: true,
    stepTimeoutMs: LIVE_STEP_TIMEOUT_MS,
    scenarios,
    runners: LIVE_SCENARIO_RUNNERS,
    async resolveTarget({ configDir }) {
      applyLiveTargetSandboxOverrides(configDir, target)
      return target
    },
  })
}
