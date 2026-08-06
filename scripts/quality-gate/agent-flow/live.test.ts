import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describeLiveTarget, resolveLiveTarget } from './live.ts'
import { LIVE_AGENT_FLOW_SCENARIOS, LIVE_FLOW_COVERAGE, LIVE_FLOW_EXCLUSIONS } from './liveScenarios.ts'

/**
 * Everything here runs without a provider. The parts of the live lane that can be
 * tested for free are the parts that decide whether to spend money at all — target
 * resolution and the confirmation gate — so those are exactly what is pinned.
 */

function configDirWith(providers: Array<{ id: string; name: string; models?: Record<string, string> }>) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-haha-live-test-'))
  mkdirSync(join(dir, 'cc-haha'), { recursive: true })
  writeFileSync(
    join(dir, 'cc-haha', 'providers.json'),
    JSON.stringify({ activeId: providers[0]?.id ?? null, providers }),
  )
  return dir
}

describe('live target resolution', () => {
  const configDir = configDirWith([
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'LM Studio', models: { main: 'local-model' } },
    { id: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'DeepSeek', models: { main: 'deepseek-chat' } },
    { id: 'aaaaaaaa-0000-4000-8000-000000000003', name: 'DeepSeek Backup', models: { main: 'deepseek-chat' } },
  ])

  // The whole point of the gate: never pick a provider on the user's behalf. An
  // implicit fallback to the active provider is how a test run bills someone for a
  // model they did not choose.
  test('refuses to run without an explicit provider', () => {
    expect(() => resolveLiveTarget(undefined, { configDir })).toThrow(/--provider is required/)
  })

  test('refuses an ambiguous selector instead of picking one', () => {
    // 'deep' substring-matches both DeepSeek entries and names neither.
    expect(() => resolveLiveTarget('deep', { configDir })).toThrow(/matches 2 providers/)
  })

  // An exact name is not ambiguous just because it prefixes another entry, or
  // 'DeepSeek' would be unusable for as long as 'DeepSeek Backup' exists.
  test('an exact name beats a longer substring match', () => {
    expect(resolveLiveTarget('DeepSeek', { configDir }).providerName).toBe('DeepSeek')
  })

  test('resolves an exact name and takes the provider main model', () => {
    const target = resolveLiveTarget('LM Studio', { configDir })
    expect(target.providerId).toBe('aaaaaaaa-0000-4000-8000-000000000001')
    expect(target.modelId).toBe('local-model')
  })

  test('resolves by id, and an explicit model wins over the configured one', () => {
    const target = resolveLiveTarget('aaaaaaaa-0000-4000-8000-000000000002', { configDir, modelId: 'override' })
    expect(target.providerName).toBe('DeepSeek')
    expect(target.modelId).toBe('override')
  })

  test('names the configured providers when nothing matches', () => {
    expect(() => resolveLiveTarget('nope', { configDir })).toThrow(/LM Studio/)
  })

  test('says where to configure one when there are none', () => {
    expect(() => resolveLiveTarget('anything', { configDir: configDirWith([]) })).toThrow(/No providers configured/)
  })
})

describe('confirmation banner', () => {
  const target = {
    providerId: 'id-1',
    providerName: 'LM Studio',
    modelId: 'local-model',
    host: 'x',
    source: '/tmp/providers.json',
  }

  test('states the cost, the target and how to proceed', () => {
    const banner = describeLiveTarget(target, 6)
    expect(banner).toContain('real money')
    expect(banner).toContain('LM Studio')
    expect(banner).toContain('local-model')
    expect(banner).toContain('--yes')
  })

  // A banner that leaks a key into a terminal or a CI log is worse than no banner.
  test('carries no credential material', () => {
    expect(describeLiveTarget(target, 6)).not.toMatch(/sk-|api[_-]?key|token|Bearer/i)
  })
})

describe('live scenario catalog', () => {
  test('every scenario has a runner and a reason it works on any model', () => {
    const source = readFileSync(join(import.meta.dir, 'live.ts'), 'utf8')
    for (const scenario of LIVE_AGENT_FLOW_SCENARIOS) {
      expect(source, `${scenario.id} has no runner`).toContain(`'${scenario.id}'(ctx)`)
      expect(scenario.modelAgnosticBecause.length, `${scenario.id} needs a real justification`).toBeGreaterThan(40)
    }
  })

  test('covers every flow it claims, and documents each gap', () => {
    const covered = new Set(LIVE_AGENT_FLOW_SCENARIOS.flatMap((scenario) => scenario.covers))
    expect([...LIVE_FLOW_COVERAGE].filter((item) => !covered.has(item))).toEqual([])
    // A flow dropped from the live lane must say why, so nobody assumes it is covered.
    for (const reason of Object.values(LIVE_FLOW_EXCLUSIONS)) {
      expect(reason.length).toBeGreaterThan(40)
    }
  })

  test('asserts on protocol and disk, never on generated text', () => {
    const source = readFileSync(join(import.meta.dir, 'live.ts'), 'utf8')
    // Guards the rule that keeps this provider-agnostic: the moment an assertion
    // compares model output, the lane only passes for whoever wrote it.
    const runnerBody = source.slice(source.indexOf('const runners'))
    expect(runnerBody).not.toMatch(/\.text\s*===\s*['"]/)
    expect(runnerBody).not.toMatch(/toContain\(['"](?!ALLOWED)/)
  })
})

describe('lane placement', () => {
  // The reason this file exists rather than a mode entry: a live lane in any CI mode
  // would mean CI needs credentials, which contradicts the brief that every
  // contributor can pass the required gate with no provider at all.
  test('is registered in no quality-gate mode', () => {
    const modes = readFileSync(join(import.meta.dir, '../modes.ts'), 'utf8')
    expect(modes).not.toContain('agent-flow-live')
    expect(modes).not.toContain('check:agent-flow:live')
  })

  test('is not referenced by any workflow', () => {
    for (const file of ['pr-quality.yml', 'nightly-quality.yml']) {
      const workflow = readFileSync(join(import.meta.dir, '../../../.github/workflows', file), 'utf8')
      expect(workflow, `${file} must not run the live lane`).not.toContain('agent-flow:live')
    }
  })
})
