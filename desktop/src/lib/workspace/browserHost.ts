import { getDesktopHost } from '../desktopHost'
import { usePreviewSelectionStore } from '../../stores/previewSelectionStore'
import type {
  WorkspaceBrowserBounds,
  WorkspaceBrowserCaptureKind,
  WorkspaceBrowserEvent,
  WorkspaceBrowserFindOptions,
  WorkspaceBrowserMenuAction,
  WorkspaceBrowserMenuOptions,
} from '../desktopHost/types'
import type { PreviewHostMessage } from '../desktopHost'

/**
 * Renderer-side facade over the multi-page browser host.
 *
 * Every call names the page it targets. That is the whole difference from the
 * old singleton `previewBridge`: with one implicit page, showing a second link
 * silently navigated the first, and unmounting the React surface closed it.
 * Here React unmounting only stops *drawing* a page — the page dies when its
 * tab is closed, and nothing else.
 *
 * On hosts without a native browser (plain desktop browser, H5) every method
 * resolves to a typed failure instead of a silent success, so callers can show
 * a real "open externally" fallback rather than an empty frame.
 */

export type WorkspaceBrowserResult = { ok: true } | { ok: false; reason: 'unsupported' }

const UNSUPPORTED: WorkspaceBrowserResult = { ok: false, reason: 'unsupported' }
const OK: WorkspaceBrowserResult = { ok: true }

function host() {
  const desktop = getDesktopHost()
  return desktop.capabilities.workspaceBrowser ? desktop.browser : null
}

export function isWorkspaceBrowserAvailable(): boolean {
  return host() !== null
}

async function call(
  run: (api: NonNullable<ReturnType<typeof host>>) => Promise<unknown>,
): Promise<WorkspaceBrowserResult> {
  const api = host()
  if (!api) return UNSUPPORTED
  await run(api)
  return OK
}

export const workspaceBrowserHost = {
  showMenu: (tabId: string, options: WorkspaceBrowserMenuOptions): Promise<WorkspaceBrowserMenuAction | null> => {
    const api = host()
    return api ? api.showMenu(tabId, options) : Promise.resolve(null)
  },
  create: (
    tabId: string,
    options: { storageId: string; url?: string; bounds?: WorkspaceBrowserBounds; visible?: boolean },
  ) => call((api) => api.create(tabId, options)),
  navigate: (tabId: string, url: string) => call((api) => api.navigate(tabId, url)),
  goBack: (tabId: string) => call((api) => api.goBack(tabId)),
  goForward: (tabId: string) => call((api) => api.goForward(tabId)),
  reload: (tabId: string, options?: { ignoreCache?: boolean }) =>
    call((api) => api.reload(tabId, options)),
  stop: (tabId: string) => call((api) => api.stop(tabId)),
  setBounds: (tabId: string, bounds: WorkspaceBrowserBounds) =>
    call((api) => api.setBounds(tabId, bounds)),
  setVisible: (tabId: string, visible: boolean) => call((api) => api.setVisible(tabId, visible)),
  setZoom: (tabId: string, factor: number) => call((api) => api.setZoom(tabId, factor)),
  find: (tabId: string, text: string, options?: WorkspaceBrowserFindOptions) =>
    call((api) => api.find(tabId, text, options)),
  stopFind: (tabId: string) => call((api) => api.stopFind(tabId)),
  capture: (tabId: string, kind: WorkspaceBrowserCaptureKind) =>
    call((api) => api.capture(tabId, kind)),
  snapshot: async (tabId: string): Promise<string | null> => {
    const api = host()
    return api ? api.snapshot(tabId) : null
  },
  message: (tabId: string, payload: PreviewHostMessage) =>
    call((api) => api.message(tabId, payload)),
  close: (tabId: string) => call((api) => api.close(tabId)),
  printToPdf: (tabId: string) => call((api) => api.printToPdf(tabId)),
}

/**
 * Fire-and-forget release used by the tab controller. Closing a page must not
 * be able to reject the close of its tab: a host that already discarded the
 * page (crash, window teardown) still has to let the UI forget about it.
 */
export function releaseWorkspaceBrowserTab(browserTabId: string): void {
  usePreviewSelectionStore.getState().clear(browserTabId)
  void workspaceBrowserHost.close(browserTabId).catch(() => {})
}

export async function subscribeWorkspaceBrowserEvents(
  handler: (event: WorkspaceBrowserEvent) => void,
): Promise<() => void> {
  const api = host()
  if (!api) return () => {}
  return api.onEvent(handler)
}
