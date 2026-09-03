import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as settings from '../settings/settings.js'
import * as bootstrapState from '../../bootstrap/state.js'
import { getEnhancedPRAttribution } from '../attribution.js'

describe('getEnhancedPRAttribution (issue #1274)', () => {
  beforeEach(() => {
    vi.spyOn(bootstrapState, 'getClientType').mockReturnValue('local')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns empty string when attribution.pr is an empty string (global disable)', async () => {
    vi.spyOn(settings, 'getInitialSettings').mockReturnValue({ attribution: { pr: '' } } as any)
    const result = await getEnhancedPRAttribution(() => ({}) as any)
    expect(result).toBe('')
  })

  it('returns the custom PR attribution when attribution.pr is a non-empty string', async () => {
    vi.spyOn(settings, 'getInitialSettings').mockReturnValue({ attribution: { pr: 'Signed-off-by: Alice' } } as any)
    const result = await getEnhancedPRAttribution(() => ({}) as any)
    expect(result).toBe('Signed-off-by: Alice')
  })
})
