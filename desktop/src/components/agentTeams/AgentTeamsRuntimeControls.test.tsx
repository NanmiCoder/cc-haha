import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useTeamStore } from '@/stores/teamStore'
import { useTeamRuntimeControlStore } from '@/stores/teamRuntimeControlStore'
import type { TeamDetail } from '@/types/team'
import type { TeamRuntimeControlView } from '../../../../src/shared/teamRuntimeControl'
import { AgentTeamsRuntimeControls } from './AgentTeamsRuntimeControls'

const mocks = vi.hoisted(() => ({
  getRuntimeControl: vi.fn(), resumeRuntime: vi.fn(), updateMemberRuntime: vi.fn(), getWorkbench: vi.fn(),
}))
vi.mock('@/api/teams', () => ({ teamsApi: { ...mocks, list: vi.fn(), get: vi.fn(), getWorkbenchForSession: vi.fn(), getMemberTranscript: vi.fn(), sendMemberMessage: vi.fn(), delete: vi.fn() } }))
vi.mock('@/components/controls/ModelSelector', () => ({
  ModelSelector: ({ ariaLabel, disabled, runtimeSelection, onRuntimeSelectionChange }: {
    ariaLabel?: string; disabled?: boolean; runtimeSelection?: { modelId: string }; onRuntimeSelectionChange: (selection: { providerId: string; modelId: string; effortLevel: 'high' }) => void
  }) => <button type="button" aria-label={ariaLabel} disabled={disabled} data-model={runtimeSelection?.modelId} onClick={() => onRuntimeSelectionChange({ providerId: 'new-provider', modelId: 'new-model', effortLevel: 'high' })}>{ariaLabel}</button>,
}))

const team: TeamDetail = {
  name: 'review-team', leadSessionId: 'lead-session', incarnationId: 'incarnation-one', leadAgentId: 'team-lead@review-team',
  members: [
    { agentId: 'team-lead@review-team', name: 'team-lead', role: 'lead', status: 'idle', model: 'lead-model', sessionId: 'lead-session' },
    { agentId: 'reader@review-team', name: 'reader', role: 'researcher', status: 'idle', activity: 'stopped', model: 'reader-model', providerId: 'old-provider', sessionId: 'reader-cli' },
    { agentId: 'writer@review-team', name: 'writer', role: 'writer', status: 'idle', activity: 'stopped', model: 'writer-model', providerId: 'old-provider', sessionId: 'writer-cli' },
  ],
}

function control(status: TeamRuntimeControlView['status'] = 'paused', revision = 5): TeamRuntimeControlView {
  return {
    schemaVersion: 1, teamName: team.name, leadSessionId: 'lead-session', incarnationId: 'incarnation-one',
    revision, epoch: 2, status, updatedAt: 1, resumeEligibleCount: 2,
    members: [
      { agentId: 'reader@review-team', sessionId: 'reader-cli', planId: 'initial-plan', memberId: 'reader', name: 'reader', status: 'paused' },
      { agentId: 'writer@review-team', sessionId: 'writer-cli', planId: 'added-plan', memberId: 'writer', name: 'writer', status: 'paused' },
    ],
  }
}

describe('AgentTeamsRuntimeControls', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    useChatStore.setState(useChatStore.getInitialState(), true)
    useTeamStore.getState().clearTeam()
    useTeamStore.setState({ activeTeam: team })
    useTeamRuntimeControlStore.getState().clear()
    mocks.getRuntimeControl.mockResolvedValue({ control: control() })
    mocks.resumeRuntime.mockResolvedValue({ control: control('running', 6) })
    mocks.getWorkbench.mockImplementation(async () => ({ version: 'v2', generatedAt: '2026-11-12T00:00:00.000Z', team: useTeamStore.getState().activeTeam, tasks: [], messages: [] }))
  })
  afterEach(() => {
    cleanup()
    useTeamRuntimeControlStore.getState().clear()
    useTeamStore.getState().clearTeam()
    useChatStore.setState(useChatStore.getInitialState(), true)
  })

  it('shows a confirmed paused state with a separate explicit team resume action', async () => {
    render(<AgentTeamsRuntimeControls team={team} />)
    expect(await screen.findByText('Team paused')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resume team (2)' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Edit member models' })).toBeEnabled()
    expect(mocks.resumeRuntime).not.toHaveBeenCalled()
  })

  it('uses the parent Stop path and keeps editing locked until the server confirms pause', async () => {
    mocks.getRuntimeControl.mockResolvedValue({ control: control('running') })
    const stop = vi.fn()
    useChatStore.setState({ stopGeneration: stop })
    render(<AgentTeamsRuntimeControls team={team} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Pause team and main task' }))
    expect(stop).toHaveBeenCalledWith('lead-session')
    expect(screen.getByRole('button', { name: 'Edit member models' })).toBeDisabled()
    expect(mocks.resumeRuntime).not.toHaveBeenCalled()

    mocks.getRuntimeControl.mockResolvedValue({ control: control('paused', 6) })
    await act(async () => {
      await useTeamRuntimeControlStore.getState().refresh({ teamName: team.name, leadSessionId: 'lead-session', incarnationId: 'incarnation-one' })
    })
    expect(screen.getByRole('button', { name: 'Edit member models' })).toBeEnabled()
  })

  it('still offers explicit coordination recovery with no ready unfinished members', async () => {
    mocks.getRuntimeControl.mockResolvedValue({ control: { ...control(), resumeEligibleCount: 0, members: control().members.map(member => ({ ...member, status: 'completed' })) } })
    render(<AgentTeamsRuntimeControls team={team} />)
    expect(await screen.findByRole('button', { name: 'Resume team (0)' })).toBeEnabled()
    expect(mocks.resumeRuntime).not.toHaveBeenCalled()
  })

  it.each(['pausing', 'resuming', 'partial'] as const)('does not enable model edits in %s', async status => {
    mocks.getRuntimeControl.mockResolvedValue({ control: control(status) })
    render(<AgentTeamsRuntimeControls team={team} />)
    expect(await screen.findByRole('button', { name: 'Edit member models' })).toBeDisabled()
  })

  it('shows partial failures and retries the same explicit resume request', async () => {
    const failed = { ...control('partial', 6), error: 'writer could not restart', members: [{ ...control().members[1]!, status: 'failed' as const, error: 'writer could not restart' }] }
    mocks.resumeRuntime.mockResolvedValueOnce({ control: failed }).mockResolvedValueOnce({ control: control('running', 7) })
    render(<AgentTeamsRuntimeControls team={team} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Resume team (2)' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('writer could not restart')
    fireEvent.click(screen.getByRole('button', { name: 'Retry team resume (2)' }))
    await waitFor(() => expect(mocks.resumeRuntime).toHaveBeenCalledTimes(2))
    expect(mocks.resumeRuntime.mock.calls[1]![1].requestId).toBe(mocks.resumeRuntime.mock.calls[0]![1].requestId)
  })

  it('keeps Pause available while an explicit resume is pending', async () => {
    let complete!: (response: { control: TeamRuntimeControlView }) => void
    mocks.resumeRuntime.mockReturnValue(new Promise<{ control: TeamRuntimeControlView }>(resolve => { complete = resolve }))
    const stop = vi.fn()
    useChatStore.setState({ stopGeneration: stop })
    render(<AgentTeamsRuntimeControls team={team} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Resume team (2)' }))
    await waitFor(() => expect(mocks.resumeRuntime).toHaveBeenCalledTimes(1))
    const pause = screen.getByRole('button', { name: 'Pause team and main task' })
    expect(pause).toBeEnabled()
    fireEvent.click(pause)
    expect(stop).toHaveBeenCalledWith('lead-session')
    await act(async () => { complete({ control: control('running', 6) }) })
    expect(screen.getByText('Pausing team…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit member models' })).toBeDisabled()
  })

  it('saves selected member runtimes sequentially without touching the lead or starting work', async () => {
    let revision = 5
    mocks.updateMemberRuntime.mockImplementation(async (_teamName: string, agentId: string, value: { modelId: string; providerId: string }) => ({
      ok: true, member: { agentId, model: value.modelId, providerId: value.providerId, providerName: 'New provider' }, control: control('paused', ++revision),
    }))
    const stop = vi.fn()
    useChatStore.setState({ stopGeneration: stop })
    render(<AgentTeamsRuntimeControls team={team} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit member models' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit member models' })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Select all members' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Model for selected members' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save models' }))
    await waitFor(() => expect(mocks.updateMemberRuntime).toHaveBeenCalledTimes(2))
    expect(mocks.updateMemberRuntime.mock.calls.map(call => [call[1], call[2].expectedRevision, call[2].sessionId])).toEqual([
      ['reader@review-team', 5, 'reader-cli'], ['writer@review-team', 6, 'writer-cli'],
    ])
    expect(useTeamStore.getState().activeTeam?.members.find(member => member.agentId === team.leadAgentId)?.model).toBe('lead-model')
    expect(mocks.resumeRuntime).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })

  it('makes replay and archived views read only without fetching active runtime controls', () => {
    render(<AgentTeamsRuntimeControls team={team} readOnly />)
    expect(screen.queryByRole('button', { name: 'Resume team (2)' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pause team and main task' })).not.toBeInTheDocument()
    expect(mocks.getRuntimeControl).not.toHaveBeenCalled()
  })

  it('does not let a previous incarnations save close or rewrite a replacement editor', async () => {
    let complete!: (value: unknown) => void
    mocks.updateMemberRuntime.mockReturnValue(new Promise(resolve => { complete = resolve }))
    const { rerender } = render(<AgentTeamsRuntimeControls team={team} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit member models' }))
    fireEvent.click(screen.getByRole('button', { name: 'reader · Provider and model' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save models' }))
    await waitFor(() => expect(mocks.updateMemberRuntime).toHaveBeenCalledTimes(1))

    const replacement = { ...team, incarnationId: 'replacement', members: team.members.map(member => ({
      ...member, sessionId: member.agentId === team.leadAgentId ? member.sessionId : `${member.sessionId}-next`,
    })) }
    mocks.getRuntimeControl.mockResolvedValue({ control: {
      ...control(), incarnationId: 'replacement', members: control().members.map(member => ({ ...member, sessionId: `${member.sessionId}-next` })),
    } })
    useTeamStore.setState({ activeTeam: replacement })
    rerender(<AgentTeamsRuntimeControls team={replacement} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit member models' }))
    await act(async () => { complete({ ok: true, member: { agentId: 'reader@review-team', model: 'new-model' }, control: control('paused', 6) }) })
    expect(screen.getByRole('dialog', { name: 'Edit member models' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'reader · Provider and model' })).toHaveAttribute('data-model', 'reader-model')
  })
})
