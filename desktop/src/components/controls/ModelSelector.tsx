import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BUNDLED_PROVIDER_PRESETS } from '../../config/providerPresets'
import { OFFICIAL_MODELS } from '../../constants/modelCatalog'
import {
  OPENAI_OFFICIAL_MODELS,
  OPENAI_OFFICIAL_PROVIDER_ID,
} from '../../constants/openaiOfficialProvider'
import { useTranslation } from '../../i18n'
import { useChatStore } from '../../stores/chatStore'
import { useProviderStore } from '../../stores/providerStore'
import { DRAFT_RUNTIME_SELECTION_KEY, useSessionRuntimeStore } from '../../stores/sessionRuntimeStore'
import { useSettingsStore } from '../../stores/settingsStore'
import type { SavedProvider } from '../../types/provider'
import type { RuntimeSelection } from '../../types/runtime'
import type { ModelInfo, ReasoningEffortLevel } from '../../types/settings'
import { useDismissable } from '@/hooks/useDismissable'
import { useMobileViewport } from '../../hooks/useMobileViewport'
import { isDesktopRuntime } from '../../lib/desktopRuntime'
import {
  normalizeRuntimeSelection,
  resolveDefaultRuntimeSelection,
} from '../../lib/runtimeSelection'
import { useHahaOAuthStore } from '../../stores/hahaOAuthStore'
import { useHahaOpenAIOAuthStore } from '../../stores/hahaOpenAIOAuthStore'
import { useHahaGrokOAuthStore } from '../../stores/hahaGrokOAuthStore'
import {
  GROK_OFFICIAL_MODELS,
  GROK_OFFICIAL_PROVIDER_ID,
} from '../../constants/grokOfficialProvider'
import { MobileBottomSheet } from '@/components/ui/MobileBottomSheet'
import { SearchField } from '@/components/ui/SearchField'
import { ReasoningEffortPopover } from './ReasoningEffortPopover'
import { useUIStore } from '../../stores/uiStore'
import { SETTINGS_TAB_ID, useTabStore } from '../../stores/tabStore'
import {
  getModelReasoningCapabilityOverride,
  isModelReasoningEffort,
  normalizeModelReasoningEffort,
  resolveModelReasoningProfile,
} from '../../../../src/shared/modelReasoning'

type ProviderChoice = {
  providerId: string | null
  providerName: string
  isDefault: boolean
  models: ModelInfo[]
}

type Props = {
  value?: string
  onChange?: (modelId: string) => void
  /**
   * Overrides the settings-store catalog for controlled pickers. This keeps
   * the shared search, portal, and viewport positioning while allowing a
   * feature to prepend semantic choices such as an inherited model.
   */
  models?: ModelInfo[]
  ariaLabel?: string
  appearance?: 'toolbar' | 'field'
  runtimeSelection?: RuntimeSelection
  onRuntimeSelectionChange?: (selection: RuntimeSelection) => void
  runtimeKey?: string
  disabled?: boolean
  compact?: boolean
  fluid?: boolean
}

export type ModelSelectorHandle = {
  open: () => void
}

type DropdownPosition = {
  top: number | undefined
  bottom: number | undefined
  left: number
  width: number
  maxHeight: number
}

const DROPDOWN_WIDTH = 360
const DROPDOWN_GAP = 8
const VIEWPORT_MARGIN = 16
const DROPDOWN_MAX_HEIGHT = 420
const DROPDOWN_MIN_HEIGHT = 180
const PROVIDER_PRESET_DEFAULT_ENVS = new Map(
  BUNDLED_PROVIDER_PRESETS.map(preset => [preset.id, preset.defaultEnv ?? {}]),
)

function getProviderModelCapabilityOverride(
  provider: SavedProvider,
  modelId: string,
): string | undefined {
  return getModelReasoningCapabilityOverride(
    modelId,
    provider.models,
    PROVIDER_PRESET_DEFAULT_ENVS.get(provider.presetId) ?? {},
  )
}

function officialChoices(
  providerId: string | null,
  models: ModelInfo[],
  isDefault: boolean,
  officialName: string,
): ProviderChoice {
  return {
    providerId,
    providerName: officialName,
    isDefault,
    models,
  }
}

function mergeOfficialModels(availableModels: ModelInfo[]): ModelInfo[] {
  const merged = [...OFFICIAL_MODELS]
  const knownIds = new Set(merged.map(model => model.id))
  for (const model of availableModels) {
    if (!knownIds.has(model.id)) {
      knownIds.add(model.id)
      merged.push(model)
    }
  }
  return merged
}

function buildProviderModels(
  provider: SavedProvider,
  labels: Record<'main' | 'haiku' | 'sonnet' | 'opus', string>,
): ModelInfo[] {
  const entries: Array<{ id: string; label: string }> = [
    { id: provider.models.main.trim(), label: labels.main },
    { id: provider.models.haiku.trim(), label: labels.haiku },
    { id: provider.models.sonnet.trim(), label: labels.sonnet },
    { id: provider.models.opus.trim(), label: labels.opus },
  ]

  const byId = new Map<string, { id: string; labels: string[] }>()
  for (const entry of entries) {
    if (!entry.id) continue
    const existing = byId.get(entry.id)
    if (existing) {
      if (!existing.labels.includes(entry.label)) {
        existing.labels.push(entry.label)
      }
      continue
    }
    byId.set(entry.id, { id: entry.id, labels: [entry.label] })
  }

  return [...byId.values()].map((entry) => {
    const reasoningProfile = resolveModelReasoningProfile(
      entry.id,
      provider.apiFormat,
      getProviderModelCapabilityOverride(provider, entry.id),
    )
    return {
      id: entry.id,
      name: entry.id,
      description: entry.labels.join(' · '),
      context: '',
      supportedReasoningEfforts: [...(reasoningProfile?.supportedReasoningEfforts ?? [])],
      ...(reasoningProfile?.defaultReasoningEffort
        ? { defaultReasoningEffort: reasoningProfile.defaultReasoningEffort }
        : {}),
    }
  })
}

function buildProviderChoices(
  providers: SavedProvider[],
  activeId: string | null,
  availableModels: ModelInfo[],
  officialName: string,
  openAIOfficialName: string,
  grokOfficialName: string,
  labels: Record<'main' | 'haiku' | 'sonnet' | 'opus', string>,
  claudeOfficialLoggedIn: boolean,
  openAIOfficialLoggedIn: boolean,
  grokOfficialLoggedIn: boolean,
): ProviderChoice[] {
  const claudeOfficialModels = activeId === null && availableModels.length > 0
    ? mergeOfficialModels(availableModels)
    : OFFICIAL_MODELS
  const openAIOfficialModels = activeId === OPENAI_OFFICIAL_PROVIDER_ID && availableModels.length > 0
    ? availableModels
    : OPENAI_OFFICIAL_MODELS
  const grokOfficialModels = activeId === GROK_OFFICIAL_PROVIDER_ID && availableModels.length > 0
    ? availableModels
    : GROK_OFFICIAL_MODELS

  const choices: ProviderChoice[] = []

  if (claudeOfficialLoggedIn) {
    choices.push(officialChoices(null, claudeOfficialModels, activeId === null, officialName))
  }
  if (openAIOfficialLoggedIn) {
    choices.push(officialChoices(
      OPENAI_OFFICIAL_PROVIDER_ID,
      openAIOfficialModels,
      activeId === OPENAI_OFFICIAL_PROVIDER_ID,
      openAIOfficialName,
    ))
  }
  if (grokOfficialLoggedIn) {
    choices.push(officialChoices(
      GROK_OFFICIAL_PROVIDER_ID,
      grokOfficialModels,
      activeId === GROK_OFFICIAL_PROVIDER_ID,
      grokOfficialName,
    ))
  }

  for (const provider of providers) {
    choices.push({
      providerId: provider.id,
      providerName: provider.name,
      isDefault: activeId === provider.id,
      models: buildProviderModels(provider, labels),
    })
  }

  return choices
}

function modelMatchesSearch(model: ModelInfo, query: string): boolean {
  return [model.id, model.name, model.description]
    .some(value => value.toLocaleLowerCase().includes(query))
}

export const ModelSelector = forwardRef<ModelSelectorHandle, Props>(function ModelSelector({
  value,
  onChange,
  models,
  ariaLabel,
  appearance = 'toolbar',
  runtimeSelection: controlledRuntimeSelection,
  onRuntimeSelectionChange,
  runtimeKey,
  disabled = false,
  compact = false,
  fluid = false,
}: Props = {}, selectorRef) {
  const t = useTranslation()
  const isMobileBrowser = useMobileViewport() && !isDesktopRuntime()
  const {
    currentModel: storeModel,
    availableModels,
    effortLevel,
    activeProviderName,
    setModel,
  } = useSettingsStore()
  const {
    providers,
    activeId,
    hasLoadedProviders,
    isLoading: providersLoading,
    fetchProviders,
  } = useProviderStore()
  const claudeOAuthStatus = useHahaOAuthStore((s) => s.status)
  const fetchClaudeOAuthStatus = useHahaOAuthStore((s) => s.fetchStatus)
  const openAIOAuthStatus = useHahaOpenAIOAuthStore((s) => s.status)
  const fetchOpenAIOAuthStatus = useHahaOpenAIOAuthStore((s) => s.fetchStatus)
  const grokOAuthStatus = useHahaGrokOAuthStore((s) => s.status)
  const fetchGrokOAuthStatus = useHahaGrokOAuthStore((s) => s.fetchStatus)
  const runtimeSelection = useSessionRuntimeStore((state) =>
    runtimeKey ? state.selections[runtimeKey] : undefined,
  )
  const [open, setOpen] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const effortButtonRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const requestedProvidersRef = useRef(false)
  const requestedOAuthStatusRef = useRef(false)

  const EFFORT_OPTIONS: { value: ReasoningEffortLevel; label: string }[] = [
    { value: 'low', label: t('settings.general.effort.low') },
    { value: 'medium', label: t('settings.general.effort.medium') },
    { value: 'high', label: t('settings.general.effort.high') },
    { value: 'xhigh', label: t('settings.general.effort.xhigh') },
    { value: 'max', label: t('settings.general.effort.max') },
  ]
  const effortLabels: Record<ReasoningEffortLevel, string> = {
    low: t('settings.general.effort.low'),
    medium: t('settings.general.effort.medium'),
    high: t('settings.general.effort.high'),
    xhigh: t('settings.general.effort.xhigh'),
    max: t('settings.general.effort.max'),
  }

  const isControlled = value !== undefined
  const isRuntimeScoped =
    !isControlled &&
    (runtimeKey !== undefined || onRuntimeSelectionChange !== undefined)
  const canEditRuntimeEffort = runtimeKey !== undefined

  useEffect(() => {
    if (
      !isRuntimeScoped ||
      hasLoadedProviders ||
      providersLoading ||
      requestedProvidersRef.current
    ) return
    requestedProvidersRef.current = true
    void fetchProviders()
  }, [fetchProviders, hasLoadedProviders, isRuntimeScoped, providersLoading])

  useEffect(() => {
    if (!isRuntimeScoped || !open || requestedOAuthStatusRef.current) return
    requestedOAuthStatusRef.current = true
    void fetchClaudeOAuthStatus()
    void fetchOpenAIOAuthStatus()
    void fetchGrokOAuthStatus()
  }, [fetchClaudeOAuthStatus, fetchGrokOAuthStatus, fetchOpenAIOAuthStatus, isRuntimeScoped, open])

  const closeSelector = useCallback(() => setOpen(false), [])

  // `ref` is the trigger row; `dropdownRef` is the portalled panel (or the
  // mobile sheet). `stopEscapePropagation` keeps one Escape from closing both
  // this dropdown and a dialog it was opened inside.
  useDismissable({
    open,
    refs: [ref, dropdownRef],
    onDismiss: closeSelector,
    stopEscapePropagation: true,
  })

  const updateDropdownPosition = useCallback(() => {
    const anchor = ref.current
    if (!anchor) return

    const rect = anchor.getBoundingClientRect()
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight
    const width = Math.min(DROPDOWN_WIDTH, Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2))
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, rect.right - width),
      Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN),
    )
    const spaceBelow = viewportHeight - rect.bottom - DROPDOWN_GAP - VIEWPORT_MARGIN
    const spaceAbove = rect.top - DROPDOWN_GAP - VIEWPORT_MARGIN
    const placeBelow = spaceBelow >= DROPDOWN_MIN_HEIGHT || spaceBelow >= spaceAbove
    const availableHeight = Math.max(
      DROPDOWN_MIN_HEIGHT,
      placeBelow ? spaceBelow : spaceAbove,
    )
    const maxHeight = Math.min(DROPDOWN_MAX_HEIGHT, availableHeight)

    setDropdownPosition({
      top: placeBelow ? rect.bottom + DROPDOWN_GAP : undefined,
      bottom: placeBelow ? undefined : (viewportHeight - rect.top + DROPDOWN_GAP),
      left,
      width,
      maxHeight,
    })
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      setDropdownPosition(null)
      return
    }
    updateDropdownPosition()
  }, [open, updateDropdownPosition])

  useEffect(() => {
    if (!open && searchQuery) setSearchQuery('')
  }, [open, searchQuery])

  useEffect(() => {
    if (!open) return
    window.addEventListener('resize', updateDropdownPosition)
    window.addEventListener('scroll', updateDropdownPosition, true)
    return () => {
      window.removeEventListener('resize', updateDropdownPosition)
      window.removeEventListener('scroll', updateDropdownPosition, true)
    }
  }, [open, updateDropdownPosition])

  const roleLabels = useMemo(
    () => ({
      main: t('settings.providers.mainModel'),
      haiku: t('settings.providers.haikuModel'),
      sonnet: t('settings.providers.sonnetModel'),
      opus: t('settings.providers.opusModel'),
    }),
    [t],
  )

  const providerChoices = useMemo(
    () => buildProviderChoices(
      providers,
      activeId,
      availableModels,
      t('settings.providers.officialName'),
      t('settings.providers.openaiOfficialName'),
      t('settings.providers.grokOfficialName'),
      roleLabels,
      claudeOAuthStatus?.loggedIn === true,
      openAIOAuthStatus?.loggedIn === true,
      grokOAuthStatus?.loggedIn === true,
    ),
    [activeId, availableModels, providers, roleLabels, t, claudeOAuthStatus, grokOAuthStatus, openAIOAuthStatus],
  )
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase()
  const selectableModels = isControlled && models ? models : availableModels
  const filteredProviderChoices = useMemo(() => {
    if (!normalizedSearchQuery) return providerChoices

    return providerChoices.flatMap((choice) => {
      const providerMatches = choice.providerName.toLocaleLowerCase().includes(normalizedSearchQuery)
      const models = providerMatches
        ? choice.models
        : choice.models.filter(model => modelMatchesSearch(model, normalizedSearchQuery))
      return models.length > 0 ? [{ ...choice, models }] : []
    })
  }, [normalizedSearchQuery, providerChoices])
  const filteredAvailableModels = useMemo(
    () => normalizedSearchQuery
      ? selectableModels.filter(model => modelMatchesSearch(model, normalizedSearchQuery))
      : selectableModels,
    [normalizedSearchQuery, selectableModels],
  )

  const selectedModel = isControlled
    ? selectableModels.find((model) => model.id === value) || null
    : storeModel

  const requestedRuntimeSelection = isRuntimeScoped
    ? controlledRuntimeSelection ?? runtimeSelection ?? resolveDefaultRuntimeSelection(
      activeId,
      activeProviderName,
      providers,
      storeModel?.id,
    )
    : null
  const activeRuntimeSelection = requestedRuntimeSelection && providerChoices.some(
    (choice) => choice.providerId === requestedRuntimeSelection.providerId,
  )
    ? requestedRuntimeSelection
    : null

  const selectedProviderChoice = activeRuntimeSelection
    ? providerChoices.find((choice) => choice.providerId === activeRuntimeSelection.providerId) ?? null
    : null

  const selectedRuntimeModel = activeRuntimeSelection
    ? selectedProviderChoice?.models.find((model) => model.id === activeRuntimeSelection.modelId)
      ?? {
        id: activeRuntimeSelection.modelId,
        name: activeRuntimeSelection.modelId,
        description: '',
        context: '',
      }
    : null

  const selectedRuntimeProvider = activeRuntimeSelection?.providerId
    ? providers.find((provider) => provider.id === activeRuntimeSelection.providerId) ?? null
    : null
  const runtimeEffortSuppressedByProvider =
    selectedRuntimeProvider?.disableExperimentalBetas === true &&
    (selectedRuntimeProvider.apiFormat ?? 'anthropic') === 'anthropic'

  const needsProviderConfiguration = isRuntimeScoped && providerChoices.length === 0
  const buttonModelLabel = isRuntimeScoped
    ? selectedRuntimeModel?.name
      ?? (needsProviderConfiguration ? t('model.configureProvider') : t('model.selectModel'))
    : selectedModel?.name ?? t('model.selectModel')
  const buttonProviderLabel = isRuntimeScoped
    ? selectedProviderChoice?.providerName ?? null
    : null
  const supportedRuntimeEfforts = selectedRuntimeModel?.supportedReasoningEfforts
  const selectedRuntimeEffort = selectedRuntimeModel && !runtimeEffortSuppressedByProvider
    ? supportedRuntimeEfforts?.length === 0
      ? undefined
      : activeRuntimeSelection?.effortLevel
        ?? selectedRuntimeModel.defaultReasoningEffort
        ?? effortLevel
    : undefined
  const runtimeEffortOptions = supportedRuntimeEfforts === undefined
    ? EFFORT_OPTIONS.filter((option) => option.value !== 'xhigh')
    : EFFORT_OPTIONS.filter((option) => supportedRuntimeEfforts.includes(option.value))

  const navigateToProviderSettings = useCallback(() => {
    setOpen(false)
    useUIStore.getState().setPendingSettingsTab('providers')
    useTabStore.getState().openTab(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings')
  }, [t])

  const openSelector = useCallback(() => {
    if (disabled) return
    setEffortOpen(false)

    if (!isRuntimeScoped || providerChoices.length > 0) {
      setOpen(true)
      return
    }

    const claudeStatus = useHahaOAuthStore.getState().status
    const openAIStatus = useHahaOpenAIOAuthStore.getState().status
    const grokStatus = useHahaGrokOAuthStore.getState().status
    const statuses = [claudeStatus, openAIStatus, grokStatus]
    const providerState = useProviderStore.getState()
    if (providerState.providers.length > 0) {
      setOpen(true)
      return
    }
    if (statuses.some((status) => status?.loggedIn === true)) {
      setOpen(true)
      return
    }
    if (providerState.hasLoadedProviders && statuses.every((status) => status !== null)) {
      navigateToProviderSettings()
      return
    }

    void (async () => {
      const latestProviderState = useProviderStore.getState()
      if (!latestProviderState.hasLoadedProviders) {
        await latestProviderState.fetchProviders()
      }
      if (useProviderStore.getState().providers.length > 0) {
        setOpen(true)
        return
      }

      requestedOAuthStatusRef.current = true
      await Promise.all([
        fetchClaudeOAuthStatus(),
        fetchOpenAIOAuthStatus(),
        fetchGrokOAuthStatus(),
      ])
      const hasOfficialLogin = [
        useHahaOAuthStore.getState().status,
        useHahaOpenAIOAuthStore.getState().status,
        useHahaGrokOAuthStore.getState().status,
      ].some((status) => status?.loggedIn === true)
      if (hasOfficialLogin) {
        setOpen(true)
      } else {
        navigateToProviderSettings()
      }
    })()
  }, [
    disabled,
    fetchClaudeOAuthStatus,
    fetchGrokOAuthStatus,
    fetchOpenAIOAuthStatus,
    isRuntimeScoped,
    navigateToProviderSettings,
    providerChoices.length,
  ])

  useImperativeHandle(selectorRef, () => ({
    open: openSelector,
  }), [openSelector])

  const handleRuntimeSelect = (selection: RuntimeSelection) => {
    const apiFormat = providers.find((provider) => provider.id === selection.providerId)?.apiFormat
    const normalizedSelection = normalizeRuntimeSelection(selection, apiFormat)
    onRuntimeSelectionChange?.(normalizedSelection)
    if (runtimeKey) {
      useSessionRuntimeStore.getState().setSelection(runtimeKey, normalizedSelection)
      if (runtimeKey !== DRAFT_RUNTIME_SELECTION_KEY) {
        useChatStore.getState().setSessionRuntime(runtimeKey, normalizedSelection)
      }
    }
    setOpen(false)
  }

  const handleRuntimeEffortSelect = (level: ReasoningEffortLevel) => {
    if (!activeRuntimeSelection) return
    handleRuntimeSelect({
      ...activeRuntimeSelection,
      effortLevel: level,
    })
  }

  const hasMatchingModels = isRuntimeScoped
    ? filteredProviderChoices.length > 0
    : filteredAvailableModels.length > 0
  const searchField = (
    <SearchField
      value={searchQuery}
      onChange={setSearchQuery}
      label={t('model.searchPlaceholder')}
      placeholder={t('model.searchPlaceholder')}
      clearLabel={t('model.clearSearch')}
      size={isMobileBrowser ? 'xl' : 'md'}
      autoFocus={!isMobileBrowser}
    />
  )

  const dropdownContent = (
    <>
      {/* The header stays OUTSIDE the scroll region: a sticky header inside
          `overflow-y-auto` depends on the engine compositing it above the
          scrolling layer, and on the desktop shell scrolled items paint
          through it (and above the panel edge). As a sibling above the
          scrollport, the list is hard-clipped below the header instead. */}
      {!isMobileBrowser && (
        <div className="flex-none border-b border-[var(--color-border)] px-3.5 pb-2 pt-3">
          <div className="mb-2 px-1 text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-tertiary)]">
            {t('model.configuration')}
          </div>
          {searchField}
        </div>
      )}
      <div className={`overflow-y-auto ${isMobileBrowser ? 'p-1' : 'min-h-0 flex-1 p-1.5'}`}>
        {!hasMatchingModels && (
          <div
            role="status"
            className={`flex items-center justify-center px-4 text-center text-sm text-[var(--color-text-tertiary)] ${isMobileBrowser ? 'min-h-28' : 'min-h-24'}`}
          >
            {t('model.noMatches')}
          </div>
        )}

        {isRuntimeScoped ? (
          <div className="space-y-3">
            {filteredProviderChoices.map((choice) => (
              <div key={choice.providerId ?? 'official'} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 px-3 pt-1">
                  <span className="truncate text-xs font-semibold text-[var(--color-text-tertiary)]">
                    {choice.providerName}
                  </span>
                  {choice.isDefault && (
                    <span className="flex-shrink-0 text-[10px] font-medium text-[var(--color-text-tertiary)]">
                      {t('settings.providers.default')}
                    </span>
                  )}
                </div>

                <div className="space-y-1">
                  {choice.models.map((model) => {
                    const isSelected =
                      activeRuntimeSelection?.providerId === choice.providerId &&
                      activeRuntimeSelection.modelId === model.id
                    return (
                      <button
                        key={`${choice.providerId ?? 'official'}:${model.id}`}
                        onClick={() => {
                          const supportedEfforts = model.supportedReasoningEfforts
                          const explicitEffort = activeRuntimeSelection?.effortLevel
                          const selectedProvider = providers.find(
                            (provider) => provider.id === choice.providerId,
                          )
                          const normalizedProviderEffort = explicitEffort &&
                            isModelReasoningEffort(explicitEffort)
                            ? normalizeModelReasoningEffort(
                                model.id,
                                explicitEffort,
                                selectedProvider?.apiFormat,
                                selectedProvider
                                  ? getProviderModelCapabilityOverride(selectedProvider, model.id)
                                  : undefined,
                              )
                            : undefined
                          const supportedProviderEffort = normalizedProviderEffort && (
                            supportedEfforts === undefined ||
                            supportedEfforts.includes(normalizedProviderEffort)
                          )
                            ? normalizedProviderEffort
                            : undefined
                          const nextEffort = supportedEfforts === undefined
                            ? explicitEffort ?? effortLevel
                            : supportedEfforts.length
                              ? supportedProviderEffort
                                ?? (explicitEffort && supportedEfforts.includes(explicitEffort)
                                ? explicitEffort
                                : supportedEfforts.includes(effortLevel)
                                  ? effortLevel
                                  : model.defaultReasoningEffort ?? supportedEfforts[0])
                              : undefined
                          handleRuntimeSelect({
                            providerId: choice.providerId,
                            modelId: model.id,
                            ...(nextEffort ? { effortLevel: nextEffort } : {}),
                          })
                        }}
                        className={`
                          w-full rounded-[var(--radius-md)] border px-3 text-left transition-colors
                          ${isMobileBrowser ? 'min-h-[56px] py-3' : 'py-2'}
                          ${isSelected
                            ? 'border-[var(--color-model-option-selected-border)] bg-[var(--color-model-option-selected-bg)]'
                            : 'border-transparent hover:bg-[var(--color-surface-hover)]'
                          }
                        `}
                      >
                        <div className="flex items-center gap-3">
                          <div className="min-w-0 flex-1">
                            {/* Model ids are identifiers, so they sit in the
                                mono face alongside paths and token counts. */}
                            <div className="truncate font-mono text-[13px] font-medium text-[var(--color-text-primary)]">
                              {model.name}
                            </div>
                            {model.description && (
                              <div className="mt-0.5 truncate pr-[6px] text-[11px] text-[var(--color-text-tertiary)]">
                                {model.description}
                              </div>
                            )}
                          </div>

                          {isSelected && (
                            <span className="material-symbols-outlined flex-shrink-0 text-[16px] text-[var(--color-brand)]">check</span>
                          )}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-1">
            {filteredAvailableModels.map((model) => {
              const isSelected = model.id === selectedModel?.id
              return (
                <button
                  key={model.id}
                  onClick={() => {
                    if (isControlled) {
                      onChange?.(model.id)
                    } else {
                      void setModel(model.id)
                    }
                    setOpen(false)
                  }}
                  className={`
                    w-full rounded-[var(--radius-md)] px-3 text-left transition-colors
                    ${isMobileBrowser ? 'min-h-[56px] py-3' : 'py-2'}
                    ${isSelected
                      ? 'border border-[var(--color-model-option-selected-border)] bg-[var(--color-model-option-selected-bg)]'
                      : 'hover:bg-[var(--color-surface-hover)]'
                    }
                  `}
                >
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[13px] font-medium text-[var(--color-text-primary)]">{model.name}</div>
                      {model.description && (
                        <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-tertiary)]">
                          {model.description}
                        </div>
                      )}
                    </div>

                    {isSelected && (
                      <span className="material-symbols-outlined flex-shrink-0 text-[16px] text-[var(--color-brand)]">check</span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

    </>
  )

  const dropdown = open && dropdownPosition
    ? isMobileBrowser ? (
      <MobileBottomSheet
        open={open}
        onClose={() => setOpen(false)}
        title={t('model.configuration')}
        closeLabel={t('tabs.close')}
        ariaLabel={t('model.configuration')}
        headerExtra={searchField}
        contentClassName="p-1"
        panelRef={dropdownRef}
        testId="model-selector-dropdown"
      >
        {dropdownContent}
      </MobileBottomSheet>
    ) : createPortal(
      <div
        ref={dropdownRef}
        data-testid="model-selector-dropdown"
        className="fixed z-[var(--z-dropdown)] flex flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-overlay)]"
        style={{
          top: dropdownPosition.top,
          bottom: dropdownPosition.bottom,
          left: dropdownPosition.left,
          width: dropdownPosition.width,
          maxHeight: dropdownPosition.maxHeight,
        }}
      >
        {dropdownContent}
      </div>,
      document.body,
    )
    : null

  return (
    <div
      data-testid="model-selector-shell"
      className={`relative min-w-0 ${fluid || appearance === 'field' ? 'flex-1' : 'shrink-0'}`}
    >
      {/* No fill at rest: on the composer row the model name is type, not a
          control chip — the handoff reserves filled pills for the permission
          and context chips and gives this one a hover ground only. */}
      {/* On the phone composer this sits between two 44px buttons and opens a
          bottom sheet, so both halves stretch to the same 44px touch target
          `PermissionModeSelector` uses; `compact` alone would also shrink the
          desktop composer, which narrows for the right panel, not for touch. */}
      <div
        ref={ref}
        className={`flex min-w-0 items-stretch rounded-[var(--radius-md)] transition-colors ${
          appearance === 'field'
            ? 'h-10 w-full border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-container-low)]'
            : 'hover:bg-[var(--color-surface-hover)]'
        } ${isMobileBrowser ? 'min-h-11' : ''} ${fluid ? 'w-full' : ''} ${disabled ? 'opacity-50' : ''}`}
      >
        <button
          type="button"
          onClick={() => {
            if (disabled) return
            if (open) {
              setOpen(false)
              return
            }
            openSelector()
          }}
          disabled={disabled}
          aria-label={ariaLabel ?? (buttonProviderLabel ? `${buttonModelLabel}, ${buttonProviderLabel}` : buttonModelLabel)}
          title={buttonProviderLabel ? `${buttonProviderLabel} · ${buttonModelLabel}` : buttonModelLabel}
          // `focus-visible:rounded-*` restores the other pair of corners while
          // focused. The ring traces `border-radius`, so on the half-rounded
          // halves of this segmented control it otherwise drew a box that was
          // rounded down one side and square down the other.
          className={`flex min-w-0 items-center gap-2 text-xs font-medium text-[var(--color-text-secondary)] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed ${
            appearance === 'field'
              ? 'h-full w-full rounded-[var(--radius-md)] px-3 text-left'
              : `rounded-l-[var(--radius-md)] focus-visible:rounded-[var(--radius-md)] ${compact ? `${fluid ? 'flex-1' : ''} max-w-[112px] py-1.5 pl-2.5 pr-1` : 'max-w-[220px] py-2 pl-2.5 pr-1'}`
          }`}
        >
          <span className={`${appearance === 'field' ? 'text-sm font-normal' : compact ? 'text-xs font-semibold' : 'text-[15px] font-semibold'} min-w-0 flex-1 truncate text-[var(--color-text-primary)]`}>
            {buttonModelLabel}
          </span>
          {!canEditRuntimeEffort && !compact && buttonProviderLabel && (
            <span className="max-w-[108px] flex-shrink-0 truncate text-[11px] text-[var(--color-text-tertiary)]">
              {buttonProviderLabel}
            </span>
          )}
          <span className={`material-symbols-outlined flex-shrink-0 text-[var(--color-text-tertiary)] ${appearance === 'field' ? 'text-[16px]' : 'text-[12px]'}`}>
            {needsProviderConfiguration ? 'arrow_forward' : 'expand_more'}
          </span>
        </button>

        {canEditRuntimeEffort && selectedRuntimeEffort && runtimeEffortOptions.length > 0 && (
          <button
            ref={effortButtonRef}
            type="button"
            disabled={disabled}
            aria-label={`${t('model.effort')}: ${effortLabels[selectedRuntimeEffort]}`}
            aria-expanded={effortOpen}
            onClick={() => {
              if (disabled) return
              setOpen(false)
              setEffortOpen(!effortOpen)
            }}
            className={`rounded-r-[var(--radius-md)] pr-2.5 text-[var(--color-text-secondary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:rounded-[var(--radius-md)] focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed ${compact ? 'pl-1 text-[10px]' : 'pl-1.5 text-[13.5px]'}`}
          >
            {effortLabels[selectedRuntimeEffort]}
          </button>
        )}
      </div>
      {dropdown}
      {canEditRuntimeEffort && selectedRuntimeEffort && (
        <ReasoningEffortPopover
          open={effortOpen}
          anchorRef={effortButtonRef}
          options={runtimeEffortOptions.map((option) => option.value)}
          value={selectedRuntimeEffort}
          labels={effortLabels}
          ariaLabel={t('model.effort')}
          onChange={handleRuntimeEffortSelect}
          onClose={() => setEffortOpen(false)}
        />
      )}
    </div>
  )
})
