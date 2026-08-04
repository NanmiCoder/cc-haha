import { describe, expect, test, beforeEach } from 'bun:test'
import { handleApiRequest } from './router.js'
import { deploymentModeService } from './services/deploymentModeService.js'

beforeEach(() => {
  deploymentModeService.reset()
})

/**
 * These tests verify the private-cloud route gate without needing real
 * handlers to dispatch. The gate runs before the switch statement, so a
 * gated resource returns 404 regardless of the downstream handler's state.
 */

async function requestApi(path: string, method = 'GET'): Promise<Response> {
  const baseUrl = 'http://localhost'
  const url = new URL(path, baseUrl)
  const req = new Request(url.toString(), { method })
  return handleApiRequest(req, url)
}

describe('router private-cloud route gating', () => {
  test('returns 404 for gated resources in private-cloud mode', async () => {
    deploymentModeService.init({ deploymentMode: 'private-cloud' })

    for (const resource of ['market', 'haha-oauth', 'haha-openai-oauth', 'haha-grok-oauth']) {
      const res = await requestApi(`/api/${resource}`)
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe('Not Found')
      expect(body.message).toContain('private-cloud')
    }
  })

  test('does not gate these resources in public mode', async () => {
    deploymentModeService.init({ deploymentMode: 'public' })

    // In public mode the gate is skipped, so the request proceeds into the
    // switch and reaches the real handler. We only assert it does NOT return
    // the private-cloud 404 — the handler may succeed or fail on its own terms.
    for (const resource of ['market', 'haha-oauth']) {
      const res = await requestApi(`/api/${resource}`)
      // The gate would return 404 with a JSON body containing 'private-cloud'.
      // Here we verify that signature is absent.
      if (res.status === 404) {
        const body = await res.json()
        expect(body.message).not.toContain('private-cloud')
      }
    }
  })

  test('non-gated resources are unaffected by private-cloud mode', async () => {
    deploymentModeService.init({ deploymentMode: 'private-cloud' })

    // /api/sessions is not gated — it should proceed past the gate (and may
    // 404 or 200 depending on server state, but never with the gate message).
    const res = await requestApi('/api/sessions')
    if (res.status === 404) {
      const body = await res.json()
      expect(body.message).not.toContain('private-cloud')
    }
  })

  test('gate message names the specific disabled resource', async () => {
    deploymentModeService.init({ deploymentMode: 'private-cloud' })
    const res = await requestApi('/api/market')
    const body = await res.json()
    expect(body.message).toContain('market')
  })
})
