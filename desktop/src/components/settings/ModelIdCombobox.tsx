import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { Check, ChevronDown } from 'lucide-react'

import { IconButton } from '@/components/ui/IconButton'
import { FIELD_BASE_CLASSES, FIELD_SIZE_CLASSES, fieldStateClasses } from '@/components/ui/Input'
import { useDismissable } from '@/hooks/useDismissable'
import { cx } from '@/lib/cx'
import type { ProviderModelGroup } from '@/lib/providerModels'

type ModelIdComboboxProps = {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  groups: ProviderModelGroup[]
  pickerLabel: string
  noMatchesLabel: string
  moreResultsLabel: string
  required?: boolean
}

const MAX_VISIBLE_MODELS = 100

export function ModelIdCombobox({
  label,
  value,
  onChange,
  placeholder,
  groups,
  pickerLabel,
  noMatchesLabel,
  moreResultsLabel,
  required = false,
}: ModelIdComboboxProps) {
  const inputId = useId()
  const listId = `${inputId}-models`
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [open, setOpen] = useState(false)
  const [filtering, setFiltering] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const hasModels = groups.some((group) => group.models.length > 0)
  const normalizedQuery = filtering ? value.trim().toLocaleLowerCase() : ''

  const { visibleGroups, totalMatches } = useMemo(() => {
    if (!open) return { visibleGroups: [], totalMatches: 0 }

    let remaining = MAX_VISIBLE_MODELS
    let matchCount = 0
    const nextGroups = groups.flatMap((group) => {
      const models = normalizedQuery
        ? group.models.filter((model) => (
            model.id.toLocaleLowerCase().includes(normalizedQuery)
            || group.group.toLocaleLowerCase().includes(normalizedQuery)
          ))
        : group.models
      matchCount += models.length
      if (remaining === 0 || models.length === 0) return []

      const visibleModels = models.slice(0, remaining)
      remaining -= visibleModels.length
      return [{ ...group, models: visibleModels }]
    })

    return { visibleGroups: nextGroups, totalMatches: matchCount }
  }, [groups, normalizedQuery, open])

  const visibleModels = useMemo(
    () => visibleGroups.flatMap((group) => group.models.map((model) => model.id)),
    [visibleGroups],
  )
  const optionIndexById = useMemo(
    () => new Map(visibleModels.map((modelId, index) => [modelId, index])),
    [visibleModels],
  )
  const hasMoreModels = totalMatches > visibleModels.length

  const close = useCallback(() => {
    setOpen(false)
    setFiltering(false)
    setActiveIndex(-1)
  }, [])

  useDismissable({
    open: open && hasModels,
    refs: [rootRef],
    onDismiss: close,
    stopEscapePropagation: true,
  })

  useEffect(() => {
    if (!hasModels && open) close()
  }, [close, hasModels, open])

  useEffect(() => {
    if (!open) return
    if (visibleModels.length === 0) {
      setActiveIndex(-1)
      return
    }

    const selectedIndex = normalizedQuery
      ? -1
      : visibleModels.findIndex((modelId) => modelId === value)
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
  }, [normalizedQuery, open, value, visibleModels])

  useEffect(() => {
    if (!open || activeIndex < 0) return
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, open])

  const openAllModels = () => {
    if (!hasModels) return
    setFiltering(false)
    setOpen(true)
  }

  const selectModel = (modelId: string) => {
    onChange(modelId)
    close()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!hasModels) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (!open) {
        openAllModels()
        return
      }
      setActiveIndex((current) => visibleModels.length > 0
        ? (current + 1 + visibleModels.length) % visibleModels.length
        : -1)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        openAllModels()
        return
      }
      setActiveIndex((current) => visibleModels.length > 0
        ? (current - 1 + visibleModels.length) % visibleModels.length
        : -1)
      return
    }

    if (event.key === 'Enter' && open && activeIndex >= 0) {
      event.preventDefault()
      const activeModel = visibleModels[activeIndex]
      if (activeModel) selectModel(activeModel)
    }
  }

  return (
    <div
      ref={rootRef}
      className="relative flex min-w-0 flex-col gap-1"
      onBlur={(event) => {
        const nextFocus = event.relatedTarget
        if (!(nextFocus instanceof Node) || !event.currentTarget.contains(nextFocus)) close()
      }}
    >
      <label htmlFor={inputId} className="text-[13px] font-medium text-[var(--color-text-primary)]">
        {label}
        {required && <span className="ml-0.5 text-[var(--color-error)]">*</span>}
      </label>

      <div className="relative">
        <input
          ref={inputRef}
          id={inputId}
          value={value}
          required={required}
          placeholder={placeholder}
          autoComplete="off"
          role={hasModels ? 'combobox' : undefined}
          aria-autocomplete={hasModels ? 'list' : undefined}
          aria-haspopup={hasModels ? 'listbox' : undefined}
          aria-expanded={hasModels ? open : undefined}
          aria-controls={hasModels && open ? listId : undefined}
          aria-activedescendant={hasModels && open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          onFocus={() => {
            if (!open) openAllModels()
          }}
          onClick={() => {
            if (!open) openAllModels()
          }}
          onChange={(event) => {
            const nextValue = event.target.value
            onChange(nextValue)
            if (hasModels) {
              setFiltering(true)
              setOpen(true)
            }
          }}
          onKeyDown={handleKeyDown}
          className={cx(
            FIELD_BASE_CLASSES,
            FIELD_SIZE_CLASSES.lg,
            fieldStateClasses(false),
            hasModels && 'pr-11',
          )}
        />

        {hasModels && (
          <IconButton
            icon={(
              <ChevronDown
                size={16}
                strokeWidth={1.75}
                aria-hidden="true"
                className={cx('transition-transform duration-150', open && 'rotate-180')}
              />
            )}
            label={pickerLabel}
            showTooltip={false}
            size="md"
            tone="secondary"
            tabIndex={-1}
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (open) {
                close()
                return
              }
              openAllModels()
              inputRef.current?.focus()
            }}
            className="absolute right-1 top-1/2 -translate-y-1/2 active:translate-y-[calc(-50%+1px)]"
          />
        )}
      </div>

      {open && hasModels && (
        <div className="absolute left-0 right-0 top-full z-[var(--z-dropdown)] mt-1 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-dropdown)] animate-overlay-in-top">
          <div
            id={listId}
            role="listbox"
            aria-label={pickerLabel}
            className="max-h-64 overflow-y-auto p-1"
          >
            {visibleGroups.length === 0 ? (
              <div
                role="option"
                aria-disabled="true"
                aria-selected="false"
                className="px-3 py-5 text-center text-xs text-[var(--color-text-tertiary)]"
              >
                {noMatchesLabel}
              </div>
            ) : visibleGroups.map((group) => (
              <div key={group.group} role="group" aria-label={group.group}>
                {visibleGroups.length > 1 && (
                  <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold text-[var(--color-text-tertiary)] first:pt-1">
                    {group.group}
                  </div>
                )}
                <div className="space-y-0.5">
                  {group.models.map((model) => {
                    const index = optionIndexById.get(model.id) ?? -1
                    const selected = model.id === value
                    const active = index === activeIndex
                    return (
                      <button
                        ref={(node) => {
                          optionRefs.current[index] = node
                        }}
                        key={model.id}
                        id={`${listId}-${index}`}
                        type="button"
                        role="option"
                        tabIndex={-1}
                        aria-selected={selected}
                        onPointerDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => selectModel(model.id)}
                        className={cx(
                          'flex min-h-8 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-[13px] outline-none transition-colors duration-150',
                          active
                            ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]'
                            : selected
                              ? 'bg-[var(--color-model-option-selected-bg)] text-[var(--color-text-primary)]'
                              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{model.id}</span>
                        {selected && (
                          <Check size={14} strokeWidth={2} aria-hidden="true" className="flex-none text-[var(--color-brand)]" />
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
          {hasMoreModels && (
            <div role="status" className="border-t border-[var(--color-border-separator)] px-3 py-2 text-center text-[11px] text-[var(--color-text-tertiary)]">
              {moreResultsLabel}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
