import { useState, useRef, useEffect } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTranslation } from '../../i18n'
import type { EffortLevel } from '../../types/settings'

const MODEL_ICONS = {
  opus: 'diamond',
  sonnet: 'auto_awesome',
  haiku: 'bolt',
} as const

type Props = {
  /** Controlled mode: model ID override */
  value?: string
  /** Controlled mode: called on change instead of updating global store */
  onChange?: (modelId: string) => void
}

export function ModelSelector({ value, onChange }: Props = {}) {
  const t = useTranslation()
  const { currentModel: storeModel, availableModels, effortLevel, setModel, setEffort } = useSettingsStore()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const EFFORT_OPTIONS: { value: EffortLevel; label: string }[] = [
    { value: 'low', label: t('settings.general.effort.low') },
    { value: 'medium', label: t('settings.general.effort.medium') },
    { value: 'high', label: t('settings.general.effort.high') },
    { value: 'max', label: t('settings.general.effort.max') },
  ]

  const isControlled = value !== undefined
  const selectedModel = isControlled ? availableModels.find((m) => m.id === value) || null : storeModel

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
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

  const getModelIcon = (id: string): string => {
    const lower = id.toLowerCase()
    if (lower.includes('opus')) return MODEL_ICONS.opus
    if (lower.includes('sonnet')) return MODEL_ICONS.sonnet
    if (lower.includes('haiku')) return MODEL_ICONS.haiku
    return 'smart_toy'
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[var(--color-surface-container-low)] hover:bg-[var(--color-surface-hover)] rounded-full text-xs font-medium text-[var(--color-text-secondary)] transition-colors"
      >
        <span className="material-symbols-outlined text-[14px] text-[var(--color-brand)]">auto_awesome</span>
        <span>{selectedModel?.name ?? t('model.selectModel')}</span>
        <span className="material-symbols-outlined text-[12px]">expand_more</span>
      </button>

      {open && (
        <div className="absolute right-0 bottom-full mb-2 w-[340px] rounded-xl bg-[var(--color-surface-container-lowest)] border border-[var(--color-border)] shadow-[var(--shadow-dropdown)] z-50">
          {/* Models */}
          <div className="p-3">
            <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-outline)] mb-2 px-1">
              {t('model.configuration')}
            </div>
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
                        setModel(model.id)
                      }
                      setOpen(false)
                    }}
                    className={`
                      w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors
                      ${isSelected
                        ? 'bg-[var(--color-primary-fixed)] border border-[var(--color-brand)]/20'
                        : 'hover:bg-[var(--color-surface-hover)]'
                      }
                    `}
                  >
                    {/* Radio button */}
                    <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                      isSelected
                        ? 'border-[var(--color-brand)]'
                        : 'border-[var(--color-outline)]'
                    }`}>
                      {isSelected && (
                        <div className="w-2 h-2 rounded-full bg-[var(--color-brand)]" />
                      )}
                    </div>

                    <span className="material-symbols-outlined text-[18px] text-[var(--color-text-secondary)]">
                      {getModelIcon(model.id)}
                    </span>

                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-[var(--color-text-primary)]">{model.name}</div>
                      {model.description && (
                        <div className="text-[10px] text-[var(--color-text-tertiary)] mt-0.5 truncate">{model.description}</div>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Effort — hidden in controlled mode (not relevant for task creation) */}
          {!isControlled && <div className="border-t border-[var(--color-border)] p-3">
            <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-outline)] mb-2 px-1">
              {t('model.effort')}
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {EFFORT_OPTIONS.map((opt) => {
                const isSelected = opt.value === effortLevel
                return (
                  <button
                    key={opt.value}
                    onClick={() => { setEffort(opt.value); setOpen(false) }}
                    className={`
                      py-2 rounded-lg text-xs font-semibold transition-colors text-center
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
          </div>}
        </div>
      )}
    </div>
  )
}
