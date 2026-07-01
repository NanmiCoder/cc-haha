import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { skillsApi } from '../../api/skills'
import { pluginsApi } from '../../api/plugins'
import { useTranslation } from '../../i18n'
import type { SkillMeta } from '../../types/skill'
import type { PluginSummary } from '../../types/plugin'

export type SkillPickerHandle = {
  handleKeyDown: (e: KeyboardEvent) => void
}

type Props = {
  mode: 'skill' | 'plugin'
  cwd?: string
  onPick: (name: string) => void
  onClose: () => void
}

type Item = {
  name: string
  description: string
  badge?: string
}

/**
 * Inline picker shown above the composer when the user opens "Skills" or
 * "Plugins" from the + menu. Mirrors the look of the slash-command popover —
 * arrow keys to navigate, Enter to confirm, Esc to dismiss. Picking inserts
 * "@skill:<name>" or "@plugin:<name>" into the composer at the cursor.
 */
export const SkillPickerMenu = forwardRef<SkillPickerHandle, Props>(
  ({ mode, cwd, onPick, onClose }, ref) => {
    const t = useTranslation()
    const [items, setItems] = useState<Item[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [activeIndex, setActiveIndex] = useState(0)
    const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

    useEffect(() => {
      let cancelled = false
      setItems(null)
      setError(null)
      if (mode === 'skill') {
        skillsApi
          .list(cwd)
          .then((response) => {
            if (cancelled) return
            const next: Item[] = response.skills
              .filter((skill: SkillMeta) => skill.userInvocable)
              .map((skill) => ({
                name: skill.name,
                description: skill.description,
                badge: skill.source,
              }))
            setItems(next)
          })
          .catch((err) => {
            if (cancelled) return
            setError(err instanceof Error ? err.message : String(err))
            setItems([])
          })
      } else {
        pluginsApi
          .list(cwd)
          .then((response) => {
            if (cancelled) return
            const next: Item[] = response.plugins
              .filter((plugin: PluginSummary) => plugin.enabled && !plugin.hasErrors)
              .map((plugin) => ({
                name: plugin.name,
                description: plugin.description ?? '',
                badge: plugin.scope,
              }))
            setItems(next)
          })
          .catch((err) => {
            if (cancelled) return
            setError(err instanceof Error ? err.message : String(err))
            setItems([])
          })
      }
      return () => {
        cancelled = true
      }
    }, [mode, cwd])

    // Reset highlight whenever the list shape changes.
    useEffect(() => {
      setActiveIndex(0)
    }, [items])

    // Keep the highlighted row in view.
    useEffect(() => {
      const el = itemRefs.current[activeIndex]
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest' })
      }
    }, [activeIndex])

    const total = items?.length ?? 0

    useImperativeHandle(ref, () => ({
      handleKeyDown: (event) => {
        if (!items || total === 0) return
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setActiveIndex((i) => (i + 1) % total)
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          setActiveIndex((i) => (i - 1 + total) % total)
        } else if (event.key === 'Enter') {
          event.preventDefault()
          const picked = items[activeIndex]
          if (picked) onPick(picked.name)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        }
      },
    }), [items, total, activeIndex, onPick, onClose])

    const headerLabel = useMemo(
      () => (mode === 'skill' ? t('chat.skillPicker.title') : t('chat.pluginPicker.title')),
      [mode, t],
    )
    const emptyLabel = useMemo(
      () => (mode === 'skill' ? t('chat.skillPicker.empty') : t('chat.pluginPicker.empty')),
      [mode, t],
    )
    const tokenPrefix = mode === 'skill' ? '@skill:' : '@plugin:'

    return (
      <div className="absolute bottom-full left-0 right-0 z-50 mb-2 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-dropdown)]">
        <div className="flex items-center justify-between border-b border-[var(--color-border-separator)] px-3 py-2">
          <span className="text-xs font-semibold text-[var(--color-text-secondary)]">
            {headerLabel}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)]"
            aria-label={t('chat.dismiss')}
          >
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>
        <div className="max-h-[260px] overflow-y-auto py-1">
          {items === null && (
            <div className="px-4 py-3 text-xs text-[var(--color-text-tertiary)]">
              {t('common.loading')}
            </div>
          )}
          {items !== null && total === 0 && (
            <div className="px-4 py-3 text-xs text-[var(--color-text-tertiary)]">
              {error ?? emptyLabel}
            </div>
          )}
          {items !== null && total > 0 && items.map((item, index) => {
            const isActive = index === activeIndex
            return (
              <button
                key={`${item.name}-${index}`}
                ref={(el) => { itemRefs.current[index] = el }}
                type="button"
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => onPick(item.name)}
                className={`flex w-full flex-col gap-0.5 px-4 py-2 text-left transition-colors ${
                  isActive ? 'bg-[var(--color-surface-hover)]' : ''
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-[var(--color-text-primary)]">
                    {tokenPrefix}{item.name}
                  </span>
                  {item.badge && (
                    <span className="rounded-full bg-[var(--color-surface-container-high)] px-2 py-0.5 text-[10px] text-[var(--color-text-tertiary)]">
                      {item.badge}
                    </span>
                  )}
                </div>
                {item.description && (
                  <span className="line-clamp-2 text-xs text-[var(--color-text-tertiary)]">
                    {item.description}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>
    )
  },
)

SkillPickerMenu.displayName = 'SkillPickerMenu'
