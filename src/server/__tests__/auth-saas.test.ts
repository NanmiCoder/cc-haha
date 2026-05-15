import { describe, expect, it } from 'bun:test'
import { requireAuth } from '../middleware/auth.js'

describe('requireAuth (SaaS single-user)', () => {
  it('returns null for any request', async () => {
    const req = new Request('http://localhost/api/sessions', { method: 'GET' })
    expect(await requireAuth(req)).toBeNull()
  })
})
