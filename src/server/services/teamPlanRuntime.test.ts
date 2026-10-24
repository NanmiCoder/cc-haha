import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TeamPlanRecord } from '../../shared/teamPlan.js'
import { CLAUDE_OFFICIAL_PROVIDER_ID } from '../types/provider.js'
import { ProviderService } from './providerService.js'
import { startTeamWorkersBarrier, validateTeamPlanRuntime } from './teamPlanRuntime.js'

let home: string
let savedEnv: Record<string, string | undefined>
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'team-plan-runtime-'))
  savedEnv = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = home
})
afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(home, { recursive: true, force: true })
})

function modelPlan(providerId: string, modelId: string): TeamPlanRecord {
  return {
    workDir: home,
    agentCatalog: { fixture: { systemPrompt: 'Fixture instructions', model: modelId, source: 'flagSettings', sourceIdentity: { kind: 'session' } } },
    members: [{ id: 'worker', name: 'worker', agentType: 'fixture', prompt: 'Work', runtime: { providerId, modelId } }],
  } as TeamPlanRecord
}

test('runtime rejects a legacy review with a teammate name that cannot launch', async () => {
  const plan = { workDir: process.cwd(), members: [{ id: 'reader', name: 'README Reader' }] } as never
  await expect(validateTeamPlanRuntime(plan)).rejects.toThrow('Invalid teammate name: README Reader')
})

describe('team preset model resolution', () => {
  test.each([
    ['claude-opus-4-6', 'member-opus'],
    ['claude-opus-4-6[1m]', 'member-opus'],
    ['claude-3-opus-20240229', 'member-opus'],
    ['claude-3-5-sonnet-20241022', 'member-sonnet'],
    ['claude-fable-5-1', 'member-opus'],
  ])('maps saved %s through the approved member provider', async (requestedModel, expectedModel) => {
    const provider = await new ProviderService().addProvider({
      presetId: 'custom', name: 'Member provider', baseUrl: 'http://127.0.0.1:1', apiKey: 'fake-member-key',
      models: { main: 'member-main', sonnet: 'member-sonnet', opus: 'member-opus', haiku: 'member-haiku' },
    })
    const validated = await validateTeamPlanRuntime(modelPlan(provider.id, requestedModel))
    expect(validated.members[0]?.runtime).toEqual({ providerId: provider.id, modelId: expectedModel })
    expect(validated.members[0]?.agentSnapshot?.model).toBe(requestedModel)
  })

  test('retains an explicit Claude version for the official provider', async () => {
    const validated = await validateTeamPlanRuntime(modelPlan(CLAUDE_OFFICIAL_PROVIDER_ID, 'claude-opus-4-6'))
    expect(validated.members[0]?.runtime).toEqual({ providerId: CLAUDE_OFFICIAL_PROVIDER_ID, modelId: 'claude-opus-4-6' })
  })

  test('retains version pins when a configured provider maps the family to Claude', async () => {
    const provider = await new ProviderService().addProvider({
      presetId: 'custom', name: 'Claude provider', baseUrl: 'http://127.0.0.1:1', apiKey: 'fake-claude-key',
      models: { main: 'claude-sonnet-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5' },
    })
    const validated = await validateTeamPlanRuntime(modelPlan(provider.id, 'claude-opus-4-6'))
    expect(validated.members[0]?.runtime).toEqual({ providerId: provider.id, modelId: 'claude-opus-4-6' })
  })
})

describe('team worker ready barrier', () => {
  test('never releases a task before all isolated runtimes are ready', async () => {
    const events: string[] = []
    const ids = await startTeamWorkersBarrier(['cheap', 'capable'], async member => {
      events.push(`prepare:${member}`)
      return member
    }, async member => { events.push(`release:${member}`) }, async id => { events.push(`stop:${id}`) })
    expect(ids).toEqual(['cheap', 'capable'])
    expect(events).toEqual(['prepare:cheap', 'prepare:capable', 'release:cheap', 'release:capable'])
  })
  test('failed preparation rolls back ready workers without sending a task', async () => {
    const released: string[] = []
    const stopped: string[] = []
    await expect(startTeamWorkersBarrier(['a', 'b'], async member => {
      if (member === 'b') throw new Error('provider unavailable')
      return member
    }, async member => { released.push(member) }, async id => { stopped.push(id) })).rejects.toThrow('provider unavailable')
    expect(released).toEqual([])
    expect(stopped).toEqual(['a'])
  })
  test('release failure stops workers and never automatically retries', async () => {
    const released: string[] = []
    const stopped: string[] = []
    await expect(startTeamWorkersBarrier(['a', 'b'], async member => member, async member => {
      released.push(member)
      if (member === 'b') throw new Error('lost SDK connection')
    }, async id => { stopped.push(id) })).rejects.toThrow('lost SDK connection')
    expect(released).toEqual(['a', 'b'])
    expect(stopped).toEqual(['a', 'b'])
  })
})
