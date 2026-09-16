import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ExternalLink, Globe, Search } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { useDismissable } from '@/hooks/useDismissable'
import { useTranslation } from '@/i18n'
import { normalizeBrowserAddress } from '@/lib/workspace/browserAddress'
import { useSuppressBrowserOverlay } from '@/stores/overlayStore'
import type { WorkspaceBrowserVisit } from '@/stores/workspaceBrowserStore'

type AddressSuggestion = { input: string; title: string; url?: string; action?: 'search' | 'visit' }

type WorkspaceBrowserAddressBarProps = {
  currentAddress: string
  active: boolean
  disabled: boolean
  blank: boolean
  visits: WorkspaceBrowserVisit[]
  resolveAddress: (input: string) => string
  onNavigate: (input: string, onAccepted?: () => void) => void
  onOpenExternal: (url: string) => void
}

const SUGGESTION_LIMIT = 6

/** A page address is viewed centered and edited as an omnibox, with local visit suggestions. */
export const WorkspaceBrowserAddressBar = forwardRef<HTMLInputElement, WorkspaceBrowserAddressBarProps>(function WorkspaceBrowserAddressBar({
  currentAddress, active, disabled, blank, visits, resolveAddress, onNavigate, onOpenExternal,
}, forwardedRef) {
  const t = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const listId = useId()
  const [draft, setDraft] = useState(currentAddress)
  const [editing, setEditing] = useState(false)
  const editingRef = useRef(false)
  const [queryEdited, setQueryEdited] = useState(false)
  const [highlighted, setHighlighted] = useState(-1)
  useImperativeHandle(forwardedRef, () => inputRef.current!)

  useEffect(() => {
    if (!editingRef.current) setDraft(currentAddress)
  }, [currentAddress])

  const finishEditing = (cancelBlankDraft = false) => {
    editingRef.current = false
    setEditing(false)
    // A blank tab has no committed URL: opening another workspace tab must
    // preserve its draft. Only explicit Escape cancels that draft.
    if (currentAddress || cancelBlankDraft) setDraft(currentAddress)
  }
  useEffect(() => {
    if (active && !disabled) return
    editingRef.current = false
    setEditing(false)
    if (currentAddress) setDraft(currentAddress)
  }, [active, disabled, currentAddress])

  const query = queryEdited ? draft.trim() : ''
  const suggestions = useMemo(() => {
    const seen = new Set<string>()
    const matches: AddressSuggestion[] = []
    for (const visit of [...visits].sort((a, b) => b.visitedAt - a.visitedAt)) {
      if (seen.has(visit.url)) continue
      seen.add(visit.url)
      if (!normalizeBrowserAddress(visit.url)) continue
      if (query && !`${visit.title} ${visit.url}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue
      matches.push({ input: visit.url, title: visit.title || visit.url, url: visit.url })
      if (matches.length >= SUGGESTION_LIMIT) break
    }
    const normalized = normalizeBrowserAddress(query)
    if (normalized) matches.unshift({
      input: query,
      title: query,
      action: normalized === `https://www.google.com/search?q=${encodeURIComponent(query)}` ? 'search' : 'visit',
    })
    return matches.slice(0, SUGGESTION_LIMIT)
  }, [query, visits])
  const open = active && !disabled && editing && suggestions.length > 0
  const selectedIndex = highlighted < suggestions.length ? highlighted : -1
  useDismissable({ open, refs: [formRef], closeOnEscape: false, onDismiss: () => finishEditing() })

  const submit = (input: string) => {
    const url = resolveAddress(input)
    if (!url) return
    finishEditing()
    inputRef.current?.blur()
    // Selection-discard confirmation can defer navigation. Display the new
    // address only when that navigation is accepted, not when it is cancelled.
    onNavigate(input, () => setDraft(url))
  }

  return (
    <form
      ref={formRef}
      className={`group/address relative flex h-8 min-w-0 flex-1 items-center rounded-[var(--radius-md)] ${editing ? 'bg-[var(--color-surface-hover)] ring-1 ring-inset ring-[var(--color-border)]' : 'hover:bg-[var(--color-surface-hover)]'}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) finishEditing()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        submit(open && selectedIndex >= 0 ? suggestions[selectedIndex]!.input : draft)
      }}
    >
      <input
        ref={inputRef}
        value={draft}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && selectedIndex >= 0 ? `${listId}-${selectedIndex}` : undefined}
        data-workspace-autofocus={blank ? true : undefined}
        disabled={disabled}
        onChange={(event) => {
          setDraft(event.target.value)
          setQueryEdited(true)
          setHighlighted(event.target.value.trim() ? 0 : -1)
        }}
        onFocus={(event) => {
          editingRef.current = true
          setEditing(true)
          setQueryEdited(!currentAddress && !!draft.trim())
          setHighlighted(!currentAddress && draft.trim() ? 0 : -1)
          event.currentTarget.select()
        }}
        onKeyDown={(event) => {
          // Enter used to confirm an IME candidate must never navigate.
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            finishEditing(true)
            event.currentTarget.blur()
          } else if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            setHighlighted(event.key === 'ArrowDown'
              ? (selectedIndex + 1) % suggestions.length
              : (selectedIndex <= 0 ? suggestions.length : selectedIndex) - 1)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            submit(open && selectedIndex >= 0 ? suggestions[selectedIndex]!.input : draft)
          }
        }}
        spellCheck={false}
        autoComplete="off"
        aria-label={t('workspace.browser.address')}
        placeholder={t('workspace.browser.addressPlaceholder')}
        data-testid="workspace-browser-address"
        className={`h-8 min-w-0 flex-1 rounded-[var(--radius-md)] bg-transparent px-3 text-[13px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)] ${editing ? 'text-left' : 'text-center'}`}
      />
      <span className="opacity-0 transition-opacity group-hover/address:opacity-100 group-focus-within/address:opacity-100">
        <IconButton
          icon={<ExternalLink size={16} strokeWidth={1.75} />}
          label={t('workspace.browser.openExternal')}
          size="md"
          tone="muted"
          disabled={!(editing ? resolveAddress(draft) : currentAddress)}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            const url = editingRef.current ? resolveAddress(draft) : currentAddress
            if (url) onOpenExternal(url)
          }}
        />
      </span>
      {open ? (
        <AddressSuggestions
          id={listId}
          items={suggestions}
          query={query}
          selectedIndex={selectedIndex}
          onHighlight={setHighlighted}
          onSelect={submit}
        />
      ) : null}
    </form>
  )
})

function AddressSuggestions({ id, items, query, selectedIndex, onHighlight, onSelect }: {
  id: string
  items: AddressSuggestion[]
  query: string
  selectedIndex: number
  onHighlight: (index: number) => void
  onSelect: (input: string) => void
}) {
  const t = useTranslation()
  const listRef = useRef<HTMLDivElement>(null)
  useSuppressBrowserOverlay({ preserveSnapshot: true })
  useEffect(() => {
    listRef.current?.children[selectedIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIndex, items])
  return (
    <div
      ref={listRef}
      id={id}
      role="listbox"
      aria-label={t('workspace.browser.suggestions')}
      className="absolute inset-x-0 top-full z-[var(--z-dropdown)] mt-1 max-h-[min(280px,60dvh)] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-1 shadow-[var(--shadow-dropdown)]"
    >
      {items.map((item, index) => (
        <div
          key={item.action ? `action:${item.input}` : item.input}
          id={`${id}-${index}`}
          role="option"
          aria-selected={selectedIndex === index}
          onPointerDown={(event) => event.preventDefault()}
          onPointerMove={() => onHighlight(index)}
          onClick={() => onSelect(item.input)}
          className={`flex h-11 cursor-pointer items-center gap-3 rounded-[var(--radius-md)] px-3 text-[13px] ${selectedIndex === index ? 'bg-[var(--color-surface-hover)]' : ''}`}
        >
          {item.action === 'search'
            ? <Search size={16} aria-hidden="true" className="shrink-0 text-[var(--color-text-secondary)]" />
            : <Globe size={16} aria-hidden="true" className="shrink-0 text-[var(--color-text-secondary)]" />}
          <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">
            <HighlightedText text={item.title} query={query} />
            {item.url ? <span className="text-[var(--color-text-tertiary)]"> — <HighlightedText text={item.url} query={query} /></span> : null}
          </span>
          {item.action ? <span className="shrink-0 text-[var(--color-text-tertiary)]">{t(item.action === 'search' ? 'workspace.browser.searchWeb' : 'workspace.browser.visitAddress')}</span> : null}
        </div>
      ))}
    </div>
  )
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const start = query ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1
  if (start < 0) return text
  return <>{text.slice(0, start)}<strong className="font-semibold">{text.slice(start, start + query.length)}</strong>{text.slice(start + query.length)}</>
}
