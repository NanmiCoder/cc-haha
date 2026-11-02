import type { ReactNode } from 'react'
import { Pressable, View, type ViewStyle } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { Text } from '../Text'
import { Callout, Icon, Mono, useColors, type IconName } from '../kit'

/**
 * 电脑设置的一行：图标 · 标题 · 右侧的值 · 箭头（设计稿 P1 / P2）。
 * kit 的 ListRow 会让长值把标题压窄，这里反过来，两种布局：
 * - 默认：标题不被压缩，值占剩余宽度、右对齐，超长只截断值（模型名、定时任务摘要）。
 * - 有副行或 titleGrow：标题（和副行）占剩余宽度、副行最多两行，值不收缩、不截断（“等 5 分钟”）。
 * 没有 onPress 就是只读行（不画箭头）。
 */
export function SettingRow({
  icon,
  glyph,
  title,
  subtitle,
  value,
  mono,
  valueSize,
  titleGrow,
  onPress,
  disabled,
  minHeight = 52,
  destructive,
  label,
}: {
  icon?: IconName
  /** 共用图标表里没有的图标（Glyph / GaugeGlyph），优先于 icon。 */
  glyph?: ReactNode
  title: string
  subtitle?: string
  value?: ReactNode
  /** 值用等宽字（地址）。 */
  mono?: boolean
  /** 值的字号，默认 15（等宽 14）。 */
  valueSize?: number
  /** 标题占剩余宽度（值不收缩），没有副行时也用，例如服务商名可能很长。 */
  titleGrow?: boolean
  onPress?(): void
  disabled?: boolean
  minHeight?: number
  destructive?: boolean
  label?: string
}) {
  const colors = useColors()
  const ValueText = mono ? Mono : Text
  const grow = titleGrow || Boolean(subtitle)
  const fontSize = valueSize ?? (mono ? 14 : 15)
  const body = (
    <>
      {glyph ?? (icon ? <Icon name={icon} size={20} color={colors.ink2} strokeWidth={1.8} /> : null)}
      <View style={grow ? { flex: 1, minWidth: 0, gap: 2 } : { flexShrink: 0, gap: 2 }}>
        <Text
          numberOfLines={1}
          style={{ fontSize: 16, lineHeight: 21, color: destructive ? colors.err : colors.ink }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={2} style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <View
        style={
          grow
            ? { flexShrink: 0, maxWidth: '45%', alignItems: 'flex-end' }
            : { flex: 1, minWidth: 0, alignItems: 'flex-end' }
        }
      >
        {typeof value === 'string' ? (
          <ValueText
            numberOfLines={1}
            style={{ fontSize, color: colors.ink3, textAlign: 'right' }}
          >
            {value}
          </ValueText>
        ) : (
          value
        )}
      </View>
      {onPress ? (
        <Icon name="chevron-right" size={16} color={colors.chevron} strokeWidth={2} />
      ) : null}
    </>
  )
  const base = {
    minHeight,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
  }
  if (!onPress) return <View style={base}>{body}</View>
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        label ?? [title, typeof value === 'string' ? value : ''].filter(Boolean).join('，')
      }
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        base,
        { opacity: disabled ? 0.45 : 1 },
        pressed && { backgroundColor: colors.fill },
      ]}
    >
      {body}
    </Pressable>
  )
}

/** P2 模型单选行：22pt 单选圈 · 名称 16/21 + 等宽 id 12/16 · 最小高 58，圈内 8pt 白点。 */
export function ModelOption({
  title,
  detail,
  mono,
  selected,
  disabled,
  onPress,
  label,
}: {
  title: string
  detail?: string
  mono?: boolean
  selected: boolean
  disabled?: boolean
  onPress(): void
  label: string
}) {
  const colors = useColors()
  const Detail = mono ? Mono : Text
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 58,
        paddingHorizontal: 14,
        paddingVertical: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        backgroundColor: pressed ? colors.fill : 'transparent',
        opacity: disabled ? 0.45 : 1,
      })}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          flexShrink: 0,
          backgroundColor: selected ? colors.run : 'transparent',
          borderWidth: selected ? 0 : 2,
          borderColor: colors.chevron,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {selected ? (
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#FFFFFF' }} />
        ) : null}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          numberOfLines={1}
          style={{ fontSize: 16, lineHeight: 21, fontWeight: selected ? '600' : '400', color: colors.ink }}
        >
          {title}
        </Text>
        {detail ? (
          <Detail
            numberOfLines={1}
            ellipsizeMode={mono ? 'middle' : 'tail'}
            style={{ fontSize: 12, lineHeight: 16, color: colors.ink3 }}
          >
            {detail}
          </Detail>
        ) : null}
      </View>
    </Pressable>
  )
}

/** 出错提示：重新读取收在提示里，不再单独浮在页面中间。 */
export function ErrorCallout({
  text,
  onRetry,
  style,
}: {
  text?: string
  onRetry?(): void
  style?: ViewStyle
}) {
  const colors = useColors()
  if (!text) return null
  return (
    <Callout tone="error" style={style}>
      <View style={{ gap: 6 }}>
        <Text selectable style={{ fontSize: 13, lineHeight: 19, color: colors.err }}>
          {text}
        </Text>
        {onRetry ? (
          <Pressable
            accessibilityRole="button"
            hitSlop={10}
            onPress={onRetry}
            style={({ pressed }) => ({ alignSelf: 'flex-start', opacity: pressed ? 0.5 : 1 })}
          >
            <Text style={{ fontSize: 13, lineHeight: 19, fontWeight: '600', color: colors.err }}>
              重新读取
            </Text>
          </Pressable>
        ) : null}
      </View>
    </Callout>
  )
}

/** 思考强度图标（Lucide gauge）：共用图标表里没有。 */
export function GaugeGlyph({ color, size = 20 }: { color: string; size?: number }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="m12 14 4-4" />
      <Path d="M3.34 19a10 10 0 1 1 17.32 0" />
    </Svg>
  )
}
