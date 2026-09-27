import { useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { useTranslation } from '@/i18n'
import { publicAssetPath } from '@/lib/publicAsset'
import { Switch } from '@/components/ui/Switch'
import { IconButton } from '@/components/ui/IconButton'
import { ComposerSuggestionRow } from '@/components/chat/ComposerSuggestionRow'
import { ComposerReferenceMenu, type ComposerReferenceMenuHandle } from '@/components/chat/ComposerReferenceMenu'
import type { NewComposerMention } from '@/lib/composerMentions'
import type { ComposerReferenceCandidate } from '@/types/composerReference'
import type { CapabilityAction, CapabilityIcon, CapabilityMenuItem, CapabilityMenuSection } from './capabilityMenuModel'

type Props = {
  id: string
  sections: CapabilityMenuSection[]
  cwd?: string
  referencesLoading?: boolean
  referencesError?: string | boolean | null
  onSelectFile?: (mention: NewComposerMention) => void
  onAction(action: CapabilityAction): void
  onClose(): void
  mobile?: boolean
}

export function getCapabilityMenuOptionId(id: string, index: number): string {
  return `${id}-option-${index}`
}

function descendants(items: CapabilityMenuItem[], path: string[] = []): Array<{ item: CapabilityMenuItem, path: string[] }> {
  return items.flatMap(item => [{ item, path }, ...descendants(item.children ?? [], [...path, item.key])])
}

function RowIcon({ icon, iconColor }: { icon: CapabilityIcon, iconColor?: string }) {
  if (icon.kind === 'image') {
    return <img src={publicAssetPath(icon.src)} alt="" className="h-5 w-5 shrink-0 object-contain" />
  }
  if (icon.kind === 'slash') {
    return (
      <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center text-[15px] font-bold text-[var(--color-text-secondary)]">
        /
      </span>
    )
  }
  const Icon = icon.icon
  return (
    <Icon
      aria-hidden="true"
      className="h-5 w-5 shrink-0 text-[var(--color-text-secondary)]"
      style={iconColor ? { color: iconColor } : undefined}
      strokeWidth={1.7}
    />
  )
}

/** The + launcher uses the same search, rows and mention selection as @. */
export function ComposerCapabilityMenu({ id, sections, cwd = '', referencesLoading, referencesError, onSelectFile, onAction, onClose, mobile = false }: Props) {
  const t = useTranslation()
  const [query, setQuery] = useState('')
  const [path, setPath] = useState<string[]>([])
  const [highlight, setHighlight] = useState(0)
  const [referenceOptionId, setReferenceOptionId] = useState<string>()
  const listRef = useRef<HTMLDivElement>(null)
  const referenceRef = useRef<ComposerReferenceMenuHandle>(null)
  const rootItems = useMemo(() => sections.flatMap(section => section.items), [sections])
  let drillParent: CapabilityMenuItem | undefined
  let items = rootItems
  for (const key of path) {
    const parent = items.find(item => item.key === key)
    if (!parent?.children) break
    drillParent = parent
    items = parent.children
  }
  const browseReferences = drillParent?.key === 'skills' || drillParent?.key === 'plugins'
  const showReferences = browseReferences || !!query.trim()
  const candidates = useMemo(() => descendants(rootItems), [rootItems])
  const scoped = drillParent ? descendants(items, path) : candidates
  const references = scoped.flatMap(({ item }) => item.action?.type === 'insertMention' ? [item.action.reference] : [])
    .filter((reference, index, all) => all.findIndex(other => other.kind === reference.kind && other.id === reference.id) === index)
  const activeIndex = items.length ? Math.min(highlight, items.length - 1) : -1
  const listId = showReferences ? `${id}-references` : `${id}-list`
  const activeOptionId = showReferences ? referenceOptionId : activeIndex < 0 ? undefined : getCapabilityMenuOptionId(id, activeIndex)
  const openCategory = (nextPath: string[]) => {
    setPath(nextPath)
    setQuery('')
    setHighlight(0)
  }
  const activate = (item: CapabilityMenuItem | undefined) => {
    if (!item || item.disabled || item.switch?.disabled) return
    if (item.children) openCategory([...path, item.key])
    else if (item.action) onAction(item.action)
  }
  const actions = scoped.filter(({ item }) => item.action?.type !== 'insertMention' && !item.disabled && !item.switch?.disabled)
    .map(({ item, path: parentPath }) => ({
      key: item.key, label: item.label, description: item.description,
      icon: <RowIcon icon={item.icon} iconColor={item.iconColor} />,
      onSelect: () => item.children ? openCategory([...parentPath, item.key]) : item.action && onAction(item.action),
    }))
  const goBack = () => openCategory(path.slice(0, -1))
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (path.length) goBack()
      else onClose()
    } else if ((event.key === 'ArrowLeft' || event.key === 'Backspace') && !query && path.length) {
      event.preventDefault()
      goBack()
    } else if (showReferences) {
      referenceRef.current?.handleKeyDown(event.nativeEvent)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!items.length) return
      const next = (Math.max(activeIndex, 0) + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length
      setHighlight(next)
      listRef.current?.ownerDocument.getElementById(getCapabilityMenuOptionId(id, next))?.scrollIntoView?.({ block: 'nearest' })
    } else if (event.key === 'Enter' || event.key === 'ArrowRight' && items[activeIndex]?.children) {
      event.preventDefault()
      activate(items[activeIndex])
    }
  }
  const selectMention = (mention: NewComposerMention) => {
    if (mention.kind === 'skill' || mention.kind === 'plugin') {
      const reference: ComposerReferenceCandidate | undefined = references.find(item => item.id === mention.id && item.kind === mention.kind)
      if (reference) onAction({ type: 'insertMention', reference })
    } else {
      onSelectFile?.(mention)
      onClose()
    }
  }
  const renderRow = (item: CapabilityMenuItem, index: number) => <ComposerSuggestionRow
    key={item.key} id={getCapabilityMenuOptionId(id, index)} label={item.label}
    selected={index === activeIndex} icon={<RowIcon icon={item.icon} iconColor={item.iconColor} />}
    aria-label={item.switch ? `${item.label}: ${t(item.switch.checked ? 'settings.plugins.status.enabled' : 'settings.plugins.status.disabled')}` : undefined}
    aria-labelledby={item.switch ? undefined : `${getCapabilityMenuOptionId(id, index)}-label`}
    aria-disabled={item.disabled || item.switch?.disabled || undefined}
    title={item.disabledReason ?? item.description}
    onMouseEnter={() => setHighlight(index)} onClick={() => activate(item)}
    trailing={item.switch ? <span className="-my-1 shrink-0" onClick={event => event.stopPropagation()}>
      <Switch size="sm" checked={item.switch.checked} disabled={item.switch.disabled} label={t('chat.capabilities.computerUseToggle')} labelHidden onChange={() => item.action && onAction(item.action)} />
    </span> : item.children ? <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--color-text-tertiary)]" /> : item.key === 'slash-commands' ? <kbd>/</kbd> : null}
  />
  let offset = 0
  return <div className={`absolute bottom-full left-0 z-[var(--z-dropdown)] mb-2 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-overlay)] ${mobile ? 'w-[min(360px,calc(100vw-32px))]' : showReferences ? 'w-[min(480px,calc(100vw-32px))]' : 'w-[min(288px,calc(100vw-32px))]'}`} onMouseDown={event => event.preventDefault()}>
    <div className="flex items-center gap-2 border-b border-[var(--color-border-separator)] px-3 py-2">
      {drillParent ? <IconButton icon={<ChevronLeft className="h-4 w-4" />} label={t('chat.capabilities.back')} size="xs" onClick={goBack} /> : null}
      <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--color-text-tertiary)]" />
      <input autoFocus value={query} onChange={event => { setQuery(event.target.value); setHighlight(0) }} onKeyDown={handleKeyDown} onClick={event => event.currentTarget.focus()}
        placeholder={drillParent?.label ?? t('chat.capabilities.searchPlaceholder')} aria-label={t('chat.capabilities.searchPlaceholder')}
        role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={activeOptionId}
        className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]" />
    </div>
    {showReferences ? <ComposerReferenceMenu key={path.join('/')} ref={referenceRef} id={listId} cwd={cwd} filter={query} embedded browseReferences={browseReferences} references={references} actions={actions}
      referencesLoading={referencesLoading} referencesError={referencesError} onSelect={selectMention} onActiveChange={setReferenceOptionId} /> :
      <div ref={listRef} id={listId} role="listbox" aria-label={t('chat.composerTools')} className="max-h-[min(360px,50vh)] overflow-y-auto p-1.5">
        {drillParent ? items.map(renderRow) : sections.map(section => {
          const start = offset
          offset += section.items.length
          return <div key={section.id} role="group" aria-label={section.title} className="border-b border-[var(--color-border-separator)] py-1 last:border-b-0">{section.items.map((item, index) => renderRow(item, start + index))}</div>
        })}
      </div>}
  </div>
}
