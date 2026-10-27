import { useEffect, useRef } from 'react'
import { AppState, Platform } from 'react-native'
import { router, useRootNavigationState } from 'expo-router'
import * as Notifications from 'expo-notifications'
import { AndroidImportance } from 'expo-notifications'
import { usePushRegistration } from './PushRegistrationContext'
import { useApp } from './AppContext'
import { usePreferences } from './PreferencesContext'
import { useDashboard } from './DashboardContext'
import { routeNotificationResponse } from '../core/notifications'
import { NotificationFallback } from '../core/notificationFallback'

/** System buttons always open the app and revalidate the exact pending request. */
export function NotificationBridge() {
  const { registry, ready } = useApp()
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
      handleNotification: async () => ({
        shouldShowBanner: AppState.currentState !== 'active',
        shouldShowList: true,
        shouldPlaySound: AppState.currentState !== 'active',
        shouldSetBadge: false,
      }),
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
      Platform.OS === 'android'
        ? Notifications.setNotificationChannelAsync('cc-haha', {
            name: '任务与审批',
            importance: AndroidImportance.HIGH,
          })
        : Promise.resolve(),
    ]).catch(() => {})
  }, [])
  useEffect(() => {
    if (Platform.OS === 'web' || !ready || !navigation?.key) return
    let active = true
    const hostIds = new Set(registry.hosts.map((host) => host.id))
    function respond(response: Notifications.NotificationResponse | null) {
      if (!active || !response) return
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
  }, [registry.hosts, ready, navigation?.key])
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
            trigger: null,
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
