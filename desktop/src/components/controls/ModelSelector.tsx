import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
import { useMobileViewport } from '../../hooks/useMobileViewport'
import { isDesktopRuntime } from '../../lib/desktopRuntime'
import { resolveDefaultRuntimeSelection } from '../../lib/runtimeSelection'
import { useHahaOAuthStore } from '../../stores/hahaOAuthStore'
import { useHahaOpenAIOAuthStore } from '../../stores/hahaOpenAIOAuthStore'
import { useHahaGrokOAuthStore } from '../../stores/hahaGrokOAuthStore'
import {
  GROK_OFFICIAL_MODELS,
  GROK_OFFICIAL_PROVIDER_ID,
} from '../../constants/grokOfficialProvider'
import { MobileBottomSheet } from '../shared/MobileBottomSheet'
import { ReasoningEffortPopover } from './ReasoningEffortPopover'

type ProviderChoice = {
  providerId: string | null
  providerName: string
  isDefault: boolean
  models: ModelInfo[]
}

type Props = {
  value?: string
  onChange?: (modelId: string) => void
  runtimeSelection?: RuntimeSelection
  onRuntimeSelectionChange?: (selection: RuntimeSelection) => void
  runtimeKey?: string
  disabled?: boolean
  compact?: boolean
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

  return [...byId.values()].map((entry) => ({
    id: entry.id,
    name: entry.id,
    description: entry.labels.join(' · '),
    context: '',
  }))
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
    ? availableModels
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

export const ModelSelector = forwardRef<ModelSelectorHandle, Props>(function ModelSelector({
  value,
  onChange,
  runtimeSelection: controlledRuntimeSelection,
  onRuntimeSelectionChange,
  runtimeKey,
  disabled = false,
  compact = false,
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
    if (!isRuntimeScoped || providersLoading || requestedProvidersRef.current) return
    requestedProvidersRef.current = true
    void fetchProviders()
  }, [fetchProviders, isRuntimeScoped, providersLoading])

  useEffect(() => {
    if (!isRuntimeScoped || !open || requestedOAuthStatusRef.current) return
    requestedOAuthStatusRef.current = true
    void fetchClaudeOAuthStatus()
    void fetchOpenAIOAuthStatus()
    void fetchGrokOAuthStatus()
  }, [fetchClaudeOAuthStatus, fetchGrokOAuthStatus, fetchOpenAIOAuthStatus, isRuntimeScoped, open])

  const openSelector = useCallback(() => {
    if (!disabled) {
      setEffortOpen(false)
      setOpen(true)
    }
  }, [disabled])

  useImperativeHandle(selectorRef, () => ({
    open: openSelector,
  }), [openSelector])

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        ref.current &&
        !ref.current.contains(target) &&
        !dropdownRef.current?.contains(target)
      ) {
        setOpen(false)
      }
    }
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [open])

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

  const selectedModel = isControlled
    ? availableModels.find((model) => model.id === value) || null
    : storeModel

  const activeRuntimeSelection = isRuntimeScoped
    ? controlledRuntimeSelection ?? runtimeSelection ?? resolveDefaultRuntimeSelection(
      activeId,
      activeProviderName,
      providers,
      storeModel?.id,
    )
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

  const buttonModelLabel = isRuntimeScoped
    ? selectedRuntimeModel?.name ?? storeModel?.name ?? t('model.selectModel')
    : selectedModel?.name ?? t('model.selectModel')
  const buttonProviderLabel = isRuntimeScoped
    ? selectedProviderChoice?.providerName ?? activeProviderName ?? t('settings.providers.officialName')
    : null
  const supportedRuntimeEfforts = selectedRuntimeModel?.supportedReasoningEfforts
  const selectedRuntimeEffort = supportedRuntimeEfforts?.length === 0
    ? undefined
    : activeRuntimeSelection?.effortLevel
      ?? selectedRuntimeModel?.defaultReasoningEffort
      ?? effortLevel
  const runtimeEffortOptions = supportedRuntimeEfforts === undefined
    ? EFFORT_OPTIONS.filter((option) => option.value !== 'xhigh')
    : EFFORT_OPTIONS.filter((option) => supportedRuntimeEfforts.includes(option.value))

  const handleRuntimeSelect = (selection: RuntimeSelection) => {
    onRuntimeSelectionChange?.(selection)
    if (runtimeKey) {
      useSessionRuntimeStore.getState().setSelection(runtimeKey, selection)
      if (runtimeKey !== DRAFT_RUNTIME_SELECTION_KEY) {
        useChatStore.getState().setSessionRuntime(runtimeKey, selection)
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

  const dropdownContent = (
    <>
      <div className={`overflow-y-auto ${isMobileBrowser ? 'p-1' : 'p-3'}`} style={{ maxHeight: isMobileBrowser ? undefined : dropdownPosition?.maxHeight }}>
        {!isMobileBrowser && (
          <div className="mb-2 px-1 text-[10px] font-bold uppercase tracking-widest text-[var(--color-outline)]">
            {t('model.configuration')}
          </div>
        )}

        {isRuntimeScoped ? (
          <div className="space-y-3">
            {providerChoices.map((choice) => (
              <div key={choice.providerId ?? 'official'} className="space-y-1.5">
                <div className="flex items-center justify-between px-2 pt-1">
                  <span className="truncate text-[11px] font-semibold tracking-[0.01em] text-[var(--color-text-secondary)]">
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
                          const nextEffort = supportedEfforts === undefined
                            ? explicitEffort ?? effortLevel
                            : supportedEfforts.length
                              ? explicitEffort && supportedEfforts.includes(explicitEffort)
                                ? explicitEffort
                                : model.defaultReasoningEffort ?? supportedEfforts[0]
                              : undefined
                          handleRuntimeSelect({
                            providerId: choice.providerId,
                            modelId: model.id,
                            ...(nextEffort ? { effortLevel: nextEffort } : {}),
                          })
                        }}
                        className={`
                          w-full rounded-lg border px-3 text-left transition-colors
                          ${isMobileBrowser ? 'min-h-[56px] py-3' : 'py-2.5'}
                          ${isSelected
                            ? 'border-[var(--color-model-option-selected-border)] bg-[var(--color-model-option-selected-bg)]'
                            : 'border-transparent hover:bg-[var(--color-surface-hover)]'
                          }
                        `}
                      >
                        <div className="flex items-start gap-3">
                          <div className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border-2 ${
                            isSelected ? 'border-[var(--color-brand)]' : 'border-[var(--color-outline)]'
                          }`}>
                            {isSelected && (
                              <div className="h-2 w-2 rounded-full bg-[var(--color-brand)]" />
                            )}
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold text-[var(--color-text-primary)]">
                              {model.name}
                            </div>
                            {model.description && (
                              <div className="mt-0.5 truncate pr-[6px] text-[10px] text-[var(--color-text-tertiary)]">
                                {model.description}
                              </div>
                            )}
                          </div>
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
            {availableModels.map((model) => {
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
                    w-full rounded-lg px-3 text-left transition-colors
                    ${isMobileBrowser ? 'min-h-[56px] py-3' : 'py-2.5'}
                    ${isSelected
                      ? 'border border-[var(--color-model-option-selected-border)] bg-[var(--color-model-option-selected-bg)]'
                      : 'hover:bg-[var(--color-surface-hover)]'
                    }
                  `}
                >
                  <div className="flex items-center gap-3">
                    <div className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border-2 ${
                      isSelected ? 'border-[var(--color-brand)]' : 'border-[var(--color-outline)]'
                    }`}>
                      {isSelected && (
                        <div className="h-2 w-2 rounded-full bg-[var(--color-brand)]" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-[var(--color-text-primary)]">{model.name}</div>
                      {model.description && (
                        <div className="mt-0.5 truncate text-[10px] text-[var(--color-text-tertiary)]">
                          {model.description}
                        </div>
                      )}
                    </div>
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
        contentClassName="p-3"
        panelRef={dropdownRef}
        testId="model-selector-dropdown"
      >
        {dropdownContent}
      </MobileBottomSheet>
    ) : createPortal(
      <div
        ref={dropdownRef}
        data-testid="model-selector-dropdown"
        className="fixed z-[80] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-dropdown)]"
        style={{
          top: dropdownPosition.top,
          bottom: dropdownPosition.bottom,
          left: dropdownPosition.left,
          width: dropdownPosition.width,
        }}
      >
        {dropdownContent}
      </div>,
      document.body,
    )
    : null

  return (
    <div className="relative min-w-0 shrink-0">
      <div ref={ref} className={`flex min-w-0 items-stretch rounded-full bg-[var(--color-surface-container-low)] transition-colors hover:bg-[var(--color-surface-hover)] ${disabled ? 'opacity-50' : ''}`}>
        <button
          onClick={() => {
            if (disabled) return
            setEffortOpen(false)
            setOpen(!open)
          }}
          disabled={disabled}
          aria-label={buttonProviderLabel ? `${buttonModelLabel}, ${buttonProviderLabel}` : undefined}
          title={buttonProviderLabel ? `${buttonProviderLabel} · ${buttonModelLabel}` : undefined}
          className={`flex min-w-0 items-center gap-2 rounded-l-full text-xs font-medium text-[var(--color-text-secondary)] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] disabled:cursor-not-allowed ${
            compact ? 'max-w-[112px] py-1.5 pl-2.5 pr-1' : 'max-w-[220px] py-1.5 pl-3 pr-1'
          }`}
        >
          <span className={`${compact ? 'text-xs' : 'text-sm'} min-w-0 flex-1 truncate font-semibold text-[var(--color-text-primary)]`}>
            {buttonModelLabel}
          </span>
          {!canEditRuntimeEffort && !compact && buttonProviderLabel && (
            <span className="max-w-[108px] flex-shrink-0 truncate text-[11px] text-[var(--color-text-tertiary)]">
              {buttonProviderLabel}
            </span>
          )}
          <span className="material-symbols-outlined flex-shrink-0 text-[12px]">expand_more</span>
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
            className={`rounded-r-full pr-3 text-[var(--color-text-tertiary)] outline-none transition-colors hover:text-[var(--color-text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] disabled:cursor-not-allowed ${compact ? 'pl-1 text-[10px]' : 'pl-1.5 text-xs'}`}
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
