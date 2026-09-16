import { expect, test } from 'bun:test'
import { createConnectorsApi } from './connectors.js'
import { ConnectorServiceError } from '../services/connectorService.js'
import type { ConnectorDto } from '../../services/connectors/types.js'

const connector = { id: 'feishu', installed: false } as ConnectorDto
let mutations = 0
const handler = createConnectorsApi(async () => ({ list: () => [connector], get: id => {
  if (id !== 'feishu') throw ConnectorServiceError.notFound('Unknown connector')
  return connector
}, action: () => { mutations++; return connector } }))
async function request(path: string, method = 'GET', body?: unknown) {
  const url = new URL(`http://localhost/api/connectors${path}`)
  return handler(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, url.pathname.split('/').filter(Boolean))
}
test('GET exposes catalog without running actions', async () => {
  const before = mutations
  expect(await (await request('')).json()).toEqual({ items: [connector] })
  expect(await (await request('/feishu')).json()).toEqual({ connector })
  expect((await request('/unknown')).status).toBe(404)
  expect(mutations).toBe(before)
})
test('strict action routes validate method and body before dispatch', async () => {
  const before = mutations
  expect((await request('/feishu/prepare', 'GET')).status).toBe(405)
  expect((await request('/feishu/prepare/extra', 'POST', {})).status).toBe(404)
  expect((await request('/feishu/other', 'POST', {})).status).toBe(404)
  for (const body of [[], null, { token: 'do-not-store' }, { acknowledgeSharedCredentials: 'true' }, { sessionId: '' }]) {
    expect((await request('/feishu/authenticate', 'POST', body)).status).toBe(400)
  }
  expect(mutations).toBe(before)
  expect((await request('/feishu/prepare', 'POST', {})).status).toBe(202)
  expect(mutations).toBe(before + 1)
})


test('configuration rejects invalid shapes and wrong actions without dispatch or reflecting secret input', async () => {
  const before = mutations
  const invalid = [[], null, { apiKey: 7 }, { apiKey: 'private-key\nvalue' }, { apiKey: 'x'.repeat(8193) }, { 'bad-key': 'private-key' }, Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`field${i}`, 'private-key']))]
  for (const configuration of invalid) {
    const response = await request('/feishu/authenticate', 'POST', { configuration })
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain('private-key')
  }
  for (const action of ['check', 'cancel', 'deactivate', 'remove']) expect((await request(`/feishu/${action}`, 'POST', { configuration: { apiKey: 'private-key' } })).status).toBe(400)
  expect(mutations).toBe(before)
  const response = await request('/feishu/authenticate', 'POST', { configuration: { apiKey: 'private-key' } })
  expect(response.status).toBe(202)
  expect(await response.text()).not.toContain('private-key')
})
