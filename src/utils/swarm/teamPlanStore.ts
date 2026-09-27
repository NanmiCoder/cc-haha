import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isValidTeamMemberName, teamPlanRecordSchema, type TeamPlanIdentity, type TeamPlanMember, type TeamPlanPatch, type TeamPlanRecord, type TeamPlanRuntime } from '../../shared/teamPlan.js'
import { getTeamsDir } from '../envUtils.js'
import { getCanonicalTeamTaskListId, withTaskListLifecycleLock } from '../tasks.js'
import { getTeamDir, readTeamFileAsync } from './teamHelpers.js'

export class TeamPlanError extends Error {
  constructor(message: string, public status = 409) { super(message) }
}
const planPath = (name: string) => join(getTeamDir(name), 'plan.json')
const locked = <T>(name: string, run: () => Promise<T>) => withTaskListLifecycleLock(getCanonicalTeamTaskListId(name), run)

async function incarnation(teamName: string, sessionId: string): Promise<string> {
  const team = await readTeamFileAsync(teamName)
  if (!team || team.leadSessionId !== sessionId) throw new TeamPlanError('Team does not belong to this session', 404)
  return createHash('sha256').update(JSON.stringify([team.name, team.leadSessionId ?? '', team.createdAt])).digest('hex')
}

/** Legacy teams without plan.json remain legacy; never infer an approval from config.json. */
export async function readTeamPlan(teamName: string): Promise<TeamPlanRecord | null> {
  let raw: unknown
  try { raw = JSON.parse(await readFile(planPath(teamName), 'utf8')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const parsed = teamPlanRecordSchema.safeParse(raw)
  if (!parsed.success) throw new TeamPlanError('Unsupported or invalid persisted team plan', 409)
  return parsed.data
}

async function writePlan(plan: TeamPlanRecord): Promise<void> {
  const path = planPath(plan.teamName)
  await mkdir(getTeamDir(plan.teamName), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(teamPlanRecordSchema.parse(plan), null, 2))
    await rename(temp, path)
  } finally { await unlink(temp).catch(() => {}) }
}

export function validateTeamPlanGraph(plan: Pick<TeamPlanRecord, 'members' | 'tasks'>, runnable = false): void {
  for (const member of plan.members) {
    if (!isValidTeamMemberName(member.name)) throw new TeamPlanError(`Invalid teammate name: ${member.name}. Use letters, numbers, underscores or hyphens; "team-lead" is reserved.`, 400)
  }
  const memberIds = new Set(plan.members.map(member => member.id))
  const names = new Set(plan.members.map(member => member.name))
  const tasks = new Map(plan.tasks.map(task => [task.id, task]))
  if (memberIds.size !== plan.members.length || names.size !== plan.members.length || tasks.size !== plan.tasks.length) throw new TeamPlanError('Member names and IDs and task IDs must be unique', 400)
  if (runnable && (plan.members.length === 0 || plan.tasks.length === 0)) throw new TeamPlanError('Plan needs members and assigned tasks', 400)
  if (runnable && plan.members.some(member => !plan.tasks.some(task => task.ownerId === member.id))) throw new TeamPlanError('Every member needs an assigned task', 400)
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (id: string) => {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new TeamPlanError('Task dependency cycle', 400)
    const task = tasks.get(id)
    if (!task) throw new TeamPlanError(`Unknown dependency: ${id}`, 400)
    if (runnable && !task.ownerId) throw new TeamPlanError('Every task needs an assigned member', 400)
    if (task.ownerId && !memberIds.has(task.ownerId)) throw new TeamPlanError(`Unknown task owner: ${task.ownerId}`, 400)
    visiting.add(id)
    task.dependencies.forEach(visit)
    visiting.delete(id)
    visited.add(id)
  }
  plan.tasks.forEach(task => visit(task.id))
}

export async function ensureTeamDraft(teamName: string, sessionId: string, leaderRuntime: TeamPlanRuntime, initial: TeamPlanPatch & { workDir?: string } = {}): Promise<TeamPlanRecord> {
  return locked(teamName, async () => {
    const incarnationId = await incarnation(teamName, sessionId)
    const existing = await readTeamPlan(teamName)
    if (existing && existing.incarnationId === incarnationId) return existing
    const now = Date.now()
    const plan = teamPlanRecordSchema.parse({ schemaVersion: 1, planId: randomUUID(), sessionId, teamName, incarnationId, revision: 1, state: 'draft', workDir: initial.workDir ?? process.cwd(), leaderRuntime, agentCatalog: initial.agentCatalog, members: initial.members ?? [], tasks: initial.tasks ?? [], createdAt: now, updatedAt: now })
    validateTeamPlanGraph(plan)
    await writePlan(plan)
    return plan
  })
}

async function requireCurrent(teamName: string, identity: TeamPlanIdentity): Promise<TeamPlanRecord> {
  const plan = await readTeamPlan(teamName)
  if (!plan || plan.planId !== identity.planId || plan.sessionId !== identity.sessionId || plan.incarnationId !== identity.incarnationId || await incarnation(teamName, identity.sessionId) !== identity.incarnationId) throw new TeamPlanError('Plan identity changed; refresh before continuing')
  return plan
}

export async function mutateTeamPlan(teamName: string, identity: TeamPlanIdentity, update: (plan: TeamPlanRecord) => Promise<TeamPlanRecord> | TeamPlanRecord): Promise<TeamPlanRecord> {
  return locked(teamName, async () => {
    const plan = await requireCurrent(teamName, identity)
    if (plan.revision !== identity.expectedRevision) throw new TeamPlanError('Plan changed; refresh before continuing')
    const next = await update(structuredClone(plan))
    next.revision = plan.revision + 1
    next.updatedAt = Date.now()
    validateTeamPlanGraph(next)
    await writePlan(next)
    return next
  })
}

function preserveRuntimeExtensions(previous: TeamPlanRuntime | undefined, next: TeamPlanRuntime): TeamPlanRuntime {
  if (!previous) return next
  const { providerId: _provider, modelId: _model, effortLevel: _effort, ...extensions } = previous
  return { ...extensions, ...next }
}
function applyDraftPatch(plan: TeamPlanRecord, patch: TeamPlanPatch, preserveHumanRuntime: boolean): TeamPlanRecord {
  return { ...plan, ...patch,
    ...(patch.members ? { members: patch.members.map(member => {
      const previous = plan.members.find(item => item.id === member.id)
      return { ...previous, ...member, runtime: preserveRuntimeExtensions(previous?.runtime, member.runtime),
        ...(preserveHumanRuntime && previous?.runtimeSource === 'human' ? { runtime: previous.runtime, runtimeSource: 'human', suggestedRuntime: member.suggestedRuntime ?? member.runtime } : {}),
      }
    }) } : {}),
    ...(patch.tasks ? { tasks: patch.tasks.map(task => ({ ...plan.tasks.find(previous => previous.id === task.id), ...task })) } : {}),
  }
}
export function replaceTeamPlan(teamName: string, identity: TeamPlanIdentity, patch: TeamPlanPatch, options: { preserveReview?: boolean } = {}): Promise<TeamPlanRecord> {
  return mutateTeamPlan(teamName, identity, plan => {
    if (plan.state !== 'draft' && plan.state !== 'review_pending') throw new TeamPlanError('Only a draft or pending review can be edited')
    return { ...applyDraftPatch(plan, patch, !options.preserveReview), state: options.preserveReview ? plan.state : 'draft' }
  })
}
/** A complete model proposal becomes reviewable in one revision and one lock transaction. */
export function submitTeamPlan(teamName: string, identity: TeamPlanIdentity, patch?: TeamPlanPatch): Promise<TeamPlanRecord> {
  return mutateTeamPlan(teamName, identity, plan => {
    if (plan.state !== 'draft' && plan.state !== 'review_pending') throw new TeamPlanError('Plan cannot be submitted')
    const next = patch ? applyDraftPatch(plan, patch, true) : plan
    validateTeamPlanGraph(next, true)
    return { ...next, state: 'review_pending' }
  })
}
export async function stageMember(teamName: string, member: TeamPlanMember): Promise<TeamPlanRecord> {
  return locked(teamName, async () => {
    let plan = await readTeamPlan(teamName)
    if (!plan) throw new TeamPlanError('Create the team draft first')
    await requireCurrent(teamName, { ...plan, expectedRevision: plan.revision })
    if (await isTeamExecutionApproved(teamName, member.name)) throw new TeamPlanError('A running team already has this member')
    if (plan.state === 'running') {
      await writeFile(join(getTeamDir(teamName), `plan-${plan.planId}.json`), JSON.stringify(plan, null, 2))
      plan = { ...plan, parentPlanId: plan.planId, planId: randomUUID(), revision: 0, state: 'draft', members: [], tasks: [], approvedSnapshot: undefined, launch: undefined }
    }
    if (plan.state !== 'draft' && plan.state !== 'review_pending') throw new TeamPlanError('Plan is not editable')
    const previous = plan.members.find(item => item.id === member.id || item.name === member.name)
    const value = { ...previous, ...member, runtime: preserveRuntimeExtensions(previous?.runtime, member.runtime), id: previous?.id ?? member.id,
      ...(previous?.runtimeSource === 'human' ? { runtime: previous.runtime, runtimeSource: 'human', suggestedRuntime: member.suggestedRuntime ?? member.runtime } : {}),
    }
    plan.members = [...plan.members.filter(item => item !== previous), value]
    plan.state = 'draft'
    plan.revision++
    plan.updatedAt = Date.now()
    validateTeamPlanGraph(plan)
    await writePlan(plan)
    return plan
  })
}
export async function findTeamPlanForSession(sessionId: string): Promise<TeamPlanRecord | null> {
  let names: string[]
  try { names = await readdir(getTeamsDir()) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const plans = await Promise.all(names.map(async name => {
    let plan: TeamPlanRecord | null
    try { plan = await readTeamPlan(name) } catch { return null }
    if (!plan || plan.sessionId !== sessionId) return null
    try { return await incarnation(name, sessionId) === plan.incarnationId ? plan : null } catch { return null }
  }))
  return plans.filter((plan): plan is TeamPlanRecord => plan !== null).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
}
export async function isTeamExecutionApproved(teamName: string, memberName?: string): Promise<boolean> {
  const plan = await readTeamPlan(teamName)
  if (!plan) return false
  if (await incarnation(teamName, plan.sessionId) !== plan.incarnationId) return false
  if ((plan.state === 'launching' || plan.state === 'running') && plan.approvedSnapshot && (!memberName || plan.approvedSnapshot.members.some(member => member.name === memberName || member.id === memberName))) return true
  let parentPlanId = memberName ? plan.parentPlanId : undefined
  const visited = new Set<string>()
  while (parentPlanId && !visited.has(parentPlanId)) {
    visited.add(parentPlanId)
    // Archive identities are generated UUIDs; never turn persisted input into a path.
    if (!/^[a-f0-9-]{36}$/i.test(parentPlanId)) return false
    let archived: TeamPlanRecord
    try { archived = teamPlanRecordSchema.parse(JSON.parse(await readFile(join(getTeamDir(teamName), `plan-${parentPlanId}.json`), 'utf8'))) } catch { return false }
    if (archived.incarnationId !== plan.incarnationId) return false
    if (archived.state === 'running' && archived.approvedSnapshot?.members.some(member => member.name === memberName || member.id === memberName)) return true
    parentPlanId = archived.parentPlanId
  }
  return false
}

export async function approveTeamPlan(teamName: string, identity: TeamPlanIdentity, requestId: string, validated: TeamPlanRecord): Promise<{ plan: TeamPlanRecord; committed: boolean }> {
  if (!requestId.trim()) throw new TeamPlanError('requestId is required', 400)
  return locked(teamName, async () => {
    const plan = await requireCurrent(teamName, identity)
    if (plan.approvedSnapshot?.requestId === requestId) return { plan, committed: false }
    if (plan.revision !== identity.expectedRevision || validated.revision !== plan.revision) throw new TeamPlanError('Plan changed; review it again')
    if (plan.state !== 'review_pending') throw new TeamPlanError('Plan is not awaiting review')
    validateTeamPlanGraph(validated, true)
    const now = Date.now()
    const next: TeamPlanRecord = { ...plan, members: validated.members, state: 'launching', revision: plan.revision + 1, updatedAt: now, approvedSnapshot: { revision: plan.revision, members: structuredClone(validated.members), tasks: structuredClone(plan.tasks), leaderRuntime: structuredClone(plan.leaderRuntime), approvedAt: now, requestId }, launch: { ...plan.launch, status: 'pending' } }
    await writePlan(next)
    return { plan: next, committed: true }
  })
}
