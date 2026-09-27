import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { teamPlansApi } from '@/api/teamPlans'
import { useChatStore } from '@/stores/chatStore'
import { useTeamPlanStore } from '@/stores/teamPlanStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useSessionRuntimeStore } from '@/stores/sessionRuntimeStore'
import { useProviderStore } from '@/stores/providerStore'
import { AgentTeamsPlanCard } from './AgentTeamsPlanCard'
import type { TeamPlanRecord } from '../../../../src/shared/teamPlan'

vi.mock('@/api/teamPlans', () => ({ teamPlansApi: { get: vi.fn(), save: vi.fn(), act: vi.fn() } }))
vi.mock('@/components/controls/ModelSelector', () => ({
  ModelSelector: (props: { ariaLabel: string; runtimeSelection: { providerId: string | null; modelId: string }; onRuntimeSelectionChange: (value: { providerId: string | null; modelId: string }) => void; disabled?: boolean; runtimeKey?: string }) => (
    <button aria-label={props.ariaLabel} disabled={props.disabled} data-runtime-key={props.runtimeKey} onClick={() => props.onRuntimeSelectionChange({ providerId: 'economy', modelId: 'cheap' })}>
      {props.runtimeSelection.providerId ?? 'official'} / {props.runtimeSelection.modelId}
    </button>
  ),
}))

function fixture(): TeamPlanRecord {
  return {
    schemaVersion: 1, planId: 'plan', sessionId: 'session', teamName: 'Test team', incarnationId: 'incarnation', revision: 1,
    state: 'review_pending', workDir: '/tmp/fixture', createdAt: 1, updatedAt: 1,
    leaderRuntime: { providerId: 'claude-official', modelId: 'leader' },
    agentCatalog: { engineer: { systemPrompt: 'Engineer', source: 'built-in' }, reviewer: { systemPrompt: 'Review', source: 'userSettings' } },
    members: [
      { id: 'build', name: 'Builder', agentType: 'engineer', prompt: 'Implement', runtime: { providerId: 'fast', modelId: 'small' }, suggestedRuntime: { providerId: 'fast', modelId: 'small' } },
      { id: 'review', name: 'Reviewer', agentType: 'reviewer', prompt: 'Review', runtime: { providerId: 'strong', modelId: 'large' }, suggestedRuntime: { providerId: 'strong', modelId: 'large' } },
    ],
    tasks: [{ id: 'task', subject: 'Implement task', ownerId: 'build', dependencies: [] }],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.setState({ locale: 'en' })
  useTeamPlanStore.setState({ bySession: {} })
  useProviderStore.setState({ providers: [] })
  useSessionRuntimeStore.setState({ selections: {} })
  vi.mocked(teamPlansApi.get).mockResolvedValue({ plan: fixture() })
})

async function open() {
  render(<AgentTeamsPlanCard sessionId="session" />)
  fireEvent.click(await screen.findByRole('button', { name: 'Review configuration' }))
}

describe('AgentTeamsPlanCard', () => {
  it('focuses one member at a time and preserves edits when navigating the roster', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Builder · Provider and model' }))
    fireEvent.click(screen.getByRole('button', { name: 'Configure Reviewer' }))
    expect(screen.queryByRole('button', { name: 'Builder · Provider and model' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reviewer · Provider and model' })).toHaveTextContent('strong / large')
    fireEvent.click(screen.getByRole('button', { name: 'Configure Builder' }))
    expect(screen.getByRole('button', { name: 'Builder · Provider and model' })).toHaveTextContent('economy / cheap')
    expect(teamPlansApi.act).not.toHaveBeenCalled()
  })

  it('restores a pending plan with read-only lead and controlled member selection', async () => {
    await open()
    expect(screen.getByText('Lead agent (read-only): Claude official · leader')).toBeInTheDocument()
    expect(screen.getByText('Task complexity: Not provided')).toBeInTheDocument()
    const member = screen.getByRole('button', { name: 'Builder · Provider and model' })
    expect(member).not.toHaveAttribute('data-runtime-key')
    fireEvent.click(member)
    const draft = useTeamPlanStore.getState().bySession.session!.draft!
    expect(draft.members[0]!.runtime).toEqual({ providerId: 'economy', modelId: 'cheap' })
    expect(draft.members[1]!.runtime.modelId).toBe('large')
    expect(useTeamPlanStore.getState().bySession.session!.plan?.leaderRuntime.modelId).toBe('leader')
    expect(teamPlansApi.save).not.toHaveBeenCalled()
  })

  it('allows task assignment, preset changes, batch model selection and restoration', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Builder · Agent preset' }))
    fireEvent.click(screen.getByRole('option', { name: /reviewer/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Implement task · Assigned member' }))
    fireEvent.click(screen.getByRole('option', { name: /^Reviewer/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all members' }))
    fireEvent.click(screen.getByRole('button', { name: 'Set model for selected members' }))
    let draft = useTeamPlanStore.getState().bySession.session!.draft!
    expect(draft.members.every(member => member.runtime.providerId === 'economy')).toBe(true)
    expect(draft.members[0]!.agentType).toBe('reviewer')
    expect(draft.tasks[0]!.ownerId).toBe('review')
    fireEvent.click(screen.getByRole('button', { name: 'Restore suggested models' }))
    draft = useTeamPlanStore.getState().bySession.session!.draft!
    expect(draft.members.map(member => member.runtime.modelId)).toEqual(['small', 'large'])
  })

  it.each([undefined, 'removed-member'])('shows an unassigned task accurately and blocks approval until assigned (%s)', async ownerId => {
    const plan = fixture()
    plan.tasks[0]!.ownerId = ownerId
    vi.mocked(teamPlansApi.get).mockResolvedValue({ plan })
    await open()
    const owner = screen.getByRole('button', { name: 'Implement task · Assigned member' })
    expect(owner).toHaveTextContent('Unassigned')
    expect(screen.getByRole('alert')).toHaveTextContent('Assign this task to a member before approving.')
    expect(screen.getByRole('button', { name: 'Approve and launch' })).toBeDisabled()
    expect(teamPlansApi.act).not.toHaveBeenCalled()
    fireEvent.click(owner)
    fireEvent.click(screen.getByRole('option', { name: /^Reviewer/ }))
    expect(owner).toHaveTextContent('Reviewer')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve and launch' })).toBeEnabled()
  })

  it('blocks an old review with an unlaunchable member name and points to revision', async () => {
    const plan = fixture()
    plan.members[0]!.name = 'README Reader'
    vi.mocked(teamPlansApi.get).mockResolvedValue({ plan })
    await open()
    expect(screen.getByRole('button', { name: 'Approve and launch' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('README Reader')
    expect(screen.getByRole('alert')).toHaveTextContent('Request a revision')
    expect(teamPlansApi.act).not.toHaveBeenCalled()
  })

  it('follows the current session runtime without switching the lead and falls back to the plan snapshot', async () => {
    await open()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all members' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use lead model for selected' }))
    expect(useTeamPlanStore.getState().bySession.session!.draft!.members[0]!.runtime).toEqual(fixture().leaderRuntime)
    const current = { providerId: 'new-provider', modelId: 'new-leader', effortLevel: 'high' as const }
    act(() => { useSessionRuntimeStore.setState({ selections: { session: current } }) })
    expect(screen.getByText('Lead agent (read-only): new-provider · new-leader')).toBeInTheDocument()
    const switchRuntime = vi.spyOn(useChatStore.getState(), 'setSessionRuntime')
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Use lead model for selected' }))
      expect(useTeamPlanStore.getState().bySession.session!.draft!.members.every(member => member.runtime.modelId === 'new-leader' && member.runtime.providerId === 'new-provider' && member.runtime.effortLevel === 'high')).toBe(true)
      expect(useSessionRuntimeStore.getState().selections.session).toBe(current)
      expect(useTeamPlanStore.getState().bySession.session!.plan!.leaderRuntime).toEqual(fixture().leaderRuntime)
      expect(switchRuntime).not.toHaveBeenCalled()
    } finally {
      switchRuntime.mockRestore()
    }
  })

  it('saves before confirming and disables approval after launch', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Builder · Provider and model' }))
    vi.mocked(teamPlansApi.save).mockResolvedValue({ plan: { ...fixture(), revision: 2 } })
    vi.mocked(teamPlansApi.act).mockResolvedValue({ plan: { ...fixture(), revision: 3, state: 'launching' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve and launch' }))
    await waitFor(() => expect(teamPlansApi.act).toHaveBeenCalledOnce())
    expect(vi.mocked(teamPlansApi.act).mock.calls[0]![0].revision).toBe(2)
    expect(screen.queryByRole('button', { name: 'Approve and launch' })).not.toBeInTheDocument()
  })

  it('keeps local choices after background revision change and blocks stale approval', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Builder · Provider and model' }))
    vi.mocked(teamPlansApi.get).mockResolvedValue({ plan: { ...fixture(), revision: 2 } })
    await act(async () => { await useTeamPlanStore.getState().refresh('session') })
    expect(screen.getByRole('button', { name: 'Approve and launch' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Builder · Provider and model' })).toHaveTextContent('economy / cheap')
    fireEvent.click(screen.getByRole('button', { name: 'Apply my edits to latest plan' }))
    expect(screen.getByRole('button', { name: 'Approve and launch' })).toBeEnabled()
  })

  it('requires saving preset changes before approval and never retries interrupted execution', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Builder · Agent preset' }))
    fireEvent.click(screen.getByRole('option', { name: /reviewer/ }))
    expect(screen.getByRole('button', { name: 'Approve and launch' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled()
    vi.mocked(teamPlansApi.get).mockResolvedValue({ plan: { ...fixture(), revision: 2, state: 'interrupted' } })
    await act(async () => { await useTeamPlanStore.getState().refresh('session') })
    expect(screen.queryByRole('button', { name: 'Approve and launch' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Review again' })).not.toBeInTheDocument()
  })

  it('requires feedback to request revision and does not launch on close', async () => {
    await open()
    fireEvent.click(screen.getByText('Request revision', { selector: 'summary' }))
    expect(screen.getByRole('button', { name: 'Request revision' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Revision feedback (required to return)' }), { target: { value: 'Split implementation and review' } })
    vi.mocked(teamPlansApi.act).mockResolvedValue({ plan: { ...fixture(), revision: 2, state: 'draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request revision' }))
    await waitFor(() => expect(teamPlansApi.act).toHaveBeenCalled())
    expect(vi.mocked(teamPlansApi.act).mock.calls[0]!.slice(1)).toEqual(['return', expect.any(String), 'Split implementation and review'])
  })
  it.each(['draft', 'review_pending', 'cancelled'] as const)('keeps Stop available for existing workers while the incremental plan is %s', async state => {
    vi.mocked(teamPlansApi.get).mockResolvedValue({ plan: { ...fixture(), state, parentPlanId: 'previous-running-plan' } })
    const stop = vi.spyOn(useChatStore.getState(), 'stopGeneration').mockImplementation(() => {})
    try {
      await open()
      fireEvent.click(screen.getByRole('button', { name: 'Stop team and main task' }))
      expect(stop).toHaveBeenCalledExactlyOnceWith('session')
      expect(screen.getByRole('button', { name: 'Stopping team and main task…' })).toBeDisabled()
      expect(teamPlansApi.act).not.toHaveBeenCalled()
    } finally {
      stop.mockRestore()
    }
  })

  it.each(['launching', 'running'] as const)('offers an explicit stop while %s even when the leader is idle', async state => {
    vi.mocked(teamPlansApi.get).mockResolvedValue({ plan: { ...fixture(), state } })
    const stop = vi.spyOn(useChatStore.getState(), 'stopGeneration').mockImplementation(() => {})
    try {
      await open()
      fireEvent.click(screen.getByRole('button', { name: 'Stop team and main task' }))
      expect(stop).toHaveBeenCalledExactlyOnceWith('session')
      const stopping = screen.getByRole('button', { name: 'Stopping team and main task…' })
      expect(stopping).toBeDisabled()
      fireEvent.click(stopping)
      expect(stop).toHaveBeenCalledOnce()
    } finally {
      stop.mockRestore()
    }
  })

})
