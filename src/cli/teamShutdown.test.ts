import { expect, test } from 'bun:test'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { createShutdownTeamPrompt, hasTeammatesRequiringShutdown } from './print.js'
import { isShutdownTeamPrompt, SHUTDOWN_TEAM_PROMPT } from '../utils/swarm/teamShutdownPrompt.js'

test('a draft team with only its leader does not trigger shutdown', () => {
  const state = getDefaultAppState()
  const lead = { name: 'team-lead' }
  const teamContext = { teammates: { lead } } as unknown as NonNullable<typeof state.teamContext>
  expect(hasTeammatesRequiringShutdown(state)).toBe(false)
  expect(hasTeammatesRequiringShutdown({ ...state, teamContext })).toBe(false)
  expect(hasTeammatesRequiringShutdown({ ...state, teamContext: { ...teamContext, teammates: { lead, worker: { ...lead, name: 'worker' } } } as typeof teamContext })).toBe(true)
  const activeTask = { type: 'in_process_teammate', status: 'running' }
  expect(hasTeammatesRequiringShutdown({ ...state, tasks: { worker: activeTask } as typeof state.tasks })).toBe(true)
})

test('shutdown instruction is model-visible but hidden from user history', () => {
  const command = createShutdownTeamPrompt()
  expect(command.mode).toBe('prompt')
  expect(command.isMeta).toBe(true)
  expect(command.value).toContain('requestShutdown')
  expect(isShutdownTeamPrompt([{ type: 'text', text: SHUTDOWN_TEAM_PROMPT }])).toBe(true)
  expect(isShutdownTeamPrompt('User quoted requestShutdown in a question')).toBe(false)
})
