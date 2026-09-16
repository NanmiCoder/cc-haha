import { useWorkspaceStore } from '../../stores/workspaceStore'
import {
  hydrateWorkspace,
  readWorkspaceStorage,
  serializeWorkspace,
  writeWorkspaceStorage,
} from './persistence'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

let resourceCounter = 0
function makeResourceId(prefix: string) {
  resourceCounter += 1
  return `${prefix}-restored-${resourceCounter.toString(36)}`
}

/**
 * Load the persisted workspace and keep writing it back.
 *
 * Writes are debounced through a microtask-free timer because the controller
 * emits a state update for every activation and every focus request; without it
 * a drag across a tab strip would serialize on each pointer move.
 */
export function initWorkspacePersistence(
  storage: StorageLike | null = defaultStorage(),
  options: { debounceMs?: number } = {},
): () => void {
  const debounceMs = options.debounceMs ?? 250
  const restored = hydrateWorkspace(readWorkspaceStorage(storage), makeResourceId)
  useWorkspaceStore.setState({
    bySession: restored.bySession,
    sideWidth: restored.sideWidth,
    bottomHeight: restored.bottomHeight,
  })

  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    timer = null
    const state = useWorkspaceStore.getState()
    writeWorkspaceStorage(
      storage,
      serializeWorkspace(state.bySession, {
        sideWidth: state.sideWidth,
        bottomHeight: state.bottomHeight,
      }),
    )
  }

  const unsubscribe = useWorkspaceStore.subscribe(() => {
    if (timer !== null) return
    timer = setTimeout(flush, debounceMs)
  })

  // Quitting inside the coalescing window would otherwise lose the last change:
  // the timer dies with the renderer and the tab the user just closed is back
  // on next launch. `pagehide` fires for both a reload and a window teardown.
  const flushPending = () => {
    if (timer === null) return
    clearTimeout(timer)
    flush()
  }
  const hasWindow = typeof window !== 'undefined'
  if (hasWindow) window.addEventListener('pagehide', flushPending)

  return () => {
    if (hasWindow) window.removeEventListener('pagehide', flushPending)
    flushPending()
    unsubscribe()
  }
}
