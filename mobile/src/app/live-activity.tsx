import { useState } from 'react'
import { Linking, Platform, Pressable, ScrollView, View } from 'react-native'
import { usePreferences } from '../state/PreferencesContext'
import type { LiveActivityMode } from '../state/preferences'
import {
  EmptyState,
  Footnote,
  Group,
  InlineError,
  NavBar,
  RadioMark,
  ScreenView,
  SectionHeader,
  Separator,
  Switch,
  useColors,
} from '../ui/kit'
import { LockScreenPreview } from '../ui/liveActivity/LockScreenPreview'
import { Text } from '../ui/Text'
import { errorText } from '../ui/theme'
import { Redirect } from 'expo-router'
import { isH5 } from '../state/h5'

const MODES: { value: LiveActivityMode; title: string; detail: string }[] = [
  {
    value: 'running',
    title: 'Show when a task is running',
    detail: 'Shows a timer while running and turns amber when waiting for you',
  },
  {
    value: 'decisions',
    title: 'Only when waiting for your decision',
    detail: 'Appears when an approval, answer or plan confirmation is needed, and closes once handled',
  },
]

/** Lock screen Live Activities are native app only; the web version connects only to the computer that opened it, so go straight home. */
export default function LiveActivitySettingsRoute() {
  return isH5 ? <Redirect href="/" /> : <LiveActivitySettings />
}

/**
 * Lock screen and Dynamic Island: when Live Activities appear and whether commands are revealed.
 * The Live Activities master switch is in System Settings and JS cannot read it (expo-widgets has no API for it), 
 * so only an entry point is provided here, without pretending to know whether it is on.
 */
function LiveActivitySettings() {
  const colors = useColors()
  const { preferences, update } = usePreferences()
  const [error, setError] = useState('')
  const save = (patch: Parameters<typeof update>[0]) => {
    setError('')
    update(patch).catch((e) => setError(errorText(e)))
  }
  if (Platform.OS !== 'ios')
    return (
      <ScreenView>
        <NavBar floating title="Lock screen and Dynamic Island" />
        <EmptyState
          icon="bell"
          title="Lock screen Live Activities are only supported on iPhone"
          detail="Android Alerts you via system notifications; adjust in Settings under “Sounds & vibration”."
        />
      </ScreenView>
    )
  return (
    <ScreenView>
      <NavBar floating title="Lock screen and Dynamic Island" />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      >
        <LockScreenPreview showCommand={preferences.liveActivityShowCommand} />

        <SectionHeader title="When to show" />
        <Group>
          <View accessibilityRole="radiogroup" accessibilityLabel="When Live Activities show">
            {MODES.map((mode, index) => {
              const selected = preferences.liveActivity === mode.value
              return (
                <View key={mode.value}>
                  {index > 0 ? <Separator inset={48} /> : null}
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityLabel={mode.title}
                    accessibilityHint={mode.detail}
                    accessibilityState={{ checked: selected }}
                    onPress={() => save({ liveActivity: mode.value })}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'flex-start',
                      gap: 12,
                      paddingHorizontal: 14,
                      paddingVertical: 12,
                      backgroundColor: pressed ? colors.fill : undefined,
                    })}
                  >
                    <View style={{ marginTop: 1 }}>
                      <RadioMark selected={selected} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <Text style={{ fontSize: 16, lineHeight: 21, fontWeight: '600', color: colors.ink }}>
                        {mode.title}
                      </Text>
                      <Text style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>
                        {mode.detail}
                      </Text>
                    </View>
                  </Pressable>
                </View>
              )
            })}
          </View>
        </Group>

        <SectionHeader title="Privacy" />
        <Group>
          <View
            style={{
              minHeight: 58,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingHorizontal: 14,
              paddingVertical: 8,
            }}
          >
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text style={{ fontSize: 16, lineHeight: 21, color: colors.ink }}>Show commands on lock screen</Text>
              <Text style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>
                When off only shows “Wants to run a command” without revealing the command or paths
              </Text>
            </View>
            <Switch
              label="Show commands on lock screen"
              value={preferences.liveActivityShowCommand}
              onValueChange={(value) => save({ liveActivityShowCommand: value })}
            />
          </View>
        </Group>
        <InlineError text={error} style={{ marginTop: 12 }} />

        <Footnote>To turn off Live Activities completely, go to System Settings › cc-haha › Live Activities.</Footnote>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open system settings"
          hitSlop={8}
          onPress={() => void Linking.openSettings().catch(() => {})}
          style={({ pressed }) => ({
            alignSelf: 'flex-start',
            height: 36,
            marginLeft: 4,
            justifyContent: 'center',
            opacity: pressed ? 0.5 : 1,
          })}
        >
          <Text style={{ fontSize: 14, fontWeight: '600', color: colors.ink2 }}>Open system settings</Text>
        </Pressable>
        <Footnote style={{ paddingTop: 12 }}>
          The computer follows these two settings when updating the lock screen via system push; with an older desktop version they apply only to content generated while the phone is in the foreground.
        </Footnote>
      </ScrollView>
    </ScreenView>
  )
}
