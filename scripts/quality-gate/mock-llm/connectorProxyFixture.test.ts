import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALL_CONNECTORS, getConnectorDefinition } from '../../../src/services/connectors/catalog'
import { getRemoteRecipe, REMOTE_RECIPES } from '../../../src/services/connectors/remoteCatalog'
import { createConnectorsApi } from '../../../src/server/api/connectors'
import { ConnectorService } from '../../../src/server/services/connectorService'
import { CONNECTOR_PROXY_FIXTURE_ENDPOINT, configureConnectorProxyFixture, connectorActionFailure } from './connectorProxyFixture'

test('Linux fixture permits the real connector API action while unrelated catalog definitions stay unsupported and unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'connector-fixture-'))
  const definition = getConnectorDefinition('huggingface')!
  const recipe = getRemoteRecipe('huggingface')!
  const originalPlatforms = definition.platforms
  const originalEndpoint = recipe.endpoint
  const definitionsBefore = structuredClone(ALL_CONNECTORS)
  const recipesBefore = structuredClone(REMOTE_RECIPES)
  let preparations = 0
  const service = new ConnectorService({
    root, definitions: ALL_CONNECTORS, platform: 'linux-x64',
    createAdapter: () => ({
      prepare: async () => { preparations++; return { directory: root, command: '', args: [], env: {} } },
      authenticate: async () => {}, check: async () => ({ authenticated: false, verification: 'remote' }),
      deactivate: async () => {}, remove: async () => {},
    }),
    bridge: {
      installConnectorPlugin: async () => {}, setConnectorPluginEnabled: async () => {}, removeConnectorPlugin: async () => {},
      isConnectorPluginReady: async () => true, reloadConnectorSessions: async () => {},
    },
  })
  const api = createConnectorsApi(async () => service)
  const prepare = (id: string) => {
    const url = new URL(`http://127.0.0.1/api/connectors/${id}/prepare`)
    return api(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'fixture-session' }) }), url, ['api', 'connectors', id, 'prepare'])
  }
  async function settle() {
    for (let i = 0; i < 100 && service.get('huggingface').operation; i++) await Bun.sleep(1)
    expect(service.get('huggingface').operation).toBeUndefined()
  }
  try {
    const before = await prepare('huggingface')
    expect(before.status).toBe(400)
    expect(await before.json()).toEqual({ error: 'BAD_REQUEST', message: 'Connector is not supported on this platform' })
    expect(service.get('huggingface').supported).toBe(false)
    expect(preparations).toBe(0)

    configureConnectorProxyFixture(CONNECTOR_PROXY_FIXTURE_ENDPOINT, 'linux-x64')
    const accepted = await prepare('huggingface')
    expect(accepted.status).toBe(202)
    expect((await accepted.json()).connector.supported).toBe(true)
    await settle()
    expect(service.get('huggingface')).toMatchObject({ supported: true, installed: true, status: 'needs-auth', enabled: false })
    expect(preparations).toBe(1)
    const unrelated = await prepare('github')
    expect(unrelated.status).toBe(400)
    expect(await unrelated.json()).toEqual({ error: 'BAD_REQUEST', message: 'Connector is not supported on this platform' })
    expect(preparations).toBe(1)
    expect(ALL_CONNECTORS.filter(item => item.id !== 'huggingface')).toEqual(definitionsBefore.filter(item => item.id !== 'huggingface'))
    expect(REMOTE_RECIPES.filter(item => item.id !== 'huggingface')).toEqual(recipesBefore.filter(item => item.id !== 'huggingface'))
    expect(definition).toEqual({ ...definitionsBefore.find(item => item.id === 'huggingface'), platforms: [...originalPlatforms, 'linux-x64'] })
    expect(recipe).toEqual({ ...recipesBefore.find(item => item.id === 'huggingface'), endpoint: CONNECTOR_PROXY_FIXTURE_ENDPOINT })
    configureConnectorProxyFixture(CONNECTOR_PROXY_FIXTURE_ENDPOINT, 'linux-x64')
    expect(definition.platforms.filter(item => item === 'linux-x64')).toHaveLength(1)
  } finally {
    try { await settle() }
    finally { definition.platforms = originalPlatforms; recipe.endpoint = originalEndpoint; rmSync(root, { recursive: true, force: true }) }
  }
  expect(ALL_CONNECTORS).toEqual(definitionsBefore)
  expect(REMOTE_RECIPES).toEqual(recipesBefore)
})

test('fixture rejects other endpoints before changing catalog data', () => {
  const definitions = structuredClone(ALL_CONNECTORS)
  const recipes = structuredClone(REMOTE_RECIPES)
  expect(() => configureConnectorProxyFixture('https://huggingface.co/mcp', 'linux-x64')).toThrow('reserved HTTPS endpoint')
  expect(ALL_CONNECTORS).toEqual(definitions)
  expect(REMOTE_RECIPES).toEqual(recipes)
})

test('action diagnostics retain fixed API information without response secrets or request material', () => {
  expect(connectorActionFailure('prepare', 400, { error: 'BAD_REQUEST', message: 'Connector is not supported on this platform' })).toEqual({
    kind: 'prepare', status: 400, error: 'BAD_REQUEST', message: 'Connector is not supported on this platform',
  })
  const secret = 'fake-connector-private-key'
  const failure = connectorActionFailure(secret, 500, { error: secret, message: `Bearer ${secret}`, body: secret, url: `https://fixture.invalid/?key=${secret}`, headers: { authorization: secret } })
  expect(failure).toEqual({ kind: 'unknown', status: 500, error: 'UNKNOWN', message: 'Unexpected connector API response' })
  expect(JSON.stringify(failure)).not.toContain(secret)
  expect(connectorActionFailure('authenticate', 502, null)).toEqual({ kind: 'authenticate', status: 502, error: 'UNKNOWN', message: 'Unexpected connector API response' })
})
