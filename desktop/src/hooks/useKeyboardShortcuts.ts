import { useEffect, useRef } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useTabStore } from '../stores/tabStore'
import { useUIStore } from '../stores/uiStore'
import {
  getAppZoomKeyboardAction,
  nextAppZoomLevel,
} from '../lib/appZoom'
import { useSettingsStore } from '../stores/settingsStore'
import { hasRunningSubagentTasks } from '../lib/backgroundTasks'
import { detectPlatform } from '../lib/workspace/shortcuts'

export function useKeyboardShortcuts() {
  const openModal = useUIStore((s) => s.openModal)
  const closeModal = useUIStore((s) => s.closeModal)
  const activeModal = useUIStore((s) => s.activeModal)
  const stopGeneration = useChatStore((s) => s.stopGeneration)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const canStopActiveSession = useChatStore((s) => {
    const session = activeTabId ? s.sessions[activeTabId] : undefined
    return Boolean(
      session &&
      (session.chatState !== 'idle' || hasRunningSubagentTasks(session.backgroundAgentTasks)),
    )
  })
  const uiZoom = useSettingsStore((s) => s.uiZoom)
  const setUiZoom = useSettingsStore((s) => s.setUiZoom)

  const activeModalRef = useRef(activeModal)
  activeModalRef.current = activeModal
  const canStopActiveSessionRef = useRef(canStopActiveSession)
  canStopActiveSessionRef.current = canStopActiveSession
  const activeTabIdRef = useRef(activeTabId)
  activeTabIdRef.current = activeTabId
  const appZoomLevelRef = useRef(uiZoom)
  appZoomLevelRef.current = uiZoom

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const zoomAction = getAppZoomKeyboardAction(e)
      if (zoomAction) {
        e.preventDefault()
        const nextZoom = nextAppZoomLevel(appZoomLevelRef.current, zoomAction)
        appZoomLevelRef.current = nextZoom
        setUiZoom(nextZoom)
        return
      }

      const meta = e.metaKey || e.ctrlKey

      // Cmd+N — what the sidebar's "New session" item does (it shows ⌘N).
      // Cmd only on macOS: Ctrl+N is "next line" in a macOS text field.
      const newSessionChord = detectPlatform() === 'mac' ? e.metaKey && !e.ctrlKey : e.ctrlKey
      if (newSessionChord && e.key === 'n' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        useUIStore.getState().requestNewSession()
      }

      // Cmd+K — Open global session search
      if (meta && e.key === 'k') {
        e.preventDefault()
        openModal('globalSearch')
      }

      // Ctrl+F — Open find-in-page bar
      if (meta && e.key === 'f') {
        e.preventDefault()
        openModal('findInPage')
      }

      // Escape — Close modal or clear state
      if (e.key === 'Escape') {
        if (activeModalRef.current) {
          closeModal()
        }
      }

      // Cmd+. — Stop generation
      if (meta && e.key === '.') {
        if (canStopActiveSessionRef.current && activeTabIdRef.current) {
          e.preventDefault()
          stopGeneration(activeTabIdRef.current)
        }
      }
    }

    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [closeModal, openModal, setUiZoom, stopGeneration])
}
