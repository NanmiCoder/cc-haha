import { useCallback, useState } from 'react'
import { BackHandler, Platform, ScrollView, View } from 'react-native'
import { Redirect, useFocusEffect } from 'expo-router'
import * as Notifications from 'expo-notifications'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useApp } from '../state/AppContext'
import { usePreferences } from '../state/PreferencesContext'
import { ensureNotificationChannel } from '../state/notificationChannel'
import {
  continueNotifyPrompt,
  emitPermissionDecided,
} from '../state/notifyPromptGate'
import { LockPreview } from '../ui/onboarding/LockPreview'
import { Text } from '../ui/Text'
import { Button, Icon, ScreenView, goBack, useColors } from '../ui/kit'
import { isH5 } from '../state/h5'

/** Push notifications are native app only; the web version connects only to the computer that opened it, so go straight home. */
export default function NotifyPrimeRoute() {
  return isH5 ? <Redirect href="/" /> : <NotifyPrime />
}

/**
 * The "Turn on notifications" onboarding page after connecting a computer (Apple HIG pre-permission page): 
 * only a single Continue, which then shows the system prompt; allow or deny both go home, and denying does not block usage.
 */
function NotifyPrime() {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const { registry } = useApp()
  const { update } = usePreferences()
  const [busy, setBusy] = useState(false)
  const host =
    registry.hosts.find((item) => item.id === registry.selectedId) ??
    registry.hosts[0]
  const hostName = host?.name ?? 'computer'

  // Can only leave via Continue: swallow the Android back key (iOS gesture is disabled in Stack options).
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') return
      const subscription = BackHandler.addEventListener(
        'hardwareBackPress',
        () => true
      )
      return () => subscription.remove()
    }, [])
  )

  async function proceed() {
    if (busy) return
    setBusy(true)
    await continueNotifyPrompt({
      ensureChannel: ensureNotificationChannel,
      request: () => Notifications.requestPermissionsAsync(),
      markPrompted: () => update({ notifyPrompted: true }),
      decided: emitPermissionDecided,
    })
    // The onboarding page sits on top of home, so go back to the layer below; if there is none (deep link) replace with home.
    goBack()
  }

  return (
    <ScreenView>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 22 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name="circle-check" size={17} color={colors.ok} strokeWidth={2.2} />
          <Text
            numberOfLines={1}
            style={{ flexShrink: 1, color: colors.ok, fontSize: 14, fontWeight: '500' }}
          >
            Connected {hostName}
          </Text>
        </View>
        <Text
          accessibilityRole="header"
          style={{
            marginTop: 14,
            color: colors.ink,
            fontSize: 26,
            lineHeight: 33,
            fontWeight: '700',
            letterSpacing: -0.3,
          }}
        >
          Get pinged when you need to decide
        </Text>
        <Text
          style={{
            marginTop: 10,
            color: colors.ink2,
            fontSize: 15,
            lineHeight: 23,
          }}
        >
          Commands needing your approval, plans awaiting confirmation, and tasks that finish or fail are all pushed to the lock screen. You can change which ones alert you anytime in Settings.
        </Text>
        <View style={{ marginTop: 26, marginBottom: 20 }}>
          <LockPreview hostName={hostName} />
        </View>
      </ScrollView>
      <View
        style={{
          paddingHorizontal: 24,
          paddingTop: 8,
          paddingBottom: Math.max(insets.bottom, 20),
        }}
      >
        <Text
          style={{
            paddingBottom: 14,
            color: colors.ink3,
            fontSize: 13,
            lineHeight: 19,
            textAlign: 'center',
          }}
        >
          Next, the system will ask for notification permission.
        </Text>
        <Button title="Continue" size="lg" busy={busy} onPress={proceed} />
      </View>
    </ScreenView>
  )
}
