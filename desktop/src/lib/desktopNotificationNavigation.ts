import { useChatStore } from '../stores/chatStore'
import { useSessionStore } from '../stores/sessionStore'
import { SCHEDULED_TAB_ID, useTabStore } from '../stores/tabStore'
import {
  installDesktopNotificationClickListener,
  type DesktopNotificationTarget,
} from './desktopNotifications'

const SCHEDULED_TAB_TITLE = 'Scheduled Tasks'

export function openDesktopNotificationTarget(target: DesktopNotificationTarget): void {
  if (target.type === 'scheduled') {
    useTabStore.getState().openTab(SCHEDULED_TAB_ID, SCHEDULED_TAB_TITLE, 'scheduled')
    return
  }

  const knownTitle = useSessionStore
    .getState()
    .sessions
    .find((session) => session.id === target.sessionId)
    ?.title
  useTabStore.getState().openTab(target.sessionId, target.title || knownTitle || 'Session', 'session')
  useChatStore.getState().connectToSession(target.sessionId)
}

export function installDesktopNotificationNavigation(): Promise<() => void> {
  return installDesktopNotificationClickListener(openDesktopNotificationTarget)
}
