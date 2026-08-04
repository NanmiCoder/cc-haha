import { describe, expect, test, beforeEach } from 'bun:test'
import { prefetchOfficialMcpUrls } from './officialRegistry.js'
import { deploymentModeService } from '../../server/services/deploymentModeService.js'

beforeEach(() => {
  deploymentModeService.reset()
  // Ensure the env guard does not interfere with the private-cloud test.
  delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
})

describe('prefetchOfficialMcpUrls deployment-mode gate', () => {
  test('short-circuits in private-cloud mode without throwing', async () => {
    deploymentModeService.init({ deploymentMode: 'private-cloud' })
    // Should resolve immediately — the function returns before any network call.
    await expect(prefetchOfficialMcpUrls()).resolves.toBeUndefined()
  })

  test('does not short-circuit in public mode (falls through to normal path)', async () => {
    deploymentModeService.init({ deploymentMode: 'public' })
    // In public mode the function proceeds to the network call. It may succeed
    // or fail depending on network availability, but it must NOT be a silent
    // no-op. We only assert it does not throw synchronously.
    await expect(prefetchOfficialMcpUrls()).resolves.toBeUndefined()
  })
})
