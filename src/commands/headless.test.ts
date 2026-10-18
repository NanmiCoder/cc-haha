import { afterEach, describe, expect, test } from 'bun:test'
import { getAgentProfile, setAgentProfile } from '../utils/agentProfile.js'
import type { Command } from '../types/command.js'
import { filterCommandsForHeadlessMode } from './headless.js'

describe('filterCommandsForHeadlessMode', () => {
  const originalProfile = getAgentProfile()
  afterEach(() => setAgentProfile(originalProfile))
  test('keeps /goal without exposing other local-jsx UI commands', () => {
    const commands = [
      {
        type: 'local-jsx',
        supportsNonInteractive: true,
        name: 'goal',
        description: 'Set a goal',
        load: async () => ({ call: async () => null }),
      },
      {
        type: 'local-jsx',
        name: 'config',
        description: 'Open config UI',
        load: async () => ({ call: async () => null }),
      },
      {
        type: 'prompt',
        name: 'review',
        description: 'Review code',
        progressMessage: 'reviewing',
        contentLength: 0,
        source: 'builtin',
        getPromptForCommand: async () => [],
      },
      {
        type: 'prompt',
        name: 'statusline',
        description: 'Hidden from print mode',
        progressMessage: 'checking',
        contentLength: 0,
        source: 'builtin',
        disableNonInteractive: true,
        getPromptForCommand: async () => [],
      },
    ] satisfies Command[]

    expect(filterCommandsForHeadlessMode(commands).map(command => command.name)).toEqual([
      'goal',
      'review',
    ])
  })
})


test('lean headless filtering retains inline skills and core local commands after refresh', async () => {
  const original = getAgentProfile()
  try {
    setAgentProfile('lean')
    const cost = (await import('./cost/index.js')).default
    const plan = (await import('./plan/index.js')).default
    const advisor = (await import('./advisor.js')).default
    const skill = {
      type: 'prompt', name: 'fixture-skill', description: 'fixture', progressMessage: 'loading',
      contentLength: 0, source: 'projectSettings', getPromptForCommand: async () => [],
    } satisfies Command
    const commands = [cost, plan, advisor, skill, { ...skill, name: 'forked', context: 'fork' as const }]
    expect(filterCommandsForHeadlessMode(commands).map(command => command.name)).toEqual(['cost', 'fixture-skill'])
    setAgentProfile('standard')
    expect(filterCommandsForHeadlessMode(commands).map(command => command.name)).toEqual(['cost', 'advisor', 'fixture-skill', 'forked'])
  } finally {
    setAgentProfile(original)
  }
})
