import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildTeamRuntimeSnapshot, confirmTeamRuntimeResume, teamRuntimeSnapshotHoldsMail } from './teamRuntimeSnapshot.js'
import { ensureTeamRuntimeControl, mutateTeamRuntimeControl, teamControlIdentity } from './teamRuntimeControlStore.js'
import { writeTeamFileAsync } from './teamHelpers.js'
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

test('reconnect holds reviewed mail and only the exact durable human resume releases it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'team-resume-ack-'))
  const oldHome = process.env.HOME, oldConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = root
  const reviewed = { ...team, reviewRequired: true }
  try {
    await writeTeamFileAsync(team.name, reviewed)
    const identity = teamControlIdentity(reviewed)
    expect(teamRuntimeSnapshotHoldsMail(reviewed)).toBe(true)
    const control = await ensureTeamRuntimeControl(team.name, identity, 'test-owner')
    expect(teamRuntimeSnapshotHoldsMail(reviewed)).toBe(true)
    const pending = await mutateTeamRuntimeControl(team.name, identity, current => ({ ...current, status: 'resuming', epoch: current.epoch + 1, resume: { requestId: 'fresh-human', epoch: current.epoch + 1, createdAt: 5, eligibleSessionIds: [], startedSessionIds: [] } }))
    const request = { team_name: team.name, created_at: team.createdAt, incarnation_id: identity.incarnationId, epoch: pending.epoch, request_id: 'fresh-human' }
    expect(confirmTeamRuntimeResume(reviewed, 'leader-session', request)).toEqual({ team_name: team.name, incarnation_id: identity.incarnationId, epoch: pending.epoch, request_id: 'fresh-human' })
    expect(() => confirmTeamRuntimeResume(reviewed, 'foreign', request)).toThrow('foreign')
    expect(() => confirmTeamRuntimeResume(reviewed, 'leader-session', { ...request, epoch: control.epoch })).toThrow('changed')
    expect(() => confirmTeamRuntimeResume(reviewed, 'leader-session', { ...request, request_id: 'old' })).toThrow('changed')
    expect(() => confirmTeamRuntimeResume(reviewed, 'leader-session', { ...request, incarnation_id: 'replaced' })).toThrow('changed')
    await mutateTeamRuntimeControl(team.name, identity, current => ({ ...current, status: 'paused', epoch: current.epoch + 1 }))
    expect(() => confirmTeamRuntimeResume(reviewed, 'leader-session', request)).toThrow('changed')
    expect(teamRuntimeSnapshotHoldsMail({ ...reviewed, reviewRequired: false })).toBe(false)
  } finally {
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = oldConfig
    await rm(root, { recursive: true, force: true })
  }
})
