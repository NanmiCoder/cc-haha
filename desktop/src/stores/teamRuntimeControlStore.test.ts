import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import type { TeamRuntimeControlView } from '../../../src/shared/teamRuntimeControl'
import { teamRuntimeControlKey, useTeamRuntimeControlStore, type TeamRuntimeScope } from './teamRuntimeControlStore'

const mocks = vi.hoisted(() => ({
  getRuntimeControl: vi.fn(),
  resumeRuntime: vi.fn(),
  updateMemberRuntime: vi.fn(),
}))
vi.mock('@/api/teams', () => ({ teamsApi: mocks }))

const scope: TeamRuntimeScope = { teamName: 'review-team', leadSessionId: 'lead-session', incarnationId: 'incarnation-one' }

function control(revision = 5, status: TeamRuntimeControlView['status'] = 'paused'): TeamRuntimeControlView {
  return {
    schemaVersion: 1, ...scope, revision, epoch: 2, status, updatedAt: revision,
    resumeEligibleCount: 2,
    members: [
      { agentId: 'reader@review-team', sessionId: 'reader-cli', planId: 'old-plan', memberId: 'reader', name: 'reader', status: 'paused' },
      { agentId: 'writer@review-team', sessionId: 'writer-cli', planId: 'addition-plan', memberId: 'writer', name: 'writer', status: 'paused' },
    ],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

describe('team runtime control state', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    useTeamRuntimeControlStore.getState().clear()
    mocks.getRuntimeControl.mockResolvedValue({ control: control() })
  })
  afterEach(() => useTeamRuntimeControlStore.getState().clear())

  it('fetches only the requested incarnation without changing any runtime', async () => {
    await useTeamRuntimeControlStore.getState().refresh(scope)
    expect(mocks.getRuntimeControl).toHaveBeenCalledWith(scope.teamName, {
      leadSessionId: scope.leadSessionId, incarnationId: scope.incarnationId,
    })
    expect(useTeamRuntimeControlStore.getState().byTeam[teamRuntimeControlKey(scope)]?.control).toEqual(control())
    expect(mocks.resumeRuntime).not.toHaveBeenCalled()
    expect(mocks.updateMemberRuntime).not.toHaveBeenCalled()
  })

  it('guards model saves with the real CLI session and the newest sequential control revision', async () => {
    await useTeamRuntimeControlStore.getState().refresh(scope)
    mocks.updateMemberRuntime
      .mockResolvedValueOnce({ ok: true, member: { agentId: 'reader@review-team', model: 'new-reader' }, control: control(6) })
      .mockResolvedValueOnce({ ok: true, member: { agentId: 'writer@review-team', model: 'new-writer' }, control: control(7) })

    await useTeamRuntimeControlStore.getState().saveMember(scope, 'reader@review-team', 'reader-cli', { providerId: 'p', modelId: 'new-reader' })
    await useTeamRuntimeControlStore.getState().saveMember(scope, 'writer@review-team', 'writer-cli', { providerId: null, modelId: 'new-writer' })

    expect(mocks.updateMemberRuntime.mock.calls).toEqual([
      ['review-team', 'reader@review-team', { providerId: 'p', modelId: 'new-reader', leadSessionId: 'lead-session', incarnationId: 'incarnation-one', expectedRevision: 5, sessionId: 'reader-cli' }],
      ['review-team', 'writer@review-team', { providerId: null, modelId: 'new-writer', leadSessionId: 'lead-session', incarnationId: 'incarnation-one', expectedRevision: 6, sessionId: 'writer-cli' }],
    ])
    expect(mocks.resumeRuntime).not.toHaveBeenCalled()
  })

  it.each(['running', 'pausing', 'resuming', 'partial'] as const)('does not treat %s as a confirmed pause', async status => {
    mocks.getRuntimeControl.mockResolvedValue({ control: control(5, status) })
    await useTeamRuntimeControlStore.getState().refresh(scope)
    await expect(useTeamRuntimeControlStore.getState().saveMember(scope, 'reader@review-team', 'reader-cli', { providerId: 'p', modelId: 'new-reader' })).rejects.toThrow()
    expect(mocks.updateMemberRuntime).not.toHaveBeenCalled()
  })

  it('rejects a stale member CLI identity before issuing the PATCH', async () => {
    await useTeamRuntimeControlStore.getState().refresh(scope)
    await expect(useTeamRuntimeControlStore.getState().saveMember(scope, 'reader@review-team', 'previous-reader-cli', { providerId: 'p', modelId: 'new-reader' })).rejects.toThrow()
    expect(mocks.updateMemberRuntime).not.toHaveBeenCalled()
  })

  it('does not let an earlier poll overwrite the result of a model save', async () => {
    await useTeamRuntimeControlStore.getState().refresh(scope)
    const oldRead = deferred<{ control: TeamRuntimeControlView }>()
    mocks.getRuntimeControl.mockReturnValueOnce(oldRead.promise)
    const reading = useTeamRuntimeControlStore.getState().refresh(scope)
    mocks.updateMemberRuntime.mockResolvedValue({ ok: true, member: { agentId: 'reader@review-team', model: 'new-reader' }, control: control(6) })
    await useTeamRuntimeControlStore.getState().saveMember(scope, 'reader@review-team', 'reader-cli', { providerId: 'p', modelId: 'new-reader' })
    oldRead.resolve({ control: control(5, 'running') })
    await reading
    expect(useTeamRuntimeControlStore.getState().byTeam[teamRuntimeControlKey(scope)]?.control?.revision).toBe(6)
    expect(useTeamRuntimeControlStore.getState().byTeam[teamRuntimeControlKey(scope)]?.control?.status).toBe('paused')
  })

  it('uses one human request id for a partial recovery retry and never dispatches a duplicate pending resume', async () => {
    await useTeamRuntimeControlStore.getState().refresh(scope)
    const response = deferred<{ control: TeamRuntimeControlView }>()
    mocks.resumeRuntime.mockReturnValueOnce(response.promise)
    const first = useTeamRuntimeControlStore.getState().resume(scope)
    const duplicate = useTeamRuntimeControlStore.getState().resume(scope)
    await Promise.resolve()
    expect(mocks.resumeRuntime).toHaveBeenCalledTimes(1)
    const partial = { ...control(6, 'partial'), epoch: 3, error: 'writer could not restart' }
    response.resolve({ control: partial })
    await Promise.all([first, duplicate])
    mocks.resumeRuntime.mockResolvedValueOnce({ control: { ...control(7, 'running'), epoch: 3 } })
    await useTeamRuntimeControlStore.getState().resume(scope)
    const firstAction = mocks.resumeRuntime.mock.calls[0]![1]
    expect(firstAction.requestId).toEqual(expect.any(String))
    expect(mocks.resumeRuntime.mock.calls[1]![1]).toEqual({
      leadSessionId: scope.leadSessionId, incarnationId: scope.incarnationId,
      expectedRevision: 6, requestId: firstAction.requestId,
    })
  })

  it('does not adopt a control response for a different same-name team', async () => {
    mocks.getRuntimeControl.mockResolvedValue({ control: { ...control(), incarnationId: 'replacement-incarnation' } })
    await useTeamRuntimeControlStore.getState().refresh(scope)
    const entry = useTeamRuntimeControlStore.getState().byTeam[teamRuntimeControlKey(scope)]
    expect(entry?.control).toBeNull()
    expect(entry?.error).toEqual(expect.any(String))
    expect(mocks.resumeRuntime).not.toHaveBeenCalled()
  })

  it('does not let a late resume response undo a newer Stop', async () => {
    await useTeamRuntimeControlStore.getState().refresh(scope)
    const response = deferred<{ control: TeamRuntimeControlView }>()
    mocks.resumeRuntime.mockReturnValueOnce(response.promise)
    const resuming = useTeamRuntimeControlStore.getState().resume(scope)
    await Promise.resolve()
    useTeamRuntimeControlStore.getState().markPauseRequested(scope)
    mocks.getRuntimeControl.mockResolvedValue({ control: { ...control(7), epoch: 4 } })
    await useTeamRuntimeControlStore.getState().refresh(scope)
    response.resolve({ control: { ...control(6, 'running'), epoch: 3 } })
    await resuming
    const entry = useTeamRuntimeControlStore.getState().byTeam[teamRuntimeControlKey(scope)]
    expect(entry?.control).toMatchObject({ status: 'paused', revision: 7, epoch: 4 })
    expect(entry?.busy).toBe(false)
  })

  it('refreshes a rejected CAS without retrying the write or turning it into a resume', async () => {
    await useTeamRuntimeControlStore.getState().refresh(scope)
    mocks.updateMemberRuntime.mockRejectedValue(new ApiError(409, { error: 'TEAM_CONTROL_CONFLICT', message: 'Team changed; refresh' }))
    mocks.getRuntimeControl.mockResolvedValue({ control: control(6, 'pausing') })
    await expect(useTeamRuntimeControlStore.getState().saveMember(scope, 'reader@review-team', 'reader-cli', { providerId: 'p', modelId: 'new-reader' })).rejects.toThrow('Team changed')
    expect(mocks.updateMemberRuntime).toHaveBeenCalledTimes(1)
    expect(mocks.getRuntimeControl).toHaveBeenCalledTimes(2)
    expect(useTeamRuntimeControlStore.getState().byTeam[teamRuntimeControlKey(scope)]?.control?.status).toBe('pausing')
    expect(mocks.resumeRuntime).not.toHaveBeenCalled()
  })

  it('drops late results after clearing an old view', async () => {
    const response = deferred<{ control: TeamRuntimeControlView }>()
    mocks.getRuntimeControl.mockReturnValue(response.promise)
    const reading = useTeamRuntimeControlStore.getState().refresh(scope)
    useTeamRuntimeControlStore.getState().clear()
    response.resolve({ control: control() })
    await reading
    expect(useTeamRuntimeControlStore.getState().byTeam).toEqual({})
  })
})
