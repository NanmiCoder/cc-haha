/**
 * Virtualized rows unmount when they scroll out of the window. Disclosure
 * state would otherwise be lost with the unmounted component and the row would
 * change height on its way back in — which is exactly the scroll jump this
 * module exists to prevent. Keys are stable per logical row; eviction is FIFO.
 */

const MAX_ENTRIES = 4096
const store = new Map<string, boolean>()

export function getDisclosure(key: string): boolean | undefined {
  return store.get(key)
}

export function setDisclosure(key: string, open: boolean) {
  if (store.has(key)) store.delete(key)
  else if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value!)
  store.set(key, open)
}

/** Test-only: clear between specs. */
export function clearDisclosureMemory() {
  store.clear()
}
