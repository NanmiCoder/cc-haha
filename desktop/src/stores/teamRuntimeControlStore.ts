import { create } from 'zustand'
import { ApiError } from '@/api/client'
import { teamsApi, type MemberRuntimeUpdateResponse } from '@/api/teams'
import { t } from '@/i18n'
import type { TeamDetail } from '@/types/team'
import type { RuntimeSelection } from '@/types/runtime'
import type { TeamRuntimeControlView } from '../../../src/shared/teamRuntimeControl'

export type TeamRuntimeScope = {
  teamName: string
  leadSessionId: string
  incarnationId: string
}

export type TeamRuntimeControlEntry = {
  control: TeamRuntimeControlView | null
  loading: boolean
  busy: boolean
  operation: 'resume' | 'save' | null
  pauseRequested: boolean
  error: string | null
}

export const EMPTY_TEAM_RUNTIME_CONTROL: TeamRuntimeControlEntry = {
  control: null, loading: false, busy: false, operation: null, pauseRequested: false, error: null,
}

export function teamRuntimeScope(team: Pick<TeamDetail, 'name' | 'leadSessionId' | 'incarnationId'> | null | undefined): TeamRuntimeScope | null {
  return team?.leadSessionId && team.incarnationId
    ? { teamName: team.name, leadSessionId: team.leadSessionId, incarnationId: team.incarnationId }
    : null
}

export function teamRuntimeControlKey(scope: TeamRuntimeScope): string {
  return JSON.stringify([scope.teamName, scope.leadSessionId, scope.incarnationId])
}

function sameScope(control: TeamRuntimeControlView, scope: TeamRuntimeScope): boolean {
  return control.teamName === scope.teamName && control.leadSessionId === scope.leadSessionId && control.incarnationId === scope.incarnationId
}

type TeamRuntimeControlState = {
  byTeam: Record<string, TeamRuntimeControlEntry | undefined>
  refresh: (scope: TeamRuntimeScope) => Promise<TeamRuntimeControlView | null>
  markPauseRequested: (scope: TeamRuntimeScope) => void
  resume: (scope: TeamRuntimeScope) => Promise<TeamRuntimeControlView | null>
  saveMember: (scope: TeamRuntimeScope, agentId: string, sessionId: string, runtime: RuntimeSelection) => Promise<MemberRuntimeUpdateResponse>
  clear: () => void
}

/** Only server responses confer paused/editable state; nothing is persisted in the client. */
export const useTeamRuntimeControlStore = create<TeamRuntimeControlState>((set, get) => {
  let storeGeneration = 0
  const generations = new Map<string, number>()
  const actionGenerations = new Map<string, number>()
  const reads = new Map<string, Promise<TeamRuntimeControlView | null>>()
  const resumes = new Map<string, Promise<TeamRuntimeControlView | null>>()
  const resumeActions = new Map<string, { requestId: string; epoch: number }>()
  const pauseTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const pauseRevisions = new Map<string, number>()
  const update = (key: string, apply: (entry: TeamRuntimeControlEntry) => TeamRuntimeControlEntry) => set(state => ({
    byTeam: { ...state.byTeam, [key]: apply(state.byTeam[key] ?? EMPTY_TEAM_RUNTIME_CONTROL) },
  }))
  const invalidate = (key: string) => {
    generations.set(key, (generations.get(key) ?? 0) + 1)
    reads.delete(key)
  }
  const beginAction = (key: string) => {
    const generation = (actionGenerations.get(key) ?? 0) + 1
    actionGenerations.set(key, generation)
    invalidate(key)
    return generation
  }
  const clearPause = (key: string) => {
    const timer = pauseTimers.get(key)
    if (timer) clearTimeout(timer)
    pauseTimers.delete(key)
    pauseRevisions.delete(key)
  }
  const accept = (scope: TeamRuntimeScope, control: TeamRuntimeControlView | null) => {
    const key = teamRuntimeControlKey(scope)
    if (control && !sameScope(control, scope)) throw new Error(t('agentTeams.runtime.changed'))
    const current = get().byTeam[key]?.control
    if (control && current && control.revision < current.revision) return current
    const pauseConfirmed = !control || control.status !== 'running' || control.revision > (pauseRevisions.get(key) ?? Number.POSITIVE_INFINITY)
    if (pauseConfirmed) clearPause(key)
    const action = resumeActions.get(key)
    if (control && (control.status === 'running' || (control.status === 'paused' && action && control.epoch > action.epoch))) resumeActions.delete(key)
    update(key, entry => ({
      ...entry, control, loading: false, error: null,
      pauseRequested: pauseConfirmed ? false : entry.pauseRequested,
    }))
    return control
  }
  const fail = (key: string, error: unknown) => update(key, entry => ({
    ...entry, loading: false, error: error instanceof Error ? error.message : String(error),
  }))

  return {
    byTeam: {},
    refresh: (scope) => {
      const key = teamRuntimeControlKey(scope)
      const existing = reads.get(key)
      if (existing) return existing
      const generation = generations.get(key) ?? 0
      const storeEpoch = storeGeneration
      update(key, entry => ({ ...entry, loading: !entry.control }))
      const request = Promise.resolve().then(async () => {
        try {
          const { control } = await teamsApi.getRuntimeControl(scope.teamName, {
            leadSessionId: scope.leadSessionId, incarnationId: scope.incarnationId,
          })
          if (storeEpoch !== storeGeneration || generation !== (generations.get(key) ?? 0)) return get().byTeam[key]?.control ?? null
          return accept(scope, control)
        } catch (error) {
          if (storeEpoch !== storeGeneration || generation !== (generations.get(key) ?? 0)) return null
          if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
            update(key, entry => ({ ...entry, control: null }))
          }
          // A same-name replacement must never leave the old control actionable.
          if (error instanceof Error && error.message === t('agentTeams.runtime.changed')) {
            update(key, entry => ({ ...entry, control: null }))
          }
          fail(key, error)
          return null
        } finally {
          if (reads.get(key) === request) reads.delete(key)
        }
      })
      reads.set(key, request)
      return request
    },
    markPauseRequested: (scope) => {
      const key = teamRuntimeControlKey(scope)
      clearPause(key)
      const actionGeneration = beginAction(key)
      const storeEpoch = storeGeneration
      resumes.delete(key)
      resumeActions.delete(key)
      pauseRevisions.set(key, get().byTeam[key]?.control?.revision ?? -1)
      update(key, entry => ({ ...entry, pauseRequested: true, busy: false, operation: null, error: null }))
      pauseTimers.set(key, setTimeout(() => {
        if (storeEpoch !== storeGeneration || actionGeneration !== actionGenerations.get(key)) return
        pauseTimers.delete(key)
        pauseRevisions.delete(key)
        update(key, entry => entry.pauseRequested
          ? { ...entry, pauseRequested: false, error: t('agentTeams.runtime.pauseUnconfirmed') }
          : entry)
      }, 15_000))
    },
    resume: (scope) => {
      const key = teamRuntimeControlKey(scope)
      const existing = resumes.get(key)
      if (existing) return existing
      const entry = get().byTeam[key]
      const control = entry?.control
      if (!control || !sameScope(control, scope) || entry?.busy || entry?.pauseRequested || (control.status !== 'paused' && control.status !== 'partial')) {
        return Promise.reject(new Error(t('agentTeams.runtime.changed')))
      }
      const storeEpoch = storeGeneration
      const action = resumeActions.get(key) ?? { requestId: crypto.randomUUID(), epoch: control.epoch }
      resumeActions.set(key, action)
      const actionGeneration = beginAction(key)
      update(key, current => ({ ...current, busy: true, operation: 'resume', error: null }))
      const operation = Promise.resolve().then(async () => {
        try {
          const response = await teamsApi.resumeRuntime(scope.teamName, {
            leadSessionId: scope.leadSessionId, incarnationId: scope.incarnationId,
            expectedRevision: control.revision, requestId: action.requestId,
          })
          if (storeEpoch !== storeGeneration || actionGeneration !== actionGenerations.get(key)) return get().byTeam[key]?.control ?? null
          invalidate(key)
          return accept(scope, response.control)
        } catch (error) {
          if (storeEpoch !== storeGeneration || actionGeneration !== actionGenerations.get(key)) return get().byTeam[key]?.control ?? null
          invalidate(key)
          if (error instanceof ApiError && error.status === 409) await get().refresh(scope)
          fail(key, error)
          throw error
        } finally {
          if (resumes.get(key) === operation) resumes.delete(key)
          if (storeEpoch === storeGeneration && actionGeneration === actionGenerations.get(key)) update(key, current => ({ ...current, busy: false, operation: null }))
        }
      })
      resumes.set(key, operation)
      return operation
    },
    saveMember: async (scope, agentId, sessionId, runtime) => {
      const key = teamRuntimeControlKey(scope)
      const entry = get().byTeam[key]
      const control = entry?.control
      if (!control || !sameScope(control, scope) || control.status !== 'paused' || entry?.busy || entry?.pauseRequested || entry?.error) throw new Error(t('agentTeams.runtime.pauseToEdit'))
      if (!control.members.some(member => member.agentId === agentId && member.sessionId === sessionId)) throw new Error(t('agentTeams.runtime.changed'))
      const storeEpoch = storeGeneration
      const actionGeneration = beginAction(key)
      update(key, current => ({ ...current, busy: true, operation: 'save', error: null }))
      try {
        const response = await teamsApi.updateMemberRuntime(scope.teamName, agentId, {
          providerId: runtime.providerId, modelId: runtime.modelId,
          ...(runtime.effortLevel ? { effortLevel: runtime.effortLevel } : {}),
          leadSessionId: scope.leadSessionId, incarnationId: scope.incarnationId,
          expectedRevision: control.revision, sessionId,
        })
        if (storeEpoch !== storeGeneration || actionGeneration !== actionGenerations.get(key)) throw new Error(t('agentTeams.runtime.changed'))
        invalidate(key)
        if (response.control) accept(scope, response.control)
        else if (!(await get().refresh(scope))) throw new Error(t('agentTeams.runtime.changed'))
        return response
      } catch (error) {
        if (storeEpoch === storeGeneration && actionGeneration === actionGenerations.get(key)) {
          invalidate(key)
          if (error instanceof ApiError && error.status === 409) await get().refresh(scope)
          fail(key, error)
        }
        throw error
      } finally {
        if (storeEpoch === storeGeneration && actionGeneration === actionGenerations.get(key)) update(key, current => ({ ...current, busy: false, operation: null }))
      }
    },
    clear: () => {
      storeGeneration += 1
      for (const timer of pauseTimers.values()) clearTimeout(timer)
      pauseTimers.clear()
      pauseRevisions.clear()
      generations.clear()
      actionGenerations.clear()
      reads.clear()
      resumes.clear()
      resumeActions.clear()
      set({ byTeam: {} })
    },
  }
})
