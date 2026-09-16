import { useEffect, useRef } from 'react'
import {
  detectPlatform,
  matchWorkspaceShortcut,
  type WorkspaceFocusContext,
  type WorkspaceShortcutAction,
} from '../lib/workspace/shortcuts'
import { workspaceOpen } from '../lib/workspace/openTarget'
import { useWorkspaceStore } from '../stores/workspaceStore'

/**
 * Decide what the keystroke belongs to from where it happened.
 *
 * A terminal is the case that matters: it is a DOM element the app owns, so the
 * app receives its keys and has to hand the reserved ones back. Native browser
 * keys arrive through the host bridge with their source page identity.
 */
function focusContext(): WorkspaceFocusContext {
  const active = document.activeElement
  if (!active) return 'other'
  if (active.closest('[data-testid^="workspace-terminal-host"]')) return 'terminal'
  if (active.closest('[data-testid="workspace-review-toolbar"]')) return 'review'
  if (active.closest('[data-testid="workspace-browser-stage"]')) return 'browser'
  if (active.closest('[data-testid="workspace-file-header"]')) return 'file'
  return 'chat'
}

export type WorkspaceShortcutContext = {
  sessionId: string | null
  cwd: string
  enabled: boolean
}

export function useWorkspaceShortcuts({ sessionId, cwd, enabled }: WorkspaceShortcutContext) {
  // The handler is registered once and reads the latest context through a ref,
  // so switching tasks does not detach and re-attach a document listener.
  const contextRef = useRef({ sessionId, cwd, enabled })
  contextRef.current = { sessionId, cwd, enabled }

  useEffect(() => {
    const platform = detectPlatform()

    const execute = (action: WorkspaceShortcutAction, sourceTabId?: string): boolean => {
      const { sessionId: session, cwd: workDir, enabled: active } = contextRef.current
      if (!active || !session) return false

      const store = useWorkspaceStore.getState()
      if (sourceTabId) {
        const owner = store.findBrowserTabOwner(sourceTabId)
        const workspace = store.getSession(session)
        if (!owner || owner.sessionId !== session || workspace.layout === 'hidden' || workspace.activeSideTabId !== owner.tabId) return false
      }
      switch (action) {
        case 'quick-open-file':
          workspaceOpen.file(session, '', { preview: true })
          window.dispatchEvent(new CustomEvent('workspace-quick-open', { detail: { sessionId: session } }))
          break
        case 'new-browser-tab':
          workspaceOpen.browser(session)
          break
        case 'open-review':
          workspaceOpen.review(session)
          break
        // Terminal defaults to the bottom dock; panel visibility is a distinct command.
        case 'toggle-terminal':
        case 'toggle-bottom-panel':
          store.toggleBottomPanel(session, workDir)
          break
        case 'new-terminal':
          workspaceOpen.terminal(session, workDir, { dock: 'bottom' })
          break
        case 'toggle-workspace':
          store.toggleWorkspace(session)
          break
        case 'toggle-fullscreen':
          store.toggleFullscreen(session)
          break
        case 'reopen-closed-tab':
          store.reopenClosedTab(session)
          break
        case 'close-tab': {
          const activeSideTabId = store.getSession(session).activeSideTabId
          // Empty workspace is a no-op; it must never hide the main window.
          if (!activeSideTabId) return false
          store.closeTab(session, activeSideTabId)
          break
        }
        case 'next-tab':
        case 'previous-tab': {
          const tabs = store.getTabs(session, 'side')
          if (tabs.length < 2) return false
          const current = tabs.findIndex((tab) => tab.id === store.getSession(session).activeSideTabId)
          const step = action === 'next-tab' ? 1 : -1
          const next = tabs[(current + step + tabs.length) % tabs.length]
          if (next) store.activateTab(session, next.id)
          break
        }
      }

      return true
    }

    const handler = (event: KeyboardEvent) => {
      const action = matchWorkspaceShortcut(event, { platform, context: focusContext() })
      if (action && execute(action)) event.preventDefault()
    }
    const nativeHandler = (event: Event) => {
      const { action, tabId } = (event as CustomEvent<{ action: WorkspaceShortcutAction, tabId: string }>).detail
      // An empty source denotes an explicit native menu click. Keyboard W in
      // the main renderer skips that accelerator and still reaches its terminal.
      execute(action, tabId)
    }

    document.addEventListener('keydown', handler)
    window.addEventListener('workspace-native-shortcut', nativeHandler)
    return () => {
      document.removeEventListener('keydown', handler)
      window.removeEventListener('workspace-native-shortcut', nativeHandler)
    }
  }, [])
}
