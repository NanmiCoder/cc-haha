import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  MessageSquarePlus,
  MoreVertical,
  RotateCw,
  Search,
  X,
} from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { Spinner } from '@/components/ui/Spinner'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { WorkspaceBrowserAddressBar } from '@/components/workbench/WorkspaceBrowserAddressBar'
import { WorkspaceBrowserSelectionBar } from '@/components/workbench/WorkspaceBrowserSelectionBar'
import { useDismissable } from '@/hooks/useDismissable'
import { useTranslation } from '../../i18n'
import { getDesktopHost } from '../../lib/desktopHost'
import { getServerBaseUrl } from '../../lib/desktopRuntime'
import { formatBytes } from '../../lib/formatBytes'
import { classifyPreviewLink } from '../../lib/previewLinkRouter'
import { isRootedLocalPath, localFileUrl, previewFsUrl } from '../../lib/handlePreviewLink'
import {
  isWorkspaceBrowserAvailable,
  workspaceBrowserHost,
} from '../../lib/workspace/browserHost'
import {
  ensureWorkspaceBrowserGuest,
  isWorkspaceBrowserGuestRegistered,
  placeWorkspaceBrowserGuest,
} from '../../lib/workspace/browserGuests'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { useWorkspaceBrowserStore } from '../../stores/workspaceBrowserStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { usePreviewSelectionStore } from '../../stores/previewSelectionStore'
import { normalizeBrowserAddress } from '../../lib/workspace/browserAddress'
import { discardBrowserSelections } from '../../lib/workspace/browserSelections'
import { buildPreviewPickerMessage } from '../../lib/previewSelectionPicker'
import { MIN_APP_ZOOM, MAX_APP_ZOOM } from '../../lib/appZoom'
import type { WorkspaceBrowserTab as WorkspaceBrowserTabModel } from '../../lib/workspace/types'

const MIN_ZOOM = MIN_APP_ZOOM
const MAX_ZOOM = MAX_APP_ZOOM
const ZOOM_STEP = 0.1

type BrowserPanel = 'downloads' | 'history' | null

export type WorkspaceBrowserTabProps = {
  sessionId: string
  tab: WorkspaceBrowserTabModel
  active: boolean
}

function resolveNavigationUrl(input: string, sessionId: string): string {
  const value = normalizeBrowserAddress(input)
  if (!value) return ''
  const classified = classifyPreviewLink(value)
  if (classified.kind === 'browser-file' && classified.path) {
    const base = getServerBaseUrl()
    return isRootedLocalPath(classified.path)
      ? localFileUrl(base, classified.path)
      : previewFsUrl(base, sessionId, classified.path)
  }
  return value
}

/**
 * One page, addressed by its own `browserTabId`.
 *
 * React here only decides *where the page is drawn*: the stage below is the
 * placeholder the page's `<webview>` is positioned over. Creating it,
 * navigating it and destroying it are the controller's and the host's business
 * — which is why unmounting this component (hiding the panel, switching tab,
 * switching task) parks the page and nothing more.
 */
export function WorkspaceBrowserTab({ sessionId, tab, active }: WorkspaceBrowserTabProps) {
  const t = useTranslation()
  const browserRootRef = useRef<HTMLDivElement>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuError, setMenuError] = useState<string | null>(null)
  const menuRequestRef = useRef<object | null>(null)
  const menuAllowedRef = useRef(false)
  const [panel, setPanel] = useState<BrowserPanel>(null)
  const [pendingNavigation, setPendingNavigation] = useState<{ run: () => void } | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const appZoom = useSettingsStore((state) => state.uiZoom)
  const theme = useUIStore((state) => state.theme)
  const available = useMemo(() => isWorkspaceBrowserAvailable(), [])
  const browserTabId = tab.browserTabId
  // Bumped when this page's registration settles; readiness itself is read
  // from the guest registry, which also knows when a page was lost.
  const [, setRegistrationSettled] = useState(0)
  const [createAttempt, setCreateAttempt] = useState(0)
  const lifetimeRef = useRef<{ id: string; ready: boolean; cancelled: boolean } | null>(null)
  const navigationRequestRef = useRef(0)
  const page = useWorkspaceBrowserStore((state) => state.pageByTabId[browserTabId])
  // Only a page the host adopted can take commands. A page registered by an
  // earlier mount is ready at once, so re-activating a tab does not flash a
  // disabled toolbar.
  const ready = isWorkspaceBrowserGuestRegistered(browserTabId)
  const initialAddressFocusRef = useRef({ browserTabId, pending: !tab.url && !ready, activated: false })
  if (initialAddressFocusRef.current.browserTabId !== browserTabId) {
    initialAddressFocusRef.current = { browserTabId, pending: !tab.url && !ready, activated: false }
  }
  const selectionCount = usePreviewSelectionStore((state) => state.bySession[browserTabId]?.items.length ?? 0)
  const zoom = page?.zoomFactor ?? 1
  const historyByTabId = useWorkspaceBrowserStore((state) => state.historyByTabId)
  const history = historyByTabId[browserTabId]
  const visits = useMemo(() => Object.values(historyByTabId).flatMap((entries) => entries ?? []), [historyByTabId])
  const downloads = useWorkspaceBrowserStore((state) => state.downloads)
  const loading = page?.loading ?? false
  menuAllowedRef.current = active && !pendingNavigation

  const currentAddress = page?.url || tab.url || ''
  const annotationActive = page?.annotationActive ?? false

  useLayoutEffect(() => {
    const request = initialAddressFocusRef.current
    if (!request.pending || !available) return
    if (tab.url || (!active && request.activated)) { request.pending = false; return }
    if (!active) return
    request.activated = true
    if (ready) {
      request.pending = false
      addressRef.current?.focus({ preventScroll: true })
      return
    }
    // A disabled address bar cannot receive the workspace's initial focus
    // request. Retry on readiness only if the user has not moved elsewhere.
    const onFocus = (event: FocusEvent) => {
      const target = event.target
      if (!(target instanceof Node) || target === document.body || target === document.documentElement) return
      const panel = browserRootRef.current?.closest('[role="tabpanel"]') ?? browserRootRef.current
      if (!panel?.contains(target)) request.pending = false
    }
    document.addEventListener('focusin', onFocus)
    return () => document.removeEventListener('focusin', onFocus)
  }, [active, available, browserTabId, ready, tab.url])

  useDismissable({ open: panel !== null, refs: [panelRef], onDismiss: () => setPanel(null) })

  useEffect(() => {
    if (!menuAllowedRef.current) {
      menuRequestRef.current = null
      setMenuOpen(false)
    }
  }, [active, pendingNavigation])

  const stillOwned = useCallback(() => useWorkspaceStore.getState().findBrowserTabOwner(browserTabId)?.sessionId === sessionId, [browserTabId, sessionId])
  const canCommand = useCallback(() => {
    const lifetime = lifetimeRef.current
    return lifetime?.id === browserTabId && !lifetime.cancelled && stillOwned() &&
      (lifetime.ready || isWorkspaceBrowserGuestRegistered(browserTabId))
  }, [browserTabId, stillOwned])
  const reportHostError = useCallback((error: unknown) => {
    const lifetime = lifetimeRef.current
    if (lifetime?.id !== browserTabId || lifetime.cancelled || !stillOwned()) return
    useWorkspaceStore.getState().updateBrowserTab(sessionId, browserTabId, {
      loadError: error instanceof Error ? error.message : String(error),
    })
  }, [browserTabId, sessionId, stillOwned])
  const runCommand = (command: () => Promise<unknown>) => {
    if (canCommand()) void command().catch(reportHostError)
  }
  const runNavigationCommand = (command: () => Promise<unknown>) => {
    if (!canCommand()) return
    const request = ++navigationRequestRef.current
    const before = useWorkspaceBrowserStore.getState().pageByTabId[browserTabId]?.navigationId ?? 0
    void command().catch((error: unknown) => {
      if (request !== navigationRequestRef.current) return
      const current = useWorkspaceBrowserStore.getState().pageByTabId[browserTabId]
      if (current && (current.navigationId > before + 1 || (current.navigationId > before && current.navigationOutcome === 'succeeded'))) return
      reportHostError(error)
    })
  }
  // Create once per page identity. `storageId` travels with it so a restored
  // tab reopens the same page rather than a blank one. A page that already
  // exists is only re-registered, never re-navigated.
  useEffect(() => {
    if (!available || !stillOwned()) return
    menuRequestRef.current = null
    setMenuOpen(false)
    setMenuError(null)
    const lifetime = { id: browserTabId, ready: false, cancelled: false }
    lifetimeRef.current = lifetime
    const request = ++navigationRequestRef.current
    void ensureWorkspaceBrowserGuest(browserTabId, async (webContentsId) => {
      const result = await workspaceBrowserHost.create(browserTabId, {
        storageId: tab.storageId,
        webContentsId,
        ...(tab.url ? { url: tab.url } : {}),
      })
      if (!result.ok) throw new Error(t('workspace.browser.unavailableTitle'))
    }).then(() => {
      if (lifetime.cancelled || !stillOwned()) return
      lifetime.ready = true
      setRegistrationSettled((count) => count + 1)
    }).catch((error: unknown) => {
      if (lifetime.cancelled || !stillOwned() || request !== navigationRequestRef.current) return
      reportHostError(error)
    })
    // Deliberately NOT closing on unmount: the page belongs to the tab, and the
    // tab outlives this component. `closeTab` is the only thing that ends it.
    return () => {
      const registered = lifetime.ready || isWorkspaceBrowserGuestRegistered(browserTabId)
      lifetime.cancelled = true
      if (registered && stillOwned()) {
        void workspaceBrowserHost.setVisible(browserTabId, false).catch((error: unknown) => {
          // Missing pages are an idempotent hide in the host. Other teardown
          // failures remain diagnostic errors rather than unhandled promises.
          console.error('Failed to hide workspace browser page', error)
        })
      }
    }
    // The URL is an initial input, not a reason to recreate a live page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserTabId, createAttempt])

  /*
    The page is a `<webview>` composited with the DOM, so menus, dialogs and
    other pages draw over it on their own. What remains is deciding when this
    surface shows it at all — and the teardown is load-bearing.

    The surface renders only the active tab, so unmount is the *normal* way a
    browser tab goes off screen: switching to a file tab, hiding the workspace
    or switching tasks. Releasing the placement parks the page (it keeps its
    state); without that it would stay drawn over whatever replaced it.

    Full-page panels and the retry overlay replace the page, and a tab with no
    address shows its empty state instead.
  */
  const pageVisible = active &&
    panel === null &&
    !tab.loadError &&
    Boolean(tab.url)

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!available || !stage) return
    return placeWorkspaceBrowserGuest(browserTabId, stage, pageVisible && ready)
  }, [available, browserTabId, pageVisible, ready])

  // Only the shown page acts as browser chrome in the host (shortcuts, the zoom
  // capsule), and a native menu of a page that goes away has to close with it.
  useLayoutEffect(() => {
    if (!canCommand()) return
    void workspaceBrowserHost.setVisible(browserTabId, pageVisible).catch(reportHostError)
  }, [browserTabId, canCommand, pageVisible, ready, reportHostError])

  // The capsule is drawn inside the page itself, so it scrolls and zooms with
  // it. The host retains this configuration and replays it after each navigation.
  useEffect(() => {
    if (!ready || !available || !active || !canCommand()) return
    const styles = getComputedStyle(document.documentElement)
    const token = (name: string) => styles.getPropertyValue(name).trim()
    void workspaceBrowserHost.message(browserTabId, {
      v: 1, type: 'browser-controls', zoomFactor: zoom, appZoom,
      copy: {
        zoom: t('workspace.browser.zoom'), zoomOut: t('workspace.browser.zoomOut'),
        zoomIn: t('workspace.browser.zoomIn'), zoomReset: t('workspace.browser.zoomReset'),
      },
      colors: {
        background: token('--color-surface-container-lowest'), foreground: token('--color-text-primary'),
        muted: token('--color-text-secondary'), border: token('--color-border'),
        hover: token('--color-surface-hover'), focus: token('--color-border-focus'), shadow: token('--shadow-dropdown'),
      },
    }).catch(reportHostError)
  }, [active, appZoom, available, browserTabId, canCommand, ready, reportHostError, t, theme, zoom])

  const requestNavigation = (run: () => void) => {
    if (!canCommand()) return
    if (usePreviewSelectionStore.getState().bySession[browserTabId]?.items.length) setPendingNavigation({ run })
    else run()
  }

  const navigate = (input: string, onAccepted?: () => void) => {
    const url = resolveNavigationUrl(input, sessionId)
    if (!url) return
    requestNavigation(() => {
      useWorkspaceStore.getState().updateBrowserTab(sessionId, browserTabId, { loadError: null })
      addressRef.current?.blur()
      onAccepted?.()
      let samePage = false
      try { samePage = new URL(currentAddress).href === new URL(url).href } catch { /* A blank page has no URL yet. */ }
      runNavigationCommand(() => samePage
        ? workspaceBrowserHost.reload(browserTabId)
        : workspaceBrowserHost.navigate(browserTabId, url))
    })
  }

  const applyZoom = (next: number) => {
    if (!canCommand()) return
    const clamped = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)) * 10) / 10
    useWorkspaceBrowserStore.getState().setZoom(browserTabId, clamped)
    runCommand(() => workspaceBrowserHost.setZoom(browserTabId, clamped))
  }

  const pickElement = () => {
    if (useWorkspaceBrowserStore.getState().pageByTabId[browserTabId]?.annotationActive) {
      runCommand(() => workspaceBrowserHost.message(browserTabId, { v: 1, type: 'exit-picker' }))
      return
    }
    const selectionDraft = usePreviewSelectionStore.getState().bySession[browserTabId]
    const message = buildPreviewPickerMessage(selectionDraft?.items.length ? 'batch' : 'single', selectionDraft?.nextNumber ?? 1)
    if (message.type === 'enter-picker') {
      runCommand(() => workspaceBrowserHost.message(browserTabId, { ...message, persistent: true }))
    }
  }

  const runFind = (text: string, findNext: boolean) => {
    if (!text) {
      runCommand(() => workspaceBrowserHost.stopFind(browserTabId))
      return
    }
    runCommand(() => workspaceBrowserHost.find(browserTabId, text, { findNext, forward: true }))
  }

  const openMenu = async () => {
    if (!canCommand() || !menuAllowedRef.current || menuRequestRef.current) return
    const anchor = menuTriggerRef.current?.getBoundingClientRect()
    if (!anchor) return
    const lifetime = lifetimeRef.current
    const request = {}
    menuRequestRef.current = request
    setMenuError(null)
    setMenuOpen(true)
    const isCurrent = () => menuRequestRef.current === request && lifetimeRef.current === lifetime && canCommand()
    try {
      const action = await workspaceBrowserHost.showMenu(browserTabId, {
        x: anchor.left,
        y: anchor.bottom,
        zoomFactor: zoom,
        hasPage: Boolean(tab.url),
        canOpenExternal: Boolean(page?.url || tab.url),
        labels: {
          find: t('workspace.browser.findInPage'),
          print: t('workspace.browser.print'),
          zoom: t('workspace.browser.zoom'),
          zoomIn: t('workspace.browser.zoomIn'),
          zoomOut: t('workspace.browser.zoomOut'),
          zoomReset: t('workspace.browser.zoomReset'),
          capture: t('workspace.browser.capture'),
          pickElement: t('workspace.browser.pickElement'),
          downloads: t('workspace.browser.downloads'),
          history: t('workspace.browser.history'),
          openExternal: t('workspace.browser.openExternal'),
        },
      })
      // A native popup can finish after a tab switch or unmount. It must never
      // send a late command to the page that has since replaced its owner.
      if (!isCurrent() || !menuAllowedRef.current) return
      const currentPage = useWorkspaceBrowserStore.getState().pageByTabId[browserTabId]
      const currentZoom = currentPage?.zoomFactor ?? zoom
      if (!tab.url && (action === 'find' || action === 'print' || action === 'capture' || action === 'pickElement')) return
      switch (action) {
        case 'find':
          setFindOpen(true)
          break
        case 'print':
          runCommand(() => workspaceBrowserHost.printToPdf(browserTabId))
          break
        case 'zoomIn':
          applyZoom(currentZoom + ZOOM_STEP)
          break
        case 'zoomOut':
          applyZoom(currentZoom - ZOOM_STEP)
          break
        case 'zoomReset':
          applyZoom(1)
          break
        case 'capture':
          runCommand(() => workspaceBrowserHost.capture(browserTabId, 'full'))
          break
        case 'pickElement':
          pickElement()
          break
        case 'downloads':
          setPanel('downloads')
          break
        case 'history':
          setPanel('history')
          break
        case 'openExternal': {
          const url = currentPage?.url || tab.url
          if (url) await getDesktopHost().shell.open(url)
          break
        }
      }
    } catch (error) {
      // A menu failure does not mean the website failed to load. Keep the guest
      // visible and expose the command error in the app chrome.
      if (isCurrent()) setMenuError(error instanceof Error ? error.message : String(error))
    } finally {
      if (isCurrent()) setMenuOpen(false)
      if (menuRequestRef.current === request) menuRequestRef.current = null
    }
  }

  if (!available) {
    return (
      <div
        data-testid="workspace-browser-unavailable"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-8 text-center"
      >
        <p className="text-[13px] font-medium text-[var(--color-text-primary)]">
          {t('workspace.browser.unavailableTitle')}
        </p>
        <p className="max-w-[360px] text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
          {t('workspace.browser.unavailableBody')}
        </p>
        {tab.url ? (
          <button
            type="button"
            onClick={() => { void getDesktopHost().shell.open(tab.url!) }}
            className="mt-1 inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-1.5 text-[12px] text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          >
            <ExternalLink size={13} aria-hidden="true" />
            {t('workspace.browser.openExternal')}
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <div ref={browserRootRef} className="relative flex min-h-0 flex-1 flex-col">
      <div
        data-testid="workspace-browser-toolbar"
        className="flex h-[52px] shrink-0 items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2.5"
      >
        <IconButton
          icon={<ArrowLeft size={15} strokeWidth={1.9} />}
          label={t('workspace.browser.back')}
          size="md"
          tone="muted"
          disabled={!ready || !page?.canGoBack}
          onClick={() => requestNavigation(() => runNavigationCommand(() => workspaceBrowserHost.goBack(browserTabId)))}
        />
        <IconButton
          icon={<ArrowRight size={15} strokeWidth={1.9} />}
          label={t('workspace.browser.forward')}
          size="md"
          tone="muted"
          disabled={!ready || !page?.canGoForward}
          onClick={() => requestNavigation(() => runNavigationCommand(() => workspaceBrowserHost.goForward(browserTabId)))}
        />
        <IconButton
          icon={loading ? <Spinner size={15} /> : <RotateCw size={15} strokeWidth={1.9} />}
          label={t(loading ? 'workspace.browser.stop' : 'workspace.browser.reload')}
          size="md"
          tone="muted"
          aria-busy={loading}
          disabled={!ready}
          onClick={() => {
            if (loading) {
              navigationRequestRef.current += 1
              runCommand(() => workspaceBrowserHost.stop(browserTabId))
            } else requestNavigation(() => runNavigationCommand(() => workspaceBrowserHost.reload(browserTabId)))
          }}
        />
        <WorkspaceBrowserAddressBar
          key={browserTabId}
          ref={addressRef}
          currentAddress={currentAddress}
          active={active}
          disabled={!ready}
          blank={!tab.url}
          visits={visits}
          resolveAddress={(input) => resolveNavigationUrl(input, sessionId)}
          onNavigate={navigate}
          onOpenExternal={(url) => { void getDesktopHost().shell.open(url) }}
        />
        <IconButton
          icon={<MessageSquarePlus size={16} strokeWidth={1.75} />}
          label={t(annotationActive ? 'workspace.browser.annotationActive' : 'workspace.browser.pickElement')}
          pressed={annotationActive}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && annotationActive) {
              event.preventDefault()
              event.stopPropagation()
              runCommand(() => workspaceBrowserHost.message(browserTabId, { v: 1, type: 'exit-picker' }))
            }
          }}
          size="md"
          tone="muted"
          disabled={!ready || !tab.url || !!tab.loadError}
          data-testid="workspace-browser-annotate"
          onClick={pickElement}
        />
        <IconButton
          ref={menuTriggerRef}
          icon={<MoreVertical size={15} strokeWidth={1.9} />}
          label={t('workspace.browser.menu')}
          size="md"
          tone="muted"
          pressed={menuOpen}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={!ready}
          data-testid="workspace-browser-menu-trigger"
          onClick={() => { void openMenu() }}
        />
      </div>

      {menuError ? (
        <div role="alert" className="shrink-0 px-3 py-1.5 text-[12px] text-[var(--color-error)]">
          {menuError}
        </div>
      ) : null}
      {findOpen ? (
        <div
          data-testid="workspace-browser-find"
          className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-2"
        >
          <Search size={13} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
          <input
            autoFocus
            value={findText}
            aria-label={t('workspace.browser.findInPage')}
            placeholder={t('workspace.browser.findPlaceholder')}
            onChange={(event) => {
              setFindText(event.target.value)
              runFind(event.target.value, false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                runFind(findText, true)
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setFindOpen(false)
                runCommand(() => workspaceBrowserHost.stopFind(browserTabId))
              }
            }}
            className="h-6 min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
          />
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
            {page?.find
              ? t('workspace.browser.findMatches', {
                  index: page.find.active,
                  total: page.find.total,
                })
              : ''}
          </span>
          <IconButton
            icon={<X size={13} />}
            label={t('workspace.browser.findClose')}
            size="2xs"
            tone="muted"
            onClick={() => {
              setFindOpen(false)
              runCommand(() => workspaceBrowserHost.stopFind(browserTabId))
            }}
          />
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden" data-testid="workspace-browser-stage">
        <div ref={stageRef} data-testid="workspace-browser-placeholder" className="absolute inset-0" />
        {!tab.url && !tab.loadError ? (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
            <Globe size={32} strokeWidth={1.75} aria-hidden="true" className="mb-2 text-[var(--color-text-tertiary)]" />
            <p className="text-[16px] font-medium text-[var(--color-text-primary)]">
              {t('workspace.browser.emptyTitle')}
            </p>
            <p className="text-[14px] text-[var(--color-text-secondary)]">
              {t('workspace.browser.emptyBody')}
            </p>
          </div>
        ) : null}
        {tab.loadError ? (
          <div
            role="alert"
            data-testid="workspace-browser-error"
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[var(--color-surface)] px-8 text-center"
          >
            <p className="text-[13px] font-medium text-[var(--color-text-primary)]">
              {t('workspace.browser.loadFailed', { url: tab.url ?? '' })}
            </p>
            <p className="max-w-[420px] text-[12px] text-[var(--color-text-secondary)]">
              {tab.loadError}
            </p>
            <button
              type="button"
              onClick={() => {
                useWorkspaceStore.getState().updateBrowserTab(sessionId, browserTabId, { loadError: null })
                if (ready) runNavigationCommand(() => workspaceBrowserHost.reload(browserTabId, { ignoreCache: true }))
                else setCreateAttempt((attempt) => attempt + 1)
              }}
              className="mt-1 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-1.5 text-[12px] text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            >
              {t('workspace.browser.retry')}
            </button>
          </div>
        ) : null}
      </div>

      <WorkspaceBrowserSelectionBar sessionId={sessionId} browserTabId={browserTabId} />
      <ConfirmDialog
        open={pendingNavigation !== null}
        onClose={() => setPendingNavigation(null)}
        onConfirm={async () => {
          const pending = pendingNavigation
          if (!pending) return
          await discardBrowserSelections(browserTabId)
          setPendingNavigation(null)
          pending.run()
        }}
        title={t('browser.selection.navigationTitle')}
        body={t('browser.selection.navigationBody', { count: selectionCount })}
        confirmLabel={t('browser.selection.navigationContinue')}
        cancelLabel={t('browser.selection.cancel')}
      />
      {panel !== null ? (
        <div
          ref={panelRef}
          data-testid={`workspace-browser-panel-${panel}`}
          className="absolute inset-x-0 bottom-0 top-[52px] z-[var(--z-raised)] flex flex-col border-t border-[var(--color-border)] bg-[var(--color-surface)]"
        >
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3">
            <span className="text-[12px] font-medium text-[var(--color-text-primary)]">
              {t(panel === 'downloads' ? 'workspace.browser.downloads' : 'workspace.browser.history')}
            </span>
            <IconButton
              icon={<X size={13} />}
              label={t('workspace.browser.closeOverlay')}
              size="2xs"
              tone="muted"
              onClick={() => setPanel(null)}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
            {panel === 'downloads' ? (
              downloads.length === 0 ? (
                <p className="px-2 py-3 text-[12px] text-[var(--color-text-tertiary)]">
                  {t('workspace.browser.downloadsEmpty')}
                </p>
              ) : (
                <ul className="space-y-0.5">
                  {downloads.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5"
                    >
                      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-primary)]">
                        {item.filename}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
                        {item.state === 'progressing' && item.totalBytes > 0
                          ? `${Math.round((item.receivedBytes / item.totalBytes) * 100)}%`
                          : formatBytes(item.receivedBytes)}
                      </span>
                      {item.state === 'completed' && item.savePath ? (
                        <IconButton
                          icon={<ExternalLink size={13} />}
                          label={t('workspace.browser.revealDownload')}
                          size="2xs"
                          tone="muted"
                          onClick={() => { void getDesktopHost().shell.openPath(item.savePath!) }}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )
            ) : (history ?? []).length === 0 ? (
              <p className="px-2 py-3 text-[12px] text-[var(--color-text-tertiary)]">
                {t('workspace.browser.historyEmpty')}
              </p>
            ) : (
              <ul className="space-y-0.5">
                {[...(history ?? [])].reverse().map((visit) => (
                  <li key={`${visit.url}-${visit.visitedAt}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setPanel(null)
                        navigate(visit.url)
                      }}
                      className="flex w-full flex-col items-start gap-0.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
                    >
                      <span className="w-full truncate text-[12px] text-[var(--color-text-primary)]">
                        {visit.title || visit.url}
                      </span>
                      <span className="w-full truncate font-mono text-[11px] text-[var(--color-text-tertiary)]">
                        {visit.url}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
