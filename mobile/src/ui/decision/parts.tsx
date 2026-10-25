import { useState, type ReactNode } from 'react'
import {
  Platform,
  Pressable,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Svg, { Circle, Path } from 'react-native-svg'
import { HaloDot, Mono, Spinner, useColors } from '../kit'
import { Text } from '../Text'
import { monoFont } from '../palette'

/** web 的 textarea 自带 focus ring（outline-style:auto 不受宽度影响），由我们自己画描边。 */
export const webNoOutline = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as object

/** 底部安全区；web 预览按 iPhone 的 34pt Home 指示条模拟（与 ScreenView 的 47pt 顶部一致）。 */
export function useBottomInset() {
  const insets = useSafeAreaInsets()
  return Platform.OS === 'web' ? Math.max(insets.bottom, 34) : Math.max(insets.bottom, 16)
}

/** “需要你决定”的底座：card 背景、顶部圆角 26、向上投影。 */
export function DecisionSurface({
  label,
  children,
  style,
}: {
  label: string
  children: ReactNode
  style?: StyleProp<ViewStyle>
}) {
  const colors = useColors()
  const bottom = useBottomInset()
  return (
    <View
      role="region"
      aria-label={label}
      style={[
        {
          backgroundColor: colors.card,
          borderTopLeftRadius: 26,
          borderTopRightRadius: 26,
          boxShadow: `0 -1px 0 ${colors.hair}, 0 -10px 30px rgba(28,25,23,0.08)`,
          paddingTop: 18,
          paddingHorizontal: 16,
          paddingBottom: bottom,
          gap: 12,
        },
        style,
      ]}
    >
      {children}
    </View>
  )
}

/** 琥珀呼吸点 + 标题 + 右侧（队列位置或胶囊）。 */
export function DecisionHeader({
  title,
  position,
  right,
  titleStyle,
}: {
  title: ReactNode
  position?: { index: number; total: number }
  right?: ReactNode
  titleStyle?: 'headline' | 'quiet'
}) {
  const colors = useColors()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 22 }}>
      <HaloDot size={9} />
      {typeof title === 'string' ? (
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={
            titleStyle === 'quiet'
              ? { flex: 1, fontSize: 14, lineHeight: 20, color: colors.ink2 }
              : { flex: 1, fontSize: 16, lineHeight: 22, fontWeight: '600', color: colors.ink }
          }
        >
          {title}
        </Text>
      ) : (
        <View style={{ flex: 1, minWidth: 0 }}>{title}</View>
      )}
      {right}
      {position && position.total > 1 ? (
        <Mono
          accessibilityLabel={`第 ${position.index} 个，共 ${position.total} 个`}
          style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}
        >
          {position.index} / {position.total}
        </Mono>
      ) : null}
    </View>
  )
}

/** 居中的弱按钮（“停止整个任务”“上一题”）：32 高、13 号、ink3。 */
export function QuietButton({
  title,
  onPress,
  disabled,
  accessibilityLabel,
}: {
  title: string
  onPress(): void
  disabled?: boolean
  accessibilityLabel?: string
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 32,
        paddingHorizontal: 12,
        alignSelf: 'center',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : pressed ? 0.5 : 1,
      })}
    >
      <Text style={{ fontSize: 13, color: colors.ink3 }}>{title}</Text>
    </Pressable>
  )
}

/** 快捷说明胶囊：34 高、fill 底、14 号。 */
export function NoteChip({
  label,
  onPress,
  disabled,
}: {
  label: string
  onPress(): void
  disabled?: boolean
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`填入：${label}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 34,
        paddingHorizontal: 12,
        borderRadius: 17,
        backgroundColor: colors.fill,
        justifyContent: 'center',
        opacity: disabled ? 0.45 : pressed ? 0.6 : 1,
      })}
    >
      <Text style={{ fontSize: 14, color: colors.ink }}>{label}</Text>
    </Pressable>
  )
}

/** 多行说明输入：bg 底，聚焦时 1.5px 运行蓝描边。 */
export function NoteInput({
  minHeight = 92,
  style,
  onFocus,
  onBlur,
  ...props
}: TextInputProps & { minHeight?: number }) {
  const colors = useColors()
  const [focused, setFocused] = useState(false)
  return (
    <TextInput
      multiline
      textAlignVertical="top"
      placeholderTextColor={colors.ink3}
      {...props}
      onFocus={(event) => {
        setFocused(true)
        onFocus?.(event)
      }}
      onBlur={(event) => {
        setFocused(false)
        onBlur?.(event)
      }}
      style={[
        {
          minHeight,
          maxHeight: 180,
          borderRadius: 14,
          backgroundColor: colors.bg,
          boxShadow: focused ? `inset 0 0 0 1.5px ${colors.run}` : undefined,
          paddingHorizontal: 14,
          paddingTop: 12,
          paddingBottom: 12,
          fontSize: 16,
          lineHeight: 23,
          color: colors.ink,
        },
        webNoOutline,
        style,
      ]}
    />
  )
}

/** 已发出、等电脑回执：占住按钮区高度，避免底座跳动。 */
export function SubmittedRow({ text = '已提交，正在等待电脑确认。' }: { text?: string }) {
  const colors = useColors()
  return (
    <View
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      style={{ minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}
    >
      <Spinner size={16} />
      <Text style={{ fontSize: 14, lineHeight: 20, color: colors.ink2 }}>{text}</Text>
    </View>
  )
}

/** AI 代答胶囊：倒计时（琥珀）/ 已接手（灰）/ 已到时（灰）。 */
export function CountdownPill({
  state,
  label,
  fraction = 1,
}: {
  state: 'counting' | 'takenOver' | 'expired'
  label?: string
  fraction?: number
}) {
  const colors = useColors()
  const counting = state === 'counting'
  const text =
    state === 'takenOver'
      ? '你已接手，AI 不会代答'
      : state === 'expired'
        ? 'AI 代答时间已到'
        : '后 AI 代答'
  // 环形进度：从 12 点钟方向顺时针画剩余比例。
  const clamped = Math.min(1, Math.max(0, fraction))
  const angle = clamped * 2 * Math.PI
  const r = 6
  const x = 8 + r * Math.sin(angle)
  const y = 8 - r * Math.cos(angle)
  const arc =
    clamped >= 0.999
      ? undefined
      : `M8 2A6 6 0 ${clamped > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={counting ? `${label} 后 AI 代答` : text}
      style={{
        height: 28,
        paddingHorizontal: 10,
        borderRadius: 14,
        backgroundColor: counting ? colors.attnSoft : colors.fill,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flexShrink: 1,
      }}
    >
      {counting ? (
        <Svg width={14} height={14} viewBox="0 0 16 16">
          <Circle cx={8} cy={8} r={r} fill="none" stroke={colors.attn} strokeOpacity={0.22} strokeWidth={2} />
          {arc ? (
            <Path d={arc} fill="none" stroke={colors.attn} strokeWidth={2} strokeLinecap="round" />
          ) : (
            <Circle cx={8} cy={8} r={r} fill="none" stroke={colors.attn} strokeWidth={2} />
          )}
        </Svg>
      ) : null}
      {counting ? (
        <Text style={{ fontSize: 13, color: colors.attn, fontFamily: monoFont, fontVariant: ['tabular-nums'] }}>
          {label}
        </Text>
      ) : null}
      <Text numberOfLines={1} style={{ fontSize: 13, color: counting ? colors.attn : colors.ink3, flexShrink: 1 }}>
        {text}
      </Text>
    </View>
  )
}
