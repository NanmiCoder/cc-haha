import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useWorkspaceHeaderTarget } from '../layout/WorkspaceHeaderContext'
import { useShallow } from 'zustand/react/shallow'
import { t, useTranslation } from '../../i18n'
import { useChatStore } from '../../stores/chatStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { discardNavigatedBrowserSelections, handleBrowserSelectionEvent } from '../../lib/workspace/browserSelections'
import { useWorkspaceBrowserStore } from '../../stores/workspaceBrowserStore'
import { useWorkspaceContentStore } from '../../stores/workspaceContentStore'
import { openWorkspaceTarget, workspaceOpen } from '../../lib/workspace/openTarget'
import { subscribeWorkspaceBrowserEvents } from '../../lib/workspace/browserHost'
import type { WorkspaceDock, WorkspaceTabKind } from '../../lib/workspace/types'
import { WorkspaceTabStrip } from './WorkspaceTabStrip'
import { WorkspaceLauncher } from './WorkspaceLauncher'
import { WorkspaceAddMenu } from './WorkspaceAddMenu'
import { WorkspaceBrowserTab } from './WorkspaceBrowserTab'
import { WorkspaceTerminalTab } from './WorkspaceTerminalTab'
import { useWorkspaceFileWatch } from '@/lib/workspace/useWorkspaceFileWatch'
import { WorkspaceFileTab } from './WorkspaceFileTab'
import { WorkspaceReviewTab } from './WorkspaceReviewTab'

export type WorkspaceSurfaceProps = {
  sessionId: string
  dock: WorkspaceDock
  /** Where a new terminal starts, and the root the file tree reads. */
  cwd: string
  /** Reason the review entry is unavailable here, e.g. "not a Git repository". */
  reviewUnavailableReason?: string | null
  /**
   * Whether this dock is on screen. The bottom dock stays mounted while hidden
   * so xterm keeps its geometry, so "mounted" and "visible" are not the same
   * question and the content needs to be told which one it is.
   */
  visible?: boolean
}

/**
 * One dock of the workspace: a mixed tab strip over the active tab's content.
 *
 * The strip is always present, including for a single tab — the reference does
 * the same, and it is what makes "this panel holds resources, and here they
 * are" true at every moment instead of only once a second thing is open.
 */
export function WorkspaceSurface({
  sessionId,
  dock,
  cwd,
  reviewUnavailableReason = null,
  visible = true,
}: WorkspaceSurfaceProps) {
  const t = useTranslation()
  const surfaceRef = useRef<HTMLDivElement>(null)
  const headerTarget = useWorkspaceHeaderTarget(surfaceRef, sessionId, dock === 'side' && visible)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuId = useId()
  const initialMenuFocus = useRef<'first' | 'last'>('first')
  const pendingMenuSelection = useRef<WorkspaceTabKind | null>(null)
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null)
  const watchError = useWorkspaceFileWatch(sessionId, dock === 'side' && visible)
  const contentRef = useRef<HTMLDivElement>(null)

  const tabs = useWorkspaceStore(
    useShallow((state) => (state.bySession[sessionId]?.tabs ?? []).filter((tab) => tab.dock === dock)),
  )
  const activeTabId = useWorkspaceStore((state) =>
    dock === 'side'
      ? state.bySession[sessionId]?.activeSideTabId ?? null
      : state.bySession[sessionId]?.activeBottomTabId ?? null,
  )
  const canReopenClosed = useWorkspaceStore(
    (state) => (state.bySession[sessionId]?.closed.length ?? 0) > 0,
  )
  const focus = useWorkspaceStore((state) => state.bySession[sessionId]?.focus ?? null)
  // Without this the branch comparison is unreachable: the picker only offers it
  // when it knows which branch to compare against.
  const defaultBranchRef = useWorkspaceContentStore(
    (state) => state.statusBySession[sessionId]?.branch ?? null,
  )

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null

  useEffect(() => {
    // A chooser belongs to the dock and task where it was opened. A reused
    // surface must show the next task's content, not the previous task's menu.
    setMenuOpen(false)
    menuTriggerRef.current = null
    pendingMenuSelection.current = null
  }, [dock, sessionId, visible])

  const closeMenu = useCallback(() => setMenuOpen(false), [])

  /*
    This surface can only ever honour a request to focus its *content*. The two
    toggle targets are handled by `useWorkspaceFocusReturn`, which lives in a
    component that outlives the panel — hiding the workspace unmounts everything
    here, so a `side-toggle` request raised by that very action could never be
    consumed from inside it, and would then fire stale on the next reopen and
    park focus on the button that hides the panel again.
  */
  useEffect(() => {
    if (!focus) return
    const wanted = dock === 'side' ? 'active-side-tab' : 'active-bottom-tab'
    if (focus.target !== wanted) return
    const target = contentRef.current?.querySelector<HTMLElement>('[data-workspace-autofocus]') ?? contentRef.current
    target?.focus({ preventScroll: true })
    useWorkspaceStore.getState().consumeFocusRequest(sessionId)
  }, [dock, focus, sessionId])

  const handleLauncherSelect = useCallback((kind: WorkspaceTabKind) => {
    setMenuOpen(false)
    // A + action adds a resource; even an uncommitted browser page belongs
    // to its existing tab and must not be consumed as a blank placeholder.
    switch (kind) {
      case 'review':
        openWorkspaceTarget({ sessionId, target: { kind: 'review' } })
        break
      case 'terminal':
        openWorkspaceTarget({
          sessionId,
          target: { kind: 'terminal', cwd, dock },
        })
        break
      case 'browser':
        openWorkspaceTarget({ sessionId, target: { kind: 'browser' } })
        break
      case 'file':
        // The tree comes with the file view, so opening "Files" with nothing
        // chosen yet is a tree with an empty content pane rather than a modal.
        openWorkspaceTarget({
          sessionId,
          target: { kind: 'file', path: '' },
          preview: true,
        })
        break
    }
  }, [cwd, dock, sessionId])

  // Let the menu finish its own focus cleanup before opening/focusing a resource.
  // Otherwise its close autofocus can pull focus out of a new address bar or tree.
  useEffect(() => {
    if (menuOpen || !visible) return
    const kind = pendingMenuSelection.current
    pendingMenuSelection.current = null
    if (kind) handleLauncherSelect(kind)
  }, [handleLauncherSelect, menuOpen, visible])

  const selectFromMenu = useCallback((kind: WorkspaceTabKind) => {
    pendingMenuSelection.current = kind
    setMenuOpen(false)
  }, [])

  const tabStrip = tabs.length > 0 ? (
      <WorkspaceTabStrip
        dock={dock}
        placement={headerTarget ? 'window' : 'dock'}
        tabs={tabs}
        activeTabId={activeTabId}
        canReopenClosed={canReopenClosed}
        onActivate={(tabId) => {
          // Choosing an existing tab is also a way of cancelling the picker.
          setMenuOpen(false)
          useWorkspaceStore.getState().activateTab(sessionId, tabId)
        }}
        onPin={(tabId) => useWorkspaceStore.getState().pinTab(sessionId, tabId)}
        onClose={(tabId) => useWorkspaceStore.getState().closeTab(sessionId, tabId)}
        onCloseScope={(tabId, scope) => useWorkspaceStore.getState().closeTabs(sessionId, tabId, scope)}
        onReorder={(tabId, index) => useWorkspaceStore.getState().moveTab(sessionId, tabId, index)}
        onMoveDock={(tabId, nextDock) =>
          useWorkspaceStore.getState().moveTabToDock(sessionId, tabId, nextDock)}
        onReopenClosed={() => useWorkspaceStore.getState().reopenClosedTab(sessionId)}
        addMenuId={menuId}
        addMenuOpen={menuOpen}
        onAdd={(trigger, initialFocus = 'first') => {
          menuTriggerRef.current = trigger
          initialMenuFocus.current = initialFocus
          setMenuOpen((open) => !open)
        }}
      />
  ) : null

  return (
    <div
      ref={surfaceRef}
      data-testid={`workspace-surface-${dock}`}
      aria-label={t('workspace.panelLabel')}
      className="flex h-full min-h-0 w-full flex-col bg-[var(--color-surface)]"
    >
      {watchError ? <p role="status" className="shrink-0 px-3 py-1 text-xs text-[var(--color-text-tertiary)]">{t('workspace.files.watchFailed', { reason: watchError })}</p> : null}
      {tabStrip && headerTarget ? createPortal(tabStrip, headerTarget) : tabStrip}

      <div
        ref={contentRef}
        tabIndex={-1}
        role="tabpanel"
        id={`workspace-tabpanel-${dock}`}
        // The strip emits this exact id on every `role="tab"`; without the
        // pairing the tablist announces a control that governs nothing.
        {...(activeTabId ? { 'aria-labelledby': `workspace-tab-${dock}-${activeTabId}` } : {})}
        className="flex min-h-0 flex-1 flex-col outline-none"
      >
        {tabs.length === 0 ? (
          <WorkspaceLauncher
            onSelect={handleLauncherSelect}
            dock={dock}
            reviewUnavailableReason={reviewUnavailableReason}
          />
        ) : activeTab === null ? null : activeTab.kind === 'browser' ? (
          <WorkspaceBrowserTab sessionId={sessionId} tab={activeTab} active={visible} />
        ) : activeTab.kind === 'terminal' ? (
          <WorkspaceTerminalTab sessionId={sessionId} tab={activeTab} active={visible} />
        ) : activeTab.kind === 'file' ? (
          <WorkspaceFileTab sessionId={sessionId} tab={activeTab} />
        ) : (
          <WorkspaceReviewTab
            active={visible}
            sessionId={sessionId}
            tab={activeTab}
            defaultBranchRef={defaultBranchRef}
          />
        )}
      </div>
      {menuOpen && visible ? (
        <WorkspaceAddMenu
          id={menuId}
          anchorRef={menuTriggerRef}
          dock={dock}
          initialFocus={initialMenuFocus.current}
          reviewUnavailableReason={reviewUnavailableReason}
          onSelect={selectFromMenu}
          onClose={closeMenu}
        />
      ) : null}
    </div>
  )
}

/**
 * Bridge host page events into the stores, once per app.
 *
 * Two things have to be true at once, and the obvious implementation gets the
 * second one wrong:
 *
 * 1. The subscription must outlive any single tab's React surface — events keep
 *    arriving for pages whose surface is not mounted (a background tab finishing
 *    a load, a download completing).
 * 2. Each event belongs to the task that **owns the page**, which is not
 *    necessarily the task on screen. Routing by the foreground session drops
 *    every event for a backgrounded task's pages, and — far worse — makes a
 *    `window.open` from one task's page create a tab in whichever task the user
 *    happens to be reading.
 *
 * So the subscription is opened once and the owner is resolved from the page id.
 */
export function useWorkspaceBrowserEventBridge(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    let unsubscribe: (() => void) | undefined
    let cancelled = false

    void subscribeWorkspaceBrowserEvents((event) => {
      const store = useWorkspaceStore.getState()
      if (event.type === 'shortcut') {
        window.dispatchEvent(new CustomEvent('workspace-native-shortcut', { detail: event }))
        return
      }
      // Downloads outlive their source tab. Only their global entry may update
      // after close; page-specific events must not resurrect forgotten state.
      if (event.type === 'download') {
        useWorkspaceBrowserStore.getState().applyEvent(event)
        return
      }
      const owner = store.findBrowserTabOwner(event.tabId)
      // A page that no longer belongs to any tab has been closed; its late
      // events must not be applied to whatever took its place.
      if (!owner) return
      const previousNavigationId = useWorkspaceBrowserStore.getState().getPage(event.tabId).navigationId
      if (!useWorkspaceBrowserStore.getState().applyEvent(event)) return

      switch (event.type) {
        case 'state':
          if (event.navigationOutcome === 'pending' && (event.navigationId ?? 0) > previousNavigationId) {
            discardNavigatedBrowserSelections(event.tabId)
          }
          store.updateBrowserTab(owner.sessionId, event.tabId, {
            url: event.url || null,
            title: event.title || null,
            ...(event.navigationOutcome === 'succeeded' ? { loadError: null } : {}),
          })
          break
        case 'failed':
          store.updateBrowserTab(owner.sessionId, event.tabId, {
            loadError: event.errorDescription || String(event.errorCode),
          })
          break
        case 'destroyed':
          store.updateBrowserTab(owner.sessionId, event.tabId, {
            // A reason code is not a message. It reaches the error overlay, so
            // it has to be a translated sentence in all five languages.
            loadError: t(event.reason === 'crashed'
              ? 'workspace.browser.pageCrashed'
              : 'workspace.browser.pageClosed'),
          })
          break
        case 'new-window':
          // A popup or `target=_blank` becomes a sibling tab in the task whose
          // page opened it, and never steals focus from a different task.
          workspaceOpen.browser(owner.sessionId, event.url, { background: true })
          break
        case 'screenshot':
          // The host does the capture and emits the result; without a consumer
          // the "capture screenshot" menu item did the work and threw it away.
          useChatStore.getState().queueComposerPrefill(owner.sessionId, {
            text: '',
            mode: 'append',
            attachments: [{
              type: 'image',
              name: `screenshot-${event.kind}.png`,
              mimeType: 'image/png',
              data: event.dataUrl,
            }],
          })
          break
        case 'agent':
          handleBrowserSelectionEvent(owner.sessionId, event.tabId, event.message)
          break
        default:
          break
      }
    }).then((dispose) => {
      if (cancelled) dispose()
      else unsubscribe = dispose
    })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [enabled])
}
