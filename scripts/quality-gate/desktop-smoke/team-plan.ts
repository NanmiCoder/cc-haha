import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TeamPlanRecord } from '../../../src/shared/teamPlan'

export const TEAM_SMOKE_PROVIDER = 'desktop-ui-economy-provider'
export const TEAM_SMOKE_MODEL = 'desktop-ui-economy-model'
export const TEAM_SMOKE_TEAM = 'desktop-ui-review-team'

type BrowserStep = (args: string[], options?: { timeoutMs?: number; allowFailure?: boolean }) => Promise<{ stdout: string; stderr: string }>

export function seedDesktopUiTeamPlan(configDir: string, sessionId: string, workDir: string): TeamPlanRecord {
  const createdAt = 1720000000000
  const teamName = TEAM_SMOKE_TEAM
  const plan: TeamPlanRecord = {
    schemaVersion: 1, planId: 'desktop-ui-review-plan', sessionId, teamName,
    incarnationId: createHash('sha256').update(JSON.stringify([teamName, sessionId, createdAt])).digest('hex'),
    revision: 1, state: 'review_pending', workDir, createdAt, updatedAt: createdAt,
    leaderRuntime: { providerId: 'desktop-ui-smoke-provider', modelId: 'desktop-ui-smoke-model' },
    agentCatalog: { engineer: { systemPrompt: 'You are an isolated smoke-test engineer. Reply with a short status.', source: 'built-in', sourceIdentity: { kind: 'builtin' }, tools: ['TaskList'] } },
    members: ['builder', 'reviewer'].map(name => ({
      id: name, name, agentType: 'engineer', prompt: `Complete the isolated ${name} task.`,
      runtime: { providerId: 'desktop-ui-smoke-provider', modelId: 'desktop-ui-smoke-model' },
      suggestedRuntime: { providerId: 'desktop-ui-smoke-provider', modelId: 'desktop-ui-smoke-model' },
    })),
    tasks: ['builder', 'reviewer'].map(name => ({ id: `task-${name}`, subject: `${name} smoke task`, ownerId: name, dependencies: [] })),
  }
  const directory = join(configDir, 'teams', teamName)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'config.json'), JSON.stringify({
    name: teamName, createdAt, leadSessionId: sessionId, leadAgentId: `team-lead@${teamName}`, reviewRequired: true,
    members: [{ agentId: `team-lead@${teamName}`, name: 'team-lead', agentType: 'team-lead', joinedAt: createdAt, cwd: workDir, tmuxPaneId: '', subscriptions: [] }],
  }))
  writeFileSync(join(directory, 'plan.json'), JSON.stringify(plan))
  return plan
}

async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(250)
  }
  throw new Error(`Timed out waiting for team review smoke: ${label}`)
}

export async function runDesktopUiTeamPlanSmoke(options: {
  configDir: string; sessionId: string; projectDir: string; baseUrl: string; artifactDir: string; auditPath: string; browserStep: BrowserStep
}) {
  const { configDir, sessionId, projectDir, baseUrl, artifactDir, auditPath, browserStep } = options
  seedDesktopUiTeamPlan(configDir, sessionId, projectDir)
  const getPlan = async () => {
    const response = await fetch(`${baseUrl}/api/teams/session/${encodeURIComponent(sessionId)}/plan`)
    if (!response.ok) throw new Error(`Plan read failed: ${response.status} ${await response.text()}`)
    return (await response.json() as { plan: TeamPlanRecord }).plan
  }
  const assertNoWorkers = () => {
    if (existsSync(auditPath) && readFileSync(auditPath, 'utf8').trim()) throw new Error('A team worker booted before human approval')
    const team = JSON.parse(readFileSync(join(configDir, 'teams', TEAM_SMOKE_TEAM, 'config.json'), 'utf8'))
    if (team.members.length !== 1) throw new Error('A staged member was created before human approval')
  }
  if (!(await getPlan())) throw new Error('Seeded team plan was not readable through the session API')
  await browserStep(['wait', '[data-testid="team-plan-open"]'])
  assertNoWorkers()
  await browserStep(['click', '[data-testid="team-plan-open"]'])
  await browserStep(['click', 'button[aria-label="builder · Provider and model"]'])
  await browserStep(['wait', '[data-testid="model-selector-dropdown"]'])
  // Search keeps the target in view even in the short CI viewport. Assert the
  // controlled trigger changed before introducing a remote revision conflict.
  await browserStep(['fill', '[data-testid="model-selector-dropdown"] input', TEAM_SMOKE_MODEL])
  await browserStep(['find', 'text', TEAM_SMOKE_MODEL, 'click', '--exact'])
  const selectedModel = await browserStep(['get', 'text', 'button[aria-label="builder · Provider and model"]'])
  if (!selectedModel.stdout.includes(TEAM_SMOKE_MODEL)) throw new Error('Member model selection did not update the review draft')
  const current = await getPlan()
  const changedElsewhere = await fetch(`${baseUrl}/api/teams/${TEAM_SMOKE_TEAM}/plan`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, planId: current.planId, incarnationId: current.incarnationId, expectedRevision: current.revision, members: [], tasks: [] }),
  })
  if (!changedElsewhere.ok) throw new Error(`Conflict setup failed: ${await changedElsewhere.text()}`)
  await browserStep(['wait', '[data-testid="team-plan-reapply"]'])
  const conflict = await browserStep(['eval', 'document.querySelector("[data-testid=team-plan-approve]").disabled'])
  if (!conflict.stdout.includes('true')) throw new Error('Stale plan could be approved while a conflicting edit was pending')
  await browserStep(['click', '[data-testid="team-plan-reapply"]'])
  await browserStep(['click', '[data-testid="team-plan-save"]'])
  await until(async () => (await getPlan()).members[0]?.runtime.providerId === TEAM_SMOKE_PROVIDER, 'cross-provider draft save')
  assertNoWorkers()
  await browserStep(['reload'])
  await browserStep(['wait', '[data-testid="team-plan-open"]'])
  await browserStep(['click', '[data-testid="team-plan-open"]'])
  const restored = await browserStep(['get', 'text', 'button[aria-label="builder · Provider and model"]'])
  if (!restored.stdout.includes(TEAM_SMOKE_MODEL)) throw new Error('Reload did not recover the saved member model')
  assertNoWorkers()
  await browserStep(['screenshot', join(artifactDir, 'team-review-pending.png')], { allowFailure: true })
  await browserStep(['click', '[data-testid="team-plan-approve"]'])
  await until(async () => {
    const plan = await getPlan()
    if (plan.state === 'launch_failed' || plan.state === 'interrupted') throw new Error(`Team launch failed: ${plan.launch?.error}`)
    return plan.state === 'running'
  }, 'approved team to reach running')
  await until(async () => {
    if (!existsSync(auditPath)) return false
    return readFileSync(auditPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(event => event.phase === 'release').length >= 2
  }, 'both approved workers to receive their tasks')
  const events = readFileSync(auditPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const boots = events.filter(event => event.phase === 'boot')
  if (boots.length !== 2 || !boots.some(event => event.model === TEAM_SMOKE_MODEL && event.baseUrl === 'http://127.0.0.1:2')) throw new Error('Workers did not preserve their approved provider/model routing')
  writeFileSync(join(artifactDir, 'team-review-result.json'), JSON.stringify({ plan: await getPlan(), workerEvents: events }, null, 2))
  await browserStep(['screenshot', join(artifactDir, 'team-review-running.png')], { allowFailure: true })
  await browserStep(['wait', '[data-testid="team-plan-stop"]'])
  await browserStep(['click', '[data-testid="team-plan-stop"]'])
  await until(async () => (await getPlan()).state === 'interrupted', 'visible Stop to interrupt the running team')
  await until(async () => {
    const team = JSON.parse(readFileSync(join(configDir, 'teams', TEAM_SMOKE_TEAM, 'config.json'), 'utf8'))
    return team.members.filter((member: { name: string }) => member.name !== 'team-lead').every((member: { isActive?: boolean }) => member.isActive === false)
  }, 'stopped workers to become inactive')
  await browserStep(['screenshot', join(artifactDir, 'team-review-stopped.png')], { allowFailure: true })
}
