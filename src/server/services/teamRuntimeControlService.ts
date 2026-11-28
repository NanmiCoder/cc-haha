import { type TeamRuntimeControlAction, type TeamRuntimeControlIdentity, type TeamRuntimeControlRecord, type TeamRuntimeControlView } from '../../shared/teamRuntimeControl.js'
import { ensureTeamRuntimeControl, mutateTeamRuntimeControl, readTeamRuntimeControl, teamControlIdentity } from '../../utils/swarm/teamRuntimeControlStore.js'
import { TeamPlanError } from '../../utils/swarm/teamPlanStore.js'
import { mutateTeamFileAsync, readTeamFile } from '../../utils/swarm/teamHelpers.js'
import { getCanonicalTeamTaskListId, listTasks, type Task } from '../../utils/tasks.js'
import { markMessagesAsReadByPredicate } from '../../utils/teammateMailbox.js'
import { parseMemberCommand } from '../../utils/swarm/memberCommand.js'
import { conversationService } from './conversationService.js'
import { getTeamRuntimeLaunches, holdTeamRuntimeLaunch, rehydrateTeamPlanRuntimesForSession, recordTeamRuntimeMemberFailure, resumeTeamRuntimeMember, teamRuntimeOwnerId, validateTeamRuntimeMember, waitForTeamRuntimeLeadReady, type TeamLaunch, type WorkerRuntime } from './teamPlanRuntime.js'

type ControlledTeam = {
  name: string
  identity: TeamRuntimeControlIdentity
  createdAt: number
  owners: TeamLaunch[]
  control: TeamRuntimeControlRecord
}
const resumeOperations = new Map<string, Promise<TeamRuntimeControlView>>()

function readyFor(name: string, tasks: Task[]): boolean {
  const unfinished = new Set(tasks.filter(task => task.status !== 'completed').map(task => task.id))
  return tasks.some(task => task.owner === name && task.status !== 'completed' && task.blockedBy.every(id => !unfinished.has(id)))
}

async function loadControlledTeam(name: string, identity: TeamRuntimeControlIdentity): Promise<ControlledTeam | null> {
  const team = readTeamFile(name)
  const actual = team && teamControlIdentity(team)
  if (!team || actual?.leadSessionId !== identity.leadSessionId || actual.incarnationId !== identity.incarnationId) throw new TeamPlanError('Team identity changed; refresh before continuing')
  await rehydrateTeamPlanRuntimesForSession(identity.leadSessionId)
  const owners = getTeamRuntimeLaunches(identity.leadSessionId, name).filter(owner => owner.running && owner.plan.incarnationId === identity.incarnationId)
  if (owners.length === 0) return null
  const control = await ensureTeamRuntimeControl(name, identity, teamRuntimeOwnerId)
  return { name, identity: { leadSessionId: identity.leadSessionId, incarnationId: identity.incarnationId }, createdAt: team.createdAt, owners, control }
}

function membersOf(team: ControlledTeam): Array<{ owner: TeamLaunch; worker: WorkerRuntime }> {
  return team.owners.flatMap(owner => [...owner.workers.values()].map(worker => ({ owner, worker })))
}

async function view(team: ControlledTeam): Promise<TeamRuntimeControlView> {
  const current = await readTeamRuntimeControl(team.name, team.identity)
  if (!current) throw new TeamPlanError('Team control is unavailable')
  const tasks = await listTasks(getCanonicalTeamTaskListId(team.name))
  const roster = readTeamFile(team.name)
  const actual = roster && teamControlIdentity(roster)
  if (!roster || actual?.incarnationId !== team.identity.incarnationId || actual.leadSessionId !== team.identity.leadSessionId) throw new TeamPlanError('Team identity changed')
  let resumeEligibleCount = 0
  const members: TeamRuntimeControlView['members'] = membersOf(team).map(({ owner, worker }) => {
    const entry = roster.members.find(member => member.sessionId === worker.sessionId)
    const open = tasks.some(task => task.owner === worker.member.name && task.status !== 'completed')
    const ready = readyFor(worker.member.name, tasks)
    const alreadyAdmitted = current.status === 'partial' && current.resume?.epoch === current.epoch && current.resume.startedSessionIds.includes(worker.sessionId)
    if (ready && !entry?.isActive && !alreadyAdmitted) resumeEligibleCount++
    const error = current.memberErrors?.[worker.sessionId]
    return {
      agentId: `${worker.member.name}@${team.name}`, sessionId: worker.sessionId, planId: owner.plan.planId, memberId: worker.member.id, name: worker.member.name,
      status: error ? 'failed' : !open ? 'completed' : !ready ? 'waiting' : conversationService.hasSession(worker.sessionId) ? 'running' : 'paused',
      ...(error ? { error } : {}),
    }
  })
  const pauseError = team.owners.find(owner => owner.controlError)?.controlError
  return {
    schemaVersion: 1, teamName: team.name, ...team.identity, revision: current.revision, epoch: current.epoch,
    status: pauseError ? 'partial' : team.owners.some(owner => owner.pausePending) && current.status === 'running' ? 'pausing' : current.status,
    updatedAt: current.updatedAt, ...((pauseError || current.error) ? { error: pauseError || current.error } : {}), members, resumeEligibleCount,
  }
}

export async function getTeamRuntimeControlView(name: string, identity: TeamRuntimeControlIdentity): Promise<TeamRuntimeControlView | null> {
  const team = await loadControlledTeam(name, identity)
  return team ? view(team) : null
}

/** The lead SDK channel is optional. Physical member exits determine paused. */
export async function pauseReviewedTeamsForParent(parentId: string): Promise<void> {
  await rehydrateTeamPlanRuntimesForSession(parentId)
  const names = new Set(getTeamRuntimeLaunches(parentId).filter(owner => owner.running).map(owner => owner.plan.teamName))
  for (const name of names) {
    const roster = readTeamFile(name)
    if (!roster || roster.leadSessionId !== parentId) continue
    const team = await loadControlledTeam(name, teamControlIdentity(roster))
    if (!team) continue
    for (const owner of team.owners) if (!owner.pausePending) holdTeamRuntimeLaunch(owner)
    const sequences = team.owners.map(owner => [owner, owner.controlSequence ?? 0] as const)
    const fresh = () => sequences.every(([owner, sequence]) => !owner.stopped && owner.controlSequence === sequence)
    const pausedAt = Math.max(...team.owners.map(owner => owner.pausedAt ?? Date.now()))
    try {
      const stopping = await mutateTeamRuntimeControl(name, team.identity, current => ({ ...current, status: 'pausing', epoch: current.epoch + 1, pausedAt, memberErrors: undefined, error: undefined }))
      const errors: Record<string, string> = {}
      for (const { owner, worker } of membersOf(team)) {
        try {
          await worker.starting
          await conversationService.stopSessionAndWait(worker.sessionId, undefined, { requireExit: true })
          await markMessagesAsReadByPredicate(worker.member.name, message => message.from === 'user' && Date.parse(message.timestamp) < pausedAt && parseMemberCommand(message.text) !== null, name)
        } catch (error) {
          errors[worker.sessionId] = error instanceof Error ? error.message : String(error)
        }
        if (owner.stopped) continue
      }
      if (!fresh()) continue
      await mutateTeamFileAsync(name, current => {
        if (teamControlIdentity(current).incarnationId !== team.identity.incarnationId) return
        const ids = new Set(membersOf(team).map(({ worker }) => worker.sessionId))
        return { ...current, members: current.members.map(member => {
          if (!member.sessionId || !ids.has(member.sessionId)) return member
          const { autoRetry: _retry, ...entry } = member
          return { ...entry, isActive: false, ...(!conversationService.hasSession(member.sessionId) ? { terminated: true } : {}) }
        }) }
      })
      await mutateTeamRuntimeControl(name, { ...team.identity, expectedEpoch: stopping.epoch }, current => ({
        ...current, status: Object.keys(errors).length ? 'partial' : 'paused',
        memberErrors: errors, error: Object.keys(errors).length ? 'Some members have not confirmed that they stopped. Pause again before editing models.' : undefined,
      }))
    } catch (error) {
      if (fresh()) {
        const message = `Could not confirm the team pause: ${error instanceof Error ? error.message : String(error)}. Pause again before editing or resuming.`
        for (const owner of team.owners) owner.controlError = message
        // A transient storage failure must stay visible and retryable. Even
        // when this write also fails, the owner keeps its conservative gate.
        await mutateTeamRuntimeControl(name, team.identity, current => ({ ...current, status: 'partial', error: message })).catch(() => {})
      }
    } finally {
      if (fresh()) for (const owner of team.owners) owner.pausePending = false
    }
  }
}

export function resumeReviewedTeam(
  name: string,
  action: TeamRuntimeControlAction,
  startLeader: (sessionId: string) => Promise<void>,
): Promise<TeamRuntimeControlView> {
  const key = JSON.stringify([name, action.leadSessionId, action.incarnationId, action.requestId])
  const existing = resumeOperations.get(key)
  if (existing) return existing
  const operation = resumeOnce(name, action, startLeader)
  resumeOperations.set(key, operation)
  void operation.finally(() => { if (resumeOperations.get(key) === operation) resumeOperations.delete(key) }).catch(() => {})
  return operation
}

async function resumeOnce(name: string, action: TeamRuntimeControlAction, startLeader: (sessionId: string) => Promise<void>): Promise<TeamRuntimeControlView> {
  const team = await loadControlledTeam(name, action)
  if (!team) throw new TeamPlanError('No reviewed process team can resume here', 404)
  const previous = team.control
  const replay = previous.resume?.requestId === action.requestId
  if (replay && previous.resume?.epoch !== previous.epoch) throw new TeamPlanError('That resume intent was superseded by a pause')
  if (replay && previous.status === 'running') return view(team)
  if (!replay && previous.revision !== action.expectedRevision) throw new TeamPlanError('Team control changed; refresh before resuming')
  const pauseError = team.owners.find(owner => owner.controlError)?.controlError
  if (pauseError) throw new TeamPlanError(pauseError)
  if (!['paused', 'partial'].includes(previous.status) || team.owners.some(owner => owner.pausePending || owner.controlResuming)) throw new TeamPlanError('Wait for the team to finish stopping before resuming')
  const tasks = await listTasks(getCanonicalTeamTaskListId(name))
  const roster = readTeamFile(name)
  const continuation = replay || (previous.status === 'partial' && previous.resume?.epoch === previous.epoch)
  const previousKey = previous.resume && JSON.stringify([action.incarnationId, previous.epoch, previous.resume.requestId])
  // A page reload may create a different HTTP request ID for the same visible
  // partial retry. Keep its durable admission and any delivered receipt still
  // held by this owner, instead of charging those members a second turn.
  const carried = continuation ? new Set([
    ...previous.resume!.startedSessionIds,
    ...membersOf(team).filter(({ worker }) => worker.explicitResumeKey === previousKey).map(({ worker }) => worker.sessionId),
  ]) : new Set<string>()
  const candidates = membersOf(team).filter(({ worker }) => !carried.has(worker.sessionId) && readyFor(worker.member.name, tasks) && !roster?.members.find(member => member.sessionId === worker.sessionId)?.isActive)
  const at = continuation ? previous.resume!.createdAt : Date.now()
  const eligible = [...new Set([...(continuation ? previous.resume!.eligibleSessionIds : []), ...candidates.map(({ worker }) => worker.sessionId)])]
  // Capture ownership before the first await that reserves this intent.
  // A Stop during that write must not be mistaken for our starting epoch.
  const sequences = team.owners.map(owner => [owner, owner.controlSequence ?? 0] as const)
  const fresh = () => sequences.every(([owner, sequence]) => !owner.stopped && (owner.controlSequence ?? 0) === sequence && !owner.pausePending)
  const begun = await mutateTeamRuntimeControl(name, { ...team.identity, expectedRevision: previous.revision }, current => ({
    ...current, status: 'resuming', epoch: continuation ? current.epoch : current.epoch + 1, error: undefined,
    resume: { ...current.resume, requestId: action.requestId, epoch: continuation ? current.epoch : current.epoch + 1, createdAt: at, eligibleSessionIds: eligible, startedSessionIds: [...carried] },
  }))
  const resumeKey = JSON.stringify([action.incarnationId, begun.epoch, action.requestId])
  const delivered = new Set([...begun.resume!.startedSessionIds, ...membersOf(team).filter(({ worker }) => worker.explicitResumeKey === resumeKey).map(({ worker }) => worker.sessionId)])
  if (!fresh()) throw new TeamPlanError('Team control changed; the newer pause takes precedence')
  for (const owner of team.owners) owner.controlResuming = true
  const errors: Record<string, string> = {}
  try {
    for (const { worker } of candidates) {
      if (delivered.has(worker.sessionId)) continue
      try { await validateTeamRuntimeMember(worker) }
      catch (error) { errors[worker.sessionId] = error instanceof Error ? error.message : String(error) }
    }
    if (!fresh()) throw new TeamPlanError('Team control changed before leader startup')
    await startLeader(action.leadSessionId)
    await waitForTeamRuntimeLeadReady(action.leadSessionId)
    if (!fresh()) throw new TeamPlanError('Team control changed during leader startup')
    const request = { subtype: 'team_runtime_resume', team_name: name, created_at: team.createdAt, incarnation_id: action.incarnationId, epoch: begun.epoch, request_id: action.requestId }
    const ack = await conversationService.requestControl(action.leadSessionId, request, 30_000, undefined, fresh, async () => {
      const current = await readTeamRuntimeControl(name, team.identity)
      return fresh() && current?.status === 'resuming' && current.epoch === begun.epoch && current.resume?.requestId === action.requestId
    })
    if (!fresh() || ack.team_name !== name || ack.incarnation_id !== action.incarnationId || ack.epoch !== begun.epoch || ack.request_id !== action.requestId) throw new TeamPlanError('The leader did not confirm this team resume intent')
    for (const owner of team.owners) {
      owner.pausedAt = undefined
      owner.resumeAllowedAt = undefined
      owner.explicitResumeAt = at
      owner.explicitResumeKey = resumeKey
      for (const worker of owner.workers.values()) {
        if (delivered.has(worker.sessionId)) {
          worker.explicitResumeKey = resumeKey
          worker.explicitResumeDeliveredAt = at
        } else worker.controlHoldAt = at
      }
    }
    for (const { owner, worker } of candidates) {
      if (!eligible.includes(worker.sessionId) || delivered.has(worker.sessionId)) continue
      if (!fresh()) throw new TeamPlanError('Team control changed during resume')
      try {
        if (errors[worker.sessionId]) throw new Error(errors[worker.sessionId])
        const sent = await resumeTeamRuntimeMember(owner, worker, fresh)
        if (sent) {
          delivered.add(worker.sessionId)
          await mutateTeamRuntimeControl(name, { ...team.identity, expectedEpoch: begun.epoch }, current => ({ ...current, resume: { ...current.resume!, startedSessionIds: [...new Set([...current.resume!.startedSessionIds, worker.sessionId])] } }))
        }
      } catch (error) {
        if (!fresh()) throw new TeamPlanError('Team control changed during member startup')
        // The message reached this process already. Keep it active and retry
        // only the durable receipt below, never the paid/model turn itself.
        if (worker.explicitResumeKey === resumeKey) { delivered.add(worker.sessionId); continue }
        errors[worker.sessionId] = error instanceof Error ? error.message : String(error)
        await recordTeamRuntimeMemberFailure(owner, worker, errors[worker.sessionId]!)
      }
    }
    await mutateTeamRuntimeControl(name, { ...team.identity, expectedEpoch: begun.epoch }, current => ({
      ...current, status: Object.keys(errors).length ? 'partial' : 'running', memberErrors: errors,
      resume: { ...current.resume!, startedSessionIds: [...new Set([...current.resume!.startedSessionIds, ...delivered])] },
      error: Object.keys(errors).length ? 'Some members could not resume. Their conversations are kept; retry this resume or pause to edit their models.' : undefined,
    }))
  } catch (error) {
    if (!fresh()) throw new TeamPlanError('Team control changed; the newer pause takes precedence')
    await mutateTeamRuntimeControl(name, { ...team.identity, expectedEpoch: begun.epoch }, current => ({ ...current, status: 'partial', error: error instanceof Error ? error.message : String(error) }))
  } finally {
    if (fresh()) for (const owner of team.owners) owner.controlResuming = false
  }
  return view(team)
}
