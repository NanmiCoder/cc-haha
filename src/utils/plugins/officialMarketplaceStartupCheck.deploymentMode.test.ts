import { describe, expect, test, beforeEach } from 'bun:test'
import { checkAndInstallOfficialMarketplace } from './officialMarketplaceStartupCheck.js'
import { deploymentModeService } from '../../server/services/deploymentModeService.js'

beforeEach(() => {
  deploymentModeService.reset()
})

describe('checkAndInstallOfficialMarketplace deployment-mode gate', () => {
  test('returns policy_blocked in private-cloud mode', async () => {
    deploymentModeService.init({ deploymentMode: 'private-cloud' })
    const result = await checkAndInstallOfficialMarketplace()
    expect(result.installed).toBe(false)
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('policy_blocked')
  })
})
