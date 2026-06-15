import { describe, expect, it } from 'bun:test'
import { PLUGIN_CATALOG, getCatalogEntry } from './pluginCatalog.js'

describe('PLUGIN_CATALOG shape', () => {
  it('every entry has the required identity fields', () => {
    for (const entry of PLUGIN_CATALOG) {
      expect(typeof entry.id).toBe('string')
      expect(entry.id.length).toBeGreaterThan(0)
      expect(typeof entry.marketplace).toBe('string')
      expect(entry.marketplace.length).toBeGreaterThan(0)
      expect(typeof entry.displayName).toBe('string')
      expect(typeof entry.description).toBe('string')
      expect(typeof entry.category).toBe('string')
    }
  })

  it('each (id, marketplace) pair is unique', () => {
    const seen = new Set<string>()
    for (const entry of PLUGIN_CATALOG) {
      const key = `${entry.id}@${entry.marketplace}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })

  it('Anthropic-official entries carry a marketplaceSource for cold install', () => {
    const officials = PLUGIN_CATALOG.filter(
      (e) => e.marketplace === 'claude-plugins-official',
    )
    expect(officials.length).toBeGreaterThan(0)
    for (const entry of officials) {
      // Without a source, addMarketplaceSource cannot register the marketplace
      // for users who haven't installed it yet — required for first-click install.
      expect(entry.marketplaceSource).toBeDefined()
    }
  })

  it('cc-haha-builtin entries omit marketplaceSource (registered by registerSeedMarketplaces at startup)', () => {
    const builtins = PLUGIN_CATALOG.filter(
      (e) => e.marketplace === 'cc-haha-builtin',
    )
    expect(builtins.length).toBeGreaterThan(0)
    for (const entry of builtins) {
      // The seed mechanism owns the marketplace registration; the catalog
      // entry must not carry a placeholder source spec that would confuse
      // addMarketplaceSource's source-idempotency check.
      expect(entry.marketplaceSource).toBeUndefined()
    }
  })

  it('image-gen and reverse-engineering are present under cc-haha-builtin', () => {
    const imageGen = PLUGIN_CATALOG.find(
      (e) => e.id === 'image-gen' && e.marketplace === 'cc-haha-builtin',
    )
    expect(imageGen).toBeDefined()
    expect(imageGen?.displayName).toBe('Image Generation')

    const re = PLUGIN_CATALOG.find(
      (e) => e.id === 'reverse-engineering' && e.marketplace === 'cc-haha-builtin',
    )
    expect(re).toBeDefined()
    expect(re?.displayName).toBe('Reverse Engineering')
  })
})

describe('getCatalogEntry', () => {
  it('finds an entry by (id, marketplace)', () => {
    const entry = getCatalogEntry('image-gen', 'cc-haha-builtin')
    expect(entry).toBeDefined()
    expect(entry?.id).toBe('image-gen')
  })

  it('returns undefined when the marketplace does not match', () => {
    const entry = getCatalogEntry('image-gen', 'claude-plugins-official')
    expect(entry).toBeUndefined()
  })

  it('returns undefined for an unknown id', () => {
    expect(getCatalogEntry('does-not-exist', 'cc-haha-builtin')).toBeUndefined()
  })
})
