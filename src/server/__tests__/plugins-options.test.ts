import { describe, expect, it, mock, spyOn } from 'bun:test'
import { handlePluginsApi } from '../api/plugins.js'
import * as pluginOptionsStorage from '../../utils/plugins/pluginOptionsStorage.js'

function makeRequest(method: string, urlStr: string, body?: unknown) {
  const url = new URL(urlStr, 'http://localhost:3456')
  const init: RequestInit = { method }
  if (body) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const req = new Request(url.toString(), init)
  return { req, url, segments: url.pathname.split('/').filter(Boolean) }
}

describe('plugins options API', () => {
  it('GET /api/plugins/options returns 400 when id is missing', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/plugins/options')
    const res = await handlePluginsApi(req, url, segments)
    expect(res.status).toBe(400)
  })

  it('POST /api/plugins/options returns 400 when id is missing', async () => {
    const { req, url, segments } = makeRequest('POST', '/api/plugins/options', {
      values: { KEY: 'value' },
    })
    const res = await handlePluginsApi(req, url, segments)
    expect(res.status).toBe(400)
  })

  it('POST /api/plugins/options returns 400 when values is not an object', async () => {
    const { req, url, segments } = makeRequest('POST', '/api/plugins/options', {
      id: 'test@test-market',
      values: 'not-an-object',
    })
    const res = await handlePluginsApi(req, url, segments)
    expect(res.status).toBe(400)
  })
})
