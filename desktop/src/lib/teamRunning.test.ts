import { describe, expect, it } from 'vitest'
import type { TeamMember, TeamWorkbenchSnapshot } from '../types/team'
import { areTeamMembersAllStopped, isTeamPlanActive, isTeamRunning } from './teamRunning'

const LEAD: TeamMember = { agentId: 'lead', role: 'Lead', status: 'idle', activity: 'idle' }

function snapshot(...members: TeamMember[]): Pick<TeamWorkbenchSnapshot, 'team'> {
  return {
    team: {
      name: 'review-team',
      leadAgentId: 'lead',
      leadSessionId: 'lead-session',
      createdAt: '2026-10-18T00:00:00.000Z',
      members: [LEAD, ...members],
    },
  }
}

const worker = (patch: Partial<TeamMember>): TeamMember => ({
  agentId: 'worker', role: 'Worker', status: 'running', activity: 'active', ...patch,
})

describe('isTeamPlanActive', () => {
  it.each(['launching', 'running'])('is true while the plan is %s', (state) => {
    expect(isTeamPlanActive({ state })).toBe(true)
  })

  it.each(['draft', 'review_pending', 'launch_failed', 'cancelled', 'interrupted'])(
    'is false once the plan is %s',
    (state) => {
      expect(isTeamPlanActive({ state })).toBe(false)
    },
  )

  it('is false without a plan', () => {
    expect(isTeamPlanActive(undefined)).toBe(false)
    expect(isTeamPlanActive(null)).toBe(false)
  })
})

describe('isTeamRunning (#1524)', () => {
  const running = { state: 'running' }

  it('is true while a teammate is mid-turn even though the lead is idle', () => {
    expect(isTeamRunning(running, snapshot(worker({})))).toBe(true)
  })

  it('stays true while a teammate is merely idle: the team is launched and can pick up work', () => {
    expect(isTeamRunning(running, snapshot(worker({ status: 'idle', activity: 'idle' })))).toBe(true)
  })

  it('is false after Stop paused the team: every member stopped', () => {
    expect(isTeamRunning(running, snapshot(worker({ status: 'idle', activity: 'stopped' })))).toBe(false)
  })

  it('is false when every member has exited', () => {
    expect(isTeamRunning(running, snapshot(worker({ activity: 'exited' })))).toBe(false)
    expect(isTeamRunning(running, snapshot(worker({ status: 'completed', activity: 'idle' })))).toBe(false)
  })

  it('is true when only some members are stopped', () => {
    const roster = snapshot(
      worker({ agentId: 'a', activity: 'stopped', status: 'idle' }),
      worker({ agentId: 'b', activity: 'active' }),
    )
    expect(isTeamRunning(running, roster)).toBe(true)
  })

  it('is false once the plan is no longer running, whatever the roster says', () => {
    expect(isTeamRunning({ state: 'cancelled' }, snapshot(worker({})))).toBe(false)
    expect(isTeamRunning(null, snapshot(worker({})))).toBe(false)
  })

  it('trusts the plan when no roster has loaded yet', () => {
    expect(isTeamRunning(running, undefined)).toBe(true)
  })
})

describe('areTeamMembersAllStopped', () => {
  it('ignores the lead and refuses to judge an empty roster', () => {
    expect(areTeamMembersAllStopped(snapshot().team)).toBe(false)
    expect(areTeamMembersAllStopped(undefined)).toBe(false)
  })
})
