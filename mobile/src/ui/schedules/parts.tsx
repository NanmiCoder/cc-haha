import type { PropsWithChildren } from 'react'
import { Pressable, TextInput, View, type StyleProp, type ViewStyle } from 'react-native'
import { isClockValid, scheduleParts, type Tone } from '../../core/schedulesView'
import { monoFont } from '../palette'
import { Dot, Icon, Mono, useColors } from '../kit'
import { Text } from '../Text'

export function useToneColor() {
  const colors = useColors()
  return (tone: Tone) =>
    tone === 'ok'
      ? colors.ok
      : tone === 'err'
        ? colors.err
        : tone === 'attn'
          ? colors.attnDot
          : tone === 'run'
            ? colors.run
            : colors.faint
}

/** “工作日 09:00 · 项目 · …”，时间用等宽；读不懂的 cron 原样等宽显示。 */
export function ScheduleLine({
  cron,
  extras,
  size = 13,
  color,
}: {
  cron: string
  extras: string[]
  size?: number
  color?: string
}) {
  const colors = useColors()
  const parts = scheduleParts(cron)
  const tail = extras.filter(Boolean).map((item) => ` · ${item}`).join('')
  return (
    <Text numberOfLines={1} style={{ fontSize: size, lineHeight: size + 5, color: color ?? colors.ink2 }}>
      {parts ? `${parts.repeat} ` : null}
      <Mono style={{ fontSize: size }}>{parts ? parts.time : cron}</Mono>
      {tail}
    </Text>
  )
}

/** 带圆点的一行状态文字（定时任务的最近运行）。 */
export function DotLine({ tone, text }: { tone: Tone; text: string }) {
  const colors = useColors()
  const toneColor = useToneColor()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Dot color={toneColor(tone)} size={6} />
      <Text
        numberOfLines={1}
        style={{ flexShrink: 1, fontSize: 13, lineHeight: 18, color: tone === 'err' ? colors.err : colors.ink3 }}
      >
        {text}
      </Text>
    </View>
  )
}

/** 分组表单的一行：左侧 64 宽标签，右侧内容。 */
export function FormRow({
  label,
  children,
  labelFlex,
  minHeight = 50,
}: PropsWithChildren<{ label: string; labelFlex?: boolean; minHeight?: number }>) {
  const colors = useColors()
  return (
    <View style={{ minHeight, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14 }}>
      <Text style={[{ fontSize: 16, color: colors.ink }, labelFlex ? { flex: 1 } : { width: 64 }]}>
        {label}
      </Text>
      {children}
    </View>
  )
}

/** 可编辑的 HH:mm 时间胶囊：fill 底、等宽；不合法时变红。 */
export function TimeField({
  value,
  onChangeText,
  editable = true,
  onSubmitEditing,
}: {
  value: string
  onChangeText(value: string): void
  editable?: boolean
  onSubmitEditing?(): void
}) {
  const colors = useColors()
  const invalid = !isClockValid(value)
  return (
    <TextInput
      accessibilityLabel="电脑本地时间（HH:mm）"
      accessibilityHint={invalid ? '请输入有效时间，例如 09:00' : undefined}
      value={value}
      onChangeText={onChangeText}
      editable={editable}
      keyboardType="numbers-and-punctuation"
      maxLength={5}
      placeholder="09:00"
      placeholderTextColor={colors.ink3}
      selectTextOnFocus
      returnKeyType="done"
      onSubmitEditing={onSubmitEditing}
      style={{
        height: 34,
        width: 76,
        paddingHorizontal: 12,
        paddingVertical: 0,
        borderRadius: 9,
        backgroundColor: colors.fill,
        fontFamily: monoFont,
        fontSize: 16,
        textAlign: 'center',
        color: invalid ? colors.err : colors.ink,
      }}
    />
  )
}

/** 卡片底、红字的整行按钮（删除这个定时任务）。 */
export function DangerRowButton({
  title,
  onPress,
  disabled,
  style,
}: {
  title: string
  onPress(): void
  disabled?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        {
          height: 50,
          borderRadius: 14,
          backgroundColor: pressed ? colors.fill : colors.card,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.45 : 1,
        },
        style,
      ]}
    >
      <Text style={{ fontSize: 16, color: colors.err }}>{title}</Text>
    </Pressable>
  )
}

/** 详情页按钮行：48 高、14 圆角；主按钮带 14 号实心播放图标。 */
export function ActionButton({
  title,
  onPress,
  primary,
  play,
  disabled,
}: {
  title: string
  onPress(): void
  primary?: boolean
  play?: boolean
  disabled?: boolean
}) {
  const colors = useColors()
  const fg = primary ? (disabled ? colors.ink3 : colors.btnInk) : colors.ink
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        height: 48,
        borderRadius: 14,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: primary ? (disabled ? colors.fill : colors.btn) : colors.card,
        boxShadow: primary ? undefined : `inset 0 0 0 1px ${colors.hair}`,
        opacity: pressed ? 0.7 : !primary && disabled ? 0.45 : 1,
      })}
    >
      {play ? <Icon name="play" size={14} color={fg} /> : null}
      <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: fg }}>
        {title}
      </Text>
    </Pressable>
  )
}
