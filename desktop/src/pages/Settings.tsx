import { useState, useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react'
import QRCode from 'qrcode'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Copy, Eye, EyeOff, GripVertical, PowerOff, QrCode, RotateCw } from 'lucide-react'
import { useSettingsStore, UI_ZOOM_DEFAULT, UI_ZOOM_MIN, UI_ZOOM_MAX, UI_ZOOM_STEP } from '../stores/settingsStore'
import { useProviderStore } from '../stores/providerStore'
import { useTranslation, type TranslationKey } from '../i18n'
import { Modal } from '@/components/ui/Modal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Badge, StatusDot } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { Spinner } from '@/components/ui/Spinner'
import {
  SettingsPageHeader,
  SettingsPill,
  SettingsSection,
} from '@/components/settings/SettingsSection'
import { Dropdown } from '@/components/ui/Dropdown'
import { Switch } from '@/components/ui/Switch'
import { Tooltip } from '@/components/ui/Tooltip'
import { PermissionModeSelector } from '../components/controls/PermissionModeSelector'
import { isDarkThemeMode, isLightThemeMode } from '../types/settings'
import type { ThemeMode, NetworkProxyMode, WebSearchMode, AppMode, ChatSendBehavior, OutputStyleSource } from '../types/settings'
import type { Locale } from '../i18n'
import type { SavedProvider, UpdateProviderInput, ProviderTestResult, ModelMapping, Model1mSupport, ApiFormat, ProviderAuthStrategy, ProviderModelInfo, ProviderModelsErrorCode } from '../types/provider'
import { groupProviderModels, providerModelsErrorKey } from '../lib/providerModels'
import {
  apply1mSupportToContextInput,
  apply1mSupportToContextInputs,
  getAutoCompactWindowErrorKey,
  getModelContextWindowErrorKey,
  MODEL_SLOTS,
  parseAutoCompactWindowInput,
  parseModelContextWindowsInput,
  type ModelContextInputs,
  type ModelSlot,
} from '../lib/providerModelContext'
import type { ProviderPreset } from '../types/providerPreset'
import { presetMatchesBaseUrl, selectableProviderPresets } from '../config/providerPresets'
import { AdapterSettings } from './AdapterSettings'
import { useSessionStore } from '../stores/sessionStore'
import { useSkillStore } from '../stores/skillStore'
import { SkillList } from '../components/skills/SkillList'
import { SkillDetail } from '../components/skills/SkillDetail'
import { usePluginStore } from '../stores/pluginStore'
import { PluginList } from '../components/plugins/PluginList'
import { PluginDetail } from '../components/plugins/PluginDetail'
import { ComputerUseSettings } from './ComputerUseSettings'
import { McpSettings } from './McpSettings'
import { TerminalSettings } from './TerminalSettings'
import { DiagnosticsSettings } from './DiagnosticsSettings'
import { TraceList } from './TraceList'
import { ActivitySettings } from './ActivitySettings'
import { MemorySettings } from './MemorySettings'
import { PetSettings } from '../features/pets/PetSettings'
import { useUIStore } from '../stores/uiStore'
import { useFeatureGate } from '../hooks/useDeploymentMode'
import type { DeploymentMode, PrivateCloudConfig } from '../types/deploymentMode'
import { ChatGPTOfficialLogin } from '../components/settings/ChatGPTOfficialLogin'
import { GrokOfficialLogin } from '../components/settings/GrokOfficialLogin'
import { AgentManager } from '../components/settings/AgentManager'
import { CcSwitchImportModal } from '../components/settings/CcSwitchImportModal'
import {
  BUILT_IN_PROVIDER_IDS,
  OPENAI_OFFICIAL_PROVIDER_ID,
} from '../constants/openaiOfficialProvider'
import { GROK_OFFICIAL_PROVIDER_ID } from '../constants/grokOfficialProvider'
import { getBaseUrl } from '../api/client'
import { isDesktopRuntime } from '../lib/desktopRuntime'
import { getDesktopHost } from '../lib/desktopHost'
import { publicAssetPath } from '../lib/publicAsset'
import { isBrowserSafePort } from '../lib/browserSafePort'
import {
  getDesktopNotificationPermission,
  notifyDesktop,
  getDesktopNotificationPlatform,
  openDesktopNotificationSettings,
  requestDesktopNotificationPermission,
  type DesktopNotificationPermission,
} from '../lib/desktopNotifications'
import {
  API_KEY_JSON_PLACEHOLDER,
  maskSettingsJsonSecrets,
  restoreSettingsJsonSecrets,
  stripProviderSettingsJsonEnv,
} from '../lib/providerSettingsJson'
import { copyTextToClipboard } from '@/lib/clipboard'

const NETWORK_TIMEOUT_MIN_SECONDS = 30
const NETWORK_TIMEOUT_MAX_SECONDS = 1800
const NETWORK_TIMEOUT_STEP_SECONDS = 30
const SETTINGS_CHECKBOX_INPUT_CLASS = 'settings-checkbox-input peer'
const BUILT_IN_OUTPUT_STYLE_TRANSLATION_KEYS = {
  default: {
    label: 'settings.general.outputStyleBuiltin.default.label',
    description: 'settings.general.outputStyleBuiltin.default.description',
  },
  Explanatory: {
    label: 'settings.general.outputStyleBuiltin.explanatory.label',
    description: 'settings.general.outputStyleBuiltin.explanatory.description',
  },
  Learning: {
    label: 'settings.general.outputStyleBuiltin.learning.label',
    description: 'settings.general.outputStyleBuiltin.learning.description',
  },
} satisfies Record<string, { label: TranslationKey; description: TranslationKey }>

function buildH5LaunchUrl(baseUrl: string | null, token: string | null): string | null {
  if (!baseUrl) return null

  try {
    const url = new URL(baseUrl)
    if (token) {
      url.searchParams.set('serverUrl', baseUrl)
      url.searchParams.set('h5Token', token)
    }
    return url.toString().replace(/\/$/, '')
  } catch {
    return token
      ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}serverUrl=${encodeURIComponent(baseUrl)}&h5Token=${encodeURIComponent(token)}`
      : baseUrl
  }
}

function isLanH5BaseUrl(url: URL): boolean {
  return url.protocol === 'http:' &&
    !!url.port &&
    (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname.startsWith('10.') ||
      url.hostname.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(url.hostname) ||
      url.hostname.startsWith('169.254.')
    )
}

function extractH5AccessAddressDraft(baseUrl: string | null): string {
  if (!baseUrl) return ''

  try {
    const url = new URL(baseUrl)
    return isLanH5BaseUrl(url) ? url.hostname : baseUrl
  } catch {
    return baseUrl
  }
}

function extractHostnameFromUrl(value: string | null): string | null {
  if (!value) return null
  try {
    return new URL(value).hostname || null
  } catch {
    return null
  }
}

function extractH5AccessPort(baseUrl: string | null): string | null {
  if (!baseUrl) return null

  try {
    const url = new URL(baseUrl)
    return url.port || null
  } catch {
    return null
  }
}

// Mirrors the server-side fixedPort range (h5AccessService MIN/MAX_FIXED_PORT).
function parseH5FixedPortDraft(draft: string): number | null | 'invalid' {
  const trimmed = draft.trim()
  if (!trimmed) return null
  if (!/^\d{1,5}$/.test(trimmed)) return 'invalid'
  const port = Number(trimmed)
  return port >= 1024 && port <= 65535 && isBrowserSafePort(port) ? port : 'invalid'
}

// Mirrors the server-side disconnect grace range (h5AccessService
// MIN/MAX_DISCONNECT_GRACE_SECONDS). Empty = use the built-in 30s default.
function parseH5GraceDraft(draft: string): number | null | 'invalid' {
  const trimmed = draft.trim()
  if (!trimmed) return null
  if (!/^\d{1,5}$/.test(trimmed)) return 'invalid'
  const seconds = Number(trimmed)
  return seconds >= 5 && seconds <= 86400 ? seconds : 'invalid'
}

function buildH5PublicBaseUrlFromHostDraft(draft: string, currentBaseUrl: string | null): string | null {
  const trimmed = draft.trim()
  if (!trimmed) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed

  try {
    const current = currentBaseUrl ? new URL(currentBaseUrl) : null
    if (!current) return trimmed

    const port = current.port ? `:${current.port}` : ''
    const path = current.pathname === '/' ? '' : current.pathname.replace(/\/+$/, '')
    return `${current.protocol}//${trimmed}${port}${path}`
  } catch {
    return trimmed
  }
}

export function Settings() {
  const activeTab = useUIStore((s) => s.activeSettingsTab)
  const setActiveTab = useUIStore((s) => s.setActiveSettingsTab)
  const pendingSettingsTab = useUIStore((s) => s.pendingSettingsTab)
  const t = useTranslation()
  // Feature gates: hide public-internet-dependent entries in private-cloud.
  const showOfficialPlugins = useFeatureGate('official-plugin-market')
  const showPublicIm = useFeatureGate('im-telegram') // any public IM key gates all public IMs

  useEffect(() => {
    if (!pendingSettingsTab) return
    setActiveTab(pendingSettingsTab)
    useUIStore.getState().setPendingSettingsTab(null)
  }, [pendingSettingsTab, setActiveTab])

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[var(--color-surface)]">
      <div className="flex-1 flex overflow-hidden">
        {/* Tab navigation */}
        {/* Narrow enough that the rail is not a gutter of dead space, wide
            enough that the longest label in any locale — the Japanese
            "コンピューター操作" — still clears the truncation on TabButton.

            Paper, separated by the rule, the way every other secondary panel
            in the app is (the workbench, the diff split). It used to be
            `--color-surface-container-low`, which is the same value the tab
            strip's trough resolves to — so the Settings tab, the one tab whose
            content this rail *is*, was the only selected tab in the app whose
            paper fill met a different colour at its bottom edge. It read as a
            white card stranded on a grey panel. Nothing else changed to fix
            it: the tab is right, this was the odd one out. */}
        <div className="w-[220px] flex-shrink-0 flex flex-col overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-4">
          <div className="flex-1 flex flex-col gap-0.5">
            <TabButton icon="dns" label={t('settings.tab.providers')} active={activeTab === 'providers'} onClick={() => setActiveTab('providers')} />
            <TabButton icon="tune" label={t('settings.tab.general')} active={activeTab === 'general'} onClick={() => setActiveTab('general')} />
            <TabButton icon="qr_code_2" label={t('settings.tab.h5Access')} active={activeTab === 'h5Access'} onClick={() => setActiveTab('h5Access')} />
            {showPublicIm && <TabButton icon="chat" label={t('settings.tab.adapters')} active={activeTab === 'adapters'} onClick={() => setActiveTab('adapters')} />}
            <TabButton icon="terminal" label={t('settings.tab.terminal')} active={activeTab === 'terminal'} onClick={() => setActiveTab('terminal')} />
            <TabButton icon="dns" label={t('settings.tab.mcp')} active={activeTab === 'mcp'} onClick={() => setActiveTab('mcp')} />
            <TabButton icon="smart_toy" label={t('settings.tab.agents')} active={activeTab === 'agents'} onClick={() => setActiveTab('agents')} />
            <TabButton icon="auto_awesome" label={t('settings.tab.skills')} active={activeTab === 'skills'} onClick={() => setActiveTab('skills')} />
            <TabButton icon="history_edu" label={t('settings.tab.memory')} active={activeTab === 'memory'} onClick={() => setActiveTab('memory')} />
            {showOfficialPlugins && <TabButton icon="extension" label={t('settings.tab.plugins')} active={activeTab === 'plugins'} onClick={() => setActiveTab('plugins')} />}
            <TabButton icon="pets" label={t('settings.tab.pets')} active={activeTab === 'pets'} onClick={() => setActiveTab('pets')} />
            <TabButton icon="mouse" label={t('settings.tab.computerUse')} active={activeTab === 'computerUse'} onClick={() => setActiveTab('computerUse')} />
            <TabButton icon="monitoring" label={t('settings.tab.activity')} active={activeTab === 'activity'} onClick={() => setActiveTab('activity')} />
            <TabButton icon="cloud" label={t('settings.tab.deploymentMode')} active={activeTab === 'deploymentMode'} onClick={() => setActiveTab('deploymentMode')} />
            <TabButton icon="account_tree" label={t('settings.tab.trace')} active={activeTab === 'trace'} onClick={() => setActiveTab('trace')} />
            <TabButton icon="monitor_heart" label={t('settings.tab.diagnostics')} active={activeTab === 'diagnostics'} onClick={() => setActiveTab('diagnostics')} />
          </div>
          <div className="mt-2 border-t border-[var(--color-border-separator)] pt-2">
            <TabButton icon="info" label={t('settings.tab.about')} active={activeTab === 'about'} onClick={() => setActiveTab('about')} />
          </div>
        </div>

        {/* Tab content; trace embeds a full-bleed page that manages its own scroll */}
        <div className={activeTab === 'trace' ? 'flex-1 flex min-h-0 flex-col overflow-hidden' : 'flex-1 overflow-y-auto px-9 py-8'}>
          {activeTab === 'providers' && <ProviderSettings />}
          {activeTab === 'activity' && <ActivitySettings />}
          {activeTab === 'general' && <GeneralSettings />}
          {activeTab === 'h5Access' && <H5AccessSettings />}
          {activeTab === 'adapters' && showPublicIm && <AdapterSettings />}
          {activeTab === 'terminal' && <TerminalSettings showPreferences />}
          {activeTab === 'mcp' && <McpSettings />}
          {activeTab === 'agents' && <AgentManager />}
          {activeTab === 'skills' && <SkillSettings />}
          {activeTab === 'memory' && <MemorySettings />}
          {activeTab === 'plugins' && showOfficialPlugins && <PluginSettings />}
          {activeTab === 'pets' && <PetSettings />}
          {activeTab === 'computerUse' && <ComputerUseSettings />}
          {activeTab === 'deploymentMode' && <DeploymentModeSettings />}
          {activeTab === 'trace' && <TraceList />}
          {activeTab === 'diagnostics' && <DiagnosticsSettings />}
          {activeTab === 'about' && <AboutSettings />}
        </div>
      </div>
    </div>
  )
}

function TabButton({ icon, label, active, onClick }: { icon: string; label: string; active: boolean; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)

  // The rail is taller than its viewport, and Settings remounts whenever the
  // tab is re-entered — from a trace tab's "back to list", say — with the
  // scroll position reset to the top. Without this the selected section can be
  // highlighted somewhere off-screen. `nearest` is a no-op when already visible.
  useEffect(() => {
    if (!active) return
    ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  return (
    <button
      ref={ref}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      // `ring-offset` has to name the rail's own fill — it is painted, not
      // transparent, so it tracks whatever the rail is.
      className={`w-full flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-[13.5px] text-left transition-[background-color,color] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] ${
        active
          ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)] font-medium'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
      }`}
    >
      <span
        className={`material-symbols-outlined text-[18px] ${active ? 'text-[var(--color-brand)]' : 'text-[var(--color-text-tertiary)]'}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}

// ─── Provider Settings ──────────────────────────────────────

type ProviderListItem =
  | { id: typeof OPENAI_OFFICIAL_PROVIDER_ID; kind: 'openai-official' }
  | { id: typeof GROK_OFFICIAL_PROVIDER_ID; kind: 'grok-official' }
  | { id: string; kind: 'saved'; provider: SavedProvider }

function defaultProviderOrder(providers: SavedProvider[]): string[] {
  return [
    ...providers.map((provider) => provider.id),
    ...BUILT_IN_PROVIDER_IDS,
  ]
}

function normalizeProviderOrder(providerOrder: string[] | undefined, providers: SavedProvider[]): string[] {
  const knownIds = new Set<string>(defaultProviderOrder(providers))
  const seen = new Set<string>()
  const order: string[] = []

  const source = providerOrder && providerOrder.length > 0
    ? providerOrder
    : defaultProviderOrder(providers)

  for (const id of source) {
    if (!knownIds.has(id) || seen.has(id)) continue
    seen.add(id)
    order.push(id)
  }

  for (const id of defaultProviderOrder(providers)) {
    if (seen.has(id)) continue
    seen.add(id)
    order.push(id)
  }

  return order
}

function buildProviderListItems(
  providers: SavedProvider[],
  providerOrder: string[] | undefined,
  options: { includeOfficialOAuth?: boolean } = {},
): ProviderListItem[] {
  const savedItems = new Map(
    providers.map((provider) => [
      provider.id,
      { id: provider.id, kind: 'saved', provider } satisfies ProviderListItem,
    ]),
  )
  const items = new Map<string, ProviderListItem>([
    ...(options.includeOfficialOAuth ?? true
      ? ([
          [OPENAI_OFFICIAL_PROVIDER_ID, { id: OPENAI_OFFICIAL_PROVIDER_ID, kind: 'openai-official' as const }],
          [GROK_OFFICIAL_PROVIDER_ID, { id: GROK_OFFICIAL_PROVIDER_ID, kind: 'grok-official' as const }],
        ] as const)
      : []),
    ...savedItems,
  ])

  return normalizeProviderOrder(providerOrder, providers)
    .map((id) => items.get(id))
    .filter((item): item is ProviderListItem => item !== undefined)
}

function providerItemTestId(item: ProviderListItem): string {
  switch (item.kind) {
    case 'openai-official':
      return 'openai-official-provider'
    case 'grok-official':
      return 'grok-official-provider'
    case 'saved':
      return `provider-${item.provider.id}`
  }
}

function ProviderSettings() {
  const {
    providers,
    providerOrder,
    activeId,
    hasLoadedProviders,
    presets,
    isLoading,
    fetchProviders,
    deleteProvider,
    reorderProviders,
    activateProvider,
    testProvider,
  } = useProviderStore()
  const fetchSettings = useSettingsStore((s) => s.fetchAll)
  const t = useTranslation()
  const [editingProvider, setEditingProvider] = useState<SavedProvider | null>(null)
  // Feature gate: hide official OAuth providers in private-cloud mode.
  const showOfficialOAuth = useFeatureGate('official-oauth')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showCcSwitchImport, setShowCcSwitchImport] = useState(false)
  const [pendingDeleteProvider, setPendingDeleteProvider] = useState<SavedProvider | null>(null)
  const [isDeletingProvider, setIsDeletingProvider] = useState(false)
  const [testResults, setTestResults] = useState<Record<string, { loading: boolean; result?: ProviderTestResult }>>({})
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  useEffect(() => {
    void fetchProviders()
  }, [fetchProviders])

  const presetMap = useMemo(
    () => new Map(presets.map((preset) => [preset.id, preset])),
    [presets],
  )

  const handleDelete = async (provider: SavedProvider) => {
    if (activeId === provider.id) return
    setPendingDeleteProvider(provider)
  }

  const confirmDelete = async () => {
    if (!pendingDeleteProvider) return
    setIsDeletingProvider(true)
    try {
      await deleteProvider(pendingDeleteProvider.id)
      setPendingDeleteProvider(null)
    } catch (error) {
      console.error(error)
    } finally {
      setIsDeletingProvider(false)
    }
  }

  const handleTest = async (provider: SavedProvider) => {
    setTestResults((r) => ({ ...r, [provider.id]: { loading: true } }))
    try {
      const result = await testProvider(provider.id)
      setTestResults((r) => ({ ...r, [provider.id]: { loading: false, result } }))
    } catch {
      setTestResults((r) => ({ ...r, [provider.id]: { loading: false, result: { connectivity: { success: false, latencyMs: 0, error: t('settings.providers.requestFailed') } } } }))
    }
  }

  const handleActivate = async (id: string) => {
    await activateProvider(id)
    await fetchSettings()
  }

  const providerItems = useMemo(
    () => buildProviderListItems(providers, providerOrder, { includeOfficialOAuth: showOfficialOAuth }),
    [providers, providerOrder, showOfficialOAuth],
  )

  const handleProviderDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const ids = providerItems.map((item) => item.id)
    const oldIndex = ids.indexOf(String(active.id))
    const newIndex = ids.indexOf(String(over.id))
    if (oldIndex === -1 || newIndex === -1) return

    void reorderProviders(arrayMove(ids, oldIndex, newIndex))
  }

  const isOpenAIOfficialActive = hasLoadedProviders && activeId === OPENAI_OFFICIAL_PROVIDER_ID
  const isGrokOfficialActive = hasLoadedProviders && activeId === GROK_OFFICIAL_PROVIDER_ID

  return (
    <div className="max-w-2xl">
      <SettingsPageHeader
        title={t('settings.providers.title')}
        description={t('settings.providers.description')}
        action={(
          <>
            <Button
              variant="secondary"
              size="base"
              onClick={() => setShowCcSwitchImport(true)}
              icon={<span className="material-symbols-outlined text-[16px]">download</span>}
            >
              {t('settings.providers.ccSwitch.importButton')}
            </Button>
            <Button
              size="base"
              onClick={() => setShowCreateModal(true)}
              icon={<span className="material-symbols-outlined text-[16px]">add</span>}
            >
              {t('settings.providers.addProvider')}
            </Button>
          </>
        )}
      />

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleProviderDragEnd}
      >
        <SortableContext
          items={providerItems.map((item) => item.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="flex flex-col gap-2">
            {providerItems.map((item) => {
              if (item.kind === 'openai-official') {
                return (
                  <SortableProviderCard
                    key={item.id}
                    item={item}
                    isActive={isOpenAIOfficialActive}
                    dragLabel={t('settings.providers.dragToReorder')}
                    onActivate={!isOpenAIOfficialActive ? () => handleActivate(OPENAI_OFFICIAL_PROVIDER_ID) : undefined}
                    title={t('settings.providers.openaiOfficialName')}
                    subtitle={t('settings.providers.openaiOfficialDesc')}
                    badges={isOpenAIOfficialActive ? (
                      <Badge tone="brand" bordered>{t('settings.providers.default')}</Badge>
                    ) : null}
                    details={isOpenAIOfficialActive ? (
                      <div className="border-t border-[var(--color-border-separator)] px-4 pb-4 pt-3">
                        <ChatGPTOfficialLogin />
                      </div>
                    ) : null}
                  />
                )
              }

              if (item.kind === 'grok-official') {
                return (
                  <SortableProviderCard
                    key={item.id}
                    item={item}
                    isActive={isGrokOfficialActive}
                    dragLabel={t('settings.providers.dragToReorder')}
                    onActivate={!isGrokOfficialActive ? () => handleActivate(GROK_OFFICIAL_PROVIDER_ID) : undefined}
                    title={t('settings.providers.grokOfficialName')}
                    subtitle={t('settings.providers.grokOfficialDesc')}
                    badges={isGrokOfficialActive ? (
                      <Badge tone="brand" bordered>{t('settings.providers.default')}</Badge>
                    ) : null}
                    details={isGrokOfficialActive ? (
                      <div className="border-t border-[var(--color-border-separator)] px-4 pb-4 pt-3">
                        <GrokOfficialLogin />
                      </div>
                    ) : null}
                  />
                )
              }

              const provider = item.provider
              const isActive = activeId === provider.id
              const test = testResults[provider.id]
              const preset = presetMap.get(provider.presetId)

              return (
                <SortableProviderCard
                  key={item.id}
                  item={item}
                  isActive={isActive}
                  dragLabel={t('settings.providers.dragToReorder')}
                  onActivate={!isActive ? () => handleActivate(provider.id) : undefined}
                  title={provider.name}
                  subtitle={<span className="font-mono text-[11.5px]">{`${provider.baseUrl} · ${provider.models.main}`}</span>}
                  badges={(
                    <>
                      {preset && preset.id !== 'custom' && (
                        <Badge tone="neutral">{preset.name}</Badge>
                      )}
                      {provider.apiFormat && provider.apiFormat !== 'anthropic' && (
                        <Badge tone="warning">
                          {provider.apiFormat === 'openai_chat' ? 'OpenAI Chat' : 'OpenAI Responses'}
                        </Badge>
                      )}
                      {isActive && (
                        <Badge tone="brand" bordered>{t('settings.providers.default')}</Badge>
                      )}
                    </>
                  )}
                  result={test && !test.loading && test.result ? (
                    <div className="mt-1 flex flex-col gap-0.5 text-xs">
                      <span className={test.result.connectivity.success ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'}>
                        {test.result.connectivity.success
                          ? t('settings.providers.connectivityOk', { latency: String(test.result.connectivity.latencyMs) })
                          : t('settings.providers.connectivityFailed', { error: test.result.connectivity.error || '' })}
                      </span>
                      {test.result.proxy && (
                        <span className={test.result.proxy.success ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'}>
                          {test.result.proxy.success
                            ? t('settings.providers.proxyOk', { latency: String(test.result.proxy.latencyMs) })
                            : t('settings.providers.proxyFailed', { error: test.result.proxy.error || '' })}
                        </span>
                      )}
                    </div>
                  ) : null}
                  actions={(
                    <>
                      {!isActive && (
                        <Button variant="ghost" size="sm" onClick={() => handleActivate(provider.id)}>{t('settings.providers.setDefault')}</Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => handleTest(provider)} loading={test?.loading}>{t('settings.providers.test')}</Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditingProvider(provider)}>{t('settings.providers.edit')}</Button>
                      {!isActive && (
                        <Button variant="ghost" size="sm" onClick={() => handleDelete(provider)} className="text-[var(--color-error)] hover:text-[var(--color-error)]">{t('common.delete')}</Button>
                      )}
                    </>
                  )}
                />
              )
            })}
          </div>
        </SortableContext>
      </DndContext>

      {isLoading && providers.length === 0 ? (
        <div className="flex justify-center py-8">
          <Spinner size={20} tone="brand" label={t('common.loading')} />
        </div>
      ) : null}

      {/* Create Modal — conditionally rendered so state resets on close */}
      {showCreateModal && (
        <ProviderFormModal open={true} onClose={() => setShowCreateModal(false)} mode="create" presets={presets} />
      )}

      {/* Edit Modal */}
      {editingProvider && (
        <ProviderFormModal key={editingProvider.id} open={true} onClose={() => setEditingProvider(null)} mode="edit" provider={editingProvider} presets={presets} />
      )}

      {/* cc-switch import — conditionally rendered so the scan reruns each time */}
      {showCcSwitchImport && (
        <CcSwitchImportModal open={true} onClose={() => setShowCcSwitchImport(false)} />
      )}

      <ConfirmDialog
        open={pendingDeleteProvider !== null}
        onClose={() => {
          if (isDeletingProvider) return
          setPendingDeleteProvider(null)
        }}
        onConfirm={confirmDelete}
        title={t('common.delete')}
        body={pendingDeleteProvider ? t('settings.providers.confirmDelete', { name: pendingDeleteProvider.name }) : ''}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={isDeletingProvider}
      />
    </div>
  )
}

type SortableProviderCardProps = {
  item: ProviderListItem
  isActive: boolean
  dragLabel: string
  title: ReactNode
  subtitle: ReactNode
  badges?: ReactNode
  result?: ReactNode
  actions?: ReactNode
  details?: ReactNode
  onActivate?: () => void
}

function SortableProviderCard({
  item,
  isActive,
  dragLabel,
  title,
  subtitle,
  badges,
  result,
  actions,
  details,
  onActivate,
}: SortableProviderCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={providerItemTestId(item)}
      className={`group relative flex flex-col rounded-[var(--radius-xl)] transition-[background-color,border-color,box-shadow] duration-150 ease-out ${
        isActive
          ? 'border-[1.5px] border-[var(--color-primary-fixed-dim)] bg-[var(--color-surface-container-low)]'
          : 'border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] hover:border-[var(--color-outline)] hover:bg-[var(--color-surface-hover)]'
      } ${isDragging ? 'shadow-[var(--shadow-overlay)] opacity-90' : ''}`}
    >
      <div className="flex items-center gap-2 px-3.5 py-3">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={dragLabel}
          title={dragLabel}
          className="flex h-8 w-8 shrink-0 cursor-grab items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-container-high)] hover:text-[var(--color-text-secondary)] focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] active:cursor-grabbing"
          style={{ touchAction: 'none' }}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onActivate}
          aria-disabled={!onActivate}
          className={`flex min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-sm)] text-left focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] ${
            onActivate ? 'cursor-pointer' : 'cursor-default'
          }`}
        >
          <StatusDot tone={isActive ? 'success' : 'neutral'} size="lg" />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{title}</span>
              {badges}
            </span>
            <span className="mt-1 block truncate text-[12px] text-[var(--color-text-tertiary)]">{subtitle}</span>
            {result}
          </span>
        </button>
        {actions && (
          <div className="flex shrink-0 items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
            {actions}
          </div>
        )}
      </div>
      {details}
    </div>
  )
}

// ─── Provider Form Modal ──────────────────────────────────────

type ProviderFormProps = {
  open: boolean
  onClose: () => void
  mode: 'create' | 'edit'
  provider?: SavedProvider
  presets: ProviderPreset[]
}

function requirePreset(preset: ProviderPreset | undefined): ProviderPreset {
  if (!preset) {
    throw new Error('Provider presets are not configured')
  }
  return preset
}

const AUTO_COMPACT_WINDOW_ENV_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
const MODEL_CONTEXT_WINDOWS_ENV_KEY = 'CLAUDE_CODE_MODEL_CONTEXT_WINDOWS'
const DISABLE_EXPERIMENTAL_BETAS_ENV_KEY = 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'
const DEFAULT_MODEL_1M_SUPPORT: Model1mSupport = {
  main: false,
  haiku: false,
  sonnet: false,
  opus: false,
}
const DEFAULT_PROVIDER_AUTH_STRATEGY: ProviderAuthStrategy = 'auth_token'
const AUTH_ENV_KEYS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])

function formatContextWindow(value: number): string {
  return value.toLocaleString('en-US')
}

function getPresetAutoCompactWindow(preset: ProviderPreset): string {
  return preset.defaultEnv?.[AUTO_COMPACT_WINDOW_ENV_KEY] ?? ''
}

function getPresetAuthStrategy(preset: ProviderPreset): ProviderAuthStrategy {
  return preset.authStrategy ?? DEFAULT_PROVIDER_AUTH_STRATEGY
}

function omitAuthEnv(env: Record<string, string> | undefined): Record<string, string> {
  if (!env) return {}
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !AUTH_ENV_KEYS.has(key.toUpperCase())),
  )
}

function getProviderAuthValue(apiKey: string, preset: ProviderPreset): string {
  return apiKey || preset.defaultEnv?.ANTHROPIC_AUTH_TOKEN || preset.defaultEnv?.ANTHROPIC_API_KEY || (preset.needsApiKey ? '(your API key)' : '')
}

function buildSettingsJsonAuthEnv(
  apiFormat: ApiFormat,
  authStrategy: ProviderAuthStrategy,
  apiKey: string,
  preset: ProviderPreset,
): Record<string, string> {
  if (apiFormat !== 'anthropic') {
    return { ANTHROPIC_API_KEY: 'proxy-managed' }
  }

  const value = getProviderAuthValue(apiKey, preset)
  switch (authStrategy) {
    case 'api_key':
      return value ? { ANTHROPIC_API_KEY: value } : {}
    case 'auth_token':
      return value ? { ANTHROPIC_AUTH_TOKEN: value } : {}
    case 'auth_token_empty_api_key':
      return {
        ANTHROPIC_API_KEY: '',
        ...(value ? { ANTHROPIC_AUTH_TOKEN: value } : {}),
      }
    case 'dual_same_token':
      return value ? { ANTHROPIC_API_KEY: value, ANTHROPIC_AUTH_TOKEN: value } : {}
    case 'dual_dummy':
      return { ANTHROPIC_API_KEY: 'dummy', ANTHROPIC_AUTH_TOKEN: 'dummy' }
  }
}

function inferAuthStrategyFromEnv(env: Record<string, string>): ProviderAuthStrategy | null {
  if (env.ANTHROPIC_API_KEY === 'dummy' && env.ANTHROPIC_AUTH_TOKEN === 'dummy') return 'dual_dummy'
  if (env.ANTHROPIC_API_KEY === '' && env.ANTHROPIC_AUTH_TOKEN) return 'auth_token_empty_api_key'
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_AUTH_TOKEN && env.ANTHROPIC_API_KEY === env.ANTHROPIC_AUTH_TOKEN) return 'dual_same_token'
  if (env.ANTHROPIC_AUTH_TOKEN) return 'auth_token'
  if (env.ANTHROPIC_API_KEY) return 'api_key'
  return null
}

function getPresetContextInputValue(model: string | undefined, preset: ProviderPreset): string {
  const trimmedModel = model?.trim()
  if (!trimmedModel) return ''
  const value = preset.modelContextWindows?.[trimmedModel]
  return value !== undefined ? String(value) : ''
}

function getModelContextInputValue(
  model: string | undefined,
  preset: ProviderPreset,
  provider?: SavedProvider,
): string {
  const trimmedModel = model?.trim()
  if (!trimmedModel) return ''
  const saved = provider?.modelContextWindows?.[trimmedModel]
  if (saved !== undefined) return String(saved)
  return getPresetContextInputValue(trimmedModel, preset)
}

function getModelContextInputs(
  models: ModelMapping,
  preset: ProviderPreset,
  provider?: SavedProvider,
): ModelContextInputs {
  const inputs = {} as ModelContextInputs
  for (const slot of MODEL_SLOTS) {
    inputs[slot] = getModelContextInputValue(models[slot], preset, provider)
  }
  return inputs
}

function buildModelContextWindows(
  models: ModelMapping,
  inputs: ModelContextInputs,
): Record<string, number> {
  const windows: Record<string, number> = {}
  for (const slot of MODEL_SLOTS) {
    const model = models[slot]?.trim()
    const parsed = parseModelContextWindowsInput(inputs[slot])
    if (model && parsed !== undefined) {
      windows[model] = parsed
    }
  }
  return windows
}

function hasModel1mMarker(model: string): boolean {
  return /\[1m\]$/i.test(model.trim()) || /:1m$/i.test(model.trim())
}

function stripModel1mMarker(model: string): string {
  return model.trim().replace(/\[1m\]$/i, '').replace(/:1m$/i, '').trim()
}

function stripModel1mMarkers(models: ModelMapping): ModelMapping {
  return {
    main: stripModel1mMarker(models.main),
    ...(models.fable ? { fable: stripModel1mMarker(models.fable) } : {}),
    haiku: stripModel1mMarker(models.haiku),
    sonnet: stripModel1mMarker(models.sonnet),
    opus: stripModel1mMarker(models.opus),
  }
}

function getInitialModel1mSupport(
  models: ModelMapping,
  provider?: SavedProvider,
): Model1mSupport {
  return {
    main: provider?.model1mSupport?.main === true || hasModel1mMarker(models.main),
    haiku: provider?.model1mSupport?.haiku === true || hasModel1mMarker(models.haiku),
    sonnet: provider?.model1mSupport?.sonnet === true || hasModel1mMarker(models.sonnet),
    opus: provider?.model1mSupport?.opus === true || hasModel1mMarker(models.opus),
  }
}

function applyModel1mSupport(model: string, enabled: boolean): string {
  const stripped = stripModel1mMarker(model)
  return enabled && stripped ? `${stripped}[1m]` : stripped
}

function applyModel1mSupportMapping(
  models: ModelMapping,
  model1mSupport: Model1mSupport,
): ModelMapping {
  return {
    main: applyModel1mSupport(models.main, model1mSupport.main),
    ...(models.fable ? { fable: stripModel1mMarker(models.fable) } : {}),
    haiku: applyModel1mSupport(models.haiku, model1mSupport.haiku),
    sonnet: applyModel1mSupport(models.sonnet, model1mSupport.sonnet),
    opus: applyModel1mSupport(models.opus, model1mSupport.opus),
  }
}

function hasAnyModel1mSupport(model1mSupport: Model1mSupport): boolean {
  return MODEL_SLOTS.some((slot) => model1mSupport[slot])
}

function normalizeModelMapping(models: ModelMapping): ModelMapping {
  const main = models.main.trim()
  return {
    main,
    ...(models.fable?.trim() ? { fable: models.fable.trim() } : {}),
    haiku: models.haiku.trim() || main,
    sonnet: models.sonnet.trim() || main,
    opus: models.opus.trim() || main,
  }
}

function readSettingsEnvString(env: Record<string, unknown>, key: string): string | undefined {
  const value = env[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function readModelMappingFromSettingsEnv(env: Record<string, unknown>): Partial<ModelMapping> {
  const hasModelEnv = [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
  ].some((key) => Object.prototype.hasOwnProperty.call(env, key))
  const fable = readSettingsEnvString(env, 'ANTHROPIC_DEFAULT_FABLE_MODEL')
  const haiku = readSettingsEnvString(env, 'ANTHROPIC_DEFAULT_HAIKU_MODEL')
  const sonnet = readSettingsEnvString(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL')
  const opus = readSettingsEnvString(env, 'ANTHROPIC_DEFAULT_OPUS_MODEL')
  const main = readSettingsEnvString(env, 'ANTHROPIC_MODEL') ?? sonnet ?? haiku ?? opus

  return {
    ...(main ? { main } : {}),
    ...(hasModelEnv ? { fable } : {}),
    ...(haiku ? { haiku } : {}),
    ...(sonnet ? { sonnet } : {}),
    ...(opus ? { opus } : {}),
  }
}

function applyToolSearchEnv(
  env: Record<string, unknown>,
  apiFormat: ApiFormat,
  toolSearchEnabled: boolean,
): void {
  delete env.ENABLE_TOOL_SEARCH
  if (apiFormat === 'anthropic') {
    env.ENABLE_TOOL_SEARCH = toolSearchEnabled ? 'true' : 'false'
  }
}

function applyDisableExperimentalBetasEnv(
  env: Record<string, unknown>,
  disableExperimentalBetas: boolean,
): void {
  if (disableExperimentalBetas) {
    env[DISABLE_EXPERIMENTAL_BETAS_ENV_KEY] = '1'
  } else {
    delete env[DISABLE_EXPERIMENTAL_BETAS_ENV_KEY]
  }
}

function updateSettingsJsonToolSearch(
  raw: string,
  apiFormat: ApiFormat,
  toolSearchEnabled: boolean,
): string {
  try {
    const parsed = JSON.parse(raw || '{}') as { env?: Record<string, unknown> }
    const existingEnv = parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
      ? parsed.env
      : {}
    const env = { ...existingEnv }
    applyToolSearchEnv(env, apiFormat, toolSearchEnabled)
    parsed.env = env
    return JSON.stringify(parsed, null, 2)
  } catch {
    return raw
  }
}

function updateSettingsJsonDisableExperimentalBetas(
  raw: string,
  disableExperimentalBetas: boolean,
): string {
  try {
    const parsed = JSON.parse(raw || '{}') as { env?: Record<string, unknown> }
    const existingEnv = parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
      ? parsed.env
      : {}
    const env = { ...existingEnv }
    applyDisableExperimentalBetasEnv(env, disableExperimentalBetas)
    parsed.env = env
    return JSON.stringify(parsed, null, 2)
  } catch {
    return raw
  }
}

function readToolSearchEnabledFromEnv(env: Record<string, unknown>): boolean {
  const value = env.ENABLE_TOOL_SEARCH
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['0', 'false', 'off', 'no'].includes(normalized)) return false
    if (['1', 'true', 'on', 'yes', 'auto'].includes(normalized) || normalized.startsWith('auto:')) {
      return true
    }
  }
  return true
}

function readDisableExperimentalBetasFromEnv(env: Record<string, unknown>): boolean {
  const value = env[DISABLE_EXPERIMENTAL_BETAS_ENV_KEY]
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['0', 'false', 'off', 'no'].includes(normalized)) return false
    if (['1', 'true', 'on', 'yes'].includes(normalized)) return true
  }
  return false
}

function updateSettingsJsonAutoCompactWindow(raw: string, value: string): string {
  try {
    const parsed = JSON.parse(raw || '{}') as { env?: Record<string, unknown> }
    const existingEnv = parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
      ? parsed.env
      : {}
    const env = { ...existingEnv }
    const trimmed = value.trim()
    if (trimmed) {
      env[AUTO_COMPACT_WINDOW_ENV_KEY] = trimmed
    } else {
      delete env[AUTO_COMPACT_WINDOW_ENV_KEY]
    }
    parsed.env = env
    return JSON.stringify(parsed, null, 2)
  } catch {
    return raw
  }
}

function updateSettingsJsonModelContextWindows(
  raw: string,
  modelContextWindows: Record<string, number>,
): string {
  try {
    const parsed = JSON.parse(raw || '{}') as { env?: Record<string, unknown> }
    const existingEnv = parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
      ? parsed.env
      : {}
    const env = { ...existingEnv }
    if (Object.keys(modelContextWindows).length > 0) {
      env[MODEL_CONTEXT_WINDOWS_ENV_KEY] = JSON.stringify(modelContextWindows)
    } else {
      delete env[MODEL_CONTEXT_WINDOWS_ENV_KEY]
    }
    parsed.env = env
    return JSON.stringify(parsed, null, 2)
  } catch {
    return raw
  }
}

function updateSettingsJsonModels(
  raw: string,
  models: ModelMapping,
  model1mSupport: Model1mSupport = DEFAULT_MODEL_1M_SUPPORT,
): string {
  try {
    const parsed = JSON.parse(raw || '{}') as { env?: Record<string, unknown> }
    const existingEnv = parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
      ? parsed.env
      : {}
    const runtimeModels = applyModel1mSupportMapping(models, model1mSupport)
    const env = { ...existingEnv }
    delete env.ANTHROPIC_DEFAULT_FABLE_MODEL
    delete env.ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION
    delete env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME
    delete env.ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES
    parsed.env = {
      ...env,
      ANTHROPIC_MODEL: runtimeModels.main,
      ...(runtimeModels.fable ? { ANTHROPIC_DEFAULT_FABLE_MODEL: runtimeModels.fable } : {}),
      ANTHROPIC_DEFAULT_HAIKU_MODEL: runtimeModels.haiku,
      ANTHROPIC_DEFAULT_SONNET_MODEL: runtimeModels.sonnet,
      ANTHROPIC_DEFAULT_OPUS_MODEL: runtimeModels.opus,
    }
    return JSON.stringify(parsed, null, 2)
  } catch {
    return raw
  }
}

function updateSettingsJsonProviderConnection(
  raw: string,
  apiFormat: ApiFormat,
  authStrategy: ProviderAuthStrategy,
  apiKey: string,
  preset: ProviderPreset,
  baseUrl: string,
  proxyBaseUrl: string,
  toolSearchEnabled = true,
  disableExperimentalBetas = false,
): string {
  try {
    const parsed = JSON.parse(raw || '{}') as { env?: Record<string, unknown> }
    const existingEnv = parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
      ? parsed.env
      : {}
    const env = { ...existingEnv }
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    applyToolSearchEnv(env, apiFormat, toolSearchEnabled)
    applyDisableExperimentalBetasEnv(env, disableExperimentalBetas)
    env.ANTHROPIC_BASE_URL = apiFormat !== 'anthropic' ? proxyBaseUrl : baseUrl
    Object.assign(env, buildSettingsJsonAuthEnv(apiFormat, authStrategy, apiKey, preset))
    parsed.env = env
    return JSON.stringify(parsed, null, 2)
  } catch {
    return raw
  }
}

function getProviderProxyBaseUrl(): string {
  return `${getBaseUrl().replace(/\/$/, '')}/proxy`
}

function buildFallbackPreset(provider?: SavedProvider): ProviderPreset {
  return {
    id: provider?.presetId ?? 'custom',
    name: provider?.name ?? 'Custom',
    baseUrl: provider?.baseUrl ?? '',
    apiFormat: provider?.apiFormat ?? 'anthropic',
    authStrategy: provider?.authStrategy,
    defaultModels: provider?.models ?? { main: '', haiku: '', sonnet: '', opus: '' },
    modelContextWindows: provider?.modelContextWindows,
    defaultEnv: provider?.autoCompactWindow !== undefined
      ? { [AUTO_COMPACT_WINDOW_ENV_KEY]: String(provider.autoCompactWindow) }
      : undefined,
    needsApiKey: true,
    websiteUrl: '',
  }
}

function openExternalUrl(url: string) {
  void getDesktopHost().shell.open(url)
    .catch(() => window.open(url, '_blank', 'noopener,noreferrer'))
}

function ProviderFormModal({ open, onClose, mode, provider, presets }: ProviderFormProps) {
  const { createProvider, updateProvider, testConfig, fetchModels } = useProviderStore()
  const fetchSettings = useSettingsStore((s) => s.fetchAll)
  const t = useTranslation()

  const fallbackPreset = buildFallbackPreset(provider)
  const loadedPresets = presets.filter((p) => p.id !== 'official')
  // Keeps retired presets, so editing a provider already saved against one still
  // resolves the preset behind its presetId instead of falling back.
  const availablePresets = loadedPresets.length > 0 ? loadedPresets : [fallbackPreset]
  // Retired presets must never be offered when adding a provider.
  const selectablePresets = selectableProviderPresets(availablePresets)
  const regularPresets = selectablePresets.filter((p) => !p.featured)
  const featuredPresets = selectablePresets.filter((p) => p.featured)
  const presetDefaultEnvKeys = useMemo(
    () => presets.flatMap((preset) => Object.keys(preset.defaultEnv ?? {})),
    [presets],
  )
  const initialPreset = provider
    ? availablePresets.find((p) => p.id === provider.presetId) ?? fallbackPreset
    : selectablePresets[0] ?? fallbackPreset
  const initialModels = stripModel1mMarkers(provider?.models ?? initialPreset.defaultModels)
  const initialModel1mSupport = getInitialModel1mSupport(
    provider?.models ?? initialPreset.defaultModels,
    provider,
  )
  const initialModelContextInputs = apply1mSupportToContextInputs(
    getModelContextInputs(initialModels, initialPreset, provider),
    initialModel1mSupport,
  )

  const [selectedPreset, setSelectedPreset] = useState<ProviderPreset>(initialPreset)
  const [name, setName] = useState(provider?.name ?? initialPreset.name)
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? initialPreset.baseUrl)
  const [apiFormat, setApiFormat] = useState<ApiFormat>(provider?.apiFormat ?? initialPreset.apiFormat ?? 'anthropic')
  const [authStrategy, setAuthStrategy] = useState<ProviderAuthStrategy>(provider?.authStrategy ?? getPresetAuthStrategy(initialPreset))
  const [apiKey, setApiKey] = useState(provider?.apiKey ?? '')
  const [showApiKey, setShowApiKey] = useState(false)
  const [notes, setNotes] = useState(provider?.notes ?? '')
  const [models, setModels] = useState<ModelMapping>(initialModels)
  const [model1mSupport, setModel1mSupport] = useState<Model1mSupport>(initialModel1mSupport)
  const [modelContextInputs, setModelContextInputs] = useState<ModelContextInputs>(initialModelContextInputs)
  const [autoCompactWindow, setAutoCompactWindow] = useState(
    provider?.autoCompactWindow !== undefined
      ? String(provider.autoCompactWindow)
      : getPresetAutoCompactWindow(initialPreset),
  )
  const [toolSearchEnabled, setToolSearchEnabled] = useState(provider?.toolSearchEnabled ?? true)
  const [disableExperimentalBetas, setDisableExperimentalBetas] = useState(provider?.disableExperimentalBetas ?? false)
  const [showContextSettings, setShowContextSettings] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null)
  const [isTesting, setIsTesting] = useState(false)
  const [fetchedModels, setFetchedModels] = useState<ProviderModelInfo[] | null>(null)
  const [modelsErrorCode, setModelsErrorCode] = useState<ProviderModelsErrorCode | null>(null)
  const [modelsErrorMessage, setModelsErrorMessage] = useState<string | null>(null)
  const [isFetchingModels, setIsFetchingModels] = useState(false)
  const modelsRequestRef = useRef(0)
  const [settingsJson, setSettingsJson] = useState('')
  const [settingsJsonError, setSettingsJsonError] = useState<string | null>(null)
  const jsonPastedRef = useRef(false)
  const providerProxyBaseUrl = useMemo(() => getProviderProxyBaseUrl(), [])

  // Load current settings.json and merge provider env vars
  useEffect(() => {
    // Skip if JSON was just populated by user paste
    if (jsonPastedRef.current) {
      jsonPastedRef.current = false
      return
    }
    import('../api/providers').then(({ providersApi }) => {
      providersApi.getSettings().then((settings) => {
        const needsProxy = apiFormat !== 'anthropic'
        const autoCompactWindowEnv = autoCompactWindow.trim()
        const modelContextWindows = buildModelContextWindows(models, modelContextInputs)
        const normalizedModels = normalizeModelMapping(models)
        const runtimeModels = applyModel1mSupportMapping(normalizedModels, model1mSupport)
        const existingEnv = (settings.env as Record<string, string>) || {}
        const cleanedEnv = stripProviderSettingsJsonEnv(existingEnv, presetDefaultEnvKeys)
        const mergedEnv: Record<string, unknown> = {
          ...cleanedEnv,
          ...omitAuthEnv(selectedPreset.defaultEnv),
          ...(autoCompactWindowEnv ? { [AUTO_COMPACT_WINDOW_ENV_KEY]: autoCompactWindowEnv } : {}),
          ...(Object.keys(modelContextWindows).length > 0
            ? { [MODEL_CONTEXT_WINDOWS_ENV_KEY]: JSON.stringify(modelContextWindows) }
            : {}),
          ANTHROPIC_BASE_URL: needsProxy ? providerProxyBaseUrl : baseUrl,
          ...buildSettingsJsonAuthEnv(apiFormat, authStrategy, apiKey, selectedPreset),
          ANTHROPIC_MODEL: runtimeModels.main,
          ...(runtimeModels.fable ? { ANTHROPIC_DEFAULT_FABLE_MODEL: runtimeModels.fable } : {}),
          ANTHROPIC_DEFAULT_HAIKU_MODEL: runtimeModels.haiku,
          ANTHROPIC_DEFAULT_SONNET_MODEL: runtimeModels.sonnet,
          ANTHROPIC_DEFAULT_OPUS_MODEL: runtimeModels.opus,
        }
        applyToolSearchEnv(mergedEnv, apiFormat, toolSearchEnabled)
        applyDisableExperimentalBetasEnv(mergedEnv, disableExperimentalBetas)
        const merged = {
          ...settings,
          skipWebFetchPreflight: settings.skipWebFetchPreflight ?? true,
          env: mergedEnv,
        }
        setSettingsJson(JSON.stringify(merged, null, 2))
      }).catch(() => {
        setSettingsJson(JSON.stringify({}, null, 2))
      })
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPreset.id, providerProxyBaseUrl])

  // A fetched list only describes the endpoint and key it came from. cc-switch
  // shipped this without a guard and kept offering the previous provider's
  // models after the user pasted a new key, which reads as the picker lying.
  useEffect(() => {
    // Bumping the token also disowns a probe that is still in flight: it walks
    // up to three candidate endpoints at 15s each, so it can easily outlive the
    // edit and re-fill the picker with the previous credentials' models.
    modelsRequestRef.current += 1
    setFetchedModels(null)
    setModelsErrorCode(null)
    setModelsErrorMessage(null)
    setIsFetchingModels(false)
  }, [baseUrl, apiKey])

  const handlePresetChange = (preset: ProviderPreset) => {
    setSelectedPreset(preset)
    setName(preset.name)
    setBaseUrl(preset.baseUrl)
    setApiFormat(preset.apiFormat ?? 'anthropic')
    setAuthStrategy(getPresetAuthStrategy(preset))
    const nextModels = stripModel1mMarkers(preset.defaultModels)
    const nextModel1mSupport = getInitialModel1mSupport(preset.defaultModels)
    const nextModelContextInputs = apply1mSupportToContextInputs(
      getModelContextInputs(nextModels, preset),
      nextModel1mSupport,
    )
    setModels(nextModels)
    setModel1mSupport(nextModel1mSupport)
    setModelContextInputs(nextModelContextInputs)
    setAutoCompactWindow(getPresetAutoCompactWindow(preset))
    setToolSearchEnabled(true)
    setDisableExperimentalBetas(false)
    setShowContextSettings(false)
    setTestResult(null)
  }

  const isCustom = selectedPreset.id === 'custom'
  const requiresApiKey = selectedPreset.needsApiKey !== false
  const autoCompactWindowErrorKey = getAutoCompactWindowErrorKey(autoCompactWindow)
  const modelContextWindowErrorSlots = MODEL_SLOTS.filter((slot) => getModelContextWindowErrorKey(modelContextInputs[slot]))
  const canSubmit = name.trim() && baseUrl.trim() && (mode === 'edit' || !requiresApiKey || apiKey.trim()) && models.main.trim() && !settingsJsonError && !autoCompactWindowErrorKey && modelContextWindowErrorSlots.length === 0
  const apiKeyUrl = selectedPreset.apiKeyUrl?.trim()
  const promoText = selectedPreset.promoText?.trim()
  const displayedSettingsJson = showApiKey
    ? settingsJson
    : maskSettingsJsonSecrets(settingsJson)
  const apiFormatItems = [
    {
      value: 'anthropic' as const,
      label: t('settings.providers.apiFormatAnthropic'),
      icon: <span className="material-symbols-outlined text-[17px]">hub</span>,
    },
    {
      value: 'openai_chat' as const,
      label: t('settings.providers.apiFormatOpenaiChat'),
      icon: <span className="material-symbols-outlined text-[17px]">forum</span>,
    },
    {
      value: 'openai_responses' as const,
      label: t('settings.providers.apiFormatOpenaiResponses'),
      icon: <span className="material-symbols-outlined text-[17px]">route</span>,
    },
  ]
  const selectedApiFormatLabel = apiFormatItems.find((item) => item.value === apiFormat)?.label ?? t('settings.providers.apiFormatAnthropic')
  const authStrategyItems = [
    {
      value: 'auth_token' as const,
      label: t('settings.providers.authStrategyAuthToken'),
      description: t('settings.providers.authStrategyAuthTokenDesc'),
      icon: <span className="material-symbols-outlined text-[17px]">key</span>,
    },
    {
      value: 'auth_token_empty_api_key' as const,
      label: t('settings.providers.authStrategyAuthTokenEmptyApiKey'),
      description: t('settings.providers.authStrategyAuthTokenEmptyApiKeyDesc'),
      icon: <span className="material-symbols-outlined text-[17px]">key_off</span>,
    },
    {
      value: 'api_key' as const,
      label: t('settings.providers.authStrategyApiKey'),
      description: t('settings.providers.authStrategyApiKeyDesc'),
      icon: <span className="material-symbols-outlined text-[17px]">vpn_key</span>,
    },
    {
      value: 'dual_same_token' as const,
      label: t('settings.providers.authStrategyDualSameToken'),
      description: t('settings.providers.authStrategyDualSameTokenDesc'),
      icon: <span className="material-symbols-outlined text-[17px]">sync_alt</span>,
    },
    {
      value: 'dual_dummy' as const,
      label: t('settings.providers.authStrategyDualDummy'),
      description: t('settings.providers.authStrategyDualDummyDesc'),
      icon: <span className="material-symbols-outlined text-[17px]">construction</span>,
    },
  ] satisfies Array<{ value: ProviderAuthStrategy; label: string; description: string; icon: ReactNode }>
  const selectedAuthStrategyLabel = authStrategyItems.find((item) => item.value === authStrategy)?.label ?? t('settings.providers.authStrategyAuthToken')
  const toolSearchUnsupported = apiFormat !== 'anthropic'
  const toolSearchDescription = toolSearchUnsupported
    ? t('settings.providers.toolSearchUnsupported')
    : t('settings.providers.toolSearchDesc')
  const configuredContextWindows = buildModelContextWindows(models, modelContextInputs)
  const configuredContextSummary = Object.entries(configuredContextWindows)
    .filter(([model], index, entries) => entries.findIndex(([candidate]) => candidate === model) === index)
    .map(([model, value]) => `${model}: ${formatContextWindow(value)}`)
  const parsedFallbackContextWindow = parseAutoCompactWindowInput(autoCompactWindow)
  const fallbackContextSummary = parsedFallbackContextWindow !== undefined
    ? t('settings.providers.contextFallbackSummary', {
      tokens: formatContextWindow(parsedFallbackContextWindow),
    })
    : t('settings.providers.contextFallbackAuto')
  const contextSummary = configuredContextSummary.length > 0
    ? [...configuredContextSummary, fallbackContextSummary].join(' · ')
    : t('settings.providers.contextSummaryAuto')
  const shouldShowContextFields = showContextSettings || modelContextWindowErrorSlots.length > 0 || !!autoCompactWindowErrorKey
  const handleAutoCompactWindowChange = (value: string) => {
    setAutoCompactWindow(value)
    setSettingsJson((current) => updateSettingsJsonAutoCompactWindow(current, value))
  }
  const handleBaseUrlChange = (value: string) => {
    setBaseUrl(value)
    setSettingsJson((current) => updateSettingsJsonProviderConnection(current, apiFormat, authStrategy, apiKey, selectedPreset, value, providerProxyBaseUrl, toolSearchEnabled, disableExperimentalBetas))
  }
  const handleApiKeyChange = (value: string) => {
    setApiKey(value)
    setSettingsJson((current) => updateSettingsJsonProviderConnection(current, apiFormat, authStrategy, value, selectedPreset, baseUrl, providerProxyBaseUrl, toolSearchEnabled, disableExperimentalBetas))
  }
  const handleApiFormatChange = (value: ApiFormat) => {
    setApiFormat(value)
    setSettingsJson((current) => updateSettingsJsonProviderConnection(current, value, authStrategy, apiKey, selectedPreset, baseUrl, providerProxyBaseUrl, toolSearchEnabled, disableExperimentalBetas))
  }
  const handleAuthStrategyChange = (value: ProviderAuthStrategy) => {
    setAuthStrategy(value)
    setSettingsJson((current) => updateSettingsJsonProviderConnection(current, apiFormat, value, apiKey, selectedPreset, baseUrl, providerProxyBaseUrl, toolSearchEnabled, disableExperimentalBetas))
  }
  const handleToolSearchToggle = (enabled: boolean) => {
    if (toolSearchUnsupported) return
    setToolSearchEnabled(enabled)
    setSettingsJson((current) => updateSettingsJsonToolSearch(current, apiFormat, enabled))
  }
  const handleDisableExperimentalBetasToggle = (disabled: boolean) => {
    setDisableExperimentalBetas(disabled)
    setSettingsJson((current) => updateSettingsJsonDisableExperimentalBetas(current, disabled))
  }
  const handleModelChange = (slot: ModelSlot, value: string) => {
    const hasMarker = hasModel1mMarker(value)
    const nextModels = { ...models, [slot]: stripModel1mMarker(value) }
    const nextModel1mSupport = hasMarker
      ? { ...model1mSupport, [slot]: true }
      : model1mSupport
    const nextInputs = {
      ...modelContextInputs,
      [slot]: getModelContextInputValue(nextModels[slot], selectedPreset, provider),
    }
    const nextInputsWith1mSupport = apply1mSupportToContextInput(
      nextInputs,
      slot,
      nextModel1mSupport[slot],
      // The field was just re-derived for the new model id, so there is nothing
      // left over from a previous 1M tick to revert.
      nextInputs[slot],
    )
    setModels(nextModels)
    setModel1mSupport(nextModel1mSupport)
    setModelContextInputs(nextInputsWith1mSupport)
    setSettingsJson((current) => updateSettingsJsonModelContextWindows(
      updateSettingsJsonModels(current, normalizeModelMapping(nextModels), nextModel1mSupport),
      buildModelContextWindows(nextModels, nextInputsWith1mSupport),
    ))
  }
  const handleModel1mSupportChange = (slot: ModelSlot, enabled: boolean) => {
    const nextModel1mSupport = { ...model1mSupport, [slot]: enabled }
    // Rolls back to the preset window rather than the saved provider one: a
    // provider saved while the box was ticked already holds the 1,000,000 the
    // user is now taking back.
    const nextInputs = apply1mSupportToContextInput(
      modelContextInputs,
      slot,
      enabled,
      getPresetContextInputValue(models[slot], selectedPreset),
    )
    setModel1mSupport(nextModel1mSupport)
    setModelContextInputs(nextInputs)
    setSettingsJson((current) => updateSettingsJsonModelContextWindows(
      updateSettingsJsonModels(current, normalizeModelMapping(models), nextModel1mSupport),
      buildModelContextWindows(models, nextInputs),
    ))
  }
  const handleModelContextWindowChange = (slot: ModelSlot, value: string) => {
    const nextInputs = { ...modelContextInputs, [slot]: value }
    setModelContextInputs(nextInputs)
    setSettingsJson((current) => updateSettingsJsonModelContextWindows(
      current,
      buildModelContextWindows(models, nextInputs),
    ))
  }
  const canFetchModels = Boolean(baseUrl.trim() && apiKey.trim())
  const handleFetchModels = async () => {
    if (!canFetchModels || isFetchingModels) return
    const requestId = modelsRequestRef.current + 1
    modelsRequestRef.current = requestId
    setIsFetchingModels(true)
    setModelsErrorCode(null)
    setModelsErrorMessage(null)
    try {
      // Upstream failures arrive as a resolved `ok: false`, so the catch below
      // only covers our own server being unreachable.
      const result = await fetchModels({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim() })
      // The form moved on while we were probing — this answer describes a base
      // URL or key the user no longer has typed in.
      if (modelsRequestRef.current !== requestId) return
      if (result.ok) {
        setFetchedModels(result.models)
      } else {
        setFetchedModels(null)
        setModelsErrorCode(result.errorCode)
        setModelsErrorMessage(result.message?.trim() || null)
      }
    } catch {
      if (modelsRequestRef.current !== requestId) return
      setFetchedModels(null)
      setModelsErrorCode('unknown')
      setModelsErrorMessage(null)
    } finally {
      // The config-change effect already cleared the flag for a discarded
      // request; clearing it again here would race a newer fetch.
      if (modelsRequestRef.current === requestId) setIsFetchingModels(false)
    }
  }
  const modelsErrorText = modelsErrorCode ? t(providerModelsErrorKey(modelsErrorCode)) : null
  // The server keeps the upstream's own wording, which is the only thing that
  // separates a 200-cloaked auth failure (智谱 answers `{"msg":"身份验证失败。"}`
  // with HTTP 200, classified `not-supported`) from a provider that genuinely
  // publishes no model list. Display-only: nothing branches on this text.
  const modelsErrorUpstream = modelsErrorMessage && modelsErrorMessage !== modelsErrorText
    ? modelsErrorMessage
    : null
  const modelPickerItems = useMemo(
    () => groupProviderModels(
      fetchedModels ?? [],
      t('settings.providers.fetchModelsGroupOther'),
    ).flatMap((group) => group.models.map((model) => ({
      value: model.id,
      label: model.id,
      description: group.group,
    }))),
    [fetchedModels, t],
  )
  const renderPresetButton = (preset: ProviderPreset) => (
    <SettingsPill
      key={preset.id}
      tone="terracotta"
      selected={selectedPreset.id === preset.id}
      onClick={() => handlePresetChange(preset)}
    >
      {preset.name}
    </SettingsPill>
  )

  const handleSubmit = async () => {
    if (!canSubmit || isSubmitting) return
    const normalizedModels = normalizeModelMapping(models)
    const parsedAutoCompactWindow = parseAutoCompactWindowInput(autoCompactWindow)
    const parsedModelContextWindows = buildModelContextWindows(models, modelContextInputs)
    const storedModel1mSupport = hasAnyModel1mSupport(model1mSupport)
      ? model1mSupport
      : undefined
    setIsSubmitting(true)
    try {
      // Write the edited cc-haha settings.json first so provider-specific model
      // settings never conflict with the user's global ~/.claude/settings.json.
      if (settingsJson.trim()) {
        try {
          const parsed = restoreSettingsJsonSecrets(JSON.parse(settingsJson), settingsJson, apiKey)
          const { providersApi } = await import('../api/providers')
          await providersApi.updateSettings(parsed)
        } catch {
          // JSON validation already prevents this
        }
      }

      if (mode === 'create') {
        await createProvider({
          presetId: selectedPreset.id,
          name: name.trim(),
          apiKey: apiKey.trim(),
          authStrategy,
          baseUrl: baseUrl.trim(),
          apiFormat,
          models: normalizedModels,
          ...(storedModel1mSupport !== undefined && { model1mSupport: storedModel1mSupport }),
          ...(parsedAutoCompactWindow !== undefined && { autoCompactWindow: parsedAutoCompactWindow }),
          ...(Object.keys(parsedModelContextWindows).length > 0 && { modelContextWindows: parsedModelContextWindows }),
          toolSearchEnabled,
          ...(disableExperimentalBetas && { disableExperimentalBetas }),
          notes: notes.trim() || undefined,
        })
      } else if (provider) {
        const input: UpdateProviderInput = {
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          authStrategy,
          apiFormat,
          models: normalizedModels,
          model1mSupport: storedModel1mSupport ?? null,
          autoCompactWindow: parsedAutoCompactWindow ?? null,
          modelContextWindows: Object.keys(parsedModelContextWindows).length > 0
            ? parsedModelContextWindows
            : null,
          toolSearchEnabled,
          disableExperimentalBetas,
          notes: notes.trim() || undefined,
        }
        if (apiKey.trim()) input.apiKey = apiKey.trim()
        await updateProvider(provider.id, input)
      }
      await fetchSettings()
      onClose()
    } catch (err) {
      console.error('Failed to save provider:', err)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleClose = () => {
    if (isSubmitting) return
    onClose()
  }

  const handleTest = async () => {
    if (!baseUrl.trim() || !models.main.trim()) return
    setIsTesting(true)
    setTestResult(null)
    try {
      let result: ProviderTestResult
      const savedConfigUnchanged = mode === 'edit' && provider && !apiKey.trim() &&
        baseUrl.trim() === provider.baseUrl.trim() &&
        apiFormat === provider.apiFormat &&
        authStrategy === provider.authStrategy
      if (savedConfigUnchanged && provider) {
        result = await useProviderStore.getState().testProvider(provider.id, {
          modelId: models.main.trim(),
        })
      } else {
        if (requiresApiKey && !apiKey.trim()) return
        result = await testConfig({
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim() || selectedPreset.defaultEnv?.ANTHROPIC_AUTH_TOKEN || 'local',
          modelId: models.main.trim(),
          authStrategy,
          apiFormat,
        })
      }
      setTestResult(result)
    } catch {
      setTestResult({ connectivity: { success: false, latencyMs: 0, error: t('settings.providers.requestFailed') } })
    } finally {
      setIsTesting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={mode === 'create' ? t('settings.providers.addTitle') : t('settings.providers.editTitle')}
      width={860}
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={isSubmitting}>{t('common.cancel')}</Button>
          <Button onClick={handleSubmit} disabled={!canSubmit || isSubmitting} loading={isSubmitting}>
            {mode === 'create' ? t('common.add') : t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Preset chips */}
        {mode === 'create' && (
          <div>
            <label className="text-sm font-medium text-[var(--color-text-primary)] mb-2 block">{t('settings.providers.preset')}</label>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                {regularPresets.map(renderPresetButton)}
              </div>
              {featuredPresets.length > 0 && (
                <div className="flex flex-wrap gap-2 border-t border-[var(--color-border-separator)] pt-2">
                  {featuredPresets.map(renderPresetButton)}
                </div>
              )}
            </div>
          </div>
        )}

        <Input label={t('settings.providers.name')} required value={name} onChange={(e) => setName(e.target.value)} placeholder={t('settings.providers.namePlaceholder')} />

        <Input label={t('settings.providers.notes')} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('settings.providers.notesPlaceholder')} />

        <Input label={t('settings.providers.baseUrl')} required value={baseUrl} onChange={(e) => handleBaseUrlChange(e.target.value)} placeholder={t('settings.providers.baseUrlPlaceholder')} className="font-mono text-[13px]" />

        {/* API Format */}
        {(isCustom || mode === 'edit') ? (
          <div>
            <label className="text-sm font-medium text-[var(--color-text-primary)] mb-1 block">{t('settings.providers.apiFormat')}</label>
            <Dropdown<ApiFormat>
              items={apiFormatItems}
              value={apiFormat}
              onChange={handleApiFormatChange}
              width="100%"
              className="block w-full"
              trigger={
                <Button variant="secondary" size="md" block className="h-10 gap-3">
                  <span className="min-w-0 flex-1 truncate text-left">{selectedApiFormatLabel}</span>
                  <span className="material-symbols-outlined flex-shrink-0 text-[18px] text-[var(--color-text-secondary)]">expand_more</span>
                </Button>
              }
            />
            {apiFormat !== 'anthropic' && (
              <p className="text-[11px] text-[var(--color-text-tertiary)] mt-1">{t('settings.providers.proxyHint')}</p>
            )}
          </div>
        ) : apiFormat !== 'anthropic' ? (
          <div>
            <label className="text-sm font-medium text-[var(--color-text-primary)] mb-1 block">{t('settings.providers.apiFormat')}</label>
            <div className="text-xs text-[var(--color-text-tertiary)] px-3 py-2 rounded-[var(--radius-md)] bg-[var(--color-surface-container-low)] border border-[var(--color-border)]">
              {apiFormat === 'openai_chat' ? t('settings.providers.apiFormatOpenaiChat') : t('settings.providers.apiFormatOpenaiResponses')}
            </div>
          </div>
        ) : null}

        {apiFormat === 'anthropic' && (
          <div>
            <label className="text-sm font-medium text-[var(--color-text-primary)] mb-1 block">{t('settings.providers.authStrategy')}</label>
            <Dropdown<ProviderAuthStrategy>
              items={authStrategyItems}
              value={authStrategy}
              onChange={handleAuthStrategyChange}
              width="100%"
              className="block w-full"
              trigger={
                <Button variant="secondary" size="md" block className="h-auto min-h-10 gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-left">{selectedAuthStrategyLabel}</span>
                  <span className="material-symbols-outlined flex-shrink-0 text-[18px] text-[var(--color-text-secondary)]">expand_more</span>
                </Button>
              }
            />
          </div>
        )}

        <label
          className={`relative flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-3 transition-colors ${
            toolSearchUnsupported
              ? 'cursor-not-allowed opacity-70'
              : 'cursor-pointer hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)]'
          }`}
        >
          <input
            type="checkbox"
            aria-label={t('settings.providers.toolSearchEnabled')}
            checked={toolSearchEnabled && !toolSearchUnsupported}
            disabled={toolSearchUnsupported}
            onChange={(e) => handleToolSearchToggle(e.target.checked)}
            className={SETTINGS_CHECKBOX_INPUT_CLASS}
          />
          <SettingsCheckboxMark checked={toolSearchEnabled && !toolSearchUnsupported} disabled={toolSearchUnsupported} />
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--color-text-primary)]">
              {t('settings.providers.toolSearchEnabled')}
            </div>
            <div className="mt-1 text-xs leading-5 text-[var(--color-text-tertiary)]">
              {toolSearchDescription}
            </div>
          </div>
        </label>

        <label className="relative flex cursor-pointer items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-3 transition-colors hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)]">
          <input
            type="checkbox"
            aria-label={t('settings.providers.disableExperimentalBetas')}
            checked={disableExperimentalBetas}
            onChange={(e) => handleDisableExperimentalBetasToggle(e.target.checked)}
            className={SETTINGS_CHECKBOX_INPUT_CLASS}
          />
          <SettingsCheckboxMark checked={disableExperimentalBetas} />
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--color-text-primary)]">
              {t('settings.providers.disableExperimentalBetas')}
            </div>
            <div className="mt-1 text-xs leading-5 text-[var(--color-text-tertiary)]">
              {t('settings.providers.disableExperimentalBetasDesc')}
            </div>
          </div>
        </label>

        <div className="flex flex-col gap-1">
          <label htmlFor="provider-api-key" className="text-sm font-medium text-[var(--color-text-primary)]">
            {t('settings.providers.apiKey')}
            {mode === 'create' && requiresApiKey && <span className="text-[var(--color-error)] ml-0.5">*</span>}
          </label>
          <div className="relative">
            <input
              id="provider-api-key"
              type={showApiKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => handleApiKeyChange(e.target.value)}
              placeholder="sk-..."
              className="h-10 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 pr-10 text-sm text-[var(--color-text-primary)] outline-none transition-colors duration-150 placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)] focus:shadow-[var(--shadow-focus-ring)]"
            />
            <IconButton
              icon={showApiKey ? 'visibility_off' : 'visibility'}
              label={t(showApiKey ? 'settings.providers.hideApiKey' : 'settings.providers.showApiKey')}
              showTooltip={false}
              size="sm"
              tone="muted"
              onClick={() => setShowApiKey((visible) => !visible)}
              className="absolute right-1.5 top-1/2 -translate-y-1/2"
            />
          </div>
        </div>

        {(apiKeyUrl || promoText) && (
          <div className="-mt-2 flex flex-col gap-1.5">
            {apiKeyUrl && (
              <button
                type="button"
                onClick={() => openExternalUrl(apiKeyUrl)}
                className="group inline-flex h-6 w-fit cursor-pointer items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-1.5 text-[11px] font-medium leading-none text-[var(--color-brand)] transition-colors hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)] focus:outline-none focus:shadow-[var(--shadow-focus-ring)]"
              >
                <span className="material-symbols-outlined text-[13px]">key</span>
                {t('settings.providers.getApiKey')}
                <span className="material-symbols-outlined text-[9px] opacity-60 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5">arrow_outward</span>
              </button>
            )}
            {promoText && (
              <button
                type="button"
                onClick={() => apiKeyUrl && openExternalUrl(apiKeyUrl)}
                disabled={!apiKeyUrl}
                className="group flex w-full cursor-pointer items-start gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-primary-fixed-dim)] bg-[var(--color-brand-soft)] px-2.5 py-1.5 text-left text-[11px] leading-5 text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-brand)] hover:bg-[var(--color-brand-soft-hover)] focus:outline-none focus:shadow-[var(--shadow-focus-ring)] disabled:cursor-default disabled:hover:border-[var(--color-primary-fixed-dim)] disabled:hover:bg-[var(--color-brand-soft)]"
              >
                <span className="material-symbols-outlined mt-0.5 text-[13px] text-[var(--color-brand)]">tips_and_updates</span>
                <span>{promoText}</span>
                {apiKeyUrl && (
                  <span className="material-symbols-outlined ml-auto mt-1 text-[10px] text-[var(--color-brand)] opacity-45 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5">arrow_outward</span>
                )}
              </button>
            )}
          </div>
        )}

        {/* Model Mapping */}
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <label className="text-sm font-medium text-[var(--color-text-primary)]">{t('settings.providers.modelMapping')}</label>
            <Button
              variant="secondary"
              size="base"
              onClick={handleFetchModels}
              disabled={!canFetchModels}
              loading={isFetchingModels}
              icon={<span className="material-symbols-outlined text-[15px]">cloud_download</span>}
            >
              {t('settings.providers.fetchModels')}
            </Button>
          </div>
          {!canFetchModels ? (
            <p className="mb-2 text-[11px] text-[var(--color-text-tertiary)]">{t('settings.providers.fetchModelsHint')}</p>
          ) : modelsErrorCode ? (
            <div role="alert" className="mb-2 flex flex-col gap-0.5">
              <p className="text-[11px] text-[var(--color-error)]">{modelsErrorText}</p>
              {modelsErrorUpstream && (
                <p className="break-words text-[11px] text-[var(--color-text-tertiary)]">
                  {t('settings.providers.fetchModelsErrorUpstream')} {modelsErrorUpstream}
                </p>
              )}
            </div>
          ) : fetchedModels && fetchedModels.length === 0 ? (
            <p className="mb-2 text-[11px] text-[var(--color-text-tertiary)]">{t('settings.providers.fetchModelsEmpty')}</p>
          ) : fetchedModels ? (
            <p className="mb-2 text-[11px] text-[var(--color-text-secondary)]">
              {t('settings.providers.fetchModelsLoaded', { count: fetchedModels.length })}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            {MODEL_SLOTS.map((slot) => {
              const labelKey = slot === 'main'
                ? 'settings.providers.mainModel'
                : slot === 'haiku'
                  ? 'settings.providers.haikuModel'
                  : slot === 'sonnet'
                    ? 'settings.providers.sonnetModel'
                    : 'settings.providers.opusModel'
              const label = t(labelKey)
              const pickLabel = t('settings.providers.fetchModelsPick', { label })
              return (
                <div key={slot} className="min-w-0">
                  <div className="flex items-end gap-1.5">
                    <Input
                      containerClassName="min-w-0 flex-1"
                      label={label}
                      required={slot === 'main'}
                      value={models[slot]}
                      onChange={(e) => handleModelChange(slot, e.target.value)}
                      placeholder={slot === 'main' ? t('settings.providers.modelIdPlaceholder') : t('settings.providers.sameAsMain')}
                    />
                    {/* The picker only supplements the field — the id stays typeable. */}
                    {modelPickerItems.length > 0 && (
                      <Dropdown<string>
                        items={modelPickerItems}
                        value={models[slot]}
                        onChange={(value) => handleModelChange(slot, value)}
                        label={pickLabel}
                        align="right"
                        maxHeight={260}
                        trigger={<IconButton icon="expand_more" label={pickLabel} size="xl" tone="secondary" bordered />}
                      />
                    )}
                  </div>
                  <Tooltip content={t('settings.providers.model1mSupportTooltip')} placement="bottom-start">
                    <label className="mt-1 inline-flex h-6 w-fit cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] px-1 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]">
                      <input
                        type="checkbox"
                        checked={model1mSupport[slot]}
                        onChange={(e) => handleModel1mSupportChange(slot, e.target.checked)}
                        aria-label={`1M support: ${slot}`}
                        className="h-3.5 w-3.5 rounded border-[var(--color-border)] text-[var(--color-brand)] accent-[var(--color-brand)] focus:ring-[var(--color-brand)]"
                      />
                      <span>{t('settings.providers.model1mSupportShort')}</span>
                    </label>
                  </Tooltip>
                </div>
              )
            })}
          </div>
          <p className="mt-2 text-[11px] leading-5 text-[var(--color-text-tertiary)]">
            {t('settings.providers.model1mSupportHint')}
          </p>
        </div>

        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
          <button
            type="button"
            onClick={() => setShowContextSettings((visible) => !visible)}
            className="flex w-full items-start gap-3 px-3 py-3 text-left outline-none transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:shadow-[var(--shadow-focus-ring)]"
            aria-expanded={shouldShowContextFields}
          >
            <span className="material-symbols-outlined mt-0.5 text-[18px] text-[var(--color-brand)]">compress</span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-[var(--color-text-primary)]">
                {t('settings.providers.contextSettingsTitle')}
              </span>
              <span className="mt-1 block truncate text-xs text-[var(--color-text-secondary)]">
                {contextSummary}
              </span>
              <span className="mt-1 block text-[11px] leading-5 text-[var(--color-text-tertiary)]">
                {t('settings.providers.contextSettingsDesc')}
              </span>
            </span>
            <span className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-[var(--color-brand)]">
              {shouldShowContextFields
                ? t('settings.providers.contextSettingsHide')
                : t('settings.providers.contextSettingsEdit')}
              <span className="material-symbols-outlined text-[16px]">
                {shouldShowContextFields ? 'expand_less' : 'expand_more'}
              </span>
            </span>
          </button>

          {shouldShowContextFields && (
            <div className="border-t border-[var(--color-border)] px-3 pb-3 pt-3">
              <div>
                <label className="text-sm font-medium text-[var(--color-text-primary)] mb-2 block">{t('settings.providers.modelContextWindows')}</label>
                <div className="grid grid-cols-2 gap-2">
                  {MODEL_SLOTS.map((slot) => {
                    const errorKey = getModelContextWindowErrorKey(modelContextInputs[slot])
                    const labelKey = slot === 'main'
                      ? 'settings.providers.mainContextWindow'
                      : slot === 'haiku'
                        ? 'settings.providers.haikuContextWindow'
                        : slot === 'sonnet'
                          ? 'settings.providers.sonnetContextWindow'
                          : 'settings.providers.opusContextWindow'
                    return (
                      <div key={slot}>
                        <Input
                          label={t(labelKey)}
                          value={modelContextInputs[slot]}
                          onChange={(e) => handleModelContextWindowChange(slot, e.target.value)}
                          placeholder={t('settings.providers.contextWindowPlaceholder')}
                        />
                        {errorKey && (
                          <p className="text-[11px] text-[var(--color-error)] mt-1">
                            {errorKey === 'number'
                              ? t('settings.providers.modelContextWindowNumberError')
                              : t('settings.providers.modelContextWindowRangeError')}
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
                <p className="text-[11px] text-[var(--color-text-tertiary)] mt-1">
                  {t('settings.providers.modelContextWindowsDesc')}
                </p>
              </div>

              <div className="mt-3">
                <Input
                  label={t('settings.providers.autoCompactWindow')}
                  value={autoCompactWindow}
                  onChange={(e) => handleAutoCompactWindowChange(e.target.value)}
                  placeholder={t('settings.providers.autoCompactWindowPlaceholder')}
                />
                {autoCompactWindowErrorKey ? (
                  <p className="text-[11px] text-[var(--color-error)] mt-1">
                    {autoCompactWindowErrorKey === 'number'
                      ? t('settings.providers.autoCompactWindowNumberError')
                      : t('settings.providers.autoCompactWindowRangeError')}
                  </p>
                ) : (
                  <p className="text-[11px] text-[var(--color-text-tertiary)] mt-1">
                    {t('settings.providers.autoCompactWindowDesc')}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Test connection */}
        <div className="flex items-center gap-3">
          <Button variant="secondary" size="sm" onClick={handleTest} loading={isTesting} disabled={!baseUrl.trim() || !models.main.trim()}>
            {t('settings.providers.testConnection')}
          </Button>
          {testResult && (
            <div className="flex flex-col gap-0.5">
              <span className={`text-xs ${testResult.connectivity.success ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'}`}>
                {testResult.connectivity.success
                  ? t('settings.providers.connectivityOk', { latency: String(testResult.connectivity.latencyMs) })
                  : t('settings.providers.connectivityFailed', { error: testResult.connectivity.error || '' })}
              </span>
              {testResult.proxy && (
                <span className={`text-xs ${testResult.proxy.success ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'}`}>
                  {testResult.proxy.success
                    ? t('settings.providers.proxyOk', { latency: String(testResult.proxy.latencyMs) })
                    : t('settings.providers.proxyFailed', { error: testResult.proxy.error || '' })}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Settings JSON — editable, shown for all presets including official */}
        <div>
          <label className="text-sm font-medium text-[var(--color-text-primary)] mb-2 block">{t('settings.providers.settingsJson')}</label>
          <textarea
            value={displayedSettingsJson}
            onChange={(e) => {
              const raw = e.target.value
              try {
                const parsed = restoreSettingsJsonSecrets(JSON.parse(raw), settingsJson, apiKey)
                setSettingsJson(JSON.stringify(parsed, null, 2))
                setSettingsJsonError(null)
                // Auto-fill form fields from parsed JSON env
                const env = parsed.env as Record<string, string> | undefined
                if (env) {
                  const baseUrl = env.ANTHROPIC_BASE_URL
                  if (baseUrl) {
                    setBaseUrl(baseUrl)
                    // Auto-switch to matching preset or Custom
                    if (mode === 'create') {
                      const matchedPreset = selectablePresets.find(
                        (preset) => preset.id !== 'custom' && presetMatchesBaseUrl(preset, baseUrl),
                      )
                      const targetPreset = requirePreset(
                        matchedPreset ?? selectablePresets.find((p) => p.id === 'custom'),
                      )
                      if (targetPreset.id !== selectedPreset.id) {
                        jsonPastedRef.current = true
                        setSelectedPreset(targetPreset)
                      }
                    }
                  }
                  const nextApiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY
                  if (nextApiKey && nextApiKey !== '(your API key)' && nextApiKey !== API_KEY_JSON_PLACEHOLDER) {
                    setApiKey(nextApiKey)
                  }
                  const nextAuthStrategy = inferAuthStrategyFromEnv(env)
                  if (nextAuthStrategy) {
                    setAuthStrategy(nextAuthStrategy)
                  }
                  setToolSearchEnabled(readToolSearchEnabledFromEnv(env))
                  setDisableExperimentalBetas(readDisableExperimentalBetasFromEnv(env))
                  if (env[AUTO_COMPACT_WINDOW_ENV_KEY] !== undefined) {
                    setAutoCompactWindow(String(env[AUTO_COMPACT_WINDOW_ENV_KEY]))
                  } else {
                    setAutoCompactWindow('')
                  }
                  let parsedContextWindows: Record<string, number> = {}
                  if (typeof env[MODEL_CONTEXT_WINDOWS_ENV_KEY] === 'string') {
                    try {
                      const parsedContext = JSON.parse(env[MODEL_CONTEXT_WINDOWS_ENV_KEY]) as Record<string, unknown>
                      parsedContextWindows = Object.fromEntries(
                        Object.entries(parsedContext)
                          .filter(([, value]) => typeof value === 'number' && Number.isInteger(value)),
                      ) as Record<string, number>
                    } catch {
                      parsedContextWindows = {}
                    }
                  }
                  const newModels = readModelMappingFromSettingsEnv(env)
                  if (Object.keys(newModels).length > 0) {
                    setModels((prev) => {
                      const mergedModels = { ...prev, ...newModels }
                      const nextModel1mSupport = {
                        main: hasModel1mMarker(mergedModels.main),
                        haiku: hasModel1mMarker(mergedModels.haiku),
                        sonnet: hasModel1mMarker(mergedModels.sonnet),
                        opus: hasModel1mMarker(mergedModels.opus),
                      }
                      const nextModels = stripModel1mMarkers(mergedModels)
                      setModel1mSupport(nextModel1mSupport)
                      setModelContextInputs(apply1mSupportToContextInputs(
                        getModelContextInputs(nextModels, {
                          ...selectedPreset,
                          modelContextWindows: parsedContextWindows,
                        }),
                        nextModel1mSupport,
                      ))
                      return nextModels
                    })
                  } else if (Object.keys(parsedContextWindows).length > 0) {
                    setModelContextInputs(getModelContextInputs(models, {
                      ...selectedPreset,
                      modelContextWindows: parsedContextWindows,
                    }))
                  }
                }
              } catch (err) {
                setSettingsJson(raw)
                setSettingsJsonError(err instanceof Error ? err.message : 'Invalid JSON')
              }
            }}
            rows={16}
            spellCheck={false}
            className={`w-full text-xs px-3 py-3 rounded-[var(--radius-md)] bg-[var(--color-surface-container-low)] border font-mono leading-relaxed resize-y text-[var(--color-text-secondary)] outline-none ${
              settingsJsonError
                ? 'border-[var(--color-error)] focus:border-[var(--color-error)]'
                : 'border-[var(--color-border)] focus:border-[var(--color-border-focus)]'
            }`}
          />
          {settingsJsonError && (
            <p className="text-[11px] text-[var(--color-error)] mt-1">{t('settings.providers.jsonError', { error: settingsJsonError })}</p>
          )}
          <p className="text-[11px] text-[var(--color-text-tertiary)] mt-1">{t('settings.providers.settingsJsonDesc')}</p>
        </div>
      </div>
    </Modal>
  )
}


// ─── General Settings ──────────────────────────────────────

export function GeneralSettings() {
  const {
    thinkingEnabled,
    setThinkingEnabled,
    permissionMode,
    setPermissionMode,
    autoDreamEnabled,
    setAutoDreamEnabled,
    locale,
    setLocale,
    setTheme,
    chatSendBehavior,
    setChatSendBehavior,
    outputStyle,
    outputStyles,
    outputStyleScope,
    outputStylesLoading,
    outputStyleError,
    fetchOutputStyles,
    setOutputStyle,
    skipWebFetchPreflight,
    setSkipWebFetchPreflight,
    desktopNotificationsEnabled,
    setDesktopNotificationsEnabled,
    webSearch,
    setWebSearch,
    network,
    setNetwork,
    traceCapture,
    setTraceCaptureEnabled,
    responseLanguage,
    setResponseLanguage,
    appMode,
    appModeRequiresRestart,
    fetchAppMode,
    setAppMode: setAppModeAction,
    uiZoom,
    setUiZoom,
  } = useSettingsStore()
  // Read the theme from the store that owns it. settingsStore keeps a copy for
  // its own consumers, but that copy is only refreshed on an explicit setTheme
  // — an OS flip updates uiStore alone and would leave this picker highlighting
  // a theme that is no longer on screen.
  const theme = useUIStore((s) => s.theme)
  const followSystemTheme = useUIStore((s) => s.followSystemTheme)
  const lightTheme = useUIStore((s) => s.lightTheme)
  const darkTheme = useUIStore((s) => s.darkTheme)
  const setFollowSystemTheme = useUIStore((s) => s.setFollowSystemTheme)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const t = useTranslation()
  const [webSearchDraft, setWebSearchDraft] = useState(webSearch)
  const [networkDraft, setNetworkDraft] = useState(network)
  const [networkTimeoutInput, setNetworkTimeoutInput] = useState(String(Math.round(network.aiRequestTimeoutMs / 1000)))
  const [networkSaveError, setNetworkSaveError] = useState<string | null>(null)
  const [isSavingNetwork, setIsSavingNetwork] = useState(false)
  const [notificationPermission, setNotificationPermission] = useState<DesktopNotificationPermission>('default')
  const [notificationActionRunning, setNotificationActionRunning] = useState(false)
  const [autoDreamConfirmOpen, setAutoDreamConfirmOpen] = useState(false)
  const [autoDreamActionRunning, setAutoDreamActionRunning] = useState(false)
  const [modeSwitchConfirmOpen, setModeSwitchConfirmOpen] = useState(false)
  const [pendingMode, setPendingMode] = useState<AppMode | null>(null)
  const [pendingPortableDir, setPendingPortableDir] = useState<string | null>(null)
  const [portableDirDraft, setPortableDirDraft] = useState('')
  const [modeActionRunning, setModeActionRunning] = useState(false)
  const [modeError, setModeError] = useState<string | null>(null)
  const [uiZoomDraft, setUiZoomDraft] = useState(uiZoom)
  const [isUiZoomDragging, setIsUiZoomDragging] = useState(false)
  const isUiZoomDraggingRef = useRef(false)
  const addToast = useUIStore((s) => s.addToast)
  const webSearchDirty = JSON.stringify(webSearchDraft) !== JSON.stringify(webSearch)
  const uiZoomPercent = Math.round(uiZoomDraft * 100)
  const uiZoomRangeProgress = `${Math.round(((uiZoomDraft - UI_ZOOM_MIN) / (UI_ZOOM_MAX - UI_ZOOM_MIN)) * 1000) / 10}%`
  const activeConfigDir = appMode.activeConfigDir ?? (appMode.mode === 'portable' ? appMode.portableDir : null)
  const configDirSource = appMode.configDirSource ?? (appMode.mode === 'portable' ? 'portable' : 'system')
  const isEnvironmentConfigDir = configDirSource === 'environment'
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [activeSessionId, sessions],
  )
  const outputStyleWorkDir =
    activeSession?.workDirExists === false
      ? null
      : activeSession?.workDir ?? activeSession?.projectRoot ?? null

  useEffect(() => {
    setWebSearchDraft(webSearch)
  }, [webSearch])

  useEffect(() => {
    void fetchOutputStyles(outputStyleWorkDir)
  }, [fetchOutputStyles, outputStyleWorkDir])

  useEffect(() => {
    setNetworkDraft(network)
    setNetworkTimeoutInput(String(Math.round(network.aiRequestTimeoutMs / 1000)))
    setNetworkSaveError(null)
  }, [network])

  useEffect(() => {
    if (!isUiZoomDragging) {
      setUiZoomDraft(uiZoom)
    }
  }, [isUiZoomDragging, uiZoom])

  useEffect(() => {
    let cancelled = false
    getDesktopNotificationPermission().then((permission) => {
      if (!cancelled) setNotificationPermission(permission)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isDesktopRuntime()) return
    void fetchAppMode()
  }, [fetchAppMode])

  useEffect(() => {
    setPortableDirDraft(appMode.portableDir ?? '')
  }, [appMode.portableDir])

  const LANGUAGES: Array<{ value: Locale; label: string }> = [
    { value: 'en', label: 'English' },
    { value: 'zh', label: '简体中文' },
    { value: 'zh-TW', label: '繁體中文' },
    { value: 'jp', label: '日本語' },
    { value: 'kr', label: '한국어' },
  ]


  const RESPONSE_LANGUAGES: Array<{ value: string; label: string }> = [
    { value: '', label: t('settings.general.responseLangDefault') },
    { value: 'english', label: 'English' },
    { value: 'chinese', label: '中文 (Chinese)' },
    { value: 'japanese', label: '日本語 (Japanese)' },
    { value: 'korean', label: '한국어 (Korean)' },
    { value: 'spanish', label: 'Español (Spanish)' },
    { value: 'french', label: 'Français (French)' },
    { value: 'german', label: 'Deutsch (German)' },
    { value: 'portuguese', label: 'Português (Portuguese)' },
    { value: 'italian', label: 'Italiano (Italian)' },
    { value: 'russian', label: 'Русский (Russian)' },
    { value: 'dutch', label: 'Nederlands (Dutch)' },
    { value: 'polish', label: 'Polski (Polish)' },
    { value: 'turkish', label: 'Türkçe (Turkish)' },
    { value: 'hindi', label: 'हिन्दी (Hindi)' },
    { value: 'indonesian', label: 'Bahasa Indonesia' },
    { value: 'ukrainian', label: 'Українська (Ukrainian)' },
    { value: 'greek', label: 'Ελληνικά (Greek)' },
    { value: 'czech', label: 'Čeština (Czech)' },
    { value: 'danish', label: 'Dansk (Danish)' },
    { value: 'swedish', label: 'Svenska (Swedish)' },
    { value: 'norwegian', label: 'Norsk (Norwegian)' },
  ]
  const selectedResponseLanguageLabel =
    RESPONSE_LANGUAGES.find(({ value }) => value === responseLanguage)?.label ?? RESPONSE_LANGUAGES[0]!.label
  const outputStyleItems = outputStyles.map((style) => ({
    value: style.value,
    label: getOutputStyleLabel(style, t),
    description: `${getOutputStyleDescription(style, t)} · ${getOutputStyleSourceLabel(style.source, t)}`,
  }))
  const selectedOutputStyle =
    outputStyles.find((style) => style.value === outputStyle) ?? outputStyles[0]
  const selectedOutputStyleLabel = selectedOutputStyle
    ? getOutputStyleLabel(selectedOutputStyle, t)
    : outputStyle
  const selectedOutputStyleDescription = selectedOutputStyle
    ? getOutputStyleDescription(selectedOutputStyle, t)
    : ''
  const outputStyleScopeLabel = outputStyleScope === 'localSettings'
    ? t('settings.general.outputStyleScopeLocal')
    : t('settings.general.outputStyleScopeUser')
  const outputStyleScopeHint = outputStyleScope === 'localSettings'
    ? t('settings.general.outputStyleScopeLocalHint')
    : t('settings.general.outputStyleScopeUserHint')

  const THEMES: Array<{ value: ThemeMode; label: string }> = [
    { value: 'white', label: t('settings.general.appearance.white') },
    { value: 'paper', label: t('settings.general.appearance.paper') },
    { value: 'warm-classic', label: t('settings.general.appearance.warmClassic') },
    { value: 'celadon', label: t('settings.general.appearance.celadon') },
    { value: 'dark', label: t('settings.general.appearance.dark') },
    { value: 'ink-blue', label: t('settings.general.appearance.inkBlue') },
  ]
  // Split by ground, in the order THEMES already lists them, so the two rows
  // shown while following the system stay consistent with the flat picker.
  const LIGHT_THEMES = THEMES.filter(({ value }) => isLightThemeMode(value))
  const DARK_THEMES = THEMES.filter(({ value }) => isDarkThemeMode(value))

  const WEB_SEARCH_MODES: Array<{ value: WebSearchMode; label: string }> = [
    { value: 'auto', label: t('settings.general.webSearch.mode.auto') },
    { value: 'tavily', label: t('settings.general.webSearch.mode.tavily') },
    { value: 'brave', label: t('settings.general.webSearch.mode.brave') },
    { value: 'anthropic', label: t('settings.general.webSearch.mode.anthropic') },
    { value: 'disabled', label: t('settings.general.webSearch.mode.disabled') },
  ]

  const NETWORK_PROXY_MODES: Array<{ value: NetworkProxyMode; label: string; description: string }> = [
    {
      value: 'direct',
      label: t('settings.general.networkProxyModeDirect'),
      description: t('settings.general.networkProxyModeDirectDescription'),
    },
    {
      value: 'system',
      label: t('settings.general.networkProxyModeSystem'),
      description: t('settings.general.networkProxyModeSystemDescription'),
    },
    {
      value: 'manual',
      label: t('settings.general.networkProxyModeManual'),
      description: t('settings.general.networkProxyModeManualDescription'),
    },
  ]

  const CHAT_SEND_BEHAVIORS: Array<{ value: ChatSendBehavior; label: string; description: string }> = [
    {
      value: 'enter',
      label: t('settings.general.chatSendBehaviorEnter'),
      description: t('settings.general.chatSendBehaviorEnterDescription'),
    },
    {
      value: 'modifierEnter',
      label: t('settings.general.chatSendBehaviorModifier'),
      description: t('settings.general.chatSendBehaviorModifierDescription'),
    },
  ]

  const notificationStatusLabel: Record<DesktopNotificationPermission, string> = {
    granted: t('settings.general.notificationsStatusGranted'),
    denied: t('settings.general.notificationsStatusDenied'),
    default: t('settings.general.notificationsStatusDefault'),
    unsupported: t('settings.general.notificationsStatusUnsupported'),
  }

  const handleDesktopNotificationsToggle = async (enabled: boolean) => {
    await setDesktopNotificationsEnabled(enabled)
    if (!enabled) return

    setNotificationActionRunning(true)
    try {
      const permission = await requestDesktopNotificationPermission()
      setNotificationPermission(permission)
      if (permission === 'granted' && getDesktopNotificationPlatform() !== 'win32') {
        void notifyDesktop({
          title: t('settings.general.notificationsTestTitle'),
          body: t('settings.general.notificationsTestBody'),
        })
      }
    } finally {
      setNotificationActionRunning(false)
    }
  }

  const handleAutoDreamToggle = (enabled: boolean) => {
    if (enabled) {
      setAutoDreamConfirmOpen(true)
      return
    }
    void setAutoDreamEnabled(false)
  }

  const confirmAutoDreamEnable = async () => {
    setAutoDreamActionRunning(true)
    try {
      await setAutoDreamEnabled(true)
      setAutoDreamConfirmOpen(false)
    } finally {
      setAutoDreamActionRunning(false)
    }
  }

  const handleNotificationPermissionAction = async () => {
    setNotificationActionRunning(true)
    try {
      if (notificationPermission === 'denied') {
        await openDesktopNotificationSettings()
      } else {
        const permission = await requestDesktopNotificationPermission()
        setNotificationPermission(permission)
        if (permission === 'granted') {
          void notifyDesktop({
            title: t('settings.general.notificationsTestTitle'),
            body: t('settings.general.notificationsTestBody'),
          })
        }
        if (permission === 'denied') {
          await openDesktopNotificationSettings()
        }
      }
    } finally {
      setNotificationActionRunning(false)
    }
  }

  const networkProxyUrl = networkDraft.proxy.url.trim()
  const networkProxyError =
    networkDraft.proxy.mode === 'manual' && !networkProxyUrl
      ? t('settings.general.networkProxyUrlRequired')
      : networkDraft.proxy.mode === 'manual' && !isValidHttpProxyUrl(networkProxyUrl)
        ? t('settings.general.networkProxyUrlInvalid')
        : null
  const timeoutSeconds = Math.round(networkDraft.aiRequestTimeoutMs / 1000)
  const parsedNetworkTimeoutSeconds = (() => {
    const trimmed = networkTimeoutInput.trim()
    if (!/^\d+$/.test(trimmed)) return null
    const seconds = Number(trimmed)
    if (!Number.isFinite(seconds) || seconds < NETWORK_TIMEOUT_MIN_SECONDS || seconds > NETWORK_TIMEOUT_MAX_SECONDS) return null
    return seconds
  })()
  const networkTimeoutError =
    networkTimeoutInput.trim().length === 0
      ? t('settings.general.networkTimeoutRequired')
      : parsedNetworkTimeoutSeconds === null
        ? t('settings.general.networkTimeoutRange', {
            min: String(NETWORK_TIMEOUT_MIN_SECONDS),
            max: String(NETWORK_TIMEOUT_MAX_SECONDS),
          })
        : null
  const networkDirty =
    networkDraft.aiRequestTimeoutMs !== network.aiRequestTimeoutMs ||
    networkDraft.proxy.mode !== network.proxy.mode ||
    networkDraft.proxy.url.trim() !== network.proxy.url.trim()

  const setNetworkTimeoutSeconds = (seconds: number) => {
    const nextSeconds = Math.min(Math.max(Math.round(seconds), NETWORK_TIMEOUT_MIN_SECONDS), NETWORK_TIMEOUT_MAX_SECONDS)
    setNetworkTimeoutInput(String(nextSeconds))
    setNetworkDraft((current) => ({
      ...current,
      aiRequestTimeoutMs: nextSeconds * 1000,
    }))
    setNetworkSaveError(null)
  }

  const saveNetworkSettings = async () => {
    if (networkProxyError) {
      setNetworkSaveError(networkProxyError)
      return
    }
    if (networkTimeoutError || parsedNetworkTimeoutSeconds === null) {
      setNetworkSaveError(networkTimeoutError ?? t('settings.general.networkTimeoutRange', {
        min: String(NETWORK_TIMEOUT_MIN_SECONDS),
        max: String(NETWORK_TIMEOUT_MAX_SECONDS),
      }))
      return
    }

    setIsSavingNetwork(true)
    setNetworkSaveError(null)
    try {
      await setNetwork({
        aiRequestTimeoutMs: parsedNetworkTimeoutSeconds * 1000,
        proxy: {
          mode: networkDraft.proxy.mode,
          url: networkDraft.proxy.mode === 'manual' ? networkProxyUrl : '',
        },
      })
      addToast({
        type: 'success',
        message: t('settings.general.networkSaved'),
      })
    } catch (error) {
      setNetworkSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSavingNetwork(false)
    }
  }

  const handleOutputStyleChange = async (value: string) => {
    try {
      await setOutputStyle(value, outputStyleWorkDir)
      addToast({
        type: 'success',
        message: t('settings.general.outputStyleSaved'),
      })
    } catch {
      // The store exposes outputStyleError below; keep the interaction local.
    }
  }

  const openPortableDirPicker = async () => {
    setModeError(null)
    const host = getDesktopHost()
    if (!host.capabilities.dialogs) {
      setModeError(t('settings.general.storagePickerError'))
      return
    }
    try {
      const selected = await host.dialogs.open({
        directory: true,
        multiple: false,
        title: t('settings.general.storageChooseDirTitle'),
      })
      if (typeof selected === 'string') {
        setPortableDirDraft(selected)
      }
    } catch {
      setModeError(t('settings.general.storagePickerError'))
    }
  }

  const openModeSwitchConfirm = (mode: AppMode) => {
    if (isEnvironmentConfigDir) {
      setModeError(t('settings.general.storageEnvironmentSwitchBlocked'))
      return
    }

    const portableDir = portableDirDraft.trim()
    if (mode === 'portable' && !portableDir) {
      setModeError(t('settings.general.storageNoDirError'))
      return
    }

    setModeError(null)
    setPendingMode(mode)
    setPendingPortableDir(mode === 'portable' ? portableDir : null)
    setModeSwitchConfirmOpen(true)
  }

  const closeModeSwitchConfirm = () => {
    if (modeActionRunning) return
    setModeSwitchConfirmOpen(false)
    setPendingMode(null)
    setPendingPortableDir(null)
  }

  const confirmModeSwitch = async () => {
    if (!pendingMode) return

    setModeActionRunning(true)
    setModeError(null)
    try {
      await setAppModeAction(pendingMode, pendingPortableDir)
      const host = getDesktopHost()
      await host.appMode.prepareRestart()
      await host.appMode.restart()
    } catch (error) {
      setModeError(
        error instanceof Error
          ? error.message
          : t('settings.general.storageRestartError'),
      )
      setModeSwitchConfirmOpen(false)
      setPendingMode(null)
      setPendingPortableDir(null)
      setModeActionRunning(false)
    }
  }

  const setUiZoomDraggingState = (dragging: boolean) => {
    isUiZoomDraggingRef.current = dragging
    setIsUiZoomDragging(dragging)
  }

  const commitUiZoom = (value: number) => {
    const nextZoom = Number.isFinite(value) ? value : UI_ZOOM_DEFAULT
    setUiZoomDraggingState(false)
    setUiZoomDraft(nextZoom)
    setUiZoom(nextZoom)
  }

  const uiZoomSection = (
    <div className="mt-8">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[16.5px] font-semibold leading-tight text-[var(--color-text-primary)] mb-1" style={{ fontFamily: 'var(--font-headline)' }}>{t('settings.general.uiZoom')}</h2>
          <p className="text-sm text-[var(--color-text-tertiary)]">{t('settings.general.uiZoomDescription')}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--color-text-tertiary)]">
            <span>{t('settings.general.uiZoomShortcutHint')}</span>
            <span className="inline-flex items-center gap-1">
              <span className="font-medium text-[var(--color-text-secondary)]">{t('settings.general.uiZoomShortcutMac')}</span>
              <kbd className="settings-zoom-kbd">⌘</kbd>
              <kbd className="settings-zoom-kbd">+</kbd>
              <span>/</span>
              <kbd className="settings-zoom-kbd">⌘</kbd>
              <kbd className="settings-zoom-kbd">-</kbd>
              <span>/</span>
              <kbd className="settings-zoom-kbd">⌘</kbd>
              <kbd className="settings-zoom-kbd">0</kbd>
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="font-medium text-[var(--color-text-secondary)]">{t('settings.general.uiZoomShortcutWindows')}</span>
              <kbd className="settings-zoom-kbd">Ctrl</kbd>
              <kbd className="settings-zoom-kbd">+</kbd>
              <span>/</span>
              <kbd className="settings-zoom-kbd">Ctrl</kbd>
              <kbd className="settings-zoom-kbd">-</kbd>
              <span>/</span>
              <kbd className="settings-zoom-kbd">Ctrl</kbd>
              <kbd className="settings-zoom-kbd">0</kbd>
            </span>
            <span>{t('settings.general.uiZoomShortcutResetHint')}</span>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <span className="min-w-[48px] rounded-[var(--radius-md)] bg-[var(--color-surface-container-low)] px-2 py-1 text-center text-sm font-medium text-[var(--color-text-secondary)]">
            {uiZoomPercent}%
          </span>
          <Button
            variant="secondary"
            size="base"
            aria-label={t('settings.general.uiZoomReset')}
            title={t('settings.general.uiZoomReset')}
            onClick={() => {
              setIsUiZoomDragging(false)
              setUiZoomDraft(UI_ZOOM_DEFAULT)
              setUiZoom(UI_ZOOM_DEFAULT)
            }}
            icon={<RotateCw className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            100%
          </Button>
        </div>
      </div>
      <div
        className={`settings-zoom-control flex items-center gap-3 ${isUiZoomDragging ? 'is-dragging' : ''}`}
        style={{ '--settings-zoom-range-progress': uiZoomRangeProgress } as CSSProperties}
      >
        <span className="w-9 text-right text-xs text-[var(--color-text-tertiary)]">{Math.round(UI_ZOOM_MIN * 100)}%</span>
        <div className="settings-zoom-range-wrap flex-1">
          <div className="settings-zoom-preview" aria-hidden="true">
            {uiZoomPercent}%
          </div>
          <input
            type="range"
            aria-label={t('settings.general.uiZoom')}
            min={UI_ZOOM_MIN}
            max={UI_ZOOM_MAX}
            step={UI_ZOOM_STEP}
            value={uiZoomDraft}
            onPointerDown={() => {
              setUiZoomDraggingState(true)
            }}
            onPointerUp={(e) => commitUiZoom(e.currentTarget.valueAsNumber)}
            onPointerCancel={() => {
              setUiZoomDraggingState(false)
              setUiZoomDraft(uiZoom)
            }}
            onChange={(e) => {
              const nextZoom = Number.isFinite(e.currentTarget.valueAsNumber)
                ? e.currentTarget.valueAsNumber
                : UI_ZOOM_DEFAULT
              setUiZoomDraft(nextZoom)
              if (!isUiZoomDraggingRef.current) {
                setUiZoom(nextZoom)
              }
            }}
            onBlur={(e) => {
              if (uiZoomDraft !== uiZoom) {
                commitUiZoom(e.currentTarget.valueAsNumber)
              } else {
                setUiZoomDraggingState(false)
              }
            }}
            className="settings-zoom-range w-full"
          />
        </div>
        <span className="w-9 text-xs text-[var(--color-text-tertiary)]">{Math.round(UI_ZOOM_MAX * 100)}%</span>
      </div>
    </div>
  )

  return (
    <div className="max-w-xl">
      {/* No page header here on purpose: the only title it could carry is the nav
          label verbatim, with no description to add. The pane opens on its first
          section instead. */}
      {/* Appearance selector */}
      <SettingsSection
        title={t('settings.general.appearanceTitle')}
        description={t('settings.general.appearanceDescription')}
      >
        <div className="mb-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3">
          <Switch
            checked={followSystemTheme}
            onChange={setFollowSystemTheme}
            label={t('settings.general.appearance.followSystem')}
            description={t('settings.general.appearance.followSystemHint')}
          />
        </div>
        {followSystemTheme ? (
          // The OS decides which ground; what is left to choose is the palette
          // on each one, so the picker splits into the two grounds.
          <div className="flex flex-col gap-4">
            <div>
              <p className="mb-2 text-[12.5px] text-[var(--color-text-tertiary)]">
                {t('settings.general.appearance.lightThemeLabel')}
              </p>
              <div className="flex flex-wrap gap-2">
                {LIGHT_THEMES.map(({ value, label }) => (
                  <SettingsPill
                    key={value}
                    selected={lightTheme === value}
                    onClick={() => void setTheme(value)}
                  >
                    {label}
                  </SettingsPill>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-[12.5px] text-[var(--color-text-tertiary)]">
                {t('settings.general.appearance.darkThemeLabel')}
              </p>
              <div className="flex flex-wrap gap-2">
                {DARK_THEMES.map(({ value, label }) => (
                  <SettingsPill
                    key={value}
                    selected={darkTheme === value}
                    onClick={() => void setTheme(value)}
                  >
                    {label}
                  </SettingsPill>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {THEMES.map(({ value, label }) => (
              <SettingsPill
                key={value}
                selected={theme === value}
                onClick={() => void setTheme(value)}
              >
                {label}
              </SettingsPill>
            ))}
          </div>
        )}
      </SettingsSection>

      {/* Language selector */}
      <SettingsSection
        title={t('settings.general.languageTitle')}
        description={t('settings.general.languageDescription')}
      >
        <div className="flex flex-wrap gap-2">
          {LANGUAGES.map(({ value, label }) => (
            <SettingsPill
              key={value}
              selected={locale === value}
              onClick={() => setLocale(value)}
            >
              {label}
            </SettingsPill>
          ))}
        </div>
      </SettingsSection>

      {/* Response Language */}
      <h2
        className="text-[16.5px] font-semibold leading-tight text-[var(--color-text-primary)] mb-1"
        style={{ fontFamily: 'var(--font-headline)' }}
      >
        {t('settings.general.responseLangTitle')}
      </h2>
      <p className="text-[13px] leading-5 text-[var(--color-text-tertiary)] mb-3">{t('settings.general.responseLangDescription')}</p>
      <Dropdown<string>
        items={RESPONSE_LANGUAGES}
        value={responseLanguage}
        onChange={(value) => void setResponseLanguage(value)}
        width="100%"
        maxHeight={320}
        className="mb-8 block w-full"
        trigger={
          <Button
            variant="secondary"
            size="md"
            block
            className="h-10 gap-3"
            aria-label={t('settings.general.responseLangTitle')}
          >
            <span className="min-w-0 flex-1 truncate text-left">{selectedResponseLanguageLabel}</span>
            <span className="material-symbols-outlined flex-shrink-0 text-[18px] text-[var(--color-text-secondary)]">expand_more</span>
          </Button>
        }
      />

      {/* Output style */}
      <h2 className="text-[16.5px] font-semibold leading-tight text-[var(--color-text-primary)] mb-1" style={{ fontFamily: 'var(--font-headline)' }}>{t('settings.general.outputStyleTitle')}</h2>
      <p className="text-sm text-[var(--color-text-tertiary)] mb-3">{t('settings.general.outputStyleDescription')}</p>
      <Card radius="xl" surface="low" padding="none" className="mb-8 px-4 py-4">
        <Dropdown<string>
          items={outputStyleItems}
          value={outputStyle}
          onChange={(value) => void handleOutputStyleChange(value)}
          width="100%"
          maxHeight={360}
          className="block w-full"
          trigger={
            <Button
              variant="secondary"
              size="md"
              block
              className="h-auto min-h-10 gap-3 py-2"
              aria-label={t('settings.general.outputStyleSelectLabel')}
              disabled={outputStylesLoading}
              icon={<span className="material-symbols-outlined flex-shrink-0 text-[18px] text-[var(--color-text-secondary)]">format_paint</span>}
            >
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate font-medium">
                  {outputStylesLoading
                    ? t('settings.general.outputStyleLoading')
                    : selectedOutputStyleLabel}
                </span>
                {selectedOutputStyleDescription && (
                  <span className="mt-0.5 block truncate text-xs text-[var(--color-text-tertiary)]">
                    {selectedOutputStyleDescription}
                  </span>
                )}
              </span>
              <span className="material-symbols-outlined flex-shrink-0 text-[18px] text-[var(--color-text-secondary)]">expand_more</span>
            </Button>
          }
        />
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-tertiary)]">
          <span className="inline-flex items-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-medium text-[var(--color-text-secondary)]">
            {outputStyleScopeLabel}
          </span>
          {selectedOutputStyle && (
            <span className="inline-flex items-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1">
              {getOutputStyleSourceLabel(selectedOutputStyle.source, t)}
            </span>
          )}
          <span className="min-w-0 flex-1 leading-5">{outputStyleScopeHint}</span>
        </div>
        <p className="mt-2 text-xs leading-5 text-[var(--color-text-tertiary)]">
          {t('settings.general.outputStyleRestartHint')}
        </p>
        {outputStyleError && (
          <p className="mt-2 text-xs leading-5 text-[var(--color-error)]">
            {outputStyleError}
          </p>
        )}
      </Card>

      <div className="mt-8">
        <h2 className="text-[16.5px] font-semibold leading-tight text-[var(--color-text-primary)] mb-1" style={{ fontFamily: 'var(--font-headline)' }}>{t('settings.general.defaultPermissionTitle')}</h2>
        <p className="text-sm text-[var(--color-text-tertiary)] mb-3">{t('settings.general.defaultPermissionDescription')}</p>
        <Card radius="xl" surface="low" padding="none" className="px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-[var(--color-text-primary)]">
                {t('settings.general.defaultPermissionLabel')}
              </div>
              <div className="mt-1 text-xs leading-5 text-[var(--color-text-tertiary)]">
                {t('settings.general.defaultPermissionHint')}
              </div>
            </div>
            <PermissionModeSelector
              value={permissionMode}
              onChange={(mode) => void setPermissionMode(mode)}
              workDir={t('settings.general.defaultPermissionScope')}
              menuPlacement="bottom"
            />
          </div>
        </Card>
      </div>

      <div className="mt-8">
        <h2 className="text-[16.5px] font-semibold leading-tight text-[var(--color-text-primary)] mb-1" style={{ fontFamily: 'var(--font-headline)' }}>{t('settings.general.thinkingTitle')}</h2>
        <p className="text-sm text-[var(--color-text-tertiary)] mb-3">{t('settings.general.thinkingDescription')}</p>
        <label className="relative flex items-start gap-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3 cursor-pointer hover:border-[var(--color-border-focus)] transition-colors">
          <input
            type="checkbox"
            aria-label={t('settings.general.thinkingEnabled')}
            checked={thinkingEnabled}
            onChange={(e) => void setThinkingEnabled(e.target.checked)}
            className={SETTINGS_CHECKBOX_INPUT_CLASS}
          />
          <SettingsCheckboxMark checked={thinkingEnabled} />
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--color-text-primary)]">
              {t('settings.general.thinkingEnabled')}
            </div>
            <div className="text-xs text-[var(--color-text-tertiary)] mt-1 leading-5">
              {t('settings.general.thinkingHint')}
            </div>
          </div>
        </label>
      </div>

      <div className="mt-8">
        <h2 className="text-[16.5px] font-semibold leading-tight text-[var(--color-text-primary)] mb-1" style={{ fontFamily: 'var(--font-headline)' }}>{t('settings.general.autoDreamTitle')}</h2>
        <p className="text-sm text-[var(--color-text-tertiary)] mb-3">{t('settings.general.autoDreamDescription')}</p>
        <label className="relative flex items-start gap-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3 cursor-pointer hover:border-[var(--color-border-focus)] transition-colors">
          <input
            type="checkbox"
            aria-label={t('settings.general.autoDreamEnabled')}
            checked={autoDreamEnabled}
            onChange={(e) => handleAutoDreamToggle(e.target.checked)}
            className={SETTINGS_CHECKBOX_INPUT_CLASS}
          />
          <SettingsCheckboxMark checked={autoDreamEnabled} />
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--color-text-primary)]">
              {t('settings.general.autoDreamEnabled')}
            </div>
            <div className="text-xs text-[var(--color-text-tertiary)] mt-1 leading-5">
              {autoDreamEnabled
                ? t('settings.general.autoDreamHintOn')
                : t('settings.general.autoDreamHintOff')}
            </div>
          </div>
        </label>
      </div>

      <div className="mt-8">
        <h2 className="text-[16.5px] font-semibold leading-tight text-[var(--color-text-primary)] mb-1" style={{ fontFamily: 'var(--font-headline)' }}>{t('settings.general.traceTitle')}</h2>
        <p className="text-sm text-[var(--color-text-tertiary)] mb-3">{t('settings.general.traceDescription')}</p>
        <label className="relative flex items-start gap-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3 cursor-pointer hover:border-[var(--color-border-focus)] transition-colors">
          <input
            type="checkbox"
            aria-label={t('settings.general.traceEnabled')}
            checked={traceCapture.enabled}
            onChange={(e) => void setTraceCaptureEnabled(e.target.checked)}
            className={SETTINGS_CHECKBOX_INPUT_CLASS}
          />
          <SettingsCheckboxMark checked={traceCapture.enabled} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-[var(--color-text-primary)]">
              {t('settings.general.traceEnabled')}
            </div>
            <div className="text-xs text-[var(--color-text-tertiary)] mt-1 leading-5">
              {traceCapture.enabled ? t('settings.general.traceHintOn') : t('settings.general.traceHintOff')}
            </div>
            {traceCapture.storageDir && (
              <div className="mt-2 truncate rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[11px] text-[var(--color-text-secondary)]">
                {traceCapture.storageDir}
              </div>
            )}
          </div>
        </label>
      </div>

      <div className="mt-8">
        <h2 className="text-[16.5px] font-semibold leading-tight text-[var(--color-text-primary)] mb-1" style={{ fontFamily: 'var(--font-headline)' }}>{t('settings.general.notificationsTitle')}</h2>
        <p className="text-sm text-[var(--color-text-tertiary)] mb-3">{t('settings.general.notificationsDescription')}</p>
        <Card radius="xl" surface="low" padding="none" className="px-4 py-3">
          <label className="relative flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              aria-label={t('settings.general.notificationsEnabled')}
              checked={desktopNotificationsEnabled}
              onChange={(e) => void handleDesktopNotificationsToggle(e.target.checked)}
              className={SETTINGS_CHECKBOX_INPUT_CLASS}
            />
            <SettingsCheckboxMark checked={desktopNotificationsEnabled} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-[var(--color-text-primary)]">
                {t('settings.general.notificationsEnabled')}
              </div>
              <div className="text-xs text-[var(--color-text-tertiary)] mt-1 leading-5">
                {desktopNotificationsEnabled
                  ? t('settings.general.notificationsHintOn')
                  : t('settings.general.notificationsHintOff')}
              </div>
            </div>
          </label>
          {desktopNotificationsEnabled && (
            <div className="mt-3 flex items-center justify-between gap-3 border-t border-[var(--color-border-separator)] pt-3">
              <div className="min-w-0 text-xs text-[var(--color-text-tertiary)]">
                {t('settings.general.notificationsStatus')}: {notificationStatusLabel[notificationPermission]}
              </div>
              {notificationPermission !== 'granted' && notificationPermission !== 'unsupported' && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="px-3 whitespace-nowrap"
                  disabled={notificationActionRunning}
                  onClick={() => void handleNotificationPermissionAction()}
                >
                  {notificationPermission === 'denied'
                    ? t('settings.general.notificationsOpenSettings')
                    : t('settings.general.notificationsAuthorize')}
                </Button>
              )}
            </div>
          )}
        </Card>
      </div>

      <div className="mt-8">
        <h2 className="text-[16.5px] font-semibold leading-tight text-[var(--color-text-primary)] mb-1" style={{ fontFamily: 'var(--font-headline)' }}>{t('settings.general.chatSendBehaviorTitle')}</h2>
        <p className="text-sm text-[var(--color-text-tertiary)] mb-3">{t('settings.general.chatSendBehaviorDescription')}</p>
        <Card radius="xl" surface="low" padding="none" className="grid grid-cols-2 gap-2 p-2">
          {CHAT_SEND_BEHAVIORS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => void setChatSendBehavior(option.value)}
              aria-pressed={chatSendBehavior === option.value}
              className={`rounded-[var(--radius-lg)] border px-3 py-2 text-left transition-colors ${
                chatSendBehavior === option.value
                  ? 'border-[var(--color-brand)] bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
              }`}
            >
              <div className="text-xs font-semibold">{option.label}</div>
              <div className="mt-1 text-[11px] leading-4 text-[var(--color-text-tertiary)]">
                {option.description}
              </div>
            </button>
          ))}
        </Card>
      </div>

      {uiZoomSection}

      <div className="mt-8">
        <h2 className="text-[16.5px] font-semibold leading-tight text-[var(--color-text-primary)] mb-1" style={{ fontFamily: 'var(--font-headline)' }}>{t('settings.general.networkTitle')}</h2>
        <p className="text-sm text-[var(--color-text-tertiary)] mb-3">{t('settings.general.networkDescription')}</p>
        <Card radius="xl" surface="low" padding="none" className="px-4 py-4">
          <div className="grid grid-cols-2 gap-2">
            {NETWORK_PROXY_MODES.map((mode) => (
              <button
                key={mode.value}
                type="button"
                onClick={() => {
                  setNetworkDraft((current) => ({
                    ...current,
                    proxy: { ...current.proxy, mode: mode.value },
                  }))
                  setNetworkSaveError(null)
                }}
                aria-pressed={networkDraft.proxy.mode === mode.value}
                className={`rounded-[var(--radius-lg)] border px-3 py-2 text-left transition-colors ${
                  networkDraft.proxy.mode === mode.value
                    ? 'border-[var(--color-brand)] bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                }`}
              >
                <div className="text-xs font-semibold">{mode.label}</div>
                <div className="mt-1 text-[11px] leading-4 text-[var(--color-text-tertiary)]">
                  {mode.description}
                </div>
              </button>
            ))}
          </div>

          {networkDraft.proxy.mode === 'manual' && (
            <div className="mt-4">
              <Input
                id="network-proxy-url"
                label={t('settings.general.networkProxyUrl')}
                value={networkDraft.proxy.url}
                placeholder="http://127.0.0.1:7890"
                autoComplete="off"
                onChange={(event) => {
                  setNetworkDraft((current) => ({
                    ...current,
                    proxy: { ...current.proxy, url: event.target.value },
                  }))
                  setNetworkSaveError(null)
                }}
              />
              <p className={`mt-1 text-[11px] leading-4 ${networkProxyError ? 'text-[var(--color-error)]' : 'text-[var(--color-text-tertiary)]'}`}>
                {networkProxyError ?? t('settings.general.networkProxyUrlHint')}
              </p>
            </div>
          )}

          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <label htmlFor="network-timeout-seconds" className="text-sm font-medium text-[var(--color-text-primary)]">
                {t('settings.general.networkTimeout')}
              </label>
              <span className="rounded-[var(--radius-md)] bg-[var(--color-surface)] px-2 py-1 text-xs font-medium text-[var(--color-text-secondary)]">
                {t('settings.general.networkTimeoutValue', { seconds: String(timeoutSeconds) })}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-10 w-10 px-0"
                aria-label={t('settings.general.networkTimeoutDecrease')}
                onClick={() => setNetworkTimeoutSeconds((parsedNetworkTimeoutSeconds ?? timeoutSeconds) - NETWORK_TIMEOUT_STEP_SECONDS)}
              >
                -30
              </Button>
              <div className="relative min-w-0 flex-1">
                <input
                  id="network-timeout-seconds"
                  type="number"
                  min={NETWORK_TIMEOUT_MIN_SECONDS}
                  max={NETWORK_TIMEOUT_MAX_SECONDS}
                  step={1}
                  inputMode="numeric"
                  value={networkTimeoutInput}
                  aria-invalid={networkTimeoutError ? true : undefined}
                  aria-describedby="network-timeout-help"
                  onChange={(event) => {
                    const nextValue = event.currentTarget.value
                    if (!/^\d*$/.test(nextValue)) return
                    setNetworkTimeoutInput(nextValue)
                    const seconds = Number(nextValue)
                    if (nextValue.length > 0 && seconds >= NETWORK_TIMEOUT_MIN_SECONDS && seconds <= NETWORK_TIMEOUT_MAX_SECONDS) {
                      setNetworkDraft((current) => ({
                        ...current,
                        aiRequestTimeoutMs: seconds * 1000,
                      }))
                    }
                    setNetworkSaveError(null)
                  }}
                  className={`h-10 w-full rounded-[var(--radius-md)] border bg-[var(--color-surface)] px-3 pr-12 text-sm text-[var(--color-text-primary)] outline-none transition-colors duration-150 placeholder:text-[var(--color-text-tertiary)] ${
                    networkTimeoutError
                      ? 'border-[var(--color-error)] focus:shadow-[var(--shadow-error-ring)]'
                      : 'border-[var(--color-border)] focus:border-[var(--color-border-focus)] focus:shadow-[var(--shadow-focus-ring)]'
                  }`}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[var(--color-text-tertiary)]">
                  {t('settings.general.networkTimeoutUnit')}
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-10 w-10 px-0"
                aria-label={t('settings.general.networkTimeoutIncrease')}
                onClick={() => setNetworkTimeoutSeconds((parsedNetworkTimeoutSeconds ?? timeoutSeconds) + NETWORK_TIMEOUT_STEP_SECONDS)}
              >
                +30
              </Button>
            </div>
            <p
              id="network-timeout-help"
              className={`mt-2 text-xs leading-5 ${networkTimeoutError ? 'text-[var(--color-error)]' : 'text-[var(--color-text-tertiary)]'}`}
            >
              {networkTimeoutError ?? t('settings.general.networkTimeoutHint')}
            </p>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="min-w-0 text-[11px] leading-4 text-[var(--color-text-tertiary)]">
              {t('settings.general.networkScopeHint')}
            </p>
            <Button
              size="sm"
              variant="secondary"
              className="min-w-[72px] px-4 whitespace-nowrap"
              disabled={!networkDirty || !!networkProxyError || !!networkTimeoutError || isSavingNetwork}
              loading={isSavingNetwork}
              onClick={() => void saveNetworkSettings()}
            >
              {t('settings.general.networkSave')}
            </Button>
          </div>

          {networkSaveError && (
            <p className="mt-2 text-[11px] leading-4 text-[var(--color-error)]">
              {networkSaveError}
            </p>
          )}
        </Card>
      </div>

      <div className="mt-8">
        <h2 className="text-[16.5px] font-semibold leading-tight text-[var(--color-text-primary)] mb-1" style={{ fontFamily: 'var(--font-headline)' }}>{t('settings.general.webFetchPreflightTitle')}</h2>
        <p className="text-sm text-[var(--color-text-tertiary)] mb-3">{t('settings.general.webFetchPreflightDescription')}</p>
        <label className="relative flex items-start gap-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3 cursor-pointer hover:border-[var(--color-border-focus)] transition-colors">
          <input
            type="checkbox"
            aria-label={t('settings.general.webFetchPreflightEnabled')}
            checked={skipWebFetchPreflight}
            onChange={(e) => void setSkipWebFetchPreflight(e.target.checked)}
            className={SETTINGS_CHECKBOX_INPUT_CLASS}
          />
          <SettingsCheckboxMark checked={skipWebFetchPreflight} />
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--color-text-primary)]">
              {t('settings.general.webFetchPreflightEnabled')}
            </div>
            <div className="text-xs text-[var(--color-text-tertiary)] mt-1 leading-5">
              {t('settings.general.webFetchPreflightHint')}
            </div>
          </div>
        </label>
      </div>

      <div className="mt-8">
        <h2 className="text-[16.5px] font-semibold leading-tight text-[var(--color-text-primary)] mb-1" style={{ fontFamily: 'var(--font-headline)' }}>{t('settings.general.webSearchTitle')}</h2>
        <p className="text-sm text-[var(--color-text-tertiary)] mb-3">{t('settings.general.webSearchDescription')}</p>
        <Card radius="xl" surface="low" padding="none" className="px-4 py-4">
          <div className="grid grid-cols-5 gap-1.5 mb-4">
            {WEB_SEARCH_MODES.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => setWebSearchDraft({ ...webSearchDraft, mode: value })}
                className={`h-9 px-2 text-xs font-semibold rounded-[var(--radius-lg)] border transition-all truncate ${
                  (webSearchDraft.mode ?? 'auto') === value
                    ? 'bg-[var(--color-brand)] text-[var(--color-on-primary)] border-[var(--color-brand)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                }`}
                title={label}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3">
            <Input
              id="web-search-tavily-key"
              type="password"
              label={t('settings.general.webSearchTavilyKey')}
              value={webSearchDraft.tavilyApiKey ?? ''}
              placeholder="tvly-..."
              autoComplete="off"
              onChange={(event) =>
                setWebSearchDraft({
                  ...webSearchDraft,
                  tavilyApiKey: event.target.value,
                })
              }
            />
            <div className="-mt-1 flex items-center justify-between gap-3 text-xs text-[var(--color-text-tertiary)]">
              <span>{t('settings.general.webSearchTavilyFreeHint')}</span>
              <a
                href="https://app.tavily.com/home"
                target="_blank"
                rel="noreferrer"
                aria-label={t('settings.general.webSearchTavilyApiKeyLink')}
                className="font-medium text-[var(--color-brand)] hover:underline whitespace-nowrap"
              >
                {t('settings.general.webSearchGetApiKey')}
              </a>
            </div>
            <Input
              id="web-search-brave-key"
              type="password"
              label={t('settings.general.webSearchBraveKey')}
              value={webSearchDraft.braveApiKey ?? ''}
              placeholder={t('settings.general.webSearchBravePlaceholder')}
              autoComplete="off"
              onChange={(event) =>
                setWebSearchDraft({
                  ...webSearchDraft,
                  braveApiKey: event.target.value,
                })
              }
            />
            <div className="-mt-1 flex items-center justify-between gap-3 text-xs text-[var(--color-text-tertiary)]">
              <span>{t('settings.general.webSearchBraveFreeHint')}</span>
              <a
                href="https://api-dashboard.search.brave.com/app/keys"
                target="_blank"
                rel="noreferrer"
                aria-label={t('settings.general.webSearchBraveApiKeyLink')}
                className="font-medium text-[var(--color-brand)] hover:underline whitespace-nowrap"
              >
                {t('settings.general.webSearchGetApiKey')}
              </a>
            </div>
          </div>
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-xs text-[var(--color-text-tertiary)] leading-5">
              {t('settings.general.webSearchHint')}
            </p>
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="secondary"
                className="min-w-[72px] px-4 whitespace-nowrap"
                disabled={!webSearchDirty}
                onClick={() => void setWebSearch(webSearchDraft)}
              >
                {t('settings.general.webSearchSave')}
              </Button>
            </div>
          </div>
        </Card>
      </div>

      {isDesktopRuntime() && (
        <div className="mt-8 border-t border-[var(--color-border)] pt-8">
          <h2 className="text-[16.5px] font-semibold leading-tight text-[var(--color-text-primary)] mb-1" style={{ fontFamily: 'var(--font-headline)' }}>{t('settings.general.storageTitle')}</h2>
          <p className="text-sm text-[var(--color-text-tertiary)] mb-3">{t('settings.general.storageDescription')}</p>

          <Card radius="xl" surface="low" padding="none" className="px-4 py-4">
            <div className="flex flex-col gap-3">
              <button
                type="button"
                onClick={() => {
                  if (isEnvironmentConfigDir) {
                    setModeError(t('settings.general.storageEnvironmentSwitchBlocked'))
                    return
                  }
                  if (appMode.mode !== 'default') {
                    openModeSwitchConfirm('default')
                  }
                }}
                aria-pressed={appMode.mode === 'default' && !isEnvironmentConfigDir}
                className={`flex items-start gap-3 rounded-[var(--radius-lg)] border px-3 py-3 text-left transition-all ${
                  appMode.mode === 'default' && !isEnvironmentConfigDir
                    ? 'border-[var(--color-brand)] bg-[var(--color-surface)] shadow-[var(--shadow-focus-ring)]'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-focus)]'
                }`}
              >
                <span className="material-symbols-outlined mt-0.5 text-[20px] text-[var(--color-text-secondary)]">settings_applications</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-[var(--color-text-primary)]">{t('settings.general.storageSystemTitle')}</span>
                  <span className="mt-1 block text-xs leading-5 text-[var(--color-text-tertiary)]">{t('settings.general.storageSystemDescription')}</span>
                </span>
              </button>

              <div
                className={`rounded-[var(--radius-lg)] border px-3 py-3 transition-all ${
                  appMode.mode === 'portable' && !isEnvironmentConfigDir
                    ? 'border-[var(--color-brand)] bg-[var(--color-surface)] shadow-[var(--shadow-focus-ring)]'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)]'
                }`}
              >
                <div className="mb-3 flex items-start gap-3">
                  <span className="material-symbols-outlined mt-0.5 text-[20px] text-[var(--color-text-secondary)]">drive_file_move</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-[var(--color-text-primary)]">{t('settings.general.storagePortableTitle')}</div>
                    <div className="mt-1 text-xs leading-5 text-[var(--color-text-tertiary)]">{t('settings.general.storagePortableDescription')}</div>
                  </div>
                </div>

                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Input
                      id="portable-data-dir"
                      label={t('settings.general.storagePortableDirLabel')}
                      value={portableDirDraft}
                      placeholder={t('settings.general.storagePortableDirPlaceholder')}
                      onChange={(event) => {
                        setPortableDirDraft(event.target.value)
                        setModeError(null)
                      }}
                      className="w-full font-mono text-xs"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-10 flex-shrink-0 px-3 whitespace-nowrap"
                    onClick={() => void openPortableDirPicker()}
                  >
                    {t('settings.general.storageChooseDir')}
                  </Button>
                </div>

                <div className="mt-3 flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={modeActionRunning || (appMode.mode === 'portable' && portableDirDraft.trim() === (appMode.portableDir ?? ''))}
                    onClick={() => openModeSwitchConfirm('portable')}
                  >
                    {t('settings.general.storageApplyPortable')}
                  </Button>
                </div>
              </div>
            </div>

            {activeConfigDir && (
              <div className="mt-3 rounded-[var(--radius-lg)] border border-[var(--color-border-separator)] bg-[var(--color-surface)] px-3 py-2">
                <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-tertiary)]">{t('settings.general.storageActiveDir')}</div>
                <div className="mt-1 break-all font-mono text-xs text-[var(--color-text-secondary)]">{activeConfigDir}</div>
              </div>
            )}

            {isEnvironmentConfigDir && (
              <div className="mt-3 rounded-[var(--radius-lg)] border border-[var(--color-warning)] bg-[var(--color-warning-container)] px-3 py-2 text-xs leading-5 text-[var(--color-on-warning-container)]">
                {t('settings.general.storageEnvironmentHint')}
              </div>
            )}

            {appModeRequiresRestart && (
              <div className="mt-3 rounded-[var(--radius-lg)] border border-[var(--color-warning)] bg-[var(--color-warning-container)] px-3 py-2 text-xs leading-5 text-[var(--color-on-warning-container)]">
                {t('settings.general.storageRestartHint')}
              </div>
            )}

            <div className="mt-3 text-xs leading-5 text-[var(--color-text-tertiary)]">
              {t('settings.general.storageMoveHint')}
            </div>

            {modeError && (
              <div className="mt-3 text-xs text-[var(--color-error)]">
                {modeError}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Confirm dialog for mode switch */}
      <ConfirmDialog
        open={modeSwitchConfirmOpen}
        onClose={closeModeSwitchConfirm}
        onConfirm={() => void confirmModeSwitch()}
        title={t('settings.general.modeSwitchTitle')}
        body={(
          <div className="space-y-3 text-sm leading-6 text-[var(--color-text-secondary)]">
            <p>
              {pendingMode === 'portable'
                ? t('settings.general.storageSwitchPortableBody')
                : t('settings.general.storageSwitchDefaultBody')}
            </p>
            {pendingMode === 'portable' && pendingPortableDir && (
              <div className="rounded-[var(--radius-lg)] bg-[var(--color-surface-container-low)] px-3 py-2 font-mono text-xs break-all text-[var(--color-text-secondary)]">
                {pendingPortableDir}
              </div>
            )}
            <p>{t('settings.general.storageSwitchRestartBody')}</p>
          </div>
        )}
        confirmLabel={t('settings.general.modeSwitchConfirm')}
        cancelLabel={t('common.cancel')}
        confirmVariant="primary"
        loading={modeActionRunning}
      />
      <ConfirmDialog
        open={autoDreamConfirmOpen}
        onClose={() => {
          if (!autoDreamActionRunning) setAutoDreamConfirmOpen(false)
        }}
        onConfirm={() => void confirmAutoDreamEnable()}
        title={t('settings.general.autoDreamConfirmTitle')}
        body={(
          <div className="space-y-2">
            <p>{t('settings.general.autoDreamConfirmKeepRunning')}</p>
            <p>{t('settings.general.autoDreamConfirmTokenCost')}</p>
          </div>
        )}
        confirmLabel={t('settings.general.autoDreamConfirmEnable')}
        cancelLabel={t('common.cancel')}
        confirmVariant="primary"
        loading={autoDreamActionRunning}
      />
    </div>
  )
}

function getBuiltInOutputStyleTranslationKeys(style: {
  value: string
  source: OutputStyleSource
}) {
  if (style.source !== 'built-in') return null
  return BUILT_IN_OUTPUT_STYLE_TRANSLATION_KEYS[
    style.value as keyof typeof BUILT_IN_OUTPUT_STYLE_TRANSLATION_KEYS
  ] ?? null
}

function getOutputStyleLabel(
  style: {
    value: string
    label: string
    source: OutputStyleSource
  },
  t: (key: TranslationKey) => string,
) {
  const keys = getBuiltInOutputStyleTranslationKeys(style)
  return keys ? t(keys.label) : style.label
}

function getOutputStyleDescription(
  style: {
    value: string
    description: string
    source: OutputStyleSource
  },
  t: (key: TranslationKey) => string,
) {
  const keys = getBuiltInOutputStyleTranslationKeys(style)
  return keys ? t(keys.description) : style.description
}

function getOutputStyleSourceLabel(
  source: OutputStyleSource,
  t: (key: TranslationKey) => string,
) {
  switch (source) {
    case 'built-in':
      return t('settings.general.outputStyleSourceBuiltIn')
    case 'userSettings':
      return t('settings.general.outputStyleSourceUser')
    case 'projectSettings':
      return t('settings.general.outputStyleSourceProject')
    case 'localSettings':
      return t('settings.general.outputStyleSourceLocal')
    case 'policySettings':
      return t('settings.general.outputStyleSourcePolicy')
    case 'plugin':
      return t('settings.general.outputStyleSourcePlugin')
  }
}

// ─── H5 Access Settings ──────────────────────────────────────

function H5AccessSettings() {
  const {
    h5Access,
    h5AccessDiagnostics,
    h5AccessError,
    enableH5Access,
    disableH5Access,
    regenerateH5AccessToken,
    updateH5AccessSettings,
  } = useSettingsStore()
  const t = useTranslation()
  const addToast = useUIStore((s) => s.addToast)
  const [h5PublicBaseUrlDraft, setH5PublicBaseUrlDraft] = useState(extractH5AccessAddressDraft(h5Access.publicBaseUrl))
  const [h5FixedPortDraft, setH5FixedPortDraft] = useState(h5Access.fixedPort != null ? String(h5Access.fixedPort) : '')
  const [h5GraceDraft, setH5GraceDraft] = useState(h5Access.disconnectGraceSeconds != null ? String(h5Access.disconnectGraceSeconds) : '')
  const [h5TokenVisible, setH5TokenVisible] = useState(false)
  const [h5EnableConfirmOpen, setH5EnableConfirmOpen] = useState(false)
  const [h5QrDataUrl, setH5QrDataUrl] = useState<string | null>(null)
  const [h5ActionRunning, setH5ActionRunning] = useState(false)
  const h5AccessUrl = h5Access.publicBaseUrl
  // The token is persisted server-side, so the QR code and copy actions stay
  // available across desktop restarts (issue #767).
  const h5Token = h5Access.token
  const h5LaunchUrl = useMemo(
    () => buildH5LaunchUrl(h5AccessUrl, h5Token),
    [h5AccessUrl, h5Token],
  )
  const h5ActivePort = h5AccessDiagnostics?.activePort != null
    ? String(h5AccessDiagnostics.activePort)
    : extractH5AccessPort(h5AccessUrl)
  const h5NextPublicBaseUrl = buildH5PublicBaseUrlFromHostDraft(h5PublicBaseUrlDraft, h5Access.publicBaseUrl)
  const h5NextFixedPort = parseH5FixedPortDraft(h5FixedPortDraft)
  const h5FixedPortInvalid = h5NextFixedPort === 'invalid'
  const h5NextGrace = parseH5GraceDraft(h5GraceDraft)
  const h5GraceInvalid = h5NextGrace === 'invalid'
  const h5AccessDirty = h5NextPublicBaseUrl !== (h5Access.publicBaseUrl ?? null) ||
    (!h5FixedPortInvalid && h5NextFixedPort !== h5Access.fixedPort) ||
    (!h5GraceInvalid && h5NextGrace !== h5Access.disconnectGraceSeconds)
  const h5FixedPortPendingRestart = h5Access.fixedPort != null &&
    h5ActivePort != null &&
    String(h5Access.fixedPort) !== h5ActivePort

  useEffect(() => {
    setH5PublicBaseUrlDraft(extractH5AccessAddressDraft(h5Access.publicBaseUrl))
    setH5FixedPortDraft(h5Access.fixedPort != null ? String(h5Access.fixedPort) : '')
    setH5GraceDraft(h5Access.disconnectGraceSeconds != null ? String(h5Access.disconnectGraceSeconds) : '')
  }, [h5Access])

  useEffect(() => {
    let cancelled = false
    if (!h5Access.enabled || !h5LaunchUrl || !h5Token) {
      setH5QrDataUrl(null)
      return () => {
        cancelled = true
      }
    }

    QRCode.toDataURL(h5LaunchUrl, { margin: 1, width: 192 })
      .then((dataUrl) => {
        if (!cancelled) setH5QrDataUrl(dataUrl)
      })
      .catch(() => {
        if (!cancelled) setH5QrDataUrl(null)
      })

    return () => {
      cancelled = true
    }
  }, [h5Access.enabled, h5LaunchUrl, h5Token])

  const runH5Action = async (action: () => Promise<void>) => {
    setH5ActionRunning(true)
    try {
      await action()
    } catch {
      // The store owns H5-specific error state.
    } finally {
      setH5ActionRunning(false)
    }
  }

  const handleH5SettingsSave = async () => {
    if (h5FixedPortInvalid || h5GraceInvalid) return
    await runH5Action(async () => {
      await updateH5AccessSettings({
        publicBaseUrl: h5NextPublicBaseUrl,
        fixedPort: h5NextFixedPort,
        disconnectGraceSeconds: h5NextGrace,
      })
    })
  }

  const handleH5SwitchToSuggestedHost = async () => {
    const suggested = h5AccessDiagnostics?.suggestedHost
    if (!suggested) return
    await runH5Action(async () => {
      // Build URL using current port if available, otherwise let backend pick.
      const port = extractH5AccessPort(h5Access.publicBaseUrl)
      const nextUrl = port ? `http://${suggested}:${port}` : `http://${suggested}`
      await updateH5AccessSettings({ publicBaseUrl: nextUrl })
    })
  }

  const handleH5UrlCopy = async () => {
    if (!h5AccessUrl) return
    const copied = await copyTextToClipboard(h5AccessUrl)
    addToast({
      type: copied ? 'success' : 'error',
      message: copied ? t('settings.general.h5AccessUrlCopied') : t('common.copyFailed'),
    })
  }

  const handleH5LaunchUrlCopy = async () => {
    if (!h5LaunchUrl) return
    const copied = await copyTextToClipboard(h5LaunchUrl)
    addToast({
      type: copied ? 'success' : 'error',
      message: copied ? t('settings.general.h5AccessLaunchUrlCopied') : t('common.copyFailed'),
    })
  }

  const handleH5EnableConfirm = async () => {
    await runH5Action(async () => {
      await enableH5Access()
      setH5TokenVisible(false)
      setH5EnableConfirmOpen(false)
    })
  }

  const handleH5Disable = async () => {
    await runH5Action(async () => {
      await disableH5Access()
      setH5TokenVisible(false)
    })
  }

  const handleH5Regenerate = async () => {
    await runH5Action(async () => {
      await regenerateH5AccessToken()
      setH5TokenVisible(false)
    })
  }

  return (
    <div className="max-w-3xl">
      <section aria-labelledby="h5-access-title" role="region">
        <div className="mb-6 flex items-start gap-3">
          <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] text-[var(--color-brand)]">
            <QrCode className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2
              id="h5-access-title"
              className="text-[24px] font-semibold leading-tight text-[var(--color-text-primary)]"
             style={{ fontFamily: 'var(--font-headline)' }}>
              {t('settings.general.h5AccessTitle')}
            </h2>
            <p className="mt-1.5 text-[13.5px] leading-6 text-[var(--color-text-secondary)]">
              {t('settings.general.h5AccessDescription')}
            </p>
          </div>
        </div>

        <Card radius="xl" surface="low" padding="none" className="px-4 py-4">
          <div className="flex items-start justify-between gap-4">
            <label className="flex min-w-0 items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 rounded-[var(--radius-sm)] border-[var(--color-border)] accent-[var(--color-brand)]"
                checked={h5Access.enabled}
                disabled={h5ActionRunning}
                aria-label={t('settings.general.h5AccessEnabled')}
                onChange={(event) => {
                  if (event.target.checked) {
                    setH5EnableConfirmOpen(true)
                  } else {
                    void handleH5Disable()
                  }
                }}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-[var(--color-text-primary)]">
                  {t('settings.general.h5AccessEnabled')}
                </span>
                <span className="mt-1 block text-xs leading-5 text-[var(--color-text-tertiary)]">
                  {t('settings.general.h5AccessEnabledHint')}
                </span>
              </span>
            </label>
            <Badge tone={h5Access.enabled ? 'success' : 'neutral'} size="sm" bordered={!h5Access.enabled}>
              {h5Access.enabled ? t('settings.general.h5AccessStatusEnabled') : t('settings.general.h5AccessDisabledValue')}
            </Badge>
          </div>

          {h5AccessDiagnostics?.storedHostStaleness === 'unreachable' && h5AccessDiagnostics.storedPublicBaseUrl ? (
            <div
              data-testid="h5-access-stale-host-banner"
              className="mt-4 rounded-[var(--radius-lg)] border border-[var(--color-warning)] bg-[var(--color-warning-container)] px-3 py-3 text-xs leading-5 text-[var(--color-on-warning-container)]"
            >
              <div className="font-semibold">
                {t('settings.general.h5AccessStaleHostTitle')}
              </div>
              <div className="mt-1 text-[var(--color-text-secondary)]">
                {h5AccessDiagnostics.suggestedHost
                  ? t('settings.general.h5AccessStaleHostBody', {
                      storedHost: extractHostnameFromUrl(h5AccessDiagnostics.storedPublicBaseUrl) ?? h5AccessDiagnostics.storedPublicBaseUrl,
                    })
                  : t('settings.general.h5AccessStaleHostNoSuggestion', {
                      storedHost: extractHostnameFromUrl(h5AccessDiagnostics.storedPublicBaseUrl) ?? h5AccessDiagnostics.storedPublicBaseUrl,
                    })}
              </div>
              {h5AccessDiagnostics.suggestedHost && (
                <div className="mt-2">
                  <Button
                    size="sm"
                    variant="primary"
                    loading={h5ActionRunning}
                    onClick={() => void handleH5SwitchToSuggestedHost()}
                    data-testid="h5-access-stale-host-apply"
                  >
                    {t('settings.general.h5AccessStaleHostApply', {
                      suggestedHost: h5AccessDiagnostics.suggestedHost,
                    })}
                  </Button>
                </div>
              )}
            </div>
          ) : null}

          {h5AccessDiagnostics?.storedHostStaleness === 'proxy' ? (
            <div
              data-testid="h5-access-proxy-note"
              className="mt-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3 py-2 text-xs leading-5 text-[var(--color-text-tertiary)]"
            >
              {t('settings.general.h5AccessProxyNote')}
            </div>
          ) : null}

          <div className="mt-4 grid grid-cols-1 gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_9rem_9rem]">
              <Input
                id="h5-access-public-url"
                label={t('settings.general.h5AccessPublicHost')}
                value={h5PublicBaseUrlDraft}
                placeholder={t('settings.general.h5AccessPublicHostPlaceholder')}
                onChange={(event) => setH5PublicBaseUrlDraft(event.target.value)}
              />
              <Input
                id="h5-access-fixed-port"
                label={t('settings.general.h5AccessFixedPort')}
                value={h5FixedPortDraft}
                placeholder={t('settings.general.h5AccessFixedPortPlaceholder')}
                inputMode="numeric"
                error={h5FixedPortInvalid ? t('settings.general.h5AccessFixedPortInvalid') : undefined}
                onChange={(event) => setH5FixedPortDraft(event.target.value)}
              />
              <Input
                id="h5-access-current-port"
                label={t('settings.general.h5AccessCurrentPort')}
                value={h5ActivePort ?? t('settings.general.h5AccessCurrentPortUnknown')}
                readOnly
                className="text-[var(--color-text-tertiary)]"
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-start">
              <Input
                id="h5-access-disconnect-grace"
                label={t('settings.general.h5AccessDisconnectGrace')}
                value={h5GraceDraft}
                placeholder={t('settings.general.h5AccessDisconnectGracePlaceholder')}
                inputMode="numeric"
                error={h5GraceInvalid ? t('settings.general.h5AccessDisconnectGraceInvalid') : undefined}
                onChange={(event) => setH5GraceDraft(event.target.value)}
              />
              <p className="text-xs leading-5 text-[var(--color-text-tertiary)] sm:pt-7">
                {t('settings.general.h5AccessDisconnectGraceHint')}
              </p>
            </div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-[var(--color-text-tertiary)]">
                {t('settings.general.h5AccessOpenHint')}
                {' '}
                {t('settings.general.h5AccessFixedPortHint')}
              </p>
              <Button
                size="sm"
                variant="secondary"
                className="shrink-0 whitespace-nowrap"
                onClick={() => void handleH5SettingsSave()}
                disabled={!h5AccessDirty || h5FixedPortInvalid || h5GraceInvalid || h5ActionRunning}
                aria-label={t('settings.general.h5AccessSave')}
              >
                {t('settings.general.h5AccessSave')}
              </Button>
            </div>
            {h5FixedPortPendingRestart && (
              <div
                data-testid="h5-access-fixed-port-restart-note"
                className="rounded-[var(--radius-lg)] border border-[var(--color-warning)] bg-[var(--color-warning-container)] px-3 py-2 text-xs leading-5 text-[var(--color-on-warning-container)]"
              >
                {t('settings.general.h5AccessFixedPortRestartNote', {
                  fixedPort: String(h5Access.fixedPort),
                  activePort: h5ActivePort ?? '',
                })}
              </div>
            )}
          </div>

          {h5AccessUrl && (
            <div className="mt-4 border-t border-[var(--color-border-separator)] pt-4">
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-xs uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                    {t('settings.general.h5AccessUrl')}
                  </div>
                  <div className="mt-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-code-bg)] px-3 py-2 font-mono text-[12.5px] leading-5 text-[var(--color-text-primary)] break-all">
                    {h5AccessUrl}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  className="shrink-0"
                  icon={<Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                  aria-label={t('settings.general.h5AccessCopyUrl')}
                  onClick={() => void handleH5UrlCopy()}
                >
                  {t('settings.general.h5AccessCopy')}
                </Button>
              </div>
            </div>
          )}

          {h5Access.enabled && h5AccessUrl && (
            <div className="mt-4 border-t border-[var(--color-border-separator)] pt-4">
              <div className="flex flex-col gap-4 sm:flex-row">
                <div className="flex h-48 w-48 shrink-0 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white p-3">
                  {h5QrDataUrl ? (
                    <img
                      src={h5QrDataUrl}
                      alt={t('settings.general.h5AccessQrAlt')}
                      className="h-full w-full"
                    />
                  ) : (
                    <div className="flex flex-col items-center gap-3 px-4 text-center">
                      {/* Stock neutrals on purpose: the QR box is a hardcoded
                          `bg-white` (scanners need the contrast), so this text
                          must stay dark in all three themes. Theme tokens would
                          go light-on-white under `data-theme="dark"`. */}
                      <QrCode className="h-12 w-12 text-neutral-400" aria-hidden="true" />
                      <p className="text-xs leading-5 text-neutral-500">
                        {t('settings.general.h5AccessQrEmptyHint')}
                      </p>
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium uppercase text-[var(--color-text-tertiary)]">
                    {t('settings.general.h5AccessQrTitle')}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-[var(--color-text-tertiary)]">
                    {h5Token
                      ? t('settings.general.h5AccessQrHint')
                      : t('settings.general.h5AccessQrRefreshHint')}
                  </p>
                  {h5LaunchUrl && (
                    <div className="mt-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-code-bg)] px-3 py-2 font-mono text-[12.5px] leading-5 text-[var(--color-text-primary)] break-all">
                      {h5LaunchUrl}
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                      disabled={!h5LaunchUrl || !h5Token}
                      onClick={() => void handleH5LaunchUrlCopy()}
                    >
                      {t('settings.general.h5AccessCopyLaunchUrl')}
                    </Button>
                    <Button
                      size="sm"
                      variant={h5Token ? 'secondary' : 'primary'}
                      icon={<RotateCw className="h-3.5 w-3.5" aria-hidden="true" />}
                      loading={h5ActionRunning}
                      onClick={() => void handleH5Regenerate()}
                    >
                      {h5Token ? t('settings.general.h5AccessRegenerate') : t('settings.general.h5AccessGenerateToken')}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {h5Access.enabled && (
            <div className="mt-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-medium uppercase text-[var(--color-text-tertiary)]">
                    {t('settings.general.h5AccessTokenPreview')}
                  </div>
                  <div className="mt-1 break-all font-mono text-[12.5px] leading-5 text-[var(--color-text-primary)]">
                    {h5TokenVisible && h5Token
                      ? h5Token
                      : h5Access.tokenPreview || t('settings.general.h5AccessTokenNotAvailable')}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={h5TokenVisible ? <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Eye className="h-3.5 w-3.5" aria-hidden="true" />}
                    disabled={!h5Token}
                    onClick={() => setH5TokenVisible((visible) => !visible)}
                  >
                    {h5TokenVisible ? t('settings.general.h5AccessHideToken') : t('settings.general.h5AccessShowToken')}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<PowerOff className="h-3.5 w-3.5" aria-hidden="true" />}
                    loading={h5ActionRunning}
                    onClick={() => void handleH5Disable()}
                  >
                    {t('settings.general.h5AccessDisable')}
                  </Button>
                </div>
              </div>
            </div>
          )}

          <p className="mt-4 text-xs text-[var(--color-text-tertiary)] leading-5">
            {t('settings.general.h5AccessSafetyNote')}
          </p>
          {h5AccessError && (
            <p className="mt-2 text-xs text-[var(--color-error)]">
              {h5AccessError}
            </p>
          )}
        </Card>
      </section>

      <ConfirmDialog
        open={h5EnableConfirmOpen}
        onClose={() => {
          if (!h5ActionRunning) setH5EnableConfirmOpen(false)
        }}
        onConfirm={handleH5EnableConfirm}
        title={t('settings.general.h5AccessConfirmTitle')}
        body={t('settings.general.h5AccessConfirmBody')}
        confirmLabel={t('settings.general.h5AccessConfirmEnable')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={h5ActionRunning}
      />
    </div>
  )
}

function SettingsCheckboxMark({ checked, disabled = false }: { checked: boolean; disabled?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-md)] border transition-all peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--color-border-focus)] ${
        checked
          ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-[var(--color-on-primary)] shadow-[var(--shadow-button-primary)]'
          : 'border-[var(--color-border-focus)] bg-[var(--color-surface)] text-transparent'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <span className="material-symbols-outlined text-[16px] leading-none" style={{ fontVariationSettings: "'FILL' 1" }}>
        check
      </span>
    </span>
  )
}

// ─── Skill Settings ──────────────────────────────────────

function SkillSettings() {
  const selectedSkill = useSkillStore((s) => s.selectedSkill)
  const t = useTranslation()

  if (selectedSkill) {
    return (
      <div className="w-full min-w-0">
        <SkillDetail />
      </div>
    )
  }

  return (
    <div className="w-full min-w-0">
      <SettingsPageHeader
        title={t('settings.skills.title')}
        description={t('settings.skills.description')}
      />
      <SkillList />
    </div>
  )
}

function PluginSettings() {
  const selectedPlugin = usePluginStore((s) => s.selectedPlugin)
  const t = useTranslation()

  if (selectedPlugin) {
    return (
      <div className="w-full min-w-0">
        <PluginDetail />
      </div>
    )
  }

  return (
    <div className="w-full min-w-0">
      <SettingsPageHeader
        title={t('settings.plugins.title')}
        description={t('settings.plugins.description')}
      />
      <PluginList />
    </div>
  )
}

// ─── About Settings ──────────────────────────────────────

const AUTHOR_DISPLAY = '千川小致'

function isValidHttpProxyUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}


/**
 * Deployment Mode settings — runtime switch between public and private-cloud
 * deployments. Changing the mode persists to settings.json, then prompts the
 * user to restart so the new mode takes effect (it is not hot-reloaded).
 */
function DeploymentModeSettings() {
  const {
    deploymentMode,
    privateCloudConfig,
    setDeploymentMode,
  } = useSettingsStore()
  const t = useTranslation()

  // Local draft state mirrors the persisted values so the user can edit the
  // private-cloud fields without committing on every keystroke.
  const [draftMode, setDraftMode] = useState<DeploymentMode>(deploymentMode)
  const [draftConfig, setDraftConfig] = useState<PrivateCloudConfig>(privateCloudConfig)
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Re-sync the draft when the persisted mode/config change externally.
  useEffect(() => {
    setDraftMode(deploymentMode)
    setDraftConfig(privateCloudConfig)
  }, [deploymentMode, privateCloudConfig])

  const hasUnsavedChanges =
    draftMode !== deploymentMode ||
    JSON.stringify(draftConfig) !== JSON.stringify(privateCloudConfig)

  const updateConfigField = (field: keyof PrivateCloudConfig, value: string) => {
    setDraftConfig((prev) => ({ ...prev, [field]: value }))
  }

  const handleSave = async () => {
    setIsSaving(true)
    setSaveError(null)
    try {
      await setDeploymentMode(draftMode, draftConfig)
      // Mode only takes effect on restart — prompt the user.
      setRestartConfirmOpen(true)
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : t('settings.deploymentMode.saveError'),
      )
    } finally {
      setIsSaving(false)
    }
  }

  const confirmRestart = async () => {
    const host = getDesktopHost()
    try {
      await host.appMode.prepareRestart()
      await host.appMode.restart()
    } catch {
      // If the restart API is unavailable (e.g. browser host), close the
      // dialog and let the user restart manually.
      setRestartConfirmOpen(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <SettingsPageHeader
        title={t('settings.deploymentMode.title')}
        description={t('settings.deploymentMode.description')}
        action={(
          <Button
            variant="primary"
            size="base"
            disabled={!hasUnsavedChanges || isSaving}
            loading={isSaving}
            onClick={handleSave}
          >
            {t('common.save')}
          </Button>
        )}
      />

      <SettingsSection title={t('settings.deploymentMode.modeSection')}>
        <div className="flex flex-col gap-3">
          <label className="flex items-start gap-3 cursor-pointer rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 transition-colors hover:bg-[var(--color-surface-hover)]">
            <input
              type="radio"
              name="deploymentMode"
              value="public"
              checked={draftMode === 'public'}
              onChange={() => setDraftMode('public')}
              className="mt-0.5"
            />
            <div>
              <div className="text-sm font-medium text-[var(--color-text-primary)]">
                {t('settings.deploymentMode.public')}
              </div>
              <div className="text-xs text-[var(--color-text-secondary)]">
                {t('settings.deploymentMode.publicDesc')}
              </div>
            </div>
          </label>

          <label className="flex items-start gap-3 cursor-pointer rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 transition-colors hover:bg-[var(--color-surface-hover)]">
            <input
              type="radio"
              name="deploymentMode"
              value="private-cloud"
              checked={draftMode === 'private-cloud'}
              onChange={() => setDraftMode('private-cloud')}
              className="mt-0.5"
            />
            <div>
              <div className="text-sm font-medium text-[var(--color-text-primary)]">
                {t('settings.deploymentMode.privateCloud')}
              </div>
              <div className="text-xs text-[var(--color-text-secondary)]">
                {t('settings.deploymentMode.privateCloudDesc')}
              </div>
            </div>
          </label>
        </div>
      </SettingsSection>

      {draftMode === 'private-cloud' && (
        <SettingsSection title={t('settings.deploymentMode.configSection')}>
          <div className="flex flex-col gap-4">
            <Input
              label={t('settings.deploymentMode.providerGatewayBaseUrl')}
              hint={t('settings.deploymentMode.providerGatewayHint')}
              value={draftConfig.providerGatewayBaseUrl ?? ''}
              onChange={(e) => updateConfigField('providerGatewayBaseUrl', e.target.value)}
              placeholder="https://gateway.intra.company.com"
            />
            <Input
              label={t('settings.deploymentMode.dingtalkEndpoint')}
              value={draftConfig.dingtalkEndpoint ?? ''}
              onChange={(e) => updateConfigField('dingtalkEndpoint', e.target.value)}
              placeholder="https://oapi.dingtalk.intra.company.com"
            />
            <Input
              label={t('settings.deploymentMode.feishuEndpoint')}
              value={draftConfig.feishuEndpoint ?? ''}
              onChange={(e) => updateConfigField('feishuEndpoint', e.target.value)}
              placeholder="https://open.feishu.intra.company.com"
            />
            <Input
              label={t('settings.deploymentMode.updateServerUrl')}
              hint={t('settings.deploymentMode.updateServerHint')}
              value={draftConfig.updateServerUrl ?? ''}
              onChange={(e) => updateConfigField('updateServerUrl', e.target.value)}
              placeholder="https://updates.intra.company.com/xiaozhi/"
            />
            <Input
              label={t('settings.deploymentMode.internalSkillSource')}
              hint={t('settings.deploymentMode.internalSkillHint')}
              value={draftConfig.internalSkillSource ?? ''}
              onChange={(e) => updateConfigField('internalSkillSource', e.target.value)}
              placeholder={t('settings.deploymentMode.comingSoon')}
              disabled
            />
            <Input
              label={t('settings.deploymentMode.telemetryEndpoint')}
              hint={t('settings.deploymentMode.telemetryHint')}
              value={draftConfig.telemetryEndpoint ?? ''}
              onChange={(e) => updateConfigField('telemetryEndpoint', e.target.value)}
              placeholder={t('settings.deploymentMode.telemetryPlaceholder')}
            />
          </div>
        </SettingsSection>
      )}

      {saveError && (
        <div className="mt-2 text-sm text-[var(--color-error)]">{saveError}</div>
      )}

      <ConfirmDialog
        open={restartConfirmOpen}
        onClose={() => setRestartConfirmOpen(false)}
        onConfirm={confirmRestart}
        title={t('settings.deploymentMode.restartTitle')}
        body={t('settings.deploymentMode.restartConfirm')}
        confirmLabel={t('settings.deploymentMode.restartNow')}
        cancelLabel={t('common.cancel')}
        confirmVariant="primary"
        loading={false}
      />
    </div>
  )
}
function AboutSettings() {
  const t = useTranslation()
  const [version, setVersion] = useState('')

  useEffect(() => {
    let cancelled = false
    getDesktopHost().app.getVersion()
      .then((value) => {
        if (!cancelled) setVersion(value)
      })
      .catch(() => {
        if (!cancelled) setVersion('')
      })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="w-full min-w-0 max-w-2xl mx-auto flex flex-col items-center py-6">
      {/* Logo + App Name + Version */}
      <img src={publicAssetPath('app-icon.png')} alt="" className="h-20 w-20 mb-4" />
      <h1 className="text-xl font-bold text-[var(--color-text-primary)]" style={{ fontFamily: 'var(--font-headline)' }}>千川小致Desktop</h1>
      {version && (
        <div className="mt-1 flex items-center gap-2 text-xs text-[var(--color-text-tertiary)]">
          <span>{t('settings.about.version')} {version}</span>
        </div>
      )}

      {/* Divider */}
      <div className="w-full border-t border-[var(--color-border-separator)] my-6" />

      {/* Author */}
      <div className="w-full">
        <h3 className="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-3">{t('settings.about.author')}</h3>
        <div className="w-full flex items-center gap-3 px-4 py-2.5 rounded-[var(--radius-lg)]">
          <span className="text-sm text-[var(--color-text-primary)]">{AUTHOR_DISPLAY}</span>
        </div>
      </div>
    </div>
  )
}
