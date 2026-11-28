import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TeamPlanRecord } from '../../../src/shared/teamPlan'
import { executeAgentFlowAgainstProvider, type LiveContext } from '../agent-flow/live'
import { runTurn } from '../agent-flow/execute'
import { startMockLlmServer } from './server'
import type { MockReply, MockRequest } from './scriptedModel'

const TEAM = 'review-fixture'
const TIMEOUT_MS = 30_000
type Phase = 'initial' | 'addition' | 'waiting'
type ToolResult = { tool_use_id?: string; is_error?: boolean; content?: unknown }

function resultText(result: ToolResult) {
  if (typeof result.content === 'string') return result.content
  return Array.isArray(result.content)
    ? result.content.map(block => typeof block?.text === 'string' ? block.text : '').join('\n') : ''
}

/** Refuse error/missing metadata, so a script cannot manufacture a successful submit. */
export function stagedPlanIdentity(result: ToolResult) {
  const text = resultText(result)
  assert.ok(!result.is_error, text)
  const planId = /^plan_id: (.+)$/m.exec(text)?.[1]
  const revision = Number(/^revision: (\d+) \(use it as TeamPlan expected_revision\)$/m.exec(text)?.[1])
  assert.ok(planId && Number.isSafeInteger(revision) && revision > 0, `Missing staged plan identity: ${text}`)
  assert.ok(text.includes('NOT started') && text.includes('Only human confirmation starts execution.'), text)
  return { planId, revision }
}

const textReply = (text: string): MockReply => ({ kind: 'message', content: [{ type: 'text', text }], stopReason: 'end_turn' })
const toolReply = (id: string, name: string, input: Record<string, unknown>): MockReply => ({
  kind: 'message', content: [{ type: 'tool_use', id, name, input }], stopReason: 'tool_use',
})

function proposal(name: string) {
  return {
    members: [{ id: name, name, agentType: 'general-purpose', prompt: `TEAM_REVIEW_CHILD_${name}: Reply ready, then wait for more work.` }],
    tasks: [{ id: `task-${name}`, subject: `Fixture work for ${name}`, ownerId: name, dependencies: [] }],
  }
}

/** Real desktop protocol, leader/worker CLIs and tools; only the Anthropic endpoint is scripted. */
export async function runTeamReviewScenario(rootDir: string, artifactDir: string) {
  mkdirSync(artifactDir, { recursive: true })
  let phase: Phase = 'initial'
  let step = 0
  let scriptError: string | undefined
  let baseUrl = ''
  let configDir = ''
  let workRoot = ''
  const staged: Partial<Record<Phase, ReturnType<typeof stagedPlanIdentity>>> = {}
  const workers: Array<{ name: string; phase: Phase; at: number }> = []
  const results: Array<{ phase: Phase; result: ToolResult }> = []
  const snapshots: Array<{ phase: Phase; plan: TeamPlanRecord; workers: typeof workers }> = []
  const actions: Array<{ path: string; status: number }> = []
  const upstream = startMockLlmServer((request: MockRequest): MockReply => {
    if (!request.tools?.some(tool => tool.name === 'TeamPlan')) {
      const prompt = JSON.stringify(request.messages?.at(-1)?.content ?? '')
      const name = /TEAM_REVIEW_CHILD_(reviewer|fix-touch)/.exec(prompt)?.[1]
      if (name && request.tools?.some(tool => tool.name === 'Read')) workers.push({ name, phase, at: Date.now() })
      return textReply('Mock worker or auxiliary reply')
    }
    if (phase === 'waiting') return textReply('Waiting for the next user request')
    try {
      const latest = JSON.stringify(request.messages?.at(-1)?.content ?? '')
      // Existing workers may notify the lead while the increment is under
      // review. Those are separate coordination turns, never a new proposal.
      if (staged[phase]) return textReply('The proposal is waiting for human review')
      if (phase === 'addition' && step === 0 && !latest.includes('TEAM_REVIEW_ADD')) return textReply('Waiting for the next user request')
      if (phase === 'initial' && step === 0) {
        step++
        return toolReply('review-create', 'TeamCreate', { team_name: TEAM })
      }
      const name = phase === 'initial' ? 'reviewer' : 'fix-touch'
      if ((phase === 'initial' && step === 1) || (phase === 'addition' && step === 0)) {
        step++
        return toolReply(`${phase}-stage`, 'Agent', { name, team_name: TEAM, subagent_type: 'general-purpose',
          description: 'Propose a member for review', prompt: proposal(name).members[0]!.prompt })
      }
      const blocks = request.messages?.at(-1)?.content
      const result = Array.isArray(blocks) ? blocks.find(block => block.type === 'tool_result' && block.tool_use_id === `${phase}-stage`) : undefined
      assert.ok(result, `No real Agent result for ${phase}`)
      results.push({ phase, result })
      staged[phase] = stagedPlanIdentity(result)
      return toolReply(`${phase}-submit`, 'TeamPlan', { team_name: TEAM, operation: 'submit',
        expected_revision: staged[phase]!.revision, plan: proposal(name) })
    } catch (error) {
      // End the turn instead of making the mock throw/retry HTTP 500. The runner
      // fails on the exact observed tool error, including an old-source control.
      scriptError = error instanceof Error ? error.message : String(error)
      return textReply('Fixture could not submit the staged result')
    }
  })
  let outcomes: Awaited<ReturnType<typeof executeAgentFlowAgainstProvider>> = []
  let cliStarts = 0
  try {
    outcomes = await executeAgentFlowAgainstProvider({
      rootDir, artifactDir, label: 'team-review', seedProviders: false, stepTimeoutMs: TIMEOUT_MS,
      sandboxSource: { PATH: process.env.PATH, SHELL: process.env.SHELL, SYSTEMROOT: process.env.SYSTEMROOT,
        CLAUDE_CONFIG_DIR: join(artifactDir, 'unused-source-config') },
      envOverrides: { CC_HAHA_SKIP_DOTENV: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
        CC_HAHA_AGENT_TEAMS_ENABLED: '1', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
      scenarios: [{ id: 'team-review', title: 'review an initial roster and a running-team addition (#1856)' }],
      async resolveTarget(server) {
        baseUrl = server.baseUrl
        configDir = server.configDir
        const response = await fetch(`${baseUrl}/api/providers`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ presetId: 'custom', name: 'Mock review provider', apiKey: 'mock-team-review-key', baseUrl: upstream.url,
            apiFormat: 'anthropic', models: { main: 'mock-model', haiku: 'mock-model', sonnet: 'mock-model', opus: 'mock-model' } }) })
        assert.equal(response.status, 201, await response.clone().text())
        const body = await response.json() as { provider?: { id: string }; id?: string }
        const providerId = body.provider?.id ?? body.id
        assert.ok(providerId)
        return { providerId, providerName: 'Mock review provider', modelId: 'mock-model', host: upstream.url, source: 'synthetic HTTP provider' }
      },
      runners: { async 'team-review'(ctx: LiveContext) {
        workRoot = ctx.workRoot
        const sessionId = await ctx.createSession()
        const socket = await ctx.openSocket(sessionId)
        ctx.pinRuntime(socket)
        const identity = (plan: TeamPlanRecord) => ({ sessionId: plan.sessionId, planId: plan.planId, incarnationId: plan.incarnationId, expectedRevision: plan.revision })
        const readPlan = async () => {
          const response = await fetch(`${baseUrl}/api/teams/session/${sessionId}/plan`)
          assert.equal(response.status, 200)
          const { plan } = await response.json() as { plan: TeamPlanRecord }
          assert.ok(plan)
          return plan
        }
        const action = async (path: string, method: string, body: unknown) => {
          const response = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          actions.push({ path, status: response.status })
          assert.equal(response.status, 200, await response.clone().text())
          return (await response.json() as { plan: TeamPlanRecord }).plan
        }
        const review = async (expectedName: string) => {
          // An existing worker/approval notice can finish a different root turn
          // while this user turn is queued. Wait for this proposal's identity,
          // rather than trusting an unrelated message_complete frame.
          const deadline = Date.now() + TIMEOUT_MS
          let plan = await readPlan()
          while (!scriptError && (plan.state !== 'review_pending' || plan.planId !== staged[phase]?.planId) && Date.now() < deadline) {
            await Bun.sleep(25)
            plan = await readPlan()
          }
          assert.equal(scriptError, undefined, scriptError)
          assert.equal(plan.state, 'review_pending')
          assert.equal(plan.planId, staged[phase]?.planId)
          assert.equal(plan.revision, staged[phase]!.revision + 1)
          assert.deepEqual(plan.members.map(member => member.name), [expectedName])
          assert.ok(!workers.some(worker => worker.name === expectedName), 'new member reached upstream before approval')
          const team = JSON.parse(readFileSync(join(configDir, 'teams', TEAM, 'config.json'), 'utf8')) as { members: Array<{ name: string }> }
          assert.ok(!team.members.some(member => member.name === expectedName), 'new member registered before approval')
          snapshots.push({ phase, plan, workers: [...workers] })
          return plan
        }
        const approve = async (plan: TeamPlanRecord, expectedName: string) => {
          phase = 'waiting'
          const edited = await action(`/api/teams/${TEAM}/plan`, 'PATCH', { ...identity(plan),
            members: [{ id: expectedName, runtime: { providerId: ctx.target.providerId, modelId: ctx.target.modelId } }] })
          assert.equal(edited.state, 'review_pending')
          assert.ok(!workers.some(worker => worker.name === expectedName), 'configuration started the member')
          await action(`/api/teams/${TEAM}/plan/approve`, 'POST', { ...identity(edited), requestId: `human-${expectedName}` })
          const deadline = Date.now() + TIMEOUT_MS
          let running = await readPlan()
          while ((running.state !== 'running' || !workers.some(worker => worker.name === expectedName)) && Date.now() < deadline) {
            await Bun.sleep(25)
            running = await readPlan()
          }
          assert.equal(running.state, 'running', JSON.stringify(running.launch))
          assert.ok(workers.some(worker => worker.name === expectedName), 'approved worker CLI never reached mock')
          snapshots.push({ phase, plan: running, workers: [...workers] })
          return running
        }
        try {
          await runTurn(socket, 'Create a team and propose reviewer; submit a complete plan using the Agent result.', TIMEOUT_MS)
          const initial = await review('reviewer')
          const running = await approve(initial, 'reviewer')
          phase = 'addition'; step = 0
          await runTurn(socket, 'TEAM_REVIEW_ADD: Add fix-touch to the already running team and submit its proposal for human review.', TIMEOUT_MS)
          const addition = await review('fix-touch')
          assert.equal(addition.parentPlanId, running.planId)
          assert.notEqual(addition.planId, running.planId)
          await approve(addition, 'fix-touch')
        } finally {
          writeFileSync(join(artifactDir, 'websocket.json'), JSON.stringify(socket.messages, null, 2) + '\n')
          socket.close()
        }
      } },
    })
  } finally {
    await upstream.stop()
    const serverLog = readFileSync(join(artifactDir, 'server.log'), 'utf8')
    const started = [...serverLog.matchAll(/^\[ConversationService\] Starting CLI for ([^\s,]+), cwd:/gm)].map(match => match[1]!)
    cliStarts = started.length
    const exited = new Set([...serverLog.matchAll(/CLI process for ([^ ]+) exited with code /g)].map(match => match[1]!))
    const cleanup = { configRemoved: !configDir || !existsSync(configDir), workRemoved: !workRoot || !existsSync(workRoot),
      startedCliSessions: started, exitedCliSessions: [...exited], serverClosed: false, upstreamClosed: false }
    cleanup.serverClosed = baseUrl !== '' && await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) }).then(() => false, () => true)
    cleanup.upstreamClosed = await fetch(`${upstream.url}/v1/models`, { signal: AbortSignal.timeout(1000) }).then(() => false, () => true)
    writeFileSync(join(artifactDir, 'results.json'), JSON.stringify({ outcomes, staged, results, snapshots, actions, workers, scriptError, cleanup }, null, 2) + '\n')
    writeFileSync(join(artifactDir, 'upstream-requests.json'), JSON.stringify(upstream.requests, null, 2) + '\n')
    assert.ok(cleanup.configRemoved && cleanup.workRemoved && cleanup.serverClosed && cleanup.upstreamClosed, JSON.stringify(cleanup))
    assert.ok(started.every(id => exited.has(id)), `CLI cleanup incomplete: ${JSON.stringify(cleanup)}`)
  }
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0]!.status, 'passed', outcomes[0]!.detail)
  assert.ok(cliStarts >= 3, 'expected the leader and both approved worker CLIs')
}
