import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { OFFICIAL_DEFAULT_MODEL_ID, OFFICIAL_MODELS } from '../../constants/modelCatalog'
import { useTranslation } from '../../i18n'
import { useChatStore } from '../../stores/chatStore'
import { useProviderStore } from '../../stores/providerStore'
import { DRAFT_RUNTIME_SELECTION_KEY, useSessionRuntimeStore } from '../../stores/sessionRuntimeStore'
import { useSettingsStore } from '../../stores/settingsStore'
import type { SavedProvider } from '../../types/provider'
import type { RuntimeSelection } from '../../types/runtime'
import type { EffortLevel, ModelInfo } from '../../types/settings'

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

type DropdownPosition = {
  top: number
  left: number
  width: number
  maxHeight: number
}

const DROPDOWN_WIDTH = 360
const DROPDOWN_GAP = 8
const VIEWPORT_MARGIN = 16
const DROPDOWN_MAX_HEIGHT = 420
const DROPDOWN_MIN_HEIGHT = 180

function officialChoices(availableModels: ModelInfo[], isDefault: boolean, officialName: string): ProviderChoice {
  return {
    providerId: null,
    providerName: officialName,
    isDefault,
    models: availableModels.length > 0 ? availableModels : OFFICIAL_MODELS,
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
  labels: Record<'main' | 'haiku' | 'sonnet' | 'opus', string>,
): ProviderChoice[] {
  return [
    officialChoices(availableModels, activeId === null, officialName),
    ...providers.map((provider) => ({
      providerId: provider.id,
      providerName: provider.name,
      isDefault: activeId === provider.id,
      models: buildProviderModels(provider, labels),
    })),
  ]
}

function resolveDefaultRuntimeSelection(
  activeId: string | null,
  activeProviderName: string | null,
  providers: SavedProvider[],
  currentModelId: string | undefined,
): RuntimeSelection {
  const inferredProviderId = activeId ?? (
    activeProviderName
      ? providers.find((provider) => provider.name === activeProviderName)?.id ?? null
      : null
  )

  return {
    providerId: inferredProviderId,
    modelId: currentModelId ?? OFFICIAL_DEFAULT_MODEL_ID,
  }
}

export function ModelSelector({
  value,
  onChange,
  runtimeSelection: controlledRuntimeSelection,
  onRuntimeSelectionChange,
  runtimeKey,
  disabled = false,
  compact = false,
}: Props = {}) {
  const t = useTranslation()
  const {
    currentModel: storeModel,
    availableModels,
    effortLevel,
    activeProviderName,
    setModel,
    setEffort,
  } = useSettingsStore()
  const {
    providers,
    activeId,
    isLoading: providersLoading,
    fetchProviders,
  } = useProviderStore()
  const runtimeSelection = useSessionRuntimeStore((state) =>
    runtimeKey ? state.selections[runtimeKey] : undefined,
  )
  const [open, setOpen] = useState(false)
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const requestedProvidersRef = useRef(false)

  const EFFORT_OPTIONS: { value: EffortLevel; label: string }[] = [
    { value: 'low', label: t('settings.general.effort.low') },
    { value: 'medium', label: t('settings.general.effort.medium') },
    { value: 'high', label: t('settings.general.effort.high') },
    { value: 'max', label: t('settings.general.effort.max') },
  ]

  const isControlled = value !== undefined
  const isRuntimeScoped =
    !isControlled &&
    (runtimeKey !== undefined || onRuntimeSelectionChange !== undefined)

  useEffect(() => {
    if (!isRuntimeScoped || providersLoading || requestedProvidersRef.current) return
    requestedProvidersRef.current = true
    void fetchProviders()
  }, [fetchProviders, isRuntimeScoped, providersLoading])

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
      top: placeBelow
        ? rect.bottom + DROPDOWN_GAP
        : Math.max(VIEWPORT_MARGIN, rect.top - DROPDOWN_GAP - maxHeight),
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
      activeId === null ? availableModels : OFFICIAL_MODELS,
      t('settings.providers.officialName'),
      roleLabels,
    ),
    [activeId, availableModels, providers, roleLabels, t],
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

  const dropdown = open && dropdownPosition
    ? createPortal(
      <div
        ref={dropdownRef}
        data-testid="model-selector-dropdown"
        className="fixed z-[80] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-dropdown)]"
        style={{
          top: dropdownPosition.top,
          left: dropdownPosition.left,
          width: dropdownPosition.width,
        }}
      >
        <div className="overflow-y-auto p-3" style={{ maxHeight: dropdownPosition.maxHeight }}>
          <div className="mb-2 px-1 text-[10px] font-bold uppercase tracking-widest text-[var(--color-outline)]">
            {t('model.configuration')}
          </div>

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
                          onClick={() => handleRuntimeSelect({ providerId: choice.providerId, modelId: model.id })}
                          className={`
                            w-full rounded-lg border px-3 py-2.5 text-left transition-colors
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
                      w-full rounded-lg px-3 py-2.5 text-left transition-colors
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

        {!isControlled && !isRuntimeScoped && (
          <div className="border-t border-[var(--color-border)] p-3">
            <div className="mb-2 px-1 text-[10px] font-bold uppercase tracking-widest text-[var(--color-outline)]">
              {t('model.effort')}
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {EFFORT_OPTIONS.map((opt) => {
                const isSelected = opt.value === effortLevel
                return (
                  <button
                    key={opt.value}
                    onClick={() => {
                      void setEffort(opt.value)
                      setOpen(false)
                    }}
                    className={`
                      rounded-lg py-2 text-center text-xs font-semibold transition-colors
                      ${isSelected
                        ? 'bg-[var(--color-brand)] text-white'
                        : 'bg-[var(--color-surface-container-high)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                      }
                    `}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>,
      document.body,
    )
    : null

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className={`flex items-center gap-2 rounded-full bg-[var(--color-surface-container-low)] text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] disabled:cursor-not-allowed disabled:opacity-50 ${
          compact ? 'max-w-[152px] px-2.5 py-1.5' : 'max-w-[280px] px-3 py-1.5'
        }`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className={`${compact ? 'text-xs' : 'text-sm'} min-w-0 flex-1 truncate font-semibold text-[var(--color-text-primary)]`}>
            {buttonModelLabel}
          </span>
          {!compact && buttonProviderLabel && (
            <span className="max-w-[108px] flex-shrink-0 truncate text-[11px] text-[var(--color-text-tertiary)]">
              {buttonProviderLabel}
            </span>
          )}
        </div>
        <span className="material-symbols-outlined flex-shrink-0 text-[12px]">expand_more</span>
      </button>
      {dropdown}
    </div>
  )
}
