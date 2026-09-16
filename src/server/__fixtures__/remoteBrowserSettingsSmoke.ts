import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { startServer, stopServerRuntimeForShutdown } from '../index.js'
import { H5AccessService } from '../services/h5AccessService.js'
import { ProviderService } from '../services/providerService.js'

const origin = 'https://fixture.ngrok-free.app'
const nativeFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.hostname !== '127.0.0.1') throw new Error('Public network forbidden in settings smoke')
  return nativeFetch(input, init)
}) as typeof fetch
await mkdir(process.env.CLAUDE_CONFIG_DIR!, { recursive: true })
const settingsPath = path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json')
await writeFile(settingsPath, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'fake-original-key' }, language: 'en', unknownFutureSetting: { keep: true } }))
const server = startServer(0, '127.0.0.1')
const local = `http://127.0.0.1:${server.port}`
const control = (route: string, body: unknown) => fetch(`${local}/api/public-access/${route}`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.CC_HAHA_LOCAL_ACCESS_TOKEN}` }, body: JSON.stringify(body) })
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
try {
  const enabled = await (await control('enable', { publicUrl: origin })).json()
  const remote = `http://127.0.0.1:${enabled.port}`
  const code = await (await control('pairing', {})).json()
  const pair = await (await fetch(`${remote}/api/public-access/pair`, { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ secret: code.secret, name: 'Settings fixture' }) })).json()
  await control('approve', { id: pair.id })
  const claimed = await fetch(`${remote}/api/public-access/claim`, { method: 'POST', headers: { Origin: origin }, body: JSON.stringify(pair) })
  const cookie = claimed.headers.get('set-cookie')!.split(';')[0]!
  const h5 = new H5AccessService()
  const { token } = await h5.enable()
  await h5.updateSettings({ allowedOrigins: [origin] })
  const providerService = new ProviderService()
  for (const transport of ['public', 'lan'] as const) {
    const base = transport === 'public' ? remote : local
    const headers = { Origin: origin, ...(transport === 'public' ? { Cookie: cookie } : { Authorization: `Bearer ${token}` }) }
    const request = (route: string, method = 'GET', body?: unknown) => fetch(base + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const protectedResponse = await fetch(base + '/api/providers', { headers: { Origin: origin } })
    check(protectedResponse.status === 401, `${transport}: unauthenticated provider list allowed`)
    const input = { presetId: 'custom', name: `Fixture ${transport}`, apiKey: `fake-${transport}-secret`, baseUrl: 'https://example.invalid', apiFormat: 'anthropic', models: { main: 'fixture-model', haiku: 'fixture-model', sonnet: 'fixture-model', opus: 'fixture-model' }, imageGeneration: { model: 'fixture-image', apiKey: `fake-${transport}-image-secret` }, requestCompatibility: { maxOutputTokens: 2048, privateFutureKey: 'fake-hidden-compatibility-key' } }
    const created = await request('/api/providers', 'POST', input)
    const createdBody = await created.json()
    check(created.status === 201 && createdBody.provider.hasApiKey && createdBody.provider.apiKey === '', `${transport}: provider creation/redaction failed`)
    const id = createdBody.provider.id
    // Seed desktop-owned extensions as an existing store fixture, not via the remote API.
    const providersPath = path.join(process.env.CLAUDE_CONFIG_DIR!, 'cc-haha', 'providers.json')
    const stored = JSON.parse(await readFile(providersPath, 'utf8'))
    const oldProvider = stored.providers.find((provider: { id: string }) => provider.id === id)
    check(!oldProvider.requestCompatibility.privateFutureKey, 'Remote creation injected a hidden compatibility field')
    oldProvider.requestCompatibility.privateFutureKey = 'fake-hidden-compatibility-key'
    oldProvider.futureCredential = 'fake-top-level-credential'
    await writeFile(providersPath, JSON.stringify(stored))
    check(createdBody.provider.imageGeneration.apiKey === '' && createdBody.provider.imageGeneration.hasApiKey, 'Image key leaked')
    for (const route of ['/api/providers', `/api/providers/${id}`]) {
      const text = await (await request(route)).text()
      check(!text.includes(input.apiKey) && !text.includes(input.imageGeneration.apiKey) && !text.includes('fake-hidden-compatibility-key') && !text.includes('fake-top-level-credential'), `${transport}: saved credentials leaked`)
    }
    const changed = await request(`/api/providers/${id}`, 'PUT', { name: 'Edited phone provider', apiKey: '', requestCompatibility: { maxOutputTokens: 4096 }, imageGeneration: { model: 'new-image-model', apiKey: '' } })
    check(changed.ok, `${transport}: provider edit failed`)
    const retained = await providerService.getProvider(id)
    check(retained.requestCompatibility?.privateFutureKey === 'fake-hidden-compatibility-key', 'Unknown compatibility field lost during edit')
    check((retained as unknown as Record<string, unknown>).futureCredential === 'fake-top-level-credential', 'Unknown provider field lost during edit')
    check(retained.apiKey === input.apiKey && retained.imageGeneration?.apiKey === input.imageGeneration.apiKey, `${transport}: omitted credentials not preserved`)
    check((await request(`/api/providers/${id}`, 'PUT', { imageGeneration: { model: 'omitted-key-model' } })).ok, 'Omitted image key edit failed')
    check((await providerService.getProvider(id)).imageGeneration?.apiKey === input.imageGeneration.apiKey, 'Omitted image key was lost')
    check((await request(`/api/providers/${id}`, 'PUT', { apiKey: 'fake-replacement-key' })).ok, 'Replacement failed')
    check((await providerService.getProvider(id)).apiKey === 'fake-replacement-key', 'Replacement not persisted')
    check((await request(`/api/providers/${id}/activate`, 'POST', {})).ok, 'Activation failed')
    check((await providerService.listProviders()).activeId === id, 'Activation missing')
    check((await request('/api/settings/user', 'PUT', { language: 'zh-CN', chatSendBehavior: 'modifierEnter', alwaysThinkingEnabled: false, workflowKeywordTriggerEnabled: true })).ok, 'General edit failed')
    const general = await (await request('/api/settings/user')).json()
    check(general.language === 'zh-CN' && general.alwaysThinkingEnabled === false && !('env' in general), 'General projection failed')
    check((await request('/api/settings/user', 'PUT', { language: '' })).ok, 'Reset response language failed')
    const resetGeneral = await (await request('/api/settings/user')).json()
    check(resetGeneral.language === '' && resetGeneral.chatSendBehavior === 'modifierEnter' && resetGeneral.alwaysThinkingEnabled === false && resetGeneral.workflowKeywordTriggerEnabled === true, 'Language reset changed unrelated settings')
    check((await request('/api/settings/user', 'PUT', { env: { API_KEY: 'must-not-save' } })).status === 400, 'Remote env mutation accepted')
    for (const route of ['/api/providers/settings', '/api/providers/cc-switch/scan', '/api/settings/project', '/api/settings/cli-launcher']) check((await request(route)).status === 403, `${transport}: admin route accessible ${route}`)
    const original = JSON.parse(await readFile(settingsPath, 'utf8'))
    check(original.env.ANTHROPIC_API_KEY === 'fake-original-key' && original.unknownFutureSetting.keep, 'Settings edit lost unknown or protected data')
    check((await fetch(base + `/api/providers/${id}`, { method: 'DELETE', headers: { ...headers, Origin: 'https://attacker.invalid' } })).status === 403, 'Cross-origin mutation accepted')
    check((await request('/api/providers/official', 'POST', {})).ok, 'Official activation failed')
    const deleted = await request(`/api/providers/${id}`, 'DELETE')
    check(deleted.ok, `Delete failed: ${deleted.status} ${await deleted.text()}`)
    check(!(await providerService.listProviders()).providers.some(p => p.id === id), 'Provider survived delete')
  }
  console.log('REMOTE_SETTINGS_INTEGRATION_PASSED')
} finally {
  await stopServerRuntimeForShutdown()
  await server.stop(true)
}
process.exit(0)
