import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedSkill } from '@/types/market'
import { AGENT_TEAMS_NOTICE_STORAGE_KEY, dismissAgentTeamsNotice, isAgentTeamsNoticeDismissed } from '@/lib/agentTeamsNotice'
import { browserHost } from '@/lib/desktopHost/browserHost'
import { useBrowserUseStore } from '@/stores/browserUseStore'
import { useMarketStore } from '@/stores/marketStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { MARKET_TAB_ID, useTabStore } from '@/stores/tabStore'
import { useUIStore } from '@/stores/uiStore'
import { pickPopularSkills, resetPopularSkillsCache, useCapabilityMenu, type CapabilityMenuComposerHandlers } from './useCapabilityMenu'

const mocks = vi.hoisted(() => ({
  marketList: vi.fn(),
  marketInstall: vi.fn(),
  browserUseGetConfig: vi.fn(),
  browserUseUpdateConfig: vi.fn(),
}))

vi.mock('@/api/agents', () => ({ agentsApi: { list: vi.fn().mockResolvedValue({ activeAgents: [], allAgents: [] }) } }))
vi.mock('@/api/connectors', () => ({ connectorsApi: { list: vi.fn().mockResolvedValue({ items: [] }) } }))
vi.mock('@/api/workflows', () => ({ workflowsApi: { list: vi.fn().mockResolvedValue({ workflows: [] }) } }))
vi.mock('@/api/computerUse', () => ({ computerUseApi: { getStatus: vi.fn().mockRejectedValue(new Error('off')), getAuthorizedApps: vi.fn() } }))
vi.mock('@/api/browserUse', () => ({
  browserUseApi: {
    getConfig: mocks.browserUseGetConfig,
    updateConfig: mocks.browserUseUpdateConfig,
  },
}))
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
  localStorage.removeItem(AGENT_TEAMS_NOTICE_STORAGE_KEY)
  resetPopularSkillsCache()
  mocks.marketList.mockReset().mockResolvedValue({ items: [marketSkill('excalidraw'), marketSkill('pptx')], nextCursor: null, sources: {} })
  mocks.marketInstall.mockReset()
  mocks.browserUseGetConfig.mockReset().mockResolvedValue({
    enabled: false,
    preferredTarget: 'auto',
    showCursorOverlay: true,
    autoOpenWorkspacePanel: true,
    managedChromeHeadless: false,
  })
  mocks.browserUseUpdateConfig.mockReset().mockImplementation(async (patch: Record<string, unknown>) => ({
    enabled: false,
    preferredTarget: 'auto',
    showCursorOverlay: true,
    autoOpenWorkspacePanel: true,
    managedChromeHeadless: false,
    ...patch,
  }))
  useBrowserUseStore.getState().reset()
  useMarketStore.setState({ installingIds: new Set(), installError: null })
  useSettingsStore.setState({ agentTeamsEnabled: true, locale: 'en' })
  useUIStore.setState({ pendingMarketTarget: null, toasts: [] })
  useTabStore.setState({ tabs: [], activeTabId: null })
})

afterEach(() => {
  Reflect.deleteProperty(window, 'desktopHost')
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

  it('asks before arming Agent Team, and arms only after the user confirms', () => {
    const { result, composer } = renderMenu()
    act(() => result.current.onAction({ type: 'toggleAgentTeam' }))
    expect(result.current.agentTeamArmed).toBe(false)
    expect(result.current.agentTeamsNotice.open).toBe(true)
    expect(composer.onClose).toHaveBeenCalled()

    act(() => result.current.agentTeamsNotice.onClose())
    expect(result.current.agentTeamsNotice.open).toBe(false)
    expect(result.current.agentTeamArmed).toBe(false)

    act(() => result.current.onAction({ type: 'toggleAgentTeam' }))
    act(() => result.current.agentTeamsNotice.onConfirm({ dontRemind: false }))
    expect(result.current.agentTeamsNotice.open).toBe(false)
    expect(result.current.agentTeamArmed).toBe(true)
    expect(isAgentTeamsNoticeDismissed()).toBe(false)

    // Turning it off never asks.
    act(() => result.current.onAction({ type: 'toggleAgentTeam' }))
    expect(result.current.agentTeamArmed).toBe(false)
    expect(result.current.agentTeamsNotice.open).toBe(false)
  })

  it('stops asking once the user chose not to be reminded', () => {
    const first = renderMenu()
    act(() => first.result.current.onAction({ type: 'toggleAgentTeam' }))
    act(() => first.result.current.agentTeamsNotice.onConfirm({ dontRemind: true }))
    expect(first.result.current.agentTeamArmed).toBe(true)
    first.unmount()

    const second = renderMenu()
    act(() => second.result.current.onAction({ type: 'toggleAgentTeam' }))
    expect(second.result.current.agentTeamsNotice.open).toBe(false)
    expect(second.result.current.agentTeamArmed).toBe(true)
  })

  it('arms Agent Team until disarmed, and never while Settings turns it off', () => {
    dismissAgentTeamsNotice()
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

  it('toggles Browser Use through consent dialog and syncs preferred target on desktop', async () => {
    window.desktopHost = { ...browserHost, kind: 'electron', isDesktop: true }
    const { result, composer } = renderMenu()
    await waitFor(() => expect(mocks.browserUseGetConfig).toHaveBeenCalled())
    await waitFor(() => {
      const runSection = result.current.sections.find(section => section.id === 'run')!
      const browserRow = runSection.items.find(item => item.key === 'browser-use')!
      expect(browserRow.switch).toEqual({ checked: false, disabled: false })
    })

    const runSection = result.current.sections.find(section => section.id === 'run')!
    const browserRow = runSection.items.find(item => item.key === 'browser-use')!
    expect(browserRow.action).toEqual({ type: 'toggleBrowserUse' })

    act(() => result.current.onAction({ type: 'toggleBrowserUse' }))
    expect(result.current.browserUseConsent.open).toBe(true)
    expect(composer.onClose).toHaveBeenCalled()

    await act(async () => {
      await result.current.browserUseConsent.onConfirm()
    })
    expect(result.current.browserUseConsent.open).toBe(false)
    expect(result.current.browserUse.enabled).toBe(true)
    expect(mocks.browserUseUpdateConfig).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }))

    await act(async () => {
      result.current.browserUse.setPreferredTarget('chrome')
      await Promise.resolve()
    })
    expect(result.current.browserUse.preferredTarget).toBe('chrome')

    await act(async () => {
      result.current.onAction({ type: 'toggleBrowserUse' })
      await Promise.resolve()
    })
    expect(result.current.browserUse.enabled).toBe(false)
  })

  it('hides the Browser Use switch on non-desktop H5 and avoids retry loops on 403', async () => {
    window.desktopHost = { ...browserHost, kind: 'browser', isDesktop: false }
    const h5Menu = renderMenu()
    const runSection = h5Menu.result.current.sections.find(section => section.id === 'run')!
    const browserRow = runSection.items.find(item => item.key === 'browser-use')!
    expect(browserRow.switch).toBeUndefined()
    expect(browserRow.action).toEqual({ type: 'settings', tab: 'browserUse' })
    expect(mocks.browserUseGetConfig).not.toHaveBeenCalled()
    h5Menu.unmount()

    // Even on desktop, a 403/error degrades to settings navigation and stops re-fetching.
    window.desktopHost = { ...browserHost, kind: 'electron', isDesktop: true }
    mocks.browserUseGetConfig.mockRejectedValue(new Error('403 Desktop-only'))
    const desktopMenu = renderHook(
      ({ open }) => useCapabilityMenu({ open, cwd: '/repo', references: [], handlers: handlers() }),
      { initialProps: { open: true } },
    )
    await waitFor(() => expect(mocks.browserUseGetConfig).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      const degradedRow = desktopMenu.result.current.sections.find(section => section.id === 'run')!.items.find(item => item.key === 'browser-use')!
      expect(degradedRow.switch).toBeUndefined()
      expect(degradedRow.action).toEqual({ type: 'settings', tab: 'browserUse' })
    })
    desktopMenu.rerender({ open: false })
    desktopMenu.rerender({ open: true })
    await Promise.resolve()
    expect(mocks.browserUseGetConfig).toHaveBeenCalledTimes(1)
  })

  it('hydrates Browser Use config before opening + menu and surfaces toasts on save failures', async () => {
    window.desktopHost = { ...browserHost, kind: 'electron', isDesktop: true }
    mocks.browserUseGetConfig.mockResolvedValue({
      enabled: true,
      preferredTarget: 'workspace',
      showCursorOverlay: true,
      autoOpenWorkspacePanel: true,
      managedChromeHeadless: false,
    })

    // Closed initially: hydration effect still fetches config once on desktop.
    const hook = renderHook(() => useCapabilityMenu({ open: false, cwd: '/repo', references: [], handlers: handlers() }))
    await waitFor(() => expect(hook.result.current.browserUse.enabled).toBe(true))
    expect(hook.result.current.browserUse.preferredTarget).toBe('workspace')

    // Action setBrowserUseTarget & toggleBrowserUse (disable) failures surface error toasts
    mocks.browserUseUpdateConfig.mockRejectedValue(new Error('write denied'))
    await act(async () => {
      hook.result.current.onAction({ type: 'setBrowserUseTarget', target: 'chrome' })
      hook.result.current.onAction({ type: 'toggleBrowserUse' })
      await Promise.resolve()
    })
    expect(useUIStore.getState().toasts.at(-1)?.type).toBe('error')

    // Direct disable / setPreferredTarget failure toasts
    await act(async () => {
      hook.result.current.browserUse.disable()
      hook.result.current.browserUse.setPreferredTarget('auto')
      await Promise.resolve()
    })
    expect(useUIStore.getState().toasts.filter(t => t.type === 'error').length).toBeGreaterThanOrEqual(2)

    // Consent dialog confirm failure keeps dialog open and toasts; onClose closes it
    useBrowserUseStore.setState({
      config: {
        enabled: false,
        preferredTarget: 'auto',
        showCursorOverlay: true,
        autoOpenWorkspacePanel: true,
        managedChromeHeadless: false,
      },
      loaded: true,
    })
    act(() => hook.result.current.onAction({ type: 'toggleBrowserUse' }))
    expect(hook.result.current.browserUseConsent.open).toBe(true)
    await act(async () => {
      await hook.result.current.browserUseConsent.onConfirm()
    })
    expect(hook.result.current.browserUseConsent.open).toBe(true)
    act(() => hook.result.current.browserUseConsent.onClose())
    expect(hook.result.current.browserUseConsent.open).toBe(false)
  })
})

it('lean exposes only file attachment and local commands, including after a standard menu', async () => {
  const composer = handlers()
  const { result, rerender } = renderHook(({ lean }) => useCapabilityMenu({ open: true, lean, cwd: '/repo', references: [], handlers: composer }), { initialProps: { lean: false } })
  await waitFor(() => expect(mocks.marketList).toHaveBeenCalled())
  rerender({ lean: true })
  const actions = result.current.sections.flatMap(section => section.items.map(item => item.action?.type))
  expect(actions).toEqual(['attachment', 'slashTrigger'])
  expect(result.current.sections.flatMap(section => section.searchOnly ?? [])).toEqual([])
  act(() => result.current.onAction({ type: 'toggleAgentTeam' }))
  expect(result.current.agentTeamArmed).toBe(false)
  act(() => result.current.onAction({ type: 'insertSlashText', command: 'agent forbidden' }))
  expect(composer.onInsertSlashText).not.toHaveBeenCalled()
})

it('keeps explicit installed skills in lean while blocking plugin mentions', () => {
  const composer = handlers()
  const skill = { id: 'review', name: 'review', displayName: 'Review', source: 'user', modelText: '/review', description: 'Review code', kind: 'skill' as const }
  const plugin = { id: 'browser', name: 'browser', displayName: 'Browser', source: 'plugin', modelText: '/browser', description: 'Browser', kind: 'plugin' as const }
  const { result } = renderHook(() => useCapabilityMenu({ open: true, lean: true, cwd: '/repo', references: [skill, plugin], handlers: composer }))
  expect(result.current.sections.flatMap(section => section.items).find(item => item.key === 'skills')?.children?.find(item => item.key === 'skills:all')?.children).toEqual([
    expect.objectContaining({ action: { type: 'insertMention', reference: skill } }),
  ])
  act(() => result.current.onAction({ type: 'insertMention', reference: skill }))
  expect(composer.onInsertMention).toHaveBeenCalledWith(skill)
  act(() => result.current.onAction({ type: 'insertMention', reference: plugin }))
  expect(composer.onInsertMention).toHaveBeenCalledTimes(1)
})

describe('the Agent mode row', () => {
  const runItems = (result: { current: ReturnType<typeof useCapabilityMenu> }) =>
    result.current.sections.flatMap(section => section.items).map(item => item.key)

  it('changes a draft to lean through the row, and drops an armed Agent Team with a notice', () => {
    dismissAgentTeamsNotice()
    const onChange = vi.fn()
    const { result } = renderHook(() => useCapabilityMenu({
      open: true, cwd: '/repo', references: [], handlers: handlers(), agentProfile: { value: 'standard', onChange },
    }))
    act(() => result.current.onAction({ type: 'toggleAgentTeam' }))
    expect(result.current.agentTeamArmed).toBe(true)

    act(() => result.current.onAction({ type: 'setAgentProfile', profile: 'lean' }))
    expect(onChange).toHaveBeenCalledWith('lean')
    expect(result.current.agentTeamArmed).toBe(false)
    expect(useUIStore.getState().toasts.some(toast => toast.message.includes('Agent Teams'))).toBe(true)
  })

  it('does not announce anything for a switch that dropped nothing, nor re-pick the current mode', () => {
    const onChange = vi.fn()
    const { result } = renderHook(() => useCapabilityMenu({
      open: true, cwd: '/repo', references: [], handlers: handlers(), agentProfile: { value: 'standard', onChange },
    }))
    act(() => result.current.onAction({ type: 'setAgentProfile', profile: 'standard' }))
    expect(onChange).not.toHaveBeenCalled()
    act(() => result.current.onAction({ type: 'setAgentProfile', profile: 'lean' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(useUIStore.getState().toasts).toEqual([])
  })

  it('shows a locked row that ignores a change, whichever way the action arrives', () => {
    const { result } = renderHook(() => useCapabilityMenu({
      open: true, lean: true, cwd: '/repo', references: [], handlers: handlers(), agentProfile: { value: 'lean' },
    }))
    const row = result.current.sections.flatMap(section => section.items).find(item => item.key === 'agent-profile')!
    expect(row.choice).toMatchObject({ value: 'lean', locked: true })
    expect(() => act(() => result.current.onAction({ type: 'setAgentProfile', profile: 'standard' }))).not.toThrow()
  })

  it('keeps the row in a lean menu while everything lean cannot run leaves it', () => {
    const { result } = renderHook(() => useCapabilityMenu({
      open: true, lean: true, cwd: '/repo', references: [], handlers: handlers(), agentProfile: { value: 'lean', onChange: vi.fn() },
    }))
    const items = runItems(result)
    expect(items).toContain('agent-profile')
    expect(items).toContain('add-files')
    expect(items).toContain('slash-commands')
    for (const gone of ['agent-team', 'computer-use', 'connectors', 'agents', 'workflows']) expect(items).not.toContain(gone)
  })

  it('has no row when the composer offers none', () => {
    const { result } = renderMenu()
    expect(runItems(result)).not.toContain('agent-profile')
  })

  it('exposes and arms Agent Team for Antigravity even when Claude Code agentTeamsEnabled is false', () => {
    dismissAgentTeamsNotice()
    useSettingsStore.setState({ agentTeamsEnabled: false })
    const composer = handlers()
    const { result } = renderHook(() => useCapabilityMenu({
      open: true,
      antigravity: true,
      cwd: '/repo',
      references: [],
      handlers: composer,
    }))
    const teamRow = result.current.sections.flatMap(section => section.items).find(item => item.key === 'agent-team')
    expect(teamRow).toMatchObject({ action: { type: 'toggleAgentTeam' }, switch: { checked: false, disabled: false } })

    act(() => result.current.onAction({ type: 'toggleAgentTeam' }))
    expect(result.current.agentTeamArmed).toBe(true)

    act(() => result.current.disarmAgentTeam())
    expect(result.current.agentTeamArmed).toBe(false)
  })
})
