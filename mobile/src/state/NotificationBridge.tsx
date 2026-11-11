import { useEffect, useRef } from 'react'
import { AppState, Platform } from 'react-native'
import { router, useRootNavigationState } from 'expo-router'
import * as Notifications from 'expo-notifications'
import { channelTriggerFor } from './channelIds'
import { ensureNotificationChannel } from './notificationChannel'
import { notificationPresentation } from './notificationPresentation'
import { usePushRegistration } from './PushRegistrationContext'
import { useApp } from './AppContext'
import { usePreferences } from './PreferencesContext'
import { useDashboard } from './DashboardContext'
import {
  hostUrlUpdate,
  notificationRequestData,
  routeNotificationResponse,
} from '../core/notifications'
import { NotificationFallback } from '../core/notificationFallback'
import { foregroundTransitions } from '../core/appVisibility'
import { applyHostUrlUpdate } from '../core/hostRelocator'

/**
 * Applies a computer's new-address notification (verified with that computer's
 * credential) and clears it from the notification center once it is handled.
 */
async function applyHostUrlNotification(
  request: Notifications.NotificationRequest,
  target: Parameters<typeof applyHostUrlUpdate>[1]
) {
  const update = hostUrlUpdate(request)
  if (!update) return
  const result = await applyHostUrlUpdate(update, target).catch(() => 'ignored' as const)
  if (result !== 'ignored')
    await Notifications.dismissNotificationAsync(request.identifier).catch(() => {})
}

/** System buttons always open the app and revalidate the exact pending request. */
export function NotificationBridge() {
  const { registry, ready, credential, relocate } = useApp()
  const navigation = useRootNavigationState()
  const {
    preferences,
    ready: preferencesReady,
    error: preferencesError,
  } = usePreferences()
  const { snapshot, fresh } = useDashboard()
  const push = usePushRegistration(snapshot?.hostId)
  const fallback = useRef(new NotificationFallback())
  const handled = useRef(new Set<string>())
  useEffect(() => {
    if (Platform.OS === 'web') return
    Notifications.setNotificationHandler({
      handleNotification: async (notification) =>
        notificationPresentation(
          AppState.currentState === 'active',
          notificationRequestData(notification.request) ?? notification.request.content.data
        ),
    })
    void Promise.all([
      Notifications.setNotificationCategoryAsync('cchahaTool', [
        {
          identifier: 'deny',
          buttonTitle: '拒绝',
          options: {
            opensAppToForeground: true,
            isAuthenticationRequired: true,
          },
        },
        {
          identifier: 'allow',
          buttonTitle: '允许',
          options: {
            opensAppToForeground: true,
            isAuthenticationRequired: true,
          },
        },
      ]),
      Notifications.setNotificationCategoryAsync('cchahaDecision', [
        {
          identifier: 'open',
          buttonTitle: '查看并处理',
          options: { opensAppToForeground: true },
        },
      ]),
      Notifications.setNotificationCategoryAsync('cchahaResult', [
        {
          identifier: 'open',
          buttonTitle: '查看结果',
          options: { opensAppToForeground: true },
        },
      ]),
      ensureNotificationChannel(),
    ]).catch(() => {})
  }, [])
  useEffect(() => {
    if (Platform.OS === 'web' || !ready || !navigation?.key) return
    let active = true
    const hostIds = new Set(registry.hosts.map((host) => host.id))
    function respond(response: Notifications.NotificationResponse | null) {
      if (!active || !response) return
      const request = response.notification.request
      if (hostUrlUpdate(request)) {
        // A computer's new address is applied, never opened like a chat.
        const key = `${request.identifier}:${response.actionIdentifier}`
        if (!handled.current.has(key)) {
          handled.current.add(key)
          void applyHostUrlNotification(request, { hosts: registry.hosts, credential, relocate })
        }
        Notifications.clearLastNotificationResponse()
        return
      }
      const routed = routeNotificationResponse(response, {
        ready: true,
        hostIds,
        handled: handled.current,
        open: (target) => router.push({
          pathname: '/chat/[id]',
          params: {
            id: target.sessionId,
            host: target.hostId,
            ...(target.requestId ? { requestId: target.requestId } : {}),
            ...(target.action ? { notificationAction: target.action } : {}),
          },
        }),
      })
      if (routed) Notifications.clearLastNotificationResponse()
    }
    const subscription =
      Notifications.addNotificationResponseReceivedListener(respond)
    respond(Notifications.getLastNotificationResponse())
    return () => {
      active = false
      subscription.remove()
    }
  }, [registry.hosts, ready, navigation?.key, credential, relocate])
  // A computer's new public address: applied as it arrives while the app is open,
  // and for any still in the notification center at launch or on coming back.
  useEffect(() => {
    if (Platform.OS === 'web' || !ready) return
    const target = { hosts: registry.hosts, credential, relocate }
    const sweep = async () => {
      const presented = await Notifications.getPresentedNotificationsAsync().catch(() => [])
      // Oldest first, so the newest address is the one that stays.
      for (const notification of [...presented].sort((a, b) => a.date - b.date))
        await applyHostUrlNotification(notification.request, target)
    }
    const received = Notifications.addNotificationReceivedListener((notification) => {
      void applyHostUrlNotification(notification.request, target)
    })
    const transition = foregroundTransitions(AppState.currentState)
    const listener = AppState.addEventListener('change', (state) => {
      if (transition(state) === 'returned') void sweep()
    })
    void sweep()
    return () => {
      received.remove()
      listener.remove()
    }
  }, [ready, registry.hosts, credential, relocate])
  useEffect(() => {
    if (
      Platform.OS === 'web' ||
      !snapshot ||
      !fresh ||
      !preferencesReady ||
      preferencesError
    )
      return
    const host = registry.hosts.find((item) => item.id === snapshot.hostId)
    if (!host) return
    const currentFallback = fallback.current
    void currentFallback
      .observe(snapshot, push?.status, preferences, {
        permitted: async () => (await Notifications.getPermissionsAsync()).granted,
        schedule: (event) =>
          Notifications.scheduleNotificationAsync({
            identifier: `${snapshot.hostId}:${event.key}`,
            content: {
              title:
                snapshot.sessions.find(
                  (session) => session.id === event.sessionId
                )?.title || host.name,
              subtitle: host.name,
              body: event.preview,
              categoryIdentifier: event.category,
              sound: 'default',
              data: {
                hostId: snapshot.hostId,
                sessionId: event.sessionId,
                requestId: event.requestId ?? '',
                eventType: event.kind,
              },
            },
            trigger: channelTriggerFor(Platform.OS, event.kind),
          }),
      })
      .catch(() => {})
    return () => currentFallback.cancel()
  }, [
    snapshot,
    fresh,
    registry.hosts,
    preferences,
    preferencesReady,
    preferencesError,
    push?.status,
  ])
  return null
}
