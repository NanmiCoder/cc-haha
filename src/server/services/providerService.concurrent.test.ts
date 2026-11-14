import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { ProviderService } from './providerService.js'
import { diagnosticsService } from './diagnosticsService.js'
import * as magpie from './magpieGateway.js'
import { OPENAI_OFFICIAL_PROVIDER_ID } from '../types/provider.js'
import type { CreateProviderInput } from '../types/provider.js'

const originalEnv = { ...process.env }
let sandbox: string

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'provider-concurrent-'))
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, createSandboxedTestEnvironment(sandbox, {}, originalEnv))
  await new ProviderService().listProviders()
})

afterEach(async () => {
  await diagnosticsService.drainForMigration()
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  await rm(sandbox, { recursive: true, force: true })
})

function input(name: string): CreateProviderInput {
  return {
    presetId: 'custom', name, apiKey: 'fake-key', baseUrl: 'https://fixture.invalid',
    models: { main: 'fixture-main', haiku: 'fixture-small', sonnet: 'fixture-medium', opus: 'fixture-large' },
  }
}

async function allSucceeded(work: Promise<unknown>[]) {
  // Drain every caller even when the regression causes a write to reject.
  const results = await Promise.allSettled(work)
  expect(results.map(result => result.status)).toEqual(work.map(() => 'fulfilled'))
}

test('concurrent creates and a bulk import across instances keep every provider', async () => {
  await allSucceeded([
    ...Array.from({ length: 6 }, (_, i) => new ProviderService().addProvider(input(`created-${i}`))),
    new ProviderService().importProviders([input('imported-a'), input('imported-b')]),
  ])
  const { providers, providerOrder } = await new ProviderService().listProviders()
  expect(providers.map(provider => provider.name).sort()).toEqual([
    'created-0', 'created-1', 'created-2', 'created-3', 'created-4', 'created-5', 'imported-a', 'imported-b',
  ])
  for (const provider of providers) expect(providerOrder).toContain(provider.id)
})

test('concurrent edits merge different fields and keep the active runtime settings current', async () => {
  const service = new ProviderService()
  const provider = await service.addProvider(input('original'))
  await service.activateProvider(provider.id)
  await allSucceeded([
    service.updateProvider(provider.id, { name: 'renamed' }),
    new ProviderService().updateProvider(provider.id, { apiKey: 'fake-new-key' }),
    new ProviderService().updateProvider(provider.id, { notes: 'keep this note' }),
  ])
  expect(await service.getProvider(provider.id)).toMatchObject({
    name: 'renamed', apiKey: 'fake-new-key', notes: 'keep this note',
  })
  expect(await service.getManagedSettings()).toMatchObject({
    providerEnvOwner: provider.id,
    env: { ANTHROPIC_AUTH_TOKEN: 'fake-new-key' },
  })
})

test('a deletion queued after activation cannot delete or resurrect the active provider', async () => {
  const service = new ProviderService()
  const provider = await service.addProvider(input('active'))
  const results = await Promise.allSettled([
    service.activateProvider(provider.id),
    new ProviderService().deleteProvider(provider.id),
  ])
  expect(results[0].status).toBe('fulfilled')
  expect(results[1].status).toBe('rejected')
  expect(await service.listProviders()).toMatchObject({ activeId: provider.id, providers: [provider] })
  expect(await service.getManagedSettings()).toMatchObject({ providerEnvOwner: provider.id })
})

test('reordering alongside editing does not restore stale provider fields', async () => {
  const service = new ProviderService()
  const first = await service.addProvider(input('first'))
  const second = await service.addProvider(input('second'))
  await allSucceeded([
    service.reorderProviders([second.id, first.id]),
    new ProviderService().updateProvider(first.id, { name: 'updated-first' }),
  ])
  const { providers } = await service.listProviders()
  expect(providers.map(provider => provider.id)).toEqual([second.id, first.id])
  expect(providers[1].name).toBe('updated-first')
})

test('official model changes and switching to Official preserve concurrent imports', async () => {
  const service = new ProviderService()
  const provider = await service.addProvider(input('previous-active'))
  await service.activateProvider(provider.id)
  const models = { ...input('unused').models, main: 'fixture-official-main' }
  await allSucceeded([
    service.updateOfficialProviderModels(OPENAI_OFFICIAL_PROVIDER_ID, models),
    new ProviderService().activateOfficial(),
    new ProviderService().importProviders([input('imported')]),
  ])
  expect(await service.getOfficialProviderModels(OPENAI_OFFICIAL_PROVIDER_ID)).toEqual(models)
  expect(await service.listProviders()).toMatchObject({ activeId: null })
  expect((await service.listProviders()).providers.map(entry => entry.name)).toEqual(['previous-active', 'imported'])
  expect(await service.getManagedSettings()).not.toHaveProperty('providerEnvOwner')
})

test('Magpie catalog synchronization preserves a concurrent provider edit', async () => {
  const service = new ProviderService()
  const provider = await service.addProvider({ ...input('gateway'), presetId: 'magpie' })
  const probe = spyOn(magpie, 'probeMagpie').mockResolvedValue({ installed: true, running: true, baseUrl: 'http://127.0.0.1:4321' })
  const catalog = spyOn(magpie, 'fetchMagpieModels').mockResolvedValue([])
  try {
    await allSucceeded([
      service.getMagpieState(),
      new ProviderService().updateProvider(provider.id, { notes: 'keep this note' }),
    ])
    expect(await service.getProvider(provider.id)).toMatchObject({ baseUrl: 'http://127.0.0.1:4321', notes: 'keep this note' })
  } finally {
    probe.mockRestore()
    catalog.mockRestore()
  }
})

test('a rejected mutation does not block later callers', async () => {
  const service = new ProviderService()
  const results = await Promise.allSettled([
    service.updateProvider('missing-provider', { name: 'invalid' }),
    new ProviderService().addProvider(input('survives')),
  ])
  expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled'])
  expect((await service.listProviders()).providers.map(provider => provider.name)).toEqual(['survives'])
})
