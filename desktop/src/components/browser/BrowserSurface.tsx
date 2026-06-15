import { useEffect, useLayoutEffect, useRef } from 'react'
import { Camera, Loader2, MousePointer2 } from 'lucide-react'
import { BrowserAddressBar } from './BrowserAddressBar'
import { computeWebviewBounds } from './computeWebviewBounds'
import { getServerBaseUrl, isLoopbackHostname } from '../../lib/desktopRuntime'
import { classifyPreviewLink } from '../../lib/previewLinkRouter'
import { isAbsoluteLocalPath, localFileUrl, previewFsUrl } from '../../lib/handlePreviewLink'
import { previewBridge } from '../../lib/previewBridge'
import { subscribePreviewEvents } from '../../lib/previewEvents'
import { useBrowserPanelStore } from '../../stores/browserPanelStore'
import { useOverlayStore } from '../../stores/overlayStore'
import { useTranslation } from '../../i18n'

const LOCAL_PREVIEW_PATH_PREFIXES = ['/preview-fs/', '/local-file/']
const LOCAL_PREVIEW_READY_TIMEOUT_MS = 2500

function shouldWaitForLocalPreview(url: string): boolean {
  try {
    const parsed = new URL(url)
    return isLoopbackHostname(parsed.hostname) &&
      LOCAL_PREVIEW_PATH_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix))
  } catch {
    return false
  }
}

async function waitForLocalPreview(url: string): Promise<void> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), LOCAL_PREVIEW_READY_TIMEOUT_MS)
  try {
    await fetch(url, {
      method: 'HEAD',
      cache: 'no-store',
      signal: controller.signal,
    })
  } catch {
    // Best-effort warmup only. The native webview still navigates so users can
    // see the server's own error page or use Reload if the first probe raced.
  } finally {
    window.clearTimeout(timeout)
  }
}

function resolveBrowserNavigationUrl(input: string, sessionId: string): string {
  const value = input.trim()
  if (!value) return ''

  const classified = classifyPreviewLink(value)
  if (classified.kind === 'browser-file' && classified.path) {
    const serverBaseUrl = getServerBaseUrl()
    return isAbsoluteLocalPath(classified.path)
      ? localFileUrl(serverBaseUrl, classified.path)
      : previewFsUrl(serverBaseUrl, sessionId, classified.path)
  }

  return value
}

export function BrowserSurface({ sessionId }: { sessionId: string }) {
  const t = useTranslation()
  const hostRef = useRef<HTMLDivElement>(null)
  const loadSeqRef = useRef(0)
  const session = useBrowserPanelStore((s) => s.bySession[sessionId])
  const store = useBrowserPanelStore.getState()
  const overlayCount = useOverlayStore((s) => s.count)

  const reportBounds = () => {
    const el = hostRef.current
    if (!el) return
    previewBridge.setBounds(computeWebviewBounds(el.getBoundingClientRect()))
  }

  const loadNativePreview = (
    url: string,
    action: () => Promise<void>,
  ) => {
    const seq = loadSeqRef.current + 1
    loadSeqRef.current = seq
    void (async () => {
      if (shouldWaitForLocalPreview(url)) {
        await waitForLocalPreview(url)
      }
      if (loadSeqRef.current !== seq) return
      await action()
    })().catch(() => {
      if (loadSeqRef.current === seq) {
        useBrowserPanelStore.getState().setLoading(sessionId, false)
      }
    })
  }

  useLayoutEffect(() => {
    const el = hostRef.current
    if (el && session?.url) {
      const bounds = computeWebviewBounds(el.getBoundingClientRect())
      const url = session.url
      loadNativePreview(url, () => previewBridge.open(url, bounds))
    }
    return () => {
      loadSeqRef.current += 1
      previewBridge.close()
    }
    // The visibility-sync effect below owns setVisible() — including the
    // initial reveal — so it always factors in overlayCount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Visibility-sync: a fullscreen DOM overlay (e.g. ImageGalleryModal) would
  // otherwise be partially covered by the native child webview, which always
  // renders above the DOM. While overlayCount > 0 we hide the webview; when
  // it returns to 0 (and we're still mounted in browser mode) we re-show it.
  // The layout-effect teardown above still closes the webview on unmount.
  useEffect(() => {
    if (!session) return
    previewBridge.setVisible(overlayCount === 0)
  }, [overlayCount, session])

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const ro = new ResizeObserver(() => reportBounds())
    ro.observe(el)
    window.addEventListener('resize', reportBounds)
    return () => { ro.disconnect(); window.removeEventListener('resize', reportBounds) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    let unsub: (() => void) | undefined
    void subscribePreviewEvents(sessionId).then((u) => { unsub = u })
    return () => { unsub?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // 兜底：navigated/ready 依赖注入脚本，若外站 CSP 拦截则永不回灌。loading 变 true 后 ~15s 强制收尾。
  const isLoading = session?.loading ?? false
  const currentUrl = session?.url
  useEffect(() => {
    if (!isLoading) return
    const timer = window.setTimeout(() => {
      useBrowserPanelStore.getState().setLoading(sessionId, false)
    }, 15000)
    return () => window.clearTimeout(timer)
  }, [isLoading, currentUrl, sessionId])

  if (!session) return null

  const openOrNavigate = (inputUrl: string) => {
    const url = resolveBrowserNavigationUrl(inputUrl, sessionId)
    if (!url) return
    const current = useBrowserPanelStore.getState().bySession[sessionId]
    store.navigate(sessionId, url)
    if (current?.url) {
      loadNativePreview(url, () => previewBridge.navigate(url))
      return
    }
    const el = hostRef.current
    if (el) {
      const bounds = computeWebviewBounds(el.getBoundingClientRect())
      loadNativePreview(url, () => previewBridge.open(url, bounds))
    } else {
      loadNativePreview(url, () => previewBridge.navigate(url))
    }
  }

  const actionButtonClass = [
    'inline-flex h-8 w-8 items-center justify-center rounded-full border transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]',
  ].join(' ')

  const previewActions = (
    <>
      <button
        aria-label={t('browser.screenshot')}
        title={t('browser.screenshot')}
        className={[
          actionButtonClass,
          'border-transparent text-[var(--color-text-secondary)] hover:border-[var(--color-border)]',
          'hover:bg-[var(--color-surface-container-low)] hover:text-[var(--color-text-primary)]',
        ].join(' ')}
        onClick={() => previewBridge.message({ v: 1, type: 'capture', kind: 'full' })}
      >
        <Camera size={16} />
      </button>
      <button
        aria-label={t('browser.selectElement')}
        aria-pressed={Boolean(session.pickerActive)}
        title={t('browser.selectElement')}
        className={[
          actionButtonClass,
          session.pickerActive
            ? 'border-[var(--color-brand)]/45 bg-[var(--color-surface-selected)] text-[var(--color-brand)]'
            : 'border-transparent text-[var(--color-text-secondary)] hover:border-[var(--color-border)] hover:bg-[var(--color-surface-container-low)] hover:text-[var(--color-text-primary)]',
        ].join(' ')}
        onClick={() => {
          const cur = useBrowserPanelStore.getState().bySession[sessionId]
          const next = !cur?.pickerActive
          store.setPicker(sessionId, next)
          previewBridge.message({ v: 1, type: next ? 'enter-picker' : 'exit-picker' })
        }}
      >
        <MousePointer2 size={16} />
      </button>
    </>
  )

  return (
    <div className="flex h-full flex-col">
      <BrowserAddressBar
        url={session.url}
        canGoBack={session.canGoBack}
        canGoForward={session.canGoForward}
        loading={session.loading}
        onNavigate={openOrNavigate}
        onBack={() => {
          store.goBack(sessionId)
          store.setLoading(sessionId, true)
          const url = useBrowserPanelStore.getState().bySession[sessionId]!.url
          loadNativePreview(url, () => previewBridge.navigate(url))
        }}
        onForward={() => {
          store.goForward(sessionId)
          store.setLoading(sessionId, true)
          const url = useBrowserPanelStore.getState().bySession[sessionId]!.url
          loadNativePreview(url, () => previewBridge.navigate(url))
        }}
        onReload={() => {
          if (!session.url) return
          store.setLoading(sessionId, true)
          loadNativePreview(session.url, () => previewBridge.navigate(session.url))
        }}
        rightActions={previewActions}
      />
      <div ref={hostRef} className="relative flex-1 overflow-hidden" data-testid="preview-host">
        {session.loading && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[var(--color-surface)] text-[var(--color-text-tertiary)]">
            <Loader2 size={18} className="animate-spin" aria-label="加载中" />
          </div>
        )}
      </div>
    </div>
  )
}
