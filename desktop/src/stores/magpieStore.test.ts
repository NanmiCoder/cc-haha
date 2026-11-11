import { afterEach, describe, expect, it, vi } from 'vitest'

import { providersApi } from '../api/providers'
import {
  MAGPIE_BANNER_DISMISSED_KEY,
  formatTokenLimit,
  groupMagpieModels,
  useMagpieStore,
} from './magpieStore'
import type { MagpieModel } from '../types/provider'

const model = (overrides: Partial<MagpieModel> & Pick<MagpieModel, 'id'>): MagpieModel => ({
  runtimeId: overrides.id,
  displayName: overrides.id,
  provider: overrides.id.split('/')[0]!,
  isGroup: false,
  reasoningEfforts: [],
  ...overrides,
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.removeItem(MAGPIE_BANNER_DISMISSED_KEY)
  useMagpieStore.setState({ state: null, loading: false, bannerDismissed: false })
})

describe('Magpie catalog display', () => {
  it('writes windows the way vendors state them', () => {
    expect(formatTokenLimit(262_144)).toBe('256K')
    expect(formatTokenLimit(200_000)).toBe('200K')
    expect(formatTokenLimit(32_768)).toBe('32K')
    expect(formatTokenLimit(1_000_000)).toBe('1M')
    expect(formatTokenLimit(1_048_576)).toBe('1M')
    expect(formatTokenLimit(1_500_000)).toBe('1.5M')
  })

  it('groups models by the provider serving them, routing groups first', () => {
    const groups = groupMagpieModels([
      model({ id: 'kimi/kimi-k3', providerName: 'Kimi Coding' }),
      model({ id: 'group/daily', isGroup: true }),
      model({ id: 'ollama/qwen3.6:27b' }),
      model({ id: 'kimi/kimi-k2' }),
    ])

    expect(groups.map((group) => [group.label, group.models.map((item) => item.id)])).toEqual([
      [null, ['group/daily']],
      ['Kimi Coding', ['kimi/kimi-k3', 'kimi/kimi-k2']],
      ['ollama', ['ollama/qwen3.6:27b']],
    ])
  })
})

describe('Magpie store', () => {
  it('remembers that the connect bar was closed', () => {
    useMagpieStore.getState().dismissBanner()

    expect(useMagpieStore.getState().bannerDismissed).toBe(true)
    expect(localStorage.getItem(MAGPIE_BANNER_DISMISSED_KEY)).toBe('1')
  })

  it('keeps the last state when our own server does not answer', async () => {
    const shown = { status: { installed: true, running: true, baseUrl: 'http://127.0.0.1:3425' }, models: [] }
    useMagpieStore.setState({ state: shown })
    vi.spyOn(providersApi, 'magpie').mockRejectedValue(new Error('server down'))

    expect(await useMagpieStore.getState().refresh()).toBeNull()
    expect(useMagpieStore.getState()).toMatchObject({ state: shown, loading: false })
  })
})
