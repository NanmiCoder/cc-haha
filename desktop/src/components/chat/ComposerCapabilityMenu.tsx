import { Fragment, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { useTranslation } from '@/i18n'
import { publicAssetPath } from '@/lib/publicAsset'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Switch'
import { IconButton } from '@/components/ui/IconButton'
import { ComposerSuggestionRow } from '@/components/chat/ComposerSuggestionRow'
import { ComposerReferenceMenu, type ComposerReferenceMenuHandle } from '@/components/chat/ComposerReferenceMenu'
import type { NewComposerMention } from '@/lib/composerMentions'
import type { ComposerReferenceCandidate } from '@/types/composerReference'
import type { CapabilityAction, CapabilityIcon, CapabilityMenuItem, CapabilityMenuSection } from './capabilityMenuModel'
import { COMPOSER_KBD, COMPOSER_MENU_SECTION, COMPOSER_MENU_SEPARATOR } from './composerMenuStyles'

type Props = {
  id: string
  sections: CapabilityMenuSection[]
  cwd?: string
  referencesLoading?: boolean
  referencesError?: string | boolean | null
  onSelectFile?: (mention: NewComposerMention) => void
  onAction(action: CapabilityAction): void
  onClose(): void
  /**
   * `popover` floats above the composer's + button; a category opens its
   * sub-list in a second panel beside it, like a desktop menu. `sheet` lays the
   * same menu out inside the phone's bottom sheet: in the flow, 44px rows, a
   * category replaces the list in place, and no autofocused search, since
   * focusing a field on a phone throws the keyboard up over the very list that
   * was just opened.
   */
  presentation?: 'popover' | 'sheet'
}

const ROOT_WIDTH = 288
const FLYOUT_WIDTH = 320
const PANEL_GAP = 4
/** The full skill list reuses the @ menu's reference browser. */
const BROWSE_REFERENCES_KEY = 'skills:all'
const PANEL = 'overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-dropdown)]'

export function getCapabilityMenuOptionId(id: string, index: number): string {
  return `${id}-option-${index}`
}

export function getCapabilitySubMenuOptionId(id: string, index: number): string {
  return `${id}-sub-option-${index}`
}

function descendants(items: CapabilityMenuItem[], path: string[] = []): Array<{ item: CapabilityMenuItem, path: string[] }> {
  return items.flatMap(item => [{ item, path }, ...descendants(item.children ?? [], [...path, item.key])])
}

function RowIcon({ icon, iconColor }: { icon: CapabilityIcon, iconColor?: string }) {
  if (icon.kind === 'image') {
    return <img src={publicAssetPath(icon.src)} alt="" className="h-4 w-4 shrink-0 object-contain" />
  }
  if (icon.kind === 'slash') {
    return (
      <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center font-mono text-[13px] text-[var(--color-text-tertiary)]">
        /
      </span>
    )
  }
  const Icon = icon.icon
  return (
    <Icon
      aria-hidden="true"
      className="h-4 w-4 shrink-0 text-[var(--color-text-tertiary)]"
      style={iconColor ? { color: iconColor } : undefined}
      strokeWidth={1.75}
    />
  )
}

/** The + launcher uses the same search, rows and mention selection as @. */
export function ComposerCapabilityMenu({ id, sections, cwd = '', referencesLoading, referencesError, onSelectFile, onAction, onClose, presentation = 'popover' }: Props) {
  const sheet = presentation === 'sheet'
  const t = useTranslation()
  const [query, setQuery] = useState('')
  const [path, setPath] = useState<string[]>([])
  /** Keyboard cursor in the open sub-list; -1 until the keyboard moves it. */
  const [highlight, setHighlight] = useState(-1)
  const [rootHighlight, setRootHighlight] = useState(0)
  const [referenceOptionId, setReferenceOptionId] = useState<string>()
  // Too little room to the right of the popover for a second panel: open
  // categories in place, as the sheet does.
  const [narrow, setNarrow] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const referenceRef = useRef<ComposerReferenceMenuHandle>(null)
  useLayoutEffect(() => {
    if (sheet) return
    const left = containerRef.current?.getBoundingClientRect().left ?? 0
    const view = containerRef.current?.ownerDocument.defaultView
    if (view) setNarrow(left + ROOT_WIDTH + PANEL_GAP + FLYOUT_WIDTH > view.innerWidth)
  }, [sheet])
  const inPlace = sheet || narrow

  const rootItems = useMemo(() => sections.flatMap(section => section.items), [sections])
  const searchOnly = useMemo(() => sections.flatMap(section => section.searchOnly ?? []), [sections])
  let drillParent: CapabilityMenuItem | undefined
  let items = rootItems
  for (const key of path) {
    const parent = items.find(item => item.key === key)
    if (!parent?.children) break
    drillParent = parent
    items = parent.children
  }
  const searching = !!query.trim()
  const browseReferences = drillParent?.key === BROWSE_REFERENCES_KEY
  const showReferences = browseReferences || searching
  const flyoutOpen = !inPlace && !!drillParent && !searching
  const candidates = useMemo(() => descendants([...rootItems, ...searchOnly]), [rootItems, searchOnly])
  const scoped = drillParent ? descendants(items, path) : candidates
  const references = scoped.flatMap(({ item }) => item.action?.type === 'insertMention' ? [item.action.reference] : [])
    .filter((reference, index, all) => all.findIndex(other => other.kind === reference.kind && other.id === reference.id) === index)
  const subIndex = items.length ? Math.min(highlight, items.length - 1) : -1
  const rootIndex = Math.min(rootHighlight, rootItems.length - 1)
  const listId = `${id}-list`
  const subListId = `${id}-sub-list`
  const referencesId = `${id}-references`
  const activeOptionId = showReferences
    ? referenceOptionId
    : drillParent
      ? subIndex < 0 ? undefined : getCapabilitySubMenuOptionId(id, subIndex)
      : rootIndex < 0 ? undefined : getCapabilityMenuOptionId(id, rootIndex)
  const controlsId = showReferences ? referencesId : drillParent ? subListId : listId

  const openCategory = (nextPath: string[]) => {
    setPath(nextPath)
    setQuery('')
    setHighlight(-1)
  }
  const activate = (item: CapabilityMenuItem | undefined, parentPath: string[]) => {
    if (!item || item.disabled || item.switch?.disabled) return
    if (item.children) openCategory([...parentPath, item.key])
    else if (item.action) onAction(item.action)
  }
  const actions = scoped.filter(({ item }) => item.action?.type !== 'insertMention' && !item.disabled && !item.switch?.disabled)
    .map(({ item, path: parentPath }) => ({
      key: item.key, label: item.label, description: item.description,
      icon: <RowIcon icon={item.icon} iconColor={item.iconColor} />,
      onSelect: () => item.children ? openCategory([...parentPath, item.key]) : item.action && onAction(item.action),
    }))
  const goBack = () => {
    const parentKey = path[0]
    openCategory(path.slice(0, -1))
    if (path.length === 1 && parentKey) setRootHighlight(Math.max(0, rootItems.findIndex(item => item.key === parentKey)))
  }
  const scrollToOption = (optionId: string) => {
    containerRef.current?.ownerDocument.getElementById(optionId)?.scrollIntoView?.({ block: 'nearest' })
  }
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
      const down = event.key === 'ArrowDown'
      if (drillParent) {
        if (!items.length) return
        const next = subIndex < 0 ? (down ? 0 : items.length - 1) : (subIndex + (down ? 1 : items.length - 1)) % items.length
        setHighlight(next)
        scrollToOption(getCapabilitySubMenuOptionId(id, next))
      } else {
        if (!rootItems.length) return
        const next = (Math.max(rootIndex, 0) + (down ? 1 : rootItems.length - 1)) % rootItems.length
        setRootHighlight(next)
        scrollToOption(getCapabilityMenuOptionId(id, next))
      }
    } else if (event.key === 'Enter' || event.key === 'ArrowRight') {
      const current = drillParent ? items[subIndex] : rootItems[rootIndex]
      if (event.key === 'ArrowRight' && !current?.children) return
      event.preventDefault()
      activate(current, drillParent ? path : [])
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

  const renderRow = (item: CapabilityMenuItem, index: number, level: 'root' | 'sub') => {
    const optionId = level === 'root' ? getCapabilityMenuOptionId(id, index) : getCapabilitySubMenuOptionId(id, index)
    const open = level === 'root' && path[0] === item.key && !inPlace
    const selected = !sheet && (open || (level === 'root' ? !drillParent && index === rootIndex : index === subIndex))
    const status = item.status
      ? <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.status === 'ok' ? 'bg-[var(--color-success)]' : 'bg-[var(--color-warning)]'}`} />
      : null
    const trailing = item.switch
      ? <span className="-my-1 shrink-0" onClick={event => event.stopPropagation()}>
        <Switch size="sm" checked={item.switch.checked} disabled={item.switch.disabled} label={item.label} labelHidden onChange={() => item.action && onAction(item.action)} />
      </span>
      : item.button
        ? <>{status}<Button size="sm" variant="secondary" loading={item.button.busy} className="-my-1 shrink-0 px-2"
          onClick={event => { event.stopPropagation(); if (!item.button?.busy) onAction(item.button!.action) }}>{item.button.label}</Button></>
        : item.children
          ? <>
            {item.count ? <span className="shrink-0 text-xs tabular-nums text-[var(--color-text-tertiary)]">{item.count}</span> : null}
            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-tertiary)]" />
          </>
          : item.key === 'slash-commands' ? <kbd className={COMPOSER_KBD}>/</kbd> : status
    return <ComposerSuggestionRow
      key={item.key} id={optionId} label={item.label}
      // The root stays a short list of names; sub-lists say what each row is.
      description={level === 'sub' ? item.description : undefined}
      // A finger has no keyboard cursor to show; the sheet keeps rows plain.
      selected={selected} icon={<RowIcon icon={item.icon} iconColor={item.iconColor} />}
      aria-label={item.switch ? `${item.label}: ${t(item.switch.checked ? 'settings.plugins.status.enabled' : 'settings.plugins.status.disabled')}` : undefined}
      aria-labelledby={item.switch ? undefined : `${optionId}-label`}
      aria-disabled={item.disabled || item.switch?.disabled || undefined}
      title={item.disabledReason ?? item.description}
      touch={sheet}
      onMouseEnter={() => {
        if (level === 'sub') {
          setHighlight(index)
          return
        }
        setRootHighlight(index)
        // Desktop menus open a category on hover and close it on a sibling.
        if (!inPlace) {
          const nextPath = item.children ? [item.key] : []
          if (nextPath.join('/') !== path.join('/') && !query) openCategory(nextPath)
        }
      }}
      onClick={() => activate(item, level === 'root' ? [] : path)}
      trailing={trailing}
    />
  }

  const renderSubList = (listItems: CapabilityMenuItem[]) => <div id={subListId} role="listbox" aria-label={drillParent?.label}
    className={sheet ? 'p-2' : 'max-h-[min(360px,50vh)] overflow-y-auto p-1'}>
    {listItems.map((item, index) => {
      const previous = listItems[index - 1]
      const heading = item.group && item.group !== previous?.group
      // Footer rows (browse, manage) under a titled group get a hairline.
      const separator = !item.group && !!previous?.group
      return <Fragment key={item.key}>
        {heading ? <div role="presentation" className={COMPOSER_MENU_SECTION}>{item.group}</div> : null}
        {separator ? <div role="presentation" className={COMPOSER_MENU_SEPARATOR} /> : null}
        {renderRow(item, index, 'sub')}
      </Fragment>
    })}
  </div>

  const referenceMenu = <ComposerReferenceMenu key={path.join('/')} ref={referenceRef} id={referencesId} cwd={cwd} filter={query} embedded browseReferences={browseReferences && !searching} references={references} actions={actions}
    referencesLoading={referencesLoading} referencesError={referencesError} onSelect={selectMention} onActiveChange={setReferenceOptionId} />

  let offset = 0
  const rootList = <div id={listId} role="listbox" aria-label={t('chat.composerTools')} className={sheet ? 'p-2' : 'max-h-[min(420px,60vh)] overflow-y-auto p-1'}>
    {sections.map(section => {
      const start = offset
      offset += section.items.length
      return <div key={section.id} role="group" aria-label={section.title} className="border-b border-[var(--color-border)] py-1 first:pt-0 last:border-b-0 last:pb-0">
        {section.showTitle ? <div role="presentation" className={COMPOSER_MENU_SECTION}>{section.title}</div> : null}
        {section.items.map((item, index) => renderRow(item, start + index, 'root'))}
      </div>
    })}
  </div>

  const searchRow = <div className={`flex items-center gap-2 border-b border-[var(--color-border)] px-3 ${sheet ? 'h-12' : 'h-10'}`}>
    {inPlace && drillParent ? <IconButton icon={<ChevronLeft size={14} strokeWidth={1.75} />} label={t('chat.capabilities.back')} size="xs" tone="muted" onClick={goBack} /> : null}
    <Search aria-hidden="true" size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" />
    <input autoFocus={!sheet} value={query}
      onChange={event => {
        setQuery(event.target.value)
        setRootHighlight(0)
        setHighlight(-1)
        // In the popover, typing searches everything: the side panel closes.
        if (!inPlace && path.length && event.target.value.trim()) setPath([])
      }}
      onKeyDown={handleKeyDown} onClick={event => event.currentTarget.focus()}
      placeholder={inPlace && drillParent ? drillParent.label : t('chat.capabilities.searchPlaceholder')} aria-label={t('chat.capabilities.searchPlaceholder')}
      role="combobox" aria-expanded="true" aria-controls={controlsId} aria-activedescendant={activeOptionId}
      className={`min-w-0 flex-1 bg-transparent text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)] ${sheet ? 'text-[15px]' : 'text-[13px]'}`} />
  </div>

  if (inPlace) {
    return <div ref={containerRef} className={sheet
      ? 'flex min-w-0 flex-col'
      : `absolute bottom-full left-0 z-[var(--z-dropdown)] mb-2 ${PANEL} ${showReferences ? 'w-[min(480px,calc(100vw-32px))]' : 'w-[min(288px,calc(100vw-32px))]'}`} onMouseDown={sheet ? undefined : event => event.preventDefault()}>
      {searchRow}
      {showReferences ? referenceMenu : drillParent ? renderSubList(items) : rootList}
    </div>
  }

  return <div ref={containerRef} className="absolute bottom-full left-0 z-[var(--z-dropdown)] mb-2 flex items-end" style={{ gap: PANEL_GAP }} onMouseDown={event => event.preventDefault()}>
    <div className={`${PANEL} shrink-0 ${searching ? 'w-[min(480px,calc(100vw-32px))]' : ''}`} style={searching ? undefined : { width: ROOT_WIDTH }}>
      {searchRow}
      {searching ? referenceMenu : rootList}
    </div>
    {flyoutOpen ? <div data-testid="capability-flyout" className={`${PANEL} shrink-0`} style={{ width: FLYOUT_WIDTH }}>
      <div className="flex h-10 items-center gap-1.5 border-b border-[var(--color-border)] px-2">
        {path.length > 1 ? <IconButton icon={<ChevronLeft size={14} strokeWidth={1.75} />} label={t('chat.capabilities.back')} size="xs" tone="muted" onClick={goBack} /> : null}
        <span className="min-w-0 flex-1 truncate px-1 text-[13px] font-semibold text-[var(--color-text-primary)]">{drillParent!.label}</span>
      </div>
      {browseReferences ? referenceMenu : renderSubList(items)}
    </div> : null}
  </div>
}
