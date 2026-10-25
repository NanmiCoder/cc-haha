import { Pressable, View } from 'react-native'
import { Text } from '../Text'
import { Icon, Mono, useColors } from '../kit'

/** 新任务顶部的“在哪做”卡：项目 · 分支 · 工作树方式 · 电脑。点击进入选择面板。 */
export function TargetCard({
  name,
  branch,
  status,
  mode,
  hostName,
  onPress,
  disabled,
}: {
  name: string
  branch?: string
  status?: string
  mode?: string
  hostName?: string
  onPress(): void
  disabled?: boolean
}) {
  const colors = useColors()
  const where = [name, branch ?? status, mode, hostName].filter(Boolean).join('，')
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`在哪做：${where}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: colors.card,
        borderRadius: 16,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 12,
        paddingHorizontal: 14,
        opacity: disabled ? 0.6 : pressed ? 0.7 : 1,
      })}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          backgroundColor: colors.fill,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name="folder" size={19} color={colors.ink2} strokeWidth={1.75} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          numberOfLines={1}
          style={{ fontSize: 16, lineHeight: 20, fontWeight: '600', color: colors.ink }}
        >
          {name}
        </Text>
        {(branch || status || mode) && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name="git-branch" size={13} color={colors.ink3} strokeWidth={2} />
          {branch ? (
            <Mono
              numberOfLines={1}
              style={{ flexShrink: 1, fontSize: 13, lineHeight: 16, color: colors.ink3 }}
            >
              {branch}
            </Mono>
          ) : (
            <Text
              numberOfLines={1}
              style={{ flexShrink: 1, fontSize: 13, lineHeight: 16, color: colors.ink3 }}
            >
              {status}
            </Text>
          )}
          {mode ? (
            <Text
              numberOfLines={1}
              style={{ flexShrink: 0, fontSize: 13, lineHeight: 16, color: colors.ink3 }}
            >
              · {mode}
            </Text>
          ) : null}
        </View>}
      </View>
      {hostName ? (
        <Text
          numberOfLines={1}
          style={{ flexShrink: 1, maxWidth: 104, fontSize: 13, color: colors.ink3 }}
        >
          {hostName}
        </Text>
      ) : null}
      <Icon name="chevron-right" size={15} color={colors.chevron} strokeWidth={2.2} />
    </Pressable>
  )
}
