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

const MODES: { value: LiveActivityMode; title: string; detail: string }[] = [
  {
    value: 'running',
    title: '有任务在跑就显示',
    detail: '运行中显示计时，等你时变成琥珀色',
  },
  {
    value: 'decisions',
    title: '只在等你决定时',
    detail: '要审批、回答或确认计划时出现，处理完就收起',
  },
]

/**
 * 锁屏与灵动岛：实时活动什么时候出现、是否露出命令。
 * 实时活动总开关在系统设置里，JS 读不到它的状态（expo-widgets 没有对应接口），
 * 所以这里只提供入口，不假装知道开没开。
 */
export default function LiveActivitySettings() {
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
        <NavBar floating title="锁屏与灵动岛" />
        <EmptyState
          icon="bell"
          title="锁屏实时活动仅支持 iPhone"
          detail="Android 通过系统通知提醒你，可在设置的「声音和震动」里调整。"
        />
      </ScreenView>
    )
  return (
    <ScreenView>
      <NavBar floating title="锁屏与灵动岛" />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      >
        <LockScreenPreview showCommand={preferences.liveActivityShowCommand} />

        <SectionHeader title="什么时候显示" />
        <Group>
          <View accessibilityRole="radiogroup" accessibilityLabel="实时活动什么时候显示">
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

        <SectionHeader title="隐私" />
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
              <Text style={{ fontSize: 16, lineHeight: 21, color: colors.ink }}>锁屏上显示命令</Text>
              <Text style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>
                关掉后只写「想运行命令」，不露出命令和路径
              </Text>
            </View>
            <Switch
              label="锁屏上显示命令"
              value={preferences.liveActivityShowCommand}
              onValueChange={(value) => save({ liveActivityShowCommand: value })}
            />
          </View>
        </Group>
        <InlineError text={error} style={{ marginTop: 12 }} />

        <Footnote>想完全关掉实时活动，去系统设置 › cc-haha › 实时活动。</Footnote>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="打开系统设置"
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
          <Text style={{ fontSize: 14, fontWeight: '600', color: colors.ink2 }}>打开系统设置</Text>
        </Pressable>
        <Footnote style={{ paddingTop: 12 }}>
          电脑通过系统推送更新锁屏时同样遵守这两项设置；电脑端版本较旧时，只对手机在前台生成的内容生效。
        </Footnote>
      </ScrollView>
    </ScreenView>
  )
}
