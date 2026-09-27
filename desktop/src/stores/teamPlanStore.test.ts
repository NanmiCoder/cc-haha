import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { teamPlansApi } from '@/api/teamPlans'
import { useTeamPlanStore } from './teamPlanStore'
import type { TeamPlanRecord } from '../../../src/shared/teamPlan'

vi.mock('@/api/teamPlans', () => ({ teamPlansApi: { get: vi.fn(), save: vi.fn(), act: vi.fn() } }))

function plan(revision = 1): TeamPlanRecord {
  return {
    schemaVersion: 1, planId: 'plan', sessionId: 'session', teamName: 'team', incarnationId: 'incarnation',
    revision, state: 'review_pending', workDir: '/tmp/fixture', createdAt: 1, updatedAt: revision,
    leaderRuntime: { providerId: 'claude-official', modelId: 'leader' },
    members: [{ id: 'member', name: 'Builder', agentType: 'general-purpose', prompt: 'Build', runtime: { providerId: 'first', modelId: 'small' } }],
    tasks: [{ id: 'task', subject: 'Build', ownerId: 'member', dependencies: [] }],
  }
}

async function load() {
  vi.mocked(teamPlansApi.get).mockResolvedValue({ plan: plan() })
  await useTeamPlanStore.getState().refresh('session')
  useTeamPlanStore.getState().beginEdit('session')
}

beforeEach(() => {
  vi.clearAllMocks()
  useTeamPlanStore.setState({ bySession: {} })
})

describe('durable team plan review', () => {
  it('recovers a plan after cold start and keeps edits scoped to their session', async () => {
    await load()
    const edited = { ...plan().members[0]!, runtime: { providerId: 'second', modelId: 'large' } }
    useTeamPlanStore.getState().edit('session', { members: [edited] })
    await useTeamPlanStore.getState().refresh('other')
    expect(useTeamPlanStore.getState().bySession.session!.draft?.members[0]!.runtime.providerId).toBe('second')
    expect(useTeamPlanStore.getState().bySession.other!.draft).toBeUndefined()
    expect(teamPlansApi.save).not.toHaveBeenCalled()
  })

  it('preserves unsaved edits on a revision conflict and requires explicit reapplication', async () => {
    await load()
    useTeamPlanStore.getState().edit('session', { members: [{ ...plan().members[0]!, runtime: { providerId: 'my-provider', modelId: 'my-model' } }] })
    vi.mocked(teamPlansApi.save).mockRejectedValue(new ApiError(409, { message: 'Revision conflict' }))
    vi.mocked(teamPlansApi.get).mockResolvedValue({ plan: plan(2) })
    expect(await useTeamPlanStore.getState().save('session')).toBe(false)
    let entry = useTeamPlanStore.getState().bySession.session!
    expect(entry.conflict).toBe(true)
    expect(entry.draft?.members[0]!.runtime.modelId).toBe('my-model')
    expect(await useTeamPlanStore.getState().act('session', 'approve')).toBe(false)
    expect(teamPlansApi.act).not.toHaveBeenCalled()
    useTeamPlanStore.getState().reapply('session')
    entry = useTeamPlanStore.getState().bySession.session!
    expect(entry.conflict).toBe(false)
    expect(entry.draft?.revision).toBe(2)
    expect(entry.draft?.members[0]!.runtime.modelId).toBe('my-model')
  })

  it('saves selected runtimes before approval and uses the saved revision', async () => {
    await load()
    const members = [{ ...plan().members[0]!, runtime: { providerId: 'second', modelId: 'large' } }]
    useTeamPlanStore.getState().edit('session', { members })
    vi.mocked(teamPlansApi.save).mockResolvedValue({ plan: { ...plan(2), members } })
    vi.mocked(teamPlansApi.act).mockResolvedValue({ plan: { ...plan(3), state: 'launching', members } })
    expect(await useTeamPlanStore.getState().act('session', 'approve')).toBe(true)
    expect(vi.mocked(teamPlansApi.act).mock.calls[0]![0].revision).toBe(2)
    expect(vi.mocked(teamPlansApi.act).mock.calls[0]![0].members[0]!.runtime.providerId).toBe('second')
    expect(useTeamPlanStore.getState().bySession.session!.plan?.state).toBe('launching')
  })

  it('does not let an older read overwrite a successful save', async () => {
    await load()
    let resolveRead!: (result: { plan: TeamPlanRecord }) => void
    vi.mocked(teamPlansApi.get).mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve }))
    const read = useTeamPlanStore.getState().refresh('session')
    useTeamPlanStore.getState().edit('session', { members: [{ ...plan().members[0]!, prompt: 'Edited' }] })
    vi.mocked(teamPlansApi.save).mockResolvedValue({ plan: plan(2) })
    await useTeamPlanStore.getState().save('session')
    resolveRead({ plan: plan() })
    await read
    expect(useTeamPlanStore.getState().bySession.session!.plan?.revision).toBe(2)
  })

  it('never reapplies old edits to a different plan with the same team name', async () => {
    await load()
    useTeamPlanStore.getState().edit('session', { members: [{ ...plan().members[0]!, prompt: 'Old plan' }] })
    vi.mocked(teamPlansApi.get).mockResolvedValue({ plan: { ...plan(2), planId: 'new-plan' } })
    await useTeamPlanStore.getState().refresh('session')
    useTeamPlanStore.getState().reapply('session')
    expect(useTeamPlanStore.getState().bySession.session!.conflict).toBe(true)
    expect(await useTeamPlanStore.getState().act('session', 'approve')).toBe(false)
  })
  it('reapplies only human-edited fields while preserving the latest instructions and other member models', async () => {
    await load()
    const original = plan().members[0]!
    useTeamPlanStore.getState().edit('session', { members: [{ ...original, runtime: { providerId: 'human', modelId: 'selected' } }] })
    const latest = {
      ...plan(2),
      members: [{ ...original, prompt: 'Revised responsibility from leader', agentType: 'new-preset' }],
      tasks: [{ ...plan().tasks[0]!, subject: 'Revised task', ownerId: 'new-owner' }],
    }
    vi.mocked(teamPlansApi.get).mockResolvedValue({ plan: latest })
    await useTeamPlanStore.getState().refresh('session')
    useTeamPlanStore.getState().reapply('session')
    const draft = useTeamPlanStore.getState().bySession.session!.draft!
    expect(draft.members[0]).toMatchObject({ prompt: 'Revised responsibility from leader', agentType: 'new-preset', runtime: { providerId: 'human', modelId: 'selected' } })
    expect(draft.tasks[0]).toMatchObject({ subject: 'Revised task', ownerId: 'new-owner' })
  })

  it.each(['save', 'approve'] as const)('invalidates an older poll started while %s is in flight', async action => {
    await load()
    let finishMutation!: (value: { plan: TeamPlanRecord }) => void
    const mutation = new Promise<{ plan: TeamPlanRecord }>(resolve => { finishMutation = resolve })
    if (action === 'save') {
      useTeamPlanStore.getState().edit('session', { members: [{ ...plan().members[0]!, runtime: { providerId: 'new', modelId: 'new' } }] })
      vi.mocked(teamPlansApi.save).mockReturnValueOnce(mutation)
    } else {
      vi.mocked(teamPlansApi.act).mockReturnValueOnce(mutation)
    }
    const commit = action === 'save' ? useTeamPlanStore.getState().save('session') : useTeamPlanStore.getState().act('session', 'approve')
    let finishRead!: (value: { plan: TeamPlanRecord }) => void
    vi.mocked(teamPlansApi.get).mockReturnValueOnce(new Promise(resolve => { finishRead = resolve }))
    const poll = useTeamPlanStore.getState().refresh('session')
    finishMutation({ plan: { ...plan(2), state: action === 'save' ? 'review_pending' : 'launching' } })
    await commit
    finishRead({ plan: plan() })
    await poll
    expect(useTeamPlanStore.getState().bySession.session!.plan?.revision).toBe(2)
    expect(useTeamPlanStore.getState().bySession.session!.plan?.state).toBe(action === 'save' ? 'review_pending' : 'launching')
  })

})
