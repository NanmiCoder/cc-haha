import { useState, useEffect, useMemo, useRef, useId, type CSSProperties, type ReactNode } from 'react'
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useProviderStore } from '../../stores/providerStore'
import { useUIStore } from '../../stores/uiStore'
import { useTranslation } from '../../i18n'
import { Modal } from '@/components/ui/Modal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Badge, StatusDot } from '@/components/ui/Badge'
import { Spinner } from '@/components/ui/Spinner'
import { SettingsPageHeader, SettingsPill } from '@/components/settings/SettingsSection'
import { Dropdown } from '@/components/ui/Dropdown'
import { Tooltip } from '@/components/ui/Tooltip'
import type { SavedProvider, UpdateProviderInput, ProviderTestResult, ModelMapping, Model1mSupport, ApiFormat, ProviderAuthStrategy, ProviderModelInfo, ProviderModelsErrorCode } from '../../types/provider'
import { groupProviderModels, providerModelsErrorKey } from '../../lib/providerModels'
import { apply1mSupportToContextInput, apply1mSupportToContextInputs, getAutoCompactWindowErrorKey, getModelContextWindowErrorKey, MODEL_SLOTS, parseAutoCompactWindowInput, parseModelContextWindowsInput, type ModelContextInputs, type ModelSlot } from '../../lib/providerModelContext'
import type { ProviderPreset } from '../../types/providerPreset'
import { normalizeProviderBaseUrl, presetMatchesBaseUrl, selectableProviderPresets } from '../../config/providerPresets'
import { ClaudeOfficialLogin } from '../../components/settings/ClaudeOfficialLogin'
import { ChatGPTOfficialLogin } from '../../components/settings/ChatGPTOfficialLogin'
import { GrokOfficialLogin } from '../../components/settings/GrokOfficialLogin'
import { CcSwitchImportModal } from '../../components/settings/CcSwitchImportModal'
import { ModelIdCombobox } from '../../components/settings/ModelIdCombobox'
import { ProviderImageGenerationFields, type ImageGenerationFormValue } from '../../components/settings/ProviderImageGenerationFields'
import { BUILT_IN_PROVIDER_IDS, CLAUDE_OFFICIAL_PROVIDER_ID, OPENAI_OFFICIAL_PROVIDER_ID } from '../../constants/openaiOfficialProvider'
import { GROK_OFFICIAL_PROVIDER_ID } from '../../constants/grokOfficialProvider'
import { getBaseUrl } from '../../api/client'
import { getDesktopHost } from '../../lib/desktopHost'
import { API_KEY_JSON_PLACEHOLDER, maskSettingsJsonSecrets, restoreSettingsJsonSecrets, stripProviderSettingsJsonEnv } from '../../lib/providerSettingsJson'
import { SETTINGS_CHECKBOX_INPUT_CLASS, SettingsCheckboxMark } from '../settings/shared'

/**
 * The Provider panel and the add/edit provider modal.
 *
 * Moved verbatim out of `Settings.tsx` as the last of the panel extractions. The list
 * and the modal come out together on purpose: they share forty-odd helpers for reading
 * and rewriting `settings.json` — auth env, model mappings, the 1M-context marker,
 * context windows, tool-search and beta flags — and splitting them apart would have
 * meant either duplicating that layer or inventing a module for it before anything
 * needed one.
 *
 * Only `ProviderSettings` is exported; everything else here has always been private to
 * this pair.
 */

type ProviderListItem =
  | { id: typeof CLAUDE_OFFICIAL_PROVIDER_ID; kind: 'claude-official' }
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
): ProviderListItem[] {
  const savedItems = new Map(
    providers.map((provider) => [
      provider.id,
      { id: provider.id, kind: 'saved', provider } satisfies ProviderListItem,
    ]),
  )
  const items = new Map<string, ProviderListItem>([
    [CLAUDE_OFFICIAL_PROVIDER_ID, { id: CLAUDE_OFFICIAL_PROVIDER_ID, kind: 'claude-official' }],
    [OPENAI_OFFICIAL_PROVIDER_ID, { id: OPENAI_OFFICIAL_PROVIDER_ID, kind: 'openai-official' }],
    [GROK_OFFICIAL_PROVIDER_ID, { id: GROK_OFFICIAL_PROVIDER_ID, kind: 'grok-official' }],
    ...savedItems,
  ])

  return normalizeProviderOrder(providerOrder, providers)
    .map((id) => items.get(id))
    .filter((item): item is ProviderListItem => item !== undefined)
}

function providerItemTestId(item: ProviderListItem): string {
  switch (item.kind) {
    case 'claude-official':
      return 'claude-official-provider'
    case 'openai-official':
      return 'openai-official-provider'
    case 'grok-official':
      return 'grok-official-provider'
    case 'saved':
      return `provider-${item.provider.id}`
  }
}

export function ProviderSettings() {
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
    activateOfficial,
    testProvider,
  } = useProviderStore()
  const fetchSettings = useSettingsStore((s) => s.fetchAll)
  const t = useTranslation()
  const [editingProvider, setEditingProvider] = useState<SavedProvider | null>(null)
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

  const handleActivateOfficial = async () => {
    await activateOfficial()
    await fetchSettings()
  }

  const providerItems = useMemo(
    () => buildProviderListItems(providers, providerOrder),
    [providerOrder, providers],
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

  const isClaudeOfficialActive = hasLoadedProviders && activeId === null
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
              if (item.kind === 'claude-official') {
                return (
                  <SortableProviderCard
                    key={item.id}
                    item={item}
                    isActive={isClaudeOfficialActive}
                    dragLabel={t('settings.providers.dragToReorder')}
                    onActivate={!isClaudeOfficialActive ? handleActivateOfficial : undefined}
                    title={t('settings.providers.officialName')}
                    subtitle={t('settings.providers.officialDesc')}
                    badges={isClaudeOfficialActive ? (
                      <Badge tone="brand" bordered>{t('settings.providers.default')}</Badge>
                    ) : null}
                    details={isClaudeOfficialActive ? (
                      <div className="border-t border-[var(--color-border-separator)] px-4 pb-4 pt-3">
                        <ClaudeOfficialLogin />
                      </div>
                    ) : null}
                  />
                )
              }

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
  return false
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
  toolSearchEnabled = false,
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
  const addToast = useUIStore((s) => s.addToast)
  const t = useTranslation()
  const baseUrlInputId = useId()

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
  const [toolSearchEnabled, setToolSearchEnabled] = useState(provider?.toolSearchEnabled ?? false)
  const [toolSearchConfirmOpen, setToolSearchConfirmOpen] = useState(false)
  const [disableExperimentalBetas, setDisableExperimentalBetas] = useState(provider?.disableExperimentalBetas ?? false)
  const [imageGeneration, setImageGeneration] = useState<ImageGenerationFormValue>({
    enabled: Boolean(provider?.imageGeneration),
    model: provider?.imageGeneration?.model ?? '',
    baseUrl: provider?.imageGeneration?.baseUrl ?? '',
    apiKey: provider?.imageGeneration?.apiKey ?? '',
  })
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
  const settingsJsonUserEditedRef = useRef(false)
  const providerProxyBaseUrl = useMemo(() => getProviderProxyBaseUrl(), [])
  const currentProviderSettings = {
    selectedPreset,
    baseUrl,
    apiFormat,
    authStrategy,
    apiKey,
    models,
    model1mSupport,
    modelContextInputs,
    autoCompactWindow,
    toolSearchEnabled,
    disableExperimentalBetas,
  }
  const providerSettingsRef = useRef(currentProviderSettings)
  providerSettingsRef.current = currentProviderSettings

  // Load current settings.json and merge provider env vars
  useEffect(() => {
    // Skip if JSON was just populated by user paste
    if (jsonPastedRef.current) {
      jsonPastedRef.current = false
      return
    }
    let cancelled = false
    import('../../api/providers').then(({ providersApi }) => {
      if (cancelled) return
      providersApi.getSettings().then((settings) => {
        if (cancelled || settingsJsonUserEditedRef.current) return
        const {
          selectedPreset,
          baseUrl,
          apiFormat,
          authStrategy,
          apiKey,
          models,
          model1mSupport,
          modelContextInputs,
          autoCompactWindow,
          toolSearchEnabled,
          disableExperimentalBetas,
        } = providerSettingsRef.current
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
        if (!cancelled && !settingsJsonUserEditedRef.current) {
          setSettingsJson((current) => current.trim() ? current : JSON.stringify({}, null, 2))
        }
      })
    })
    return () => {
      cancelled = true
    }
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
    settingsJsonUserEditedRef.current = false
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
    setToolSearchEnabled(false)
    setToolSearchConfirmOpen(false)
    setDisableExperimentalBetas(false)
    setShowContextSettings(false)
    setTestResult(null)
  }

  const isCustom = selectedPreset.id === 'custom'
  const requiresApiKey = selectedPreset.needsApiKey !== false
  const autoCompactWindowErrorKey = getAutoCompactWindowErrorKey(autoCompactWindow)
  const modelContextWindowErrorSlots = MODEL_SLOTS.filter((slot) => getModelContextWindowErrorKey(modelContextInputs[slot]))
  const canSubmit = name.trim() && baseUrl.trim() && (mode === 'edit' || !requiresApiKey || apiKey.trim()) && models.main.trim() && (!imageGeneration.enabled || imageGeneration.model.trim()) && !settingsJsonError && !autoCompactWindowErrorKey && modelContextWindowErrorSlots.length === 0
  const normalizedBaseUrl = normalizeProviderBaseUrl(baseUrl)
  const isPresetDefaultEndpoint = normalizedBaseUrl === normalizeProviderBaseUrl(selectedPreset.baseUrl)
  const apiKeyUrl = isPresetDefaultEndpoint ? selectedPreset.apiKeyUrl?.trim() : undefined
  const promoText = isPresetDefaultEndpoint ? selectedPreset.promoText?.trim() : undefined
  const displayedSettingsJson = showApiKey
    ? settingsJson
    : maskSettingsJsonSecrets(settingsJson)
  const regionalEndpointItems = (selectedPreset.regionalEndpoints ?? []).map((endpoint) => ({
    value: endpoint.baseUrl,
    label: endpoint.region === 'cn_zh'
      ? t('settings.providers.regionChina')
      : endpoint.region === 'global_en'
        ? t('settings.providers.regionGlobal')
        : endpoint.region,
    description: endpoint.baseUrl,
    icon: (
      <span className="material-symbols-outlined text-[17px]">
        {endpoint.region === 'cn_zh' ? 'location_on' : endpoint.region === 'global_en' ? 'public' : 'link'}
      </span>
    ),
  }))
  const selectedRegionalEndpointUrl = regionalEndpointItems.find(
    (option) => normalizeProviderBaseUrl(option.value) === normalizedBaseUrl,
  )?.value ?? ''
  // A hand-typed or pasted baseUrl may match no regional endpoint; the old
  // native select went blank there, but the Dropdown trigger needs real text.
  const selectedRegionalEndpointLabel = regionalEndpointItems.find(
    (item) => item.value === selectedRegionalEndpointUrl,
  )?.label ?? t('settings.providers.regionCustom')
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
    if (enabled) {
      setToolSearchConfirmOpen(true)
      return
    }
    setToolSearchEnabled(false)
    setSettingsJson((current) => updateSettingsJsonToolSearch(current, apiFormat, false))
  }
  const confirmToolSearchEnable = () => {
    setToolSearchEnabled(true)
    setSettingsJson((current) => updateSettingsJsonToolSearch(current, apiFormat, true))
    setToolSearchConfirmOpen(false)
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
  const hasModelsBaseUrl = Boolean(baseUrl.trim())
  const hasModelsApiKey = Boolean(apiKey.trim())
  const canFetchModels = hasModelsBaseUrl && hasModelsApiKey
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
        // The picker that just appeared is easy to miss below the button, so
        // point the user at it. Empty lists already render an inline notice.
        if (result.models.length > 0) {
          addToast({
            type: 'success',
            message: t('settings.providers.fetchModelsToast'),
          })
        }
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
  const modelPickerGroups = useMemo(
    () => groupProviderModels(
      fetchedModels ?? [],
      t('settings.providers.fetchModelsGroupOther'),
    ),
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
    const storedImageGeneration = imageGeneration.enabled
      ? {
          model: imageGeneration.model.trim(),
          ...(imageGeneration.baseUrl.trim() ? { baseUrl: imageGeneration.baseUrl.trim() } : {}),
          ...(imageGeneration.apiKey.trim() ? { apiKey: imageGeneration.apiKey.trim() } : {}),
        }
      : undefined
    setIsSubmitting(true)
    try {
      // Write the edited cc-haha settings.json first so provider-specific model
      // settings never conflict with the user's global ~/.claude/settings.json.
      if (settingsJson.trim()) {
        try {
          const parsed = restoreSettingsJsonSecrets(JSON.parse(settingsJson), settingsJson, apiKey)
          const { providersApi } = await import('../../api/providers')
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
          ...(storedImageGeneration !== undefined && { imageGeneration: storedImageGeneration }),
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
          imageGeneration: storedImageGeneration ?? null,
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
    <>
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

        {regionalEndpointItems.length > 1 && (
          <div>
            <label className="text-sm font-medium text-[var(--color-text-primary)] mb-1 block">{t('settings.providers.endpointRegion')}</label>
            <Dropdown<string>
              items={regionalEndpointItems}
              value={selectedRegionalEndpointUrl}
              onChange={handleBaseUrlChange}
              label={t('settings.providers.endpointRegion')}
              width="100%"
              className="block w-full"
              trigger={
                <Button variant="secondary" size="md" block className="h-10 gap-3">
                  <span className="min-w-0 flex-1 truncate text-left">{selectedRegionalEndpointLabel}</span>
                  <span className="material-symbols-outlined flex-shrink-0 text-[18px] text-[var(--color-text-secondary)]">expand_more</span>
                </Button>
              }
            />
          </div>
        )}

        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1">
            <label htmlFor={baseUrlInputId} className="text-sm font-medium text-[var(--color-text-primary)]">
              {t('settings.providers.baseUrl')}
              <span className="ml-0.5 text-[var(--color-error)]">*</span>
            </label>
            <Tooltip content={t('settings.providers.baseUrlTooltip')} placement="bottom-start">
              <IconButton
                icon="info"
                label={t('settings.providers.baseUrlHelp')}
                showTooltip={false}
                size="2xs"
                tone="muted"
                shape="circle"
              />
            </Tooltip>
          </div>
          <Input id={baseUrlInputId} required value={baseUrl} onChange={(e) => handleBaseUrlChange(e.target.value)} placeholder={t('settings.providers.baseUrlPlaceholder')} className="font-mono text-[13px]" />
        </div>

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

        <ProviderImageGenerationFields
          value={imageGeneration}
          onChange={setImageGeneration}
        />

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
          {!hasModelsApiKey ? (
            <p className="mb-2 text-[11px] text-[var(--color-text-tertiary)]">{t('settings.providers.fetchModelsApiKeyHint')}</p>
          ) : !hasModelsBaseUrl ? (
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
          ) : (
            <p className="mb-2 text-[11px] text-[var(--color-text-tertiary)]">{t('settings.providers.fetchModelsSupportHint')}</p>
          )}
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
                  <ModelIdCombobox
                    label={label}
                    required={slot === 'main'}
                    value={models[slot]}
                    onChange={(value) => handleModelChange(slot, value)}
                    placeholder={slot === 'main' ? t('settings.providers.modelIdPlaceholder') : t('settings.providers.sameAsMain')}
                    groups={modelPickerGroups}
                    pickerLabel={pickLabel}
                    noMatchesLabel={t('model.noMatches')}
                    moreResultsLabel={t('settings.providers.fetchModelsMoreResults')}
                  />
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
              settingsJsonUserEditedRef.current = true
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
      <ConfirmDialog
        open={toolSearchConfirmOpen}
        onClose={() => setToolSearchConfirmOpen(false)}
        onConfirm={confirmToolSearchEnable}
        title={t('settings.providers.toolSearchConfirmTitle')}
        body={(
          <div className="space-y-3 text-sm leading-6 text-[var(--color-text-secondary)]">
            <p>{t('settings.providers.toolSearchConfirmBody')}</p>
            <p className="rounded-[var(--radius-md)] border border-[var(--color-warning)] bg-[var(--color-warning-container)] px-3 py-2 text-[var(--color-on-warning-container)]">
              {t('settings.providers.toolSearchConfirmRisk')}
            </p>
          </div>
        )}
        confirmLabel={t('settings.providers.toolSearchConfirmEnable')}
        cancelLabel={t('common.cancel')}
        confirmVariant="primary"
      />
    </>
  )
}
