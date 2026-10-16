import { afterEach, describe, expect, it } from 'vitest'
import type { ComposerReferenceCandidate } from '../types/composerReference'
import { useCapabilityCatalogStore } from './capabilityCatalogStore'

const candidate = (overrides: Partial<ComposerReferenceCandidate>): ComposerReferenceCandidate => ({
  kind: 'plugin', id: 'amap@official', name: 'amap', displayName: '高德地图', description: '',
  source: 'amap@official', modelText: '', ...overrides,
})

describe('capabilityCatalogStore', () => {
  afterEach(() => useCapabilityCatalogStore.setState({ entries: {} }))

  it('remembers each capability by kind and id with its display name and safe icon', () => {
    useCapabilityCatalogStore.getState().remember([
      candidate({ icon: '/connectors/amap.svg' }),
      candidate({ kind: 'skill', id: 'amap@official', displayName: '', name: 'route', icon: 'https://evil.example/x.svg' }),
    ])
    expect(useCapabilityCatalogStore.getState().entries).toEqual({
      'plugin:amap@official': { label: '高德地图', icon: '/connectors/amap.svg' },
      'skill:amap@official': { label: 'route' },
    })
  })

  it('keeps the same state object when a listing changes nothing', () => {
    useCapabilityCatalogStore.getState().remember([candidate({})])
    const before = useCapabilityCatalogStore.getState().entries
    useCapabilityCatalogStore.getState().remember([candidate({})])
    expect(useCapabilityCatalogStore.getState().entries).toBe(before)
  })
})
