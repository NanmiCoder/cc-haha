import { describe, expect, it, mock } from 'bun:test'
import * as realPluginLoader from '../../utils/plugins/pluginLoader'
import * as realInstalledPluginsManager from '../../utils/plugins/installedPluginsManager'
import * as realMarketplaceManager from '../../utils/plugins/marketplaceManager'

const state = { marketplaces: {} as Record<string, unknown> }

// Spread the real module so every other export PluginService imports stays intact.
mock.module('../../utils/plugins/marketplaceManager', () => ({
  ...realMarketplaceManager,
  loadKnownMarketplacesConfig: async () => state.marketplaces,
}))
mock.module('../../utils/plugins/installedPluginsManager', () => ({
  ...realInstalledPluginsManager,
  loadInstalledPluginsV2: () => ({ plugins: {} }),
}))
mock.module('../../utils/plugins/pluginLoader', () => ({
  ...realPluginLoader,
  loadAllPluginsCacheOnly: async () => ({ enabled: [], disabled: [], errors: [] }),
}))

const { PluginService } = await import('../services/pluginService')

describe('PluginService.collectPluginState marketplaces', () => {
  it('reads the marketplace map at its top level, not under a nested .marketplaces key', async () => {
    state.marketplaces = {
      alpha: { source: { source: 'github', repo: 'owner/alpha' } },
      beta: { source: { source: 'github', repo: 'owner/beta' } },
    }

    const { marketplaces, summary } = await new PluginService().listPlugins()

    // Regression guard: reading `marketplaceConfig.marketplaces` yields undefined,
    // the `?? {}` fallback turns it into {}, and the list comes back empty.
    expect(marketplaces.map((m) => m.name)).toEqual(['alpha', 'beta'])
    expect(summary.marketplaceCount).toBe(2)
  })

  it('returns an empty list, not a crash, when no marketplaces are configured', async () => {
    state.marketplaces = {}

    const { marketplaces, summary } = await new PluginService().listPlugins()

    expect(marketplaces).toEqual([])
    expect(summary.marketplaceCount).toBe(0)
  })
})
