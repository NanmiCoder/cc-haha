declare global {
  interface Window {
    /** Storages index.html replaced with in-memory ones because the browser denied them. */
    __CC_HAHA_MEMORY_STORAGE__?: string[]
  }
}

/**
 * Whether localStorage outlives this page. False only when the browser denied
 * web storage and index.html swapped in an in-memory one, so anything written
 * now (the H5 token, settings) is gone after a reload or navigation.
 */
export function isLocalStoragePersistent(win: Pick<Window, '__CC_HAHA_MEMORY_STORAGE__'> | undefined =
  typeof window === 'undefined' ? undefined : window): boolean {
  return !win?.__CC_HAHA_MEMORY_STORAGE__?.includes('localStorage')
}
