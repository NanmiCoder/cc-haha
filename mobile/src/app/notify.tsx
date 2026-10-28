import { useCallback, useState } from 'react'
import { BackHandler, Platform, ScrollView, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
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

/**
 * 连上电脑后的「开启通知」引导页（Apple HIG 的授权前说明页）：
 * 只有一个「继续」，点了才弹系统授权框；允许或拒绝都回首页，拒绝不挡使用。
 */
export default function NotifyPrime() {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const { registry } = useApp()
  const { update } = usePreferences()
  const [busy, setBusy] = useState(false)
  const host =
    registry.hosts.find((item) => item.id === registry.selectedId) ??
    registry.hosts[0]
  const hostName = host?.name ?? '电脑'

  // 只能通过「继续」离开：吞掉安卓返回键（iOS 的手势在 Stack 选项里关了）。
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
    // 引导页是压在首页上的，回到下面那层；万一没有（深链直达）就换成首页。
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
            已连接 {hostName}
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
          要你拍板时，叫你一声
        </Text>
        <Text
          style={{
            marginTop: 10,
            color: colors.ink2,
            fontSize: 15,
            lineHeight: 23,
          }}
        >
          命令要你批准、计划等你确认、任务做完或出错，都会推到锁屏。哪几类要提醒，之后在设置里随时改。
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
          下一步会弹出系统的通知授权。
        </Text>
        <Button title="继续" size="lg" busy={busy} onPress={proceed} />
      </View>
    </ScreenView>
  )
}
