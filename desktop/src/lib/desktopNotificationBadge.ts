import { translate, type Locale } from '../i18n'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { getDesktopHost } from './desktopHost'
import { getDesktopNotificationPlatform } from './desktopNotifications'
import { collectAttentionIds } from './sessionAttention'

export function installDesktopNotificationBadge() {
  const host = getDesktopHost()
  const platform = getDesktopNotificationPlatform()
  if (host.kind !== 'electron' || (platform !== 'darwin' && platform !== 'win32')) return

  let lastBadge: { count: number; locale: Locale } | undefined
  function sync() {
    const { sessions, unreadCompletions } = useChatStore.getState()
    const { desktopNotificationsEnabled, locale } = useSettingsStore.getState()
    const count = desktopNotificationsEnabled
      ? unreadCompletions.size + collectAttentionIds(sessions).filter(id => !unreadCompletions.has(id)).length
      : 0
    if (count === lastBadge?.count && lastBadge.locale === locale) return
    const description = count ? translate(locale, 'notifications.badgeDescription', { count }) : ''
    const badge = { count, locale }
    lastBadge = badge
    void host.commands.invoke<boolean>('set_notification_badge', { count, description }).then(applied => {
      if (!applied && lastBadge === badge) lastBadge = undefined
    }).catch(error => {
      if (lastBadge === badge) lastBadge = undefined
      console.warn('[desktopNotifications] failed to update application badge:', error)
    })
  }

  sync()
  const unsubscribeChat = useChatStore.subscribe((state, previous) => {
    if (state.sessions !== previous.sessions || state.unreadCompletions !== previous.unreadCompletions) sync()
  })
  const unsubscribeSettings = useSettingsStore.subscribe((state, previous) => {
    if (state.desktopNotificationsEnabled !== previous.desktopNotificationsEnabled || state.locale !== previous.locale) sync()
  })
  return () => {
    unsubscribeChat()
    unsubscribeSettings()
  }
}
