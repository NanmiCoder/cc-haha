/**
 * Shared between the renderer, which creates each page's `<webview>`, and the
 * Electron host, which only adopts guests that match this contract.
 */

/**
 * One persistent partition for every workspace browser page of this user.
 *
 * Codex does the same with `persist:codex-browser-app`: a login performed in
 * one tab has to be there in the next one. The per-tab `storageId` is a *page
 * restore identity* — which page to reopen after a restart — and must never be
 * turned into a partition name, or every tab would get its own cookie jar.
 */
export const WORKSPACE_BROWSER_PARTITION = 'persist:cc-haha-browser-app'

/**
 * A `<webview>` creates no guest until it has a `src`. The renderer always
 * starts from this document and the host performs every real navigation, so a
 * renderer never chooses what a page loads by writing an attribute.
 */
export const WORKSPACE_BROWSER_INITIAL_SRC = 'about:blank'
