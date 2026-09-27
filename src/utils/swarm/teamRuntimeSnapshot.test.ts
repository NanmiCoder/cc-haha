import { expect, test } from 'bun:test'
import { buildTeamRuntimeSnapshot } from './teamRuntimeSnapshot.js'
import type { TeamFile } from './teamHelpers.js'

const team: TeamFile = { name: 'team', createdAt: 1, leadSessionId: 'leader-session', leadAgentId: 'team-lead@team', members: [{ agentId: 'worker@team', name: 'worker', joinedAt: 2, cwd: '/fixture', tmuxPaneId: '', subscriptions: [], backendType: 'process' }] }
test('reconnect restores approved members structurally without spawning them', () => {
  const context = buildTeamRuntimeSnapshot(team, 1, 'leader-session', '/fixture/team.json')
  expect(context.leadAgentId).toBe('team-lead@team')
  expect(context.teammates['worker@team']?.tmuxSessionName).toBe('process')
  expect(context.isLeader).toBe(true)
})
test('old team generations and foreign leaders cannot install a snapshot', () => {
  expect(() => buildTeamRuntimeSnapshot(team, 0, 'leader-session', '/fixture/team.json')).toThrow('Stale')
  expect(() => buildTeamRuntimeSnapshot(team, 1, 'other-session', '/fixture/team.json')).toThrow('foreign')
  expect(() => buildTeamRuntimeSnapshot(null, 1, 'leader-session', '/fixture/team.json')).toThrow('Stale')
})
