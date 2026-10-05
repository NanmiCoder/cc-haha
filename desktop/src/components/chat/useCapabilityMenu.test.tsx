import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedSkill } from '@/types/market'
import { useMarketStore } from '@/stores/marketStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { MARKET_TAB_ID, useTabStore } from '@/stores/tabStore'
import { useUIStore } from '@/stores/uiStore'
import { pickPopularSkills, resetPopularSkillsCache, useCapabilityMenu, type CapabilityMenuComposerHandlers } from './useCapabilityMenu'

const mocks = vi.hoisted(() => ({
  marketList: vi.fn(),
  marketInstall: vi.fn(),
}))

vi.mock('@/api/agents', () => ({ agentsApi: { list: vi.fn().mockResolvedValue({ activeAgents: [], allAgents: [] }) } }))
vi.mock('@/api/connectors', () => ({ connectorsApi: { list: vi.fn().mockResolvedValue({ items: [] }) } }))
vi.mock('@/api/workflows', () => ({ workflowsApi: { list: vi.fn().mockResolvedValue({ workflows: [] }) } }))
vi.mock('@/api/computerUse', () => ({ computerUseApi: { getStatus: vi.fn().mockRejectedValue(new Error('off')), getAuthorizedApps: vi.fn() } }))
vi.mock('@/api/market', () => ({ marketApi: { list: mocks.marketList, install: mocks.marketInstall } }))
vi.mock('@/stores/skillStore', () => ({ useSkillStore: { getState: () => ({ fetchSkills: vi.fn().mockResolvedValue(undefined) }) } }))

function marketSkill(id: string, overrides: Partial<NormalizedSkill> = {}): NormalizedSkill {
  return {
    id,
    source: 'clawhub',
    slug: id,
    name: id,
    summary: `${id} summary`,
    author: { handle: 'someone' },
    stats: { downloads: 1 },
    tags: [],
    securityStatus: 'verified',
    installState: 'installable',
    ...overrides,
  }
}

function handlers(): CapabilityMenuComposerHandlers {
  return {
    onInsertMention: vi.fn(),
    onInsertSlashText: vi.fn(),
    onAttachment: vi.fn(),
    onSlashTrigger: vi.fn(),
    onSaveWorkflow: vi.fn(),
    onReferencesChanged: vi.fn(),
    onClose: vi.fn(),
  }
}

function renderMenu(composer = handlers()) {
  const view = renderHook(() => useCapabilityMenu({ open: true, cwd: '/repo', references: [], handlers: composer }))
  return { ...view, composer }
}

function skillChildKeys(result: { current: ReturnType<typeof useCapabilityMenu> }) {
  return result.current.sections[0]!.items.find(item => item.key === 'skills')!.children!.map(item => item.key)
}

beforeEach(() => {
  resetPopularSkillsCache()
  mocks.marketList.mockReset().mockResolvedValue({ items: [marketSkill('excalidraw'), marketSkill('pptx')], nextCursor: null, sources: {} })
  mocks.marketInstall.mockReset()
  useMarketStore.setState({ installingIds: new Set(), installError: null })
  useSettingsStore.setState({ agentTeamsEnabled: true, locale: 'en' })
  useUIStore.setState({ pendingMarketTarget: null, toasts: [] })
  useTabStore.setState({ tabs: [], activeTabId: null })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('pickPopularSkills', () => {
  it('keeps installable, cleanly scanned skills that need no key, editor picks first', () => {
    const picked = pickPopularSkills([
      marketSkill('plain'),
      marketSkill('installed', { installState: 'installed' }),
      marketSkill('flagged', { securityStatus: 'flagged' }),
      marketSkill('unknown', { securityStatus: 'unknown' }),
      marketSkill('benign', { securityStatus: 'benign' }),
      marketSkill('needs-key', { requiresApiKey: true }),
      marketSkill('pick', { featured: true }),
    ])
    expect(picked.map(skill => skill.id)).toEqual(['pick', 'plain', 'benign'])
  })
})

describe('useCapabilityMenu', () => {
  it('opens the market at a connector and closes the menu', () => {
    const { result, composer } = renderMenu()
    act(() => result.current.onAction({ type: 'market', section: 'plugins', connectorId: 'github' }))
    expect(useUIStore.getState().pendingMarketTarget).toEqual({ section: 'plugins', connectorId: 'github' })
    expect(useTabStore.getState().activeTabId).toBe(MARKET_TAB_ID)
    expect(composer.onClose).toHaveBeenCalled()
  })

  it('reads the curated catalog once for every composer', async () => {
    const first = renderMenu()
    await waitFor(() => expect(skillChildKeys(first.result)).toContain('market-skill:excalidraw'))
    const second = renderMenu()
    await waitFor(() => expect(skillChildKeys(second.result)).toContain('market-skill:excalidraw'))
    expect(mocks.marketList).toHaveBeenCalledTimes(1)
    expect(mocks.marketList).toHaveBeenCalledWith({ scope: 'catalog', installed: 'installable', limit: 30 })
  })

  it('installs a suggested skill in place and reloads the mention list', async () => {
    mocks.marketInstall.mockResolvedValue({ ok: true, installedPath: '/skills/excalidraw', skill: marketSkill('excalidraw', { installState: 'installed' }) })
    const { result, composer } = renderMenu()
    await waitFor(() => expect(skillChildKeys(result)).toContain('market-skill:excalidraw'))

    await act(async () => {
      result.current.onAction({ type: 'installSkill', id: 'excalidraw', name: 'excalidraw' })
    })
    await waitFor(() => expect(composer.onReferencesChanged).toHaveBeenCalledTimes(1))
    expect(mocks.marketInstall).toHaveBeenCalledWith('excalidraw', undefined)
    expect(composer.onClose).not.toHaveBeenCalled()
    expect(skillChildKeys(result)).not.toContain('market-skill:excalidraw')
    expect(skillChildKeys(result)).toContain('market-skill:pptx')
    expect(useUIStore.getState().toasts.at(-1)).toMatchObject({ type: 'success' })

    // Another composer opened later does not offer the installed skill again.
    const later = renderMenu()
    await waitFor(() => expect(skillChildKeys(later.result)).toContain('market-skill:pptx'))
    expect(skillChildKeys(later.result)).not.toContain('market-skill:excalidraw')
  })

  it('keeps the suggestion and reports why when an install fails', async () => {
    mocks.marketInstall.mockRejectedValue(new Error('network down'))
    const { result, composer } = renderMenu()
    await waitFor(() => expect(skillChildKeys(result)).toContain('market-skill:excalidraw'))

    await act(async () => {
      result.current.onAction({ type: 'installSkill', id: 'excalidraw', name: 'excalidraw' })
    })
    await waitFor(() => expect(useUIStore.getState().toasts.at(-1)).toMatchObject({ type: 'error' }))
    expect(composer.onReferencesChanged).not.toHaveBeenCalled()
    expect(skillChildKeys(result)).toContain('market-skill:excalidraw')
  })

  it('arms Agent Team until disarmed, and never while Settings turns it off', () => {
    const { result, rerender } = renderMenu()
    act(() => result.current.onAction({ type: 'toggleAgentTeam' }))
    expect(result.current.agentTeamArmed).toBe(true)
    act(() => result.current.disarmAgentTeam())
    expect(result.current.agentTeamArmed).toBe(false)

    act(() => result.current.onAction({ type: 'toggleAgentTeam' }))
    act(() => useSettingsStore.setState({ agentTeamsEnabled: false }))
    rerender()
    expect(result.current.agentTeamArmed).toBe(false)
    expect(result.current.sections[1]!.items[0]!.action).toEqual({ type: 'settings', tab: 'general' })
  })
})
