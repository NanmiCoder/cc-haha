import { createHash, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isValidTeamMemberName, type TeamPlanRecord, type TeamPlanMember } from '../../shared/teamPlan.js'
import { conversationService } from './conversationService.js'
import { ProviderService } from './providerService.js'
import { CLAUDE_OFFICIAL_PROVIDER_ID } from '../types/provider.js'
import { normalizeExplicitClaudeOfficialModelId } from './claudeOfficialRuntime.js'
import { getModelReasoningCapabilityOverride, isModelReasoningEffort, normalizeModelReasoningEffort } from '../../shared/modelReasoning.js'
import { getPresetDefaultEnv, getPresetReasoningProviderKind } from './providerRuntimeEnv.js'
import { validateTeamPlanPresetSource } from '../../utils/swarm/teamPlanPresetSource.js'
import { readTeamPlan, findTeamPlanForSession, mutateTeamPlan } from '../../utils/swarm/teamPlanStore.js'
import { readTeamFile, writeTeamFileAsync } from '../../utils/swarm/teamHelpers.js'
import { createTask, listTasks, updateTask, withTaskListLifecycleLock, getCanonicalTeamTaskListId } from '../../utils/tasks.js'
import { readUnreadMessages, markMessagesAsReadByPredicate, writeToMailbox, createIdleNotification } from '../../utils/teammateMailbox.js'

const providerService = new ProviderService()
const launches = new Map<string, { parentId: string; plan: TeamPlanRecord; released: boolean; children: string[]; timer?: ReturnType<typeof setInterval>; stopped: boolean }>()
const essentialTools = ['SendMessage', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate']

/** Validation is local: checking a proposal never invokes a model or discovers credentials. */
export async function validateTeamPlanRuntime(plan: TeamPlanRecord): Promise<TeamPlanRecord> {
  if (!(await stat(plan.workDir)).isDirectory()) throw new Error('Team working directory is unavailable')
  const team = plan.teamName ? readTeamFile(plan.teamName) : null
  if (plan.teamName && (!team || team.leadSessionId !== plan.sessionId || createHash('sha256').update(JSON.stringify([team.name, team.leadSessionId || '', team.createdAt])).digest('hex') !== plan.incarnationId)) throw new Error('Team generation no longer exists')
  const members: TeamPlanMember[] = []
  for (const member of plan.members) {
    if (!isValidTeamMemberName(member.name)) throw new Error(`Invalid teammate name: ${member.name}`)
    if (team?.members.some(existing => existing.name === member.name)) throw new Error(`Member already exists: ${member.name}`)
    const snapshot = plan.agentCatalog?.[member.agentType]
    if (!snapshot || !snapshot.systemPrompt.trim()) throw new Error(`Agent preset is unavailable: ${member.agentType}`)
    validateTeamPlanPresetSource(snapshot)
    if (snapshot.configurationError) throw new Error(`Agent preset ${member.agentType}: ${snapshot.configurationError}`)
    if (snapshot.permissionMode && snapshot.permissionMode !== 'default' && snapshot.permissionMode !== conversationService.getSessionPermissionMode(plan.sessionId)) throw new Error(`Agent preset ${member.agentType} requires permission mode ${snapshot.permissionMode}; adjust the preset or leader permission mode and submit a new plan`)
    const unsupported = [
      ...(snapshot.isolation ? ['isolation'] : []),
    ]
    if (unsupported.length) throw new Error(`Agent preset ${member.agentType} uses unsupported team worker settings: ${unsupported.join(', ')}`)
    if (snapshot.maxTurns !== undefined && (!Number.isInteger(snapshot.maxTurns) || snapshot.maxTurns < 1)) throw new Error(`Agent preset ${member.agentType} has invalid maxTurns`)
    const provider = member.runtime.providerId === CLAUDE_OFFICIAL_PROVIDER_ID ? null : await providerService.getProvider(member.runtime.providerId)
    const requestedModel = member.runtime.modelId.trim()
    const aliases = provider?.models as Record<string, string> | undefined
    if (provider && ['default', 'main', 'fable', 'sonnet', 'opus', 'haiku'].includes(requestedModel) && !aliases?.[requestedModel === 'default' ? 'main' : requestedModel]) throw new Error(`Provider has no mapping for ${requestedModel}`)
    const modelId = provider
      ? (aliases?.[requestedModel === 'default' ? 'main' : requestedModel] || requestedModel)
      : normalizeExplicitClaudeOfficialModelId(requestedModel)
    if (!modelId || !/^[^\s\x00-\x1f]+$/.test(modelId) || modelId === 'inherit') throw new Error(`Choose a concrete model for ${member.name}`)
    const requestedEffort = member.runtime.effortLevel
    if (requestedEffort !== undefined && (!isModelReasoningEffort(requestedEffort) || !normalizeModelReasoningEffort(modelId, requestedEffort, provider?.apiFormat ?? 'anthropic', provider ? getModelReasoningCapabilityOverride(modelId, provider.models, getPresetDefaultEnv(provider.presetId)) : undefined, provider ? getPresetReasoningProviderKind(provider.presetId) : undefined))) throw new Error(`Unsupported reasoning effort for ${member.name}`)
    const runtime = { ...member.runtime, modelId }

    // These restrictions would break the team's mailbox protocol even if the
    // preset were allowed to execute its task successfully.
    if (snapshot.disallowedTools?.some(tool => essentialTools.includes(tool.split('(')[0]!))) throw new Error(`Agent preset ${member.agentType} disables team communication tools`)
    members.push({ ...member, providerName: provider?.name ?? 'Claude', runtime, agentSnapshot: structuredClone(snapshot) })
  }
  if (new Set(members.map(member => member.name)).size !== members.length) throw new Error('Teammate names must be unique')
  return { ...plan, members }
}

/** All children must acknowledge the model control before any task is released. */
export async function startTeamWorkersBarrier<T>(
  members: readonly T[],
  prepare: (member: T) => Promise<string>,
  release: (member: T, id: string) => Promise<void>,
  stop: (id: string) => Promise<void>,
): Promise<string[]> {
  const ids: string[] = []
  try {
    for (const member of members) ids.push(await prepare(member))
  } catch (error) {
    await Promise.allSettled(ids.map(stop))
    throw error
  }
  // A release failure is not retried: another worker may already have acted.
  try {
    for (let i = 0; i < members.length; i++) await release(members[i]!, ids[i]!)
  } catch (error) {
    await Promise.allSettled(ids.map(stop))
    throw error
  }
  return ids
}

async function materializeTasks(plan: TeamPlanRecord): Promise<Record<string, string>> {
  const existing = await listTasks(getCanonicalTeamTaskListId(plan.teamName))
  const mapping: Record<string, string> = {}
  for (const task of plan.approvedSnapshot!.tasks) {
    const old = existing.find(entry => entry.metadata?.teamPlanId === plan.planId && entry.metadata?.teamPlanTaskId === task.id)
      ?? existing.find(entry => entry.id === task.id && entry.subject === task.subject && !entry.metadata?.teamPlanId)
    mapping[task.id] = old?.id ?? await createTask(getCanonicalTeamTaskListId(plan.teamName), {
      subject: task.subject, description: task.description ?? '', status: 'pending', blocks: [], blockedBy: [],
      metadata: { teamPlanId: plan.planId, teamPlanTaskId: task.id },
    })
  }
  for (const task of plan.approvedSnapshot!.tasks) {
    const owner = plan.approvedSnapshot!.members.find(member => member.id === task.ownerId)
    await updateTask(getCanonicalTeamTaskListId(plan.teamName), mapping[task.id]!, {
      subject: task.subject, description: task.description ?? '',
      owner: owner?.name,
      blockedBy: task.dependencies.map(id => mapping[id]!),
      blocks: plan.approvedSnapshot!.tasks.filter(other => other.dependencies.includes(task.id)).map(other => mapping[other.id]!),
      metadata: { ...existing.find(entry => entry.id === mapping[task.id])?.metadata, teamPlanId: plan.planId, teamPlanTaskId: task.id },
    })
  }
  return mapping
}

export async function stopTeamPlanRuntime(planId: string): Promise<void> {
  const launch = launches.get(planId)
  if (!launch) return
  launch.stopped = true
  if (launch.timer) clearInterval(launch.timer)
  launches.delete(planId)
  await Promise.allSettled(launch.children.map(id => conversationService.stopSessionAndWait(id)))
  const plan = launch.plan
  await withTaskListLifecycleLock(getCanonicalTeamTaskListId(plan.teamName), async () => {
    const team = readTeamFile(plan.teamName)
    if (!team || createHash('sha256').update(JSON.stringify([team.name, team.leadSessionId || '', team.createdAt])).digest('hex') !== plan.incarnationId) return
    team.members = team.members.flatMap(member => {
      if (!member.sessionId || !launch.children.includes(member.sessionId)) return [member]
      return launch.released ? [{ ...member, isActive: false, terminated: true }] : []
    })
    await writeTeamFileAsync(plan.teamName, team)
  })
  if (launch.released) {
    const tasks = await listTasks(getCanonicalTeamTaskListId(plan.teamName))
    for (const task of tasks.filter(task => task.metadata?.teamPlanId === plan.planId && task.status === 'in_progress')) {
      await updateTask(getCanonicalTeamTaskListId(plan.teamName), task.id, { metadata: { ...task.metadata, teamRuntimeInterrupted: true } })
    }
  }
}

export async function launchTeamPlanRuntime(plan: TeamPlanRecord): Promise<{ memberIds: Record<string, string> }> {
  const approved = plan.approvedSnapshot
  if (!approved || approved.revision !== plan.revision - 1 || plan.state !== 'launching') throw new Error('Team plan is not approved for launch')
  await conversationService.waitForTeamWorkersStopped(plan.sessionId)
  const durable = await readTeamPlan(plan.teamName)
  if (!durable || durable.planId !== plan.planId || durable.incarnationId !== plan.incarnationId || durable.state !== 'launching' || durable.revision !== plan.revision || durable.approvedSnapshot?.requestId !== approved.requestId) throw new Error('Team launch authorization has been revoked')
  if (launches.has(plan.planId)) throw new Error('Team plan already has a launch in progress')
  if (!conversationService.hasSession(plan.sessionId)) throw new Error('Team leader must be connected before launching')
  const members = approved.members
  const launch = { parentId: plan.sessionId, plan, released: false, children: [] as string[], stopped: false, timer: undefined as ReturnType<typeof setInterval> | undefined }
  launches.set(plan.planId, launch)
  const memberIds: Record<string, string> = {}
  const permissionMode = conversationService.getSessionPermissionMode(plan.sessionId)
  let taskMapping: Record<string, string> = {}
  let createdAt = 0
  let executionStarted = false
  try {
    await withTaskListLifecycleLock(getCanonicalTeamTaskListId(plan.teamName), async () => {
      const team = readTeamFile(plan.teamName)
      if (!team || team.leadSessionId !== plan.sessionId || createHash('sha256').update(JSON.stringify([team.name, team.leadSessionId || '', team.createdAt])).digest('hex') !== plan.incarnationId) throw new Error('Team generation no longer exists')
      team.reviewRequired = true
      createdAt = team.createdAt
      await writeTeamFileAsync(plan.teamName, team)
    })
    taskMapping = await materializeTasks(plan)
    await startTeamWorkersBarrier(members, async member => {
      if (launch.stopped || !conversationService.hasSession(plan.sessionId)) throw new Error('Team launch cancelled')
      const id = randomUUID()
      launch.children.push(id)
      memberIds[member.id] = id
      const url = new URL(`ws://127.0.0.1:${ProviderService.getServerPort()}/sdk/${id}`)
      url.searchParams.set('token', randomUUID())
      const snapshot = member.agentSnapshot
      if (!snapshot) throw new Error(`Missing approved preset for ${member.name}`)
      const tools = snapshot.tools ? [...new Set([...snapshot.tools, ...essentialTools])] : undefined
      try {
        await conversationService.startSession(id, plan.workDir, url.toString(), {
          providerId: member.runtime.providerId === CLAUDE_OFFICIAL_PROVIDER_ID ? null : member.runtime.providerId, model: member.runtime.modelId, effort: member.runtime.effortLevel, permissionMode,
          teamWorker: {
            parentSessionId: plan.sessionId, teamName: plan.teamName, memberId: member.id, name: member.name,
            systemPrompt: snapshot.systemPrompt, tools,
            agentDefinition: { ...snapshot, initialPrompt: undefined, effort: member.runtime.effortLevel },
          },
        })
        await conversationService.requestControl(id, { subtype: 'set_model', model: member.runtime.modelId }, 30_000)
      } catch (error) {
        await conversationService.stopSessionAndWait(id)
        throw error
      }
      return id
    }, async (member, id) => {
      if (launch.stopped || !conversationService.hasSession(plan.sessionId)) throw new Error('Team launch cancelled')
      // All processes are ready by the time the first release is reached.
      if (member === members[0]) {
        await withTaskListLifecycleLock(getCanonicalTeamTaskListId(plan.teamName), async () => {
          const team = readTeamFile(plan.teamName)
          if (!team || team.createdAt !== createdAt) throw new Error('Team generation changed during launch')
          for (const entry of members) {
            if (team.members.some(old => old.name === entry.name)) throw new Error(`Member already exists: ${entry.name}`)
            team.members.push({ agentId: `${entry.name}@${plan.teamName}`, name: entry.name, agentType: entry.agentType,
              model: entry.runtime.modelId, providerId: entry.runtime.providerId, providerName: typeof entry.providerName === 'string' ? entry.providerName : undefined, effortLevel: entry.runtime.effortLevel,
              planMemberId: entry.id, joinedAt: Date.now(), tmuxPaneId: '', cwd: plan.workDir, subscriptions: [],
              sessionId: memberIds[entry.id], backendType: 'process', isActive: true })
          }
          await writeTeamFileAsync(plan.teamName, team)
        })
        await conversationService.requestControl(plan.sessionId, { subtype: 'team_runtime_snapshot', team_name: plan.teamName, created_at: createdAt })
      }
      conversationService.onOutput(id, message => {
        if (message?.type !== 'result') return
        void withTaskListLifecycleLock(getCanonicalTeamTaskListId(plan.teamName), async () => {
          const team = readTeamFile(plan.teamName)
          if (!team || team.createdAt !== createdAt) return
          const entry = team.members.find(entry => entry.sessionId === id)
          if (entry) { entry.isActive = false; if (!conversationService.hasSession(id)) entry.terminated = true; await writeTeamFileAsync(plan.teamName, team) }
        }).catch(error => console.error('[TeamPlanRuntime] cannot update idle member', error))
        const failed = !conversationService.hasSession(id) || message.is_error
        void writeToMailbox('team-lead', {
          from: member.name, timestamp: new Date().toISOString(),
          text: JSON.stringify(createIdleNotification(member.name, { idleReason: failed ? 'failed' : 'available', summary: typeof message.result === 'string' ? message.result.slice(0, 1000) : undefined })),
        }, plan.teamName)
      })
      const assigned = approved.tasks.filter(task => task.ownerId === member.id).map(task => ({ ...task, id: taskMapping[task.id], dependencies: task.dependencies.map(dep => taskMapping[dep]) }))
      await withTaskListLifecycleLock(getCanonicalTeamTaskListId(plan.teamName), async () => {
        const latest = await readTeamPlan(plan.teamName)
        if (launch.stopped || !latest || latest.planId !== plan.planId || latest.incarnationId !== plan.incarnationId || latest.state !== 'launching' || latest.revision !== plan.revision || latest.approvedSnapshot?.requestId !== approved.requestId) throw new Error('Team launch authorization has been revoked')
        executionStarted = true
        launch.released = true
        const sent = await conversationService.sendMessage(id, `${member.agentSnapshot?.initialPrompt ? member.agentSnapshot.initialPrompt + "\n" : ""}${member.prompt}\n\nApproved shared tasks (use TaskGet/TaskUpdate; respect dependencies):\n${JSON.stringify(assigned)}`, undefined, { canSend: () => !launch.stopped })
        if (!sent) throw new Error(`Failed to release ${member.name}`)
      })
    }, id => conversationService.stopSessionAndWait(id))

    // One consumer owns each worker inbox. SDK serializes user turns; a worker
    // remains connected while idle and wakes when another teammate writes.
    let polling = false
    launch.timer = setInterval(() => {
      if (polling || launch.stopped) return
      polling = true
      void (async () => {
        const currentTeam = readTeamFile(plan.teamName)
        if (!conversationService.hasSession(plan.sessionId) || !currentTeam || currentTeam.createdAt !== createdAt) { await stopTeamPlanRuntime(plan.planId); return }
        for (const member of members) {
          const id = memberIds[member.id]!
          if (!conversationService.hasSession(id)) continue
          const messages = await readUnreadMessages(member.name, plan.teamName)
          if (!messages.length) continue
          await withTaskListLifecycleLock(getCanonicalTeamTaskListId(plan.teamName), async () => {
            const team = readTeamFile(plan.teamName)
            if (!team || team.createdAt !== createdAt) throw new Error('Team generation has ended')
            const entry = team.members.find(entry => entry.sessionId === id)
            if (entry) { entry.isActive = true; await writeTeamFileAsync(plan.teamName, team) }
          })
          const accepted = await conversationService.sendMessage(id, messages.map(message => `<teammate-message teammate_id="${message.from}">\n${message.text}\n</teammate-message>`).join('\n'))
          if (accepted) {
            const ids = new Set(messages.map(message => message.id).filter(Boolean))
            const legacy = new Set(messages.filter(message => !message.id).map(message => JSON.stringify([message.from, message.timestamp, message.text])))
            await markMessagesAsReadByPredicate(member.name, message => message.id ? ids.has(message.id) : legacy.has(JSON.stringify([message.from, message.timestamp, message.text])), plan.teamName)
          }
        }
      })().catch(error => { console.error('[TeamPlanRuntime] mailbox delivery failed', error) }).finally(() => { polling = false })
    }, 250)
    launch.timer.unref()
    await conversationService.sendMessage(plan.sessionId, `Approved team ${plan.teamName} is running. Members and their shared tasks are ready. Continue coordinating the approved team; do not spawn these members again.`)
    return { memberIds }
  } catch (error) {
    await stopTeamPlanRuntime(plan.planId)
    if (executionStarted) throw new TeamPlanExecutionInterruptedError(error instanceof Error ? error.message : String(error))
    throw error
  }
}

export async function notifyTeamPlanLeader(plan: TeamPlanRecord, kind: 'approved' | 'returned' | 'cancelled'): Promise<void> {
  // Approval wakes the leader only after launch's readiness barrier and snapshot.
  if (kind === 'approved' || !conversationService.hasSession(plan.sessionId)) return
  await conversationService.sendMessage(plan.sessionId, kind === 'returned'
    ? `The user returned team plan ${plan.teamName} for revision. No members were launched. Feedback: ${plan.feedback ?? 'Revise the team proposal.'}`
    : `The user cancelled team plan ${plan.teamName}. Do not launch its members. Wait for new user instructions.`)
}

export class TeamPlanExecutionInterruptedError extends Error {
  readonly executionStarted = true
}

export function isTeamPlanRuntimeActive(planId: string): boolean {
  const launch = launches.get(planId)
  // A graceful member shutdown does not turn a successfully launched plan into
  // an interrupted plan. This probe checks host ownership, not current activity.
  return !!launch && !launch.stopped && conversationService.hasSession(launch.parentId)
}

export async function stopTeamPlanRuntimesForParent(parentSessionId: string): Promise<void> {
  const stopOwned = () => Promise.all([...launches.entries()].filter(([, launch]) => launch.parentId === parentSessionId).map(([planId]) => stopTeamPlanRuntime(planId)))
  const hadReleasedWork = [...launches.values()].some(launch => launch.parentId === parentSessionId && launch.released)
  await stopOwned()
  const plan = await findTeamPlanForSession(parentSessionId)
  if (plan?.state === 'launching') {
    await mutateTeamPlan(plan.teamName, { ...plan, expectedRevision: plan.revision }, current => ({
      ...current, state: hadReleasedWork ? 'interrupted' : 'cancelled',
      launch: { ...current.launch, status: 'failed', executionStarted: hadReleasedWork, error: 'The user stopped team startup.' },
    })).catch(error => {
      // A concurrent approval/cancellation changes the revision; the second
      // ownership pass still revokes any process launch admitted in that window.
      console.error('[TeamPlanRuntime] stopped plan changed concurrently', error)
    })
  }
  await stopOwned()
}
