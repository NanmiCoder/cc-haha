import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { SearchField } from '@/components/ui/SearchField'
import { Button } from '@/components/ui/Button'
import { WorkspaceFileIcon } from '@/components/workbench/WorkspaceFileIcon'
import { sessionsApi, type WorkspaceSearchResult } from '@/api/sessions'
import { Spinner } from '@/components/ui/Spinner'
import { useTranslation } from '../../i18n'
import { EMPTY_WORKSPACE_TREE_VIEW, useWorkspaceContentStore } from '../../stores/workspaceContentStore'
import { basenameOf } from '../../lib/workspace/types'
import { useRovingTree } from './treeKeyboard'
import { useWorkspaceChatContextStore } from '@/stores/workspaceChatContextStore'
import { useDismissable } from '@/hooks/useDismissable'
import { useAnchoredPosition } from '@/hooks/useAnchoredPosition'
import { useMenuKeyboard } from '@/components/workbench/menuKeyboard'

export type WorkspaceFileTreePaneProps = {
  sessionId: string
  /** Highlighted row; the path of whatever the content area is showing. */
  selectedPath: string | null
  /** Every activation opens its own tab; repeat opens of one path dedup in the store. */
  onOpen: (path: string) => void
  autoFocus?: boolean
}

type TreeRow = {
  path: string
  name: string
  depth: number
  isDirectory: boolean
  expanded: boolean
}

/**
 * The tree lives beside the content, not instead of it.
 *
 * That is the whole point of the layout change: the previous panel hid its
 * navigation the moment a file opened, so browsing a repository meant the
 * structure kept appearing and disappearing. Here it stays put and the content
 * changes underneath the selection.
 */
export function WorkspaceFileTreePane({
  sessionId,
  selectedPath,
  onOpen,
  autoFocus = false,
}: WorkspaceFileTreePaneProps) {
  const t = useTranslation()
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; row: TreeRow; x: number; y: number } | null>(null)
  const menu = contextMenu?.sessionId === sessionId ? contextMenu : null
  const menuRef = useRef<HTMLDivElement>(null)
  const menuTriggerRef = useRef<HTMLElement | null>(null)
  const closeMenu = useCallback(() => setContextMenu(null), [])
  useEffect(closeMenu, [closeMenu, sessionId])
  useDismissable({ open: menu !== null, refs: [menuRef], onDismiss: closeMenu })
  const handleMenuKeyDown = useMenuKeyboard({ open: menu !== null, menuRef, triggerRef: menuTriggerRef, onClose: closeMenu })
  const menuPosition = useAnchoredPosition({
    open: menu !== null,
    anchorRect: { top: menu?.y ?? 0, bottom: menu?.y ?? 0, left: menu?.x ?? 0, right: menu?.x ?? 0 },
    floatingRef: menuRef,
    offset: 0,
    clampHeight: true,
  })
  const treeView = useWorkspaceContentStore((state) => state.treeViewBySession[sessionId] ?? EMPTY_WORKSPACE_TREE_VIEW)
  const setTreeView = useWorkspaceContentStore((state) => state.setTreeView)
  const { filter } = treeView
  const setFilter = (filter: string) => setTreeView(sessionId, { filter, scrollTop: 0 })
  const [search, setSearch] = useState<(WorkspaceSearchResult & { sessionId: string }) | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Files always navigates the project; changed-file navigation belongs to Review.
  // Ignore the old in-memory mode so a previously selected mode cannot hide files.
  const watchPath = useWorkspaceContentStore((state) => selectedPath ? state.filesByKey[`${sessionId}::${selectedPath}`]?.watchPath : undefined)
  const candidatePath = watchPath ?? selectedPath
  // Absolute chat targets acquire their root-relative identity from the server.
  // Never turn an unvalidated absolute path into ancestors outside the workspace.
  const selectedTreePath = candidatePath && !/^(?:[\\/]|[a-zA-Z]:)/.test(candidatePath)
    ? candidatePath.replaceAll('\\', '/') : null
  const revealedPath = useRef<string | null>(null)

  useEffect(() => {
    if (autoFocus && treeView.open) inputRef.current?.focus()
    const focusSearch = (event: Event) => {
      if ((event as CustomEvent<{ sessionId: string }>).detail.sessionId !== sessionId) return
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('workspace-quick-open', focusSearch)
    return () => window.removeEventListener('workspace-quick-open', focusSearch)
  }, [autoFocus, sessionId, setTreeView, treeView.open])

  useEffect(() => {
    const query = filter.trim()
    setSearch(null)
    setSearchError(null)
    setSearching(!!query)
    if (!query) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void sessionsApi.searchWorkspace(sessionId, query, controller.signal).then((result) => {
        if (controller.signal.aborted) return
        setSearch({ ...result, sessionId })
        setSearching(false)
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return
        setSearchError(error instanceof Error ? error.message : String(error))
        setSearching(false)
      })
    }, 120)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [filter, sessionId])
  const loadTree = useWorkspaceContentStore((state) => state.loadTree)
  const toggleDirectory = useWorkspaceContentStore((state) => state.toggleDirectory)
  const treeByKey = useWorkspaceContentStore((state) => state.treeByKey)
  const treeLoadingByKey = useWorkspaceContentStore((state) => state.treeLoadingByKey)
  const expandedBySession = useWorkspaceContentStore((state) => state.expandedBySession)
  const rootLoading = useWorkspaceContentStore((state) => state.treeLoadingByKey[`${sessionId}::`])

  useEffect(() => {
    void loadTree(sessionId, '')
  }, [loadTree, sessionId])

  useEffect(() => {
    if (!selectedTreePath || filter.trim()) return
    const segments = selectedTreePath.split('/').filter(Boolean)
    for (let depth = 1; depth < segments.length; depth += 1) {
      const path = segments.slice(0, depth).join('/')
      const store = useWorkspaceContentStore.getState()
      if (!store.isExpanded(sessionId, path)) void toggleDirectory(sessionId, path)
      else void loadTree(sessionId, path)
    }
    // Follow a new active file, not every tree update: collapsing its parent or
    // scrolling elsewhere must remain under the user's control.
  }, [filter, loadTree, selectedTreePath, sessionId, toggleDirectory])

  const expanded = useMemo(
    () => new Set(expandedBySession[sessionId] ?? []),
    [expandedBySession, sessionId],
  )

  const treeFailures = useMemo(() => filter.trim() ? [] : ['', ...expanded].flatMap((path) => {
    const entry = treeByKey[`${sessionId}::${path}`]
    return entry && entry.state !== 'ok' ? [{ path, state: entry.state, error: entry.error }] : []
  }), [expanded, filter, sessionId, treeByKey])

  const rows = useMemo(() => {
    const query = filter.trim().toLowerCase()
    const out: TreeRow[] = []
    // Search is bounded by the server and does not walk every directory in the
    // renderer. Build ancestor rows from returned paths so unopened parents
    // cannot hide matching descendants.
    const matches = search?.sessionId === sessionId && search.query === filter.trim() ? search.entries : null
    if (matches) {
      const byPath = new Map<string, TreeRow>()
      for (const file of matches) {
        const parts = file.path.split('/').filter(Boolean)
        const prefix = file.path.startsWith('/') ? '/' : ''
        parts.forEach((name, depth) => {
          const path = prefix + parts.slice(0, depth + 1).join('/')
          const isDirectory = depth < parts.length - 1
          byPath.set(path, { path, name, depth, isDirectory, expanded: isDirectory })
        })
      }
      // Search hits are ranked by relevance and can interleave directories.
      // Group each parent's children before flattening or a later src/c.ts
      // would appear below test/b.ts and ArrowLeft would focus the wrong root.
      const children = new Map<string, TreeRow[]>()
      for (const row of byPath.values()) {
        const separator = row.path.lastIndexOf('/')
        const parent = separator <= 0 ? '' : row.path.slice(0, separator)
        const siblings = children.get(parent) ?? []
        siblings.push(row)
        children.set(parent, siblings)
      }
      const ordered: TreeRow[] = []
      const append = (parent: string) => {
        for (const row of children.get(parent) ?? []) {
          ordered.push(row)
          if (row.isDirectory) append(row.path)
        }
      }
      append('')
      return ordered
    }

    const walk = (path: string, depth: number) => {
      const node = treeByKey[`${sessionId}::${path}`]
      if (!node || node.state !== 'ok') return
      for (const entry of node.entries) {
        const matches = !query || entry.path.toLowerCase().includes(query)
        // A filter must not make a directory's matching children unreachable,
        // so a directory survives when anything under it survives. That is why
        // the recursion happens before the row is dropped.
        const childStart = out.length
        if (entry.isDirectory && (expanded.has(entry.path) || query)) {
          walk(entry.path, depth + 1)
        }
        const hasVisibleChildren = out.length > childStart
        if (!matches && !hasVisibleChildren) {
          out.length = childStart
          continue
        }
        out.splice(childStart, 0, {
          path: entry.path,
          name: entry.name,
          depth,
          isDirectory: entry.isDirectory,
          expanded: entry.isDirectory && (expanded.has(entry.path) || (!!query && hasVisibleChildren)),
        })
      }
    }

    walk('', 0)
    return out
  }, [expanded, filter, search, sessionId, treeByKey])

  useLayoutEffect(() => {
    revealedPath.current = null
  }, [filter, selectedTreePath, sessionId])

  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = treeView.scrollTop
  }, [rows, sessionId, treeView.scrollTop])

  useLayoutEffect(() => {
    if (!selectedTreePath || !treeView.open || filter.trim()) return
    const identity = `${sessionId}::${selectedTreePath}`
    if (revealedPath.current === identity) return
    const row = scrollRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!row) return
    row.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    revealedPath.current = identity
  }, [filter, rows, selectedTreePath, sessionId, treeView.open])

  const handleActivate = (row: TreeRow) => {
    if (row.isDirectory) {
      void toggleDirectory(sessionId, row.path)
      return
    }
    onOpen(row.path)
  }

  const { activePath, handleKeyDown, registerRow, setFocusedPath } = useRovingTree(rows, {
    selectedPath: selectedTreePath,
    onActivate: handleActivate,
    onToggleDirectory: (row) => { void toggleDirectory(sessionId, row.path) },
  })

  useEffect(() => {
    // Give the new active file the tab stop without moving DOM focus away from
    // the surface (or search field) that opened it.
    setFocusedPath(null)
  }, [selectedTreePath, sessionId, setFocusedPath])

  return (
    <div
      data-testid="workspace-file-tree"
      className="flex h-full min-h-0 w-full flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      <div className="shrink-0 px-2 pb-1 pt-2">
        <SearchField
          ref={inputRef}
          data-workspace-autofocus={autoFocus && treeView.open ? '' : undefined}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              inputRef.current?.closest('[data-testid="workspace-file-tree"]')?.querySelector<HTMLElement>('[role="treeitem"]')?.focus()
            }
          }}
          value={filter}
          onChange={setFilter}
          size="md"
          label={t('workspace.files.filter')}
          placeholder={t('workspace.files.filter')}
          clearLabel={t('workspace.clearFilter')}
          data-testid="workspace-file-tree-filter"
        />
      </div>

      {searchError ? <p role="alert" className="px-2 text-xs text-[var(--color-error)]">{searchError}</p> : null}
      {searching ? <p role="status" className="px-2 text-xs text-[var(--color-text-tertiary)]">{t('workspace.searching')}</p> : null}
      {search?.truncated ? <p role="status" className="px-2 text-xs text-[var(--color-text-tertiary)]">{t('workspace.searchResultsTruncated', { count: search.entries.length })}</p> : null}
      {treeFailures.length > 0 ? (
        <div className="max-h-[40%] shrink-0 overflow-y-auto px-2 py-1">
          {treeFailures.map((failure) => {
            const name = failure.path || t('workspace.files.projectRoot')
            return (
              <div key={failure.path} role="alert" className="py-1 text-xs text-[var(--color-error)]">
                <p className="break-words">{t(failure.state === 'missing' ? 'workspace.files.directoryMissing' : 'workspace.files.directoryError', { path: name })}</p>
                {failure.error ? <p className="break-words text-[var(--color-text-secondary)]">{failure.error}</p> : null}
                <Button variant="ghost" size="xs" aria-label={`${t('common.retry')}: ${name}`} loading={treeLoadingByKey[`${sessionId}::${failure.path}`]} onClick={() => { void loadTree(sessionId, failure.path, { force: true }) }}>
                  {t('common.retry')}
                </Button>
              </div>
            )
          })}
        </div>
      ) : null}
      <div ref={scrollRef} onScroll={(event) => setTreeView(sessionId, { scrollTop: event.currentTarget.scrollTop })} className="min-h-0 flex-1 overflow-auto px-1 pb-2" role="tree" aria-label={t('workspace.files.tree')}>
        {rootLoading && rows.length === 0 ? (
          <div className="flex items-center justify-center py-6">
            <Spinner size={16} label={t('common.loading')} />
          </div>
        ) : rows.length === 0 && (treeFailures.length > 0 || searchError) ? null : rows.length === 0 ? (
          <p className="px-2 py-3 text-[12px] text-[var(--color-text-tertiary)]">
            {t('workspace.files.empty')}
          </p>
        ) : (
          rows.map((row) => {
            const isSelected = !row.isDirectory && row.path === selectedTreePath
            return (
              <div
                key={row.path}
                ref={registerRow(row.path)}
                role="treeitem"
                // Exactly one row is tabbable; the arrow keys move the tab stop.
                tabIndex={row.path === activePath ? 0 : -1}
                aria-selected={isSelected}
                aria-expanded={row.isDirectory ? row.expanded : undefined}
                // Depth is conveyed by padding for sighted users; without this
                // it reaches assistive tech as a flat list.
                aria-level={row.depth + 1}
                data-testid={`workspace-tree-row-${row.path}`}
                onClick={() => {
                  setFocusedPath(row.path)
                  handleActivate(row)
                }}
                onFocus={() => setFocusedPath(row.path)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  menuTriggerRef.current = event.currentTarget
                  setContextMenu({ sessionId, row, x: event.clientX, y: event.clientY })
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                    event.preventDefault()
                    const rect = event.currentTarget.getBoundingClientRect()
                    menuTriggerRef.current = event.currentTarget
                    setContextMenu({ sessionId, row, x: rect.left, y: rect.bottom })
                    return
                  }
                  handleKeyDown(event, row)
                }}
                style={{ paddingLeft: 6 + row.depth * 16 }}
                className={[
                  'relative flex h-[34px] cursor-default items-center gap-1.5 rounded-[var(--radius-sm)] pr-2 text-[14px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]',
                  isSelected
                    ? 'bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]',
                ].join(' ')}
              >
                {Array.from({ length: row.depth }, (_, depth) => (
                  <span key={depth} aria-hidden="true" data-workspace-tree-guide className="pointer-events-none absolute inset-y-0 border-l border-[var(--color-border)]" style={{ left: 13 + depth * 16 }} />
                ))}
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--color-text-tertiary)]">
                  {row.isDirectory
                    ? row.expanded
                      ? <ChevronDown size={14} strokeWidth={1.9} aria-hidden="true" />
                      : <ChevronRight size={14} strokeWidth={1.9} aria-hidden="true" />
                    : <WorkspaceFileIcon path={row.path} />}
                </span>
                <span className="min-w-0 flex-1 truncate" title={row.path}>
                  {row.name || basenameOf(row.path)}
                </span>
              </div>
            )
          })
        )}
      </div>
      {menu ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('workspace.addSelectionToChat')}
          onKeyDown={handleMenuKeyDown}
          style={menuPosition.style}
          className="fixed z-[var(--z-dropdown)] min-w-[160px] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-1 shadow-[var(--shadow-dropdown)]"
        >
          <Button role="menuitem" variant="ghost" size="sm" onClick={() => {
            useWorkspaceChatContextStore.getState().addReference(sessionId, {
              kind: 'file', path: menu.row.path, name: menu.row.name,
              isDirectory: menu.row.isDirectory,
            })
            closeMenu()
          }}>
            {t('workspace.addSelectionToChat')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
