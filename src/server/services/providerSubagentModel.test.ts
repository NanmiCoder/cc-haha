import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as fs from 'node:fs/promises'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { handleProvidersApi } from '../api/providers.js'
import { ConversationService } from './conversationService.js'
import { diagnosticsService } from './diagnosticsService.js'
import { ProviderService } from './providerService.js'
import { ensurePersistentStorageUpgraded, resetPersistentStorageMigrationsForTests } from './persistentStorageMigrations.js'

const originalEnv = { ...process.env }
let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'provider-subagent-model-'))
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, createSandboxedTestEnvironment(home, {}, originalEnv))
})

afterEach(async () => {
  await diagnosticsService.drainForMigration()
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  await rm(home, { recursive: true, force: true })
})

async function api(method: string, route: string, body: unknown) {
  const url = new URL(`http://localhost/api/providers/${route}`)
  return handleProvidersApi(new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), url, url.pathname.split('/').filter(Boolean))
}

async function fixture(presetId = 'custom') {
  const providers = new ProviderService()
  const provider = await providers.addProvider({
    presetId, name: 'Subagent fixture', baseUrl: 'https://fixture.invalid',
    apiKey: 'fake-test-key', apiFormat: 'anthropic',
    models: { main: 'fixture-main', haiku: 'fixture-small', sonnet: 'fixture-medium', opus: 'fixture-large' },
  })
  await providers.activateProvider(provider.id)
  return { providers, provider }
}

async function saveEditor(providers: ProviderService, providerId: string, value: string) {
  const settings = await providers.getManagedSettings()
  const response = await api('PUT', `settings?expectedActiveProviderId=${providerId}`, {
    ...settings,
    futureSetting: { keep: true },
    env: { ...(settings.env as Record<string, string>), CLAUDE_CODE_SUBAGENT_MODEL: value },
  })
  expect(response.status).toBe(200)
  // The real form saves its JSON first, then the provider fields.
  expect((await api('PUT', providerId, { name: 'Renamed fixture' })).status).toBe(200)
}

async function childEnv(providerId: string | null) {
  const service = new ConversationService() as unknown as {
    buildChildEnv(workDir: string, sdkUrl: undefined, options: { providerId: string | null }): Promise<Record<string, string>>
    buildOfficialOAuthEnv(): Promise<Record<string, string>>
  }
  // Exercise the actual Official launch flags without reading system credentials.
  if (providerId === null) spyOn(service, 'buildOfficialOAuthEnv').mockResolvedValue({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' })
  return service.buildChildEnv(home, undefined, { providerId })
}

async function selectInFreshCli(env: Record<string, string>, hostManaged?: boolean) {
  const managedEnvUrl = pathToFileURL(join(import.meta.dir, '../../utils/managedEnv.ts')).href
  const agentUrl = pathToFileURL(join(import.meta.dir, '../../utils/model/agent.ts')).href
  const teammateUrl = pathToFileURL(join(import.meta.dir, '../../utils/swarm/resolveTeammateModel.ts')).href
  const proc = Bun.spawn([process.execPath, '--no-env-file', '--preload', join(import.meta.dir, '../../../preload.ts'), '-e', `
    const { applySafeConfigEnvironmentVariables, applyConfigEnvironmentVariables } = await import(${JSON.stringify(managedEnvUrl)})
    const { getAgentModel } = await import(${JSON.stringify(agentUrl)})
    const { resolveTeammateModel } = await import(${JSON.stringify(teammateUrl)})
    applySafeConfigEnvironmentVariables()
    applyConfigEnvironmentVariables()
    console.log(JSON.stringify({
      model: getAgentModel('inherit', 'fixture-main'),
      teammate: resolveTeammateModel('fixture-team', 'fixture-main'),
      baseUrl: process.env.ANTHROPIC_BASE_URL,
    }))
  `], {
    env: { ...env, ...(hostManaged === undefined ? {} : { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: hostManaged ? '1' : '0' }) },
    stdout: 'pipe', stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ])
  expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 })
  return JSON.parse(stdout.trim().split('\n').at(-1)!) as { model: string; teammate: string; baseUrl: string }
}

test.each(['fixture-subagent', '  fixture-subagent  ', 'inherit', '  InHeRiT  ', ''])('provider JSON save retains %j through sync and new CLI selection', async (value) => {
  const { providers, provider } = await fixture()
  await saveEditor(providers, provider.id, value)
  const reloaded = new ProviderService()
  expect(await reloaded.getManagedSettings()).toMatchObject({
    futureSetting: { keep: true }, env: { CLAUDE_CODE_SUBAGENT_MODEL: value },
  })
  await reloaded.activateProvider(provider.id)
  const runtime = await selectInFreshCli(await childEnv(provider.id))
  const explicit = value.trim() && value.trim().toLowerCase() !== 'inherit'
  expect(runtime.model).toBe(explicit ? 'fixture-subagent' : 'fixture-main')
  expect(runtime.teammate).toBe(explicit ? 'fixture-subagent' : 'fixture-team')
  expect(runtime.baseUrl).toBe(provider.baseUrl)
})

test('a manually edited managed env reaches a host-managed new session', async () => {
  const { providers, provider } = await fixture()
  const file = join(process.env.CLAUDE_CONFIG_DIR!, 'cc-haha', 'settings.json')
  const settings = await providers.getManagedSettings()
  settings.env = { ...(settings.env as Record<string, string>), CLAUDE_CODE_SUBAGENT_MODEL: 'fixture-subagent' }
  await writeFile(file, JSON.stringify(settings))
  expect((await selectInFreshCli(await childEnv(provider.id))).model).toBe('fixture-subagent')
  // Standalone CLI rebuilds provider defaults while loading the same file.
  expect((await selectInFreshCli(createSandboxedTestEnvironment(home), false)).model).toBe('fixture-subagent')
  expect(JSON.parse(await readFile(file, 'utf8')).env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('fixture-subagent')
})

test('active-provider subagent settings cannot redirect another provider or Claude Official', async () => {
  const { providers, provider } = await fixture()
  await saveEditor(providers, provider.id, 'fixture-subagent')
  const other = await providers.addProvider({
    presetId: 'custom', name: 'Other', baseUrl: 'https://other.invalid', apiKey: 'fake-other',
    models: { main: 'other-main', haiku: 'other-small', sonnet: 'other-medium', opus: 'other-large' },
  })
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'stale-provider-subagent'
  expect((await selectInFreshCli(await childEnv(other.id))).model).toBe('fixture-main')
  expect((await childEnv(null)).CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined()
  expect((await selectInFreshCli(await childEnv(null))).model).toBe('fixture-main')
  await providers.activateProvider(other.id)
  expect((await providers.getManagedSettings()).env).not.toHaveProperty('CLAUDE_CODE_SUBAGENT_MODEL')
})

test('new session runtime cannot borrow the previous provider override during activation', async () => {
  const { providers, provider } = await fixture()
  await saveEditor(providers, provider.id, 'fixture-subagent')
  const other = await providers.addProvider({
    presetId: 'custom', name: 'Other', baseUrl: 'https://other.invalid', apiKey: 'fake-other',
    models: { main: 'other-main', haiku: 'other-small', sonnet: 'other-medium', opus: 'other-large' },
  })
  const internals = providers as unknown as { syncToSettings(...args: unknown[]): Promise<void> }
  const sync = internals.syncToSettings.bind(providers)
  let entered!: () => void
  let release!: () => void
  const paused = new Promise<void>(resolve => { entered = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  spyOn(internals, 'syncToSettings').mockImplementation(async (...args) => {
    entered()
    await barrier
    await sync(...args)
  })
  const activating = providers.activateProvider(other.id)
  await paused
  const runtime = new ProviderService().getProviderRuntimeEnv(other.id)
  try {
    // Let an unprotected read finish inside the paused activation window.
    await Promise.race([runtime, Bun.sleep(250)])
  } finally {
    release()
    await activating
  }
  expect(await runtime).not.toHaveProperty('CLAUDE_CODE_SUBAGENT_MODEL')
})

test('Official OAuth keeps the original user subagent preference', async () => {
  const { providers, provider } = await fixture()
  await saveEditor(providers, provider.id, 'fixture-subagent')
  await writeFile(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({
    env: { CLAUDE_CODE_SUBAGENT_MODEL: 'official-user-subagent' },
  }))
  expect((await selectInFreshCli(await childEnv(null))).model).toBe('official-user-subagent')
})

test('legacy provider settings upgrade ownership with a backup and preserve the original user file', async () => {
  const configDir = process.env.CLAUDE_CONFIG_DIR!
  const managedDir = join(configDir, 'cc-haha')
  await mkdir(managedDir, { recursive: true })
  const index = {
    schemaVersion: 9, activeId: 'legacy-provider', futureIndex: { keep: true },
    providers: [{ id: 'legacy-provider', presetId: 'custom', name: 'Legacy fixture', baseUrl: 'https://legacy.invalid', apiKey: 'fake-legacy',
      models: { main: 'fixture-main', haiku: 'fixture-small', sonnet: 'fixture-medium', opus: 'fixture-large' } }],
  }
  const legacy = { futureSetting: { keep: true }, env: { CLAUDE_CODE_SUBAGENT_MODEL: 'fixture-subagent', USER_ENV: 'keep' } }
  const originalUser = JSON.stringify({ futureUserSetting: { keep: true } })
  await writeFile(join(configDir, 'settings.json'), originalUser)
  await writeFile(join(managedDir, 'providers.json'), JSON.stringify(index))
  await writeFile(join(managedDir, 'settings.json'), JSON.stringify(legacy))
  // Standalone CLI supports the old snapshot before the async server migration.
  expect((await selectInFreshCli(createSandboxedTestEnvironment(home), false)).model).toBe('fixture-subagent')
  expect(await new ProviderService().getManagedSettings()).toMatchObject({ ...legacy, providerEnvOwner: 'legacy-provider' })
  const files = await readdir(managedDir)
  const backup = files.find(name => name.startsWith('settings.json.bak-before-migration-'))
  expect(backup).toBeDefined()
  expect(JSON.parse(await readFile(join(managedDir, backup!), 'utf8'))).toEqual(legacy)
  expect(JSON.parse(await readFile(join(managedDir, 'providers.json'), 'utf8'))).toMatchObject({ schemaVersion: 10, futureIndex: { keep: true } })
  resetPersistentStorageMigrationsForTests()
  expect((await ensurePersistentStorageUpgraded()).migratedEntries).toEqual([])
  expect(await readFile(join(configDir, 'settings.json'), 'utf8')).toBe(originalUser)
  expect((await selectInFreshCli(createSandboxedTestEnvironment(home), false)).model).toBe('fixture-subagent')
})

test.each(['paused', 'failed'])('standalone CLI does not borrow a subagent model after %s provider sync', async (state) => {
  const { providers, provider } = await fixture()
  await saveEditor(providers, provider.id, 'fixture-subagent')
  const other = await providers.addProvider({
    presetId: 'custom', name: 'Other', baseUrl: 'https://other.invalid', apiKey: 'fake-other',
    models: { main: 'other-main', haiku: 'other-small', sonnet: 'other-medium', opus: 'other-large' },
  })
  const internals = providers as unknown as { syncToSettings(...args: unknown[]): Promise<void> }
  const sync = internals.syncToSettings.bind(providers)
  let entered!: () => void
  let release!: () => void
  const paused = new Promise<void>(resolve => { entered = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  const intercept = spyOn(internals, 'syncToSettings').mockImplementation(async (...args) => {
    entered()
    if (state === 'failed') throw new Error('fixture settings sync failed')
    await barrier
    await sync(...args)
  })
  const activation = providers.activateProvider(other.id).catch(error => error)
  await paused
  try {
    if (state === 'failed') await activation
    expect((await selectInFreshCli(createSandboxedTestEnvironment(home), false)).model).toBe('fixture-main')
  } finally {
    release()
    await activation
    intercept.mockRestore()
  }
  if (state === 'failed') {
    expect((await providers.getProviderRuntimeEnv(other.id)).CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined()
    await providers.activateProvider(other.id)
    expect((await selectInFreshCli(createSandboxedTestEnvironment(home), false)).model).toBe('fixture-main')
  }
})

test('a failed Official switch cannot reload the previous provider subagent model', async () => {
  const { providers, provider } = await fixture()
  await saveEditor(providers, provider.id, 'fixture-subagent')
  const internals = providers as unknown as { clearProviderFromSettings(): Promise<void> }
  const intercept = spyOn(internals, 'clearProviderFromSettings').mockRejectedValue(new Error('fixture clear failed'))
  try {
    await expect(providers.activateOfficial()).rejects.toThrow('fixture clear failed')
    expect((await selectInFreshCli(createSandboxedTestEnvironment(home), false)).model).toBe('fixture-main')
  } finally {
    intercept.mockRestore()
  }
})

test.each(['missing key', 'missing file', 'malformed file', 'null file', 'array file', 'scalar file'])('a legacy %s can be manually configured after upgrading without reactivation', async (state) => {
  const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'cc-haha')
  await mkdir(dir, { recursive: true })
  const provider = { id: 'legacy', presetId: 'custom', name: 'Legacy', apiKey: 'fake', baseUrl: 'https://fixture.invalid',
    models: { main: 'fixture-main', haiku: 'small', sonnet: 'medium', opus: 'large' } }
  await writeFile(join(dir, 'providers.json'), JSON.stringify({ schemaVersion: 9, activeId: 'legacy', providers: [provider] }))
  const file = join(dir, 'settings.json')
  if (state === 'missing key') await writeFile(file, JSON.stringify({ env: { USER_ENV: 'keep' } }))
  if (state === 'malformed file') await writeFile(file, '{"env":')
  if (state === 'null file') await writeFile(file, 'null')
  if (state === 'array file') await writeFile(file, '[]')
  if (state === 'scalar file') await writeFile(file, '1')
  await ensurePersistentStorageUpgraded()
  const settings = await new ProviderService().getManagedSettings()
  await writeFile(file, JSON.stringify({ ...settings, env: { ...(settings.env as Record<string, string>), CLAUDE_CODE_SUBAGENT_MODEL: 'fixture-subagent' } }))
  expect((await selectInFreshCli(await childEnv('legacy'))).model).toBe('fixture-subagent')
  expect((await selectInFreshCli(createSandboxedTestEnvironment(home), false)).model).toBe('fixture-subagent')
})

test('a successful save for the newly active provider survives the pending activation sync', async () => {
  const { providers } = await fixture()
  const other = await providers.addProvider({
    presetId: 'custom', name: 'Other', baseUrl: 'https://other.invalid', apiKey: 'fake-other',
    models: { main: 'other-main', haiku: 'small', sonnet: 'medium', opus: 'large' },
  })
  const internals = providers as unknown as { syncToSettings(...args: unknown[]): Promise<void> }
  const sync = internals.syncToSettings.bind(providers)
  let entered!: () => void
  let release!: () => void
  const paused = new Promise<void>(resolve => { entered = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  const intercept = spyOn(internals, 'syncToSettings').mockImplementation(async (...args) => { entered(); await barrier; await sync(...args) })
  const activation = providers.activateProvider(other.id)
  await paused
  try {
    await saveEditor(new ProviderService(), other.id, 'other-subagent')
  } finally {
    release()
    await activation
    intercept.mockRestore()
  }
  expect((await selectInFreshCli(await childEnv(other.id))).model).toBe('other-subagent')
})

test.each(['provider sync', 'Official clear'])('a late %s cannot erase the newly active provider saved override', async (phase) => {
  const { providers, provider } = await fixture()
  const other = await providers.addProvider({
    presetId: 'custom', name: 'Other', baseUrl: 'https://other.invalid', apiKey: 'fake-other',
    models: { main: 'other-main', haiku: 'small', sonnet: 'medium', opus: 'large' },
  })
  const internals = providers as unknown as {
    syncToSettings(...args: unknown[]): Promise<void>
    clearProviderFromSettings(...args: unknown[]): Promise<void>
  }
  const method = phase === 'provider sync' ? 'syncToSettings' : 'clearProviderFromSettings'
  const original = internals[method].bind(providers)
  let entered!: () => void
  let release!: () => void
  const paused = new Promise<void>(resolve => { entered = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  const intercept = spyOn(internals, method).mockImplementation(async (...args) => { entered(); await barrier; await original(...args) })
  const activation = phase === 'provider sync' ? providers.activateProvider(provider.id) : providers.activateOfficial()
  await paused
  try {
    const otherClient = new ProviderService()
    await otherClient.activateProvider(other.id)
    await saveEditor(otherClient, other.id, 'other-subagent')
  } finally {
    release()
    await activation
    intercept.mockRestore()
  }
  expect((await selectInFreshCli(await childEnv(other.id))).model).toBe('other-subagent')
})

test.each(['settings write', 'provider read'])('a failed ownership migration at %s keeps legacy data usable and retries before provider mutation', async (phase) => {
  const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'cc-haha')
  await mkdir(dir, { recursive: true })
  const provider = { id: 'legacy', presetId: 'custom', name: 'Legacy', apiKey: 'fake', baseUrl: 'https://fixture.invalid',
    models: { main: 'fixture-main', haiku: 'small', sonnet: 'medium', opus: 'large' } }
  const settingsPath = join(dir, 'settings.json')
  const indexPath = join(dir, 'providers.json')
  await writeFile(indexPath, JSON.stringify({ schemaVersion: 9, activeId: 'legacy', providers: [provider] }))
  await writeFile(settingsPath, JSON.stringify({ futureSetting: true, env: { CLAUDE_CODE_SUBAGENT_MODEL: 'fixture-subagent' } }))
  const rename = fs.rename
  const read = fs.readFile
  let failing = true
  let readFailures = 1
  const intercept = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (failing && phase === 'settings write' && String(to) === settingsPath) throw Object.assign(new Error('fixture ownership rename failed'), { code: 'EBUSY' })
    await rename(from, to)
  })
  const readIntercept = spyOn(fs, 'readFile').mockImplementation((async (file, options) => {
    if (failing && phase === 'provider read' && String(file) === indexPath && readFailures-- > 0) throw Object.assign(new Error('fixture ownership read failed'), { code: 'EBUSY' })
    return read(file, options)
  }) as typeof fs.readFile)
  try {
    expect((await ensurePersistentStorageUpgraded()).failures).not.toEqual([])
    expect(JSON.parse(await read(indexPath, 'utf8')).schemaVersion).toBe(9)
    expect((await selectInFreshCli(createSandboxedTestEnvironment(home), false)).model).toBe('fixture-subagent')
    const providers = new ProviderService()
    if (phase === 'settings write') await expect(providers.activateProvider('legacy')).rejects.toThrow('Provider settings upgrade')
    expect(JSON.parse(await readFile(settingsPath, 'utf8')).env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('fixture-subagent')
    failing = false
    expect((await providers.getProviderRuntimeEnv('legacy')).CLAUDE_CODE_SUBAGENT_MODEL).toBe('fixture-subagent')
    await providers.activateProvider('legacy')
    expect(await providers.getManagedSettings()).toMatchObject({ futureSetting: true, providerEnvOwner: 'legacy', env: { CLAUDE_CODE_SUBAGENT_MODEL: 'fixture-subagent' } })
  } finally {
    intercept.mockRestore()
    readIntercept.mockRestore()
  }
})

test('an explicit subagent choice overrides a preset default only for its active provider', async () => {
  const { providers, provider } = await fixture('xuanshuapi')
  expect((await providers.getProviderRuntimeEnv(provider.id)).CLAUDE_CODE_SUBAGENT_MODEL).toBe('claude-sonnet-5')
  await saveEditor(providers, provider.id, 'fixture-subagent')
  expect((await selectInFreshCli(await childEnv(provider.id))).model).toBe('fixture-subagent')
  expect((await selectInFreshCli(createSandboxedTestEnvironment(home), false)).model).toBe('fixture-subagent')
  await providers.activateOfficial()
  expect((await providers.getManagedSettings()).env).not.toHaveProperty('CLAUDE_CODE_SUBAGENT_MODEL')
})
