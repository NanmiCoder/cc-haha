import React, { useEffect, useMemo, useState } from 'react'
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  FlatList,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
  useWindowDimensions,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import Svg, { Circle, Path, Rect } from 'react-native-svg'
import { router } from 'expo-router'
import { Text } from './Text'
import { KeyboardViewport } from './KeyboardViewport'
import { Icon, type IconName } from './icons'
import { useTheme, type Colors } from './theme'
import { monoFont, type } from './palette'
import type { DiffLine } from '../core/operations'

export { Icon, type IconName } from './icons'
export { type } from './palette'

export function useColors(): Colors {
  return useTheme().colors
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    let alive = true
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => alive && setReduced(value))
      .catch(() => {})
    const sub = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduced
    )
    return () => {
      alive = false
      sub.remove()
    }
  }, [])
  return reduced
}

/* ───────────── 文本 ───────────── */

export function Mono({ style, ...props }: TextProps) {
  return (
    <Text
      {...props}
      style={[{ fontFamily: monoFont, fontVariant: ['tabular-nums'] }, style]}
    />
  )
}

export function InlineCode({ children }: { children: React.ReactNode }) {
  const colors = useColors()
  return (
    <Mono
      style={{
        fontSize: 14,
        backgroundColor: colors.code,
        color: colors.ink,
        borderRadius: 5,
        paddingHorizontal: 4,
      }}
    >
      {children}
    </Mono>
  )
}

/* ───────────── 屏幕与导航 ───────────── */

/** 顶部安全区 + 背景。web 预览额外模拟 54pt 状态栏高度（与设计稿一致）。 */
export function ScreenView({
  children,
  background,
  style,
}: React.PropsWithChildren<{ background?: string; style?: StyleProp<ViewStyle> }>) {
  const colors = useColors()
  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[
        { flex: 1, backgroundColor: background ?? colors.bg },
        Platform.OS === 'web' && { paddingTop: 54 },
        style,
      ]}
    >
      {children}
    </SafeAreaView>
  )
}

export function goBack() {
  if (router.canGoBack()) router.back()
  else router.replace('/')
}

/** 44pt 导航栏：返回（可带文字）· 居中标题/副标题 · 右侧操作。 */
export function NavBar({
  title,
  subtitle,
  titleMono,
  onBack,
  backLabel,
  back = true,
  right,
  bordered = false,
  background,
  floating = false,
}: {
  title?: string
  subtitle?: React.ReactNode
  titleMono?: boolean
  onBack?(): void
  backLabel?: string
  back?: boolean
  right?: React.ReactNode
  bordered?: boolean
  background?: string
  /**
   * 浮动样式：返回和右侧是 44 圆形白底按钮，中间只有标题与副标题，没有底线和底色。
   * `right` 里请放 {@link FloatingButton}。
   */
  floating?: boolean
}) {
  const colors = useColors()
  const TitleText = titleMono ? Mono : Text
  if (floating)
    return (
      <View style={{ minHeight: 44, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ minWidth: 44, alignItems: 'flex-start' }}>
          {back ? (
            <FloatingButton
              icon="chevron-left"
              label={backLabel ? `返回${backLabel}` : '返回'}
              onPress={onBack ?? goBack}
            />
          ) : null}
        </View>
        <View style={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
          {title ? (
            <TitleText
              numberOfLines={1}
              style={{
                maxWidth: '100%',
                fontSize: 16,
                lineHeight: 21,
                fontWeight: '600',
                color: colors.ink,
              }}
            >
              {title}
            </TitleText>
          ) : null}
          {subtitle ? (
            typeof subtitle === 'string' ? (
              <Text
                numberOfLines={1}
                style={{ maxWidth: '100%', fontSize: 12, lineHeight: 16, color: colors.ink3 }}
              >
                {subtitle}
              </Text>
            ) : (
              subtitle
            )
          ) : null}
        </View>
        <View style={{ minWidth: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
          {right}
        </View>
      </View>
    )
  return (
    <View
      style={{
        minHeight: 44,
        paddingHorizontal: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        backgroundColor: background,
        borderBottomWidth: bordered ? 1 : 0,
        borderBottomColor: colors.hair,
      }}
    >
      <View style={{ minWidth: 44, alignItems: 'flex-start' }}>
        {back && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={backLabel ? `返回${backLabel}` : '返回'}
            hitSlop={6}
            onPress={onBack ?? goBack}
            style={({ pressed }) => ({
              height: 44,
              minWidth: 44,
              paddingHorizontal: backLabel ? 4 : 0,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: backLabel ? 'flex-start' : 'center',
              gap: 2,
              opacity: pressed ? 0.5 : 1,
            })}
          >
            <Icon name="chevron-left" size={22} color={colors.ink} strokeWidth={2.2} />
            {backLabel ? (
              <Text style={{ fontSize: 16, color: colors.ink }}>{backLabel}</Text>
            ) : null}
          </Pressable>
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
        {title ? (
          <TitleText
            numberOfLines={1}
            style={{
              fontSize: subtitle ? (titleMono ? 15 : 16) : 17,
              lineHeight: subtitle ? 21 : 22,
              fontWeight: '600',
              color: colors.ink,
            }}
          >
            {title}
          </TitleText>
        ) : null}
        {subtitle ? (
          typeof subtitle === 'string' ? (
            <Text
              numberOfLines={1}
              style={{ fontSize: 12, lineHeight: 16, color: colors.ink3 }}
            >
              {subtitle}
            </Text>
          ) : (
            subtitle
          )
        ) : null}
      </View>
      <View style={{ minWidth: 44, alignItems: 'flex-end' }}>{right}</View>
    </View>
  )
}

/** 浮动圆钮的投影与描边（NavBar 的 floating 样式、会话页的活动胶囊共用）。 */
export const floatingShadow = (hair: string) =>
  `0 1px 2px rgba(28,25,23,0.06), 0 4px 14px rgba(28,25,23,0.09), 0 0 0 1px ${hair}`

/**
 * 44 圆形白底按钮，带轻阴影：浮动导航栏的返回和“…”。可带角标，或用 children 放自定义内容
 * （例如转圈）。`active` 表示它正在展开菜单，外圈画一道墨色描边。
 */
export function FloatingButton({
  icon,
  label,
  onPress,
  badge,
  active,
  disabled,
  children,
}: {
  icon?: IconName
  label: string
  onPress?(): void
  /** 右上角的小圆角标，数字或短文字；没有就不画。 */
  badge?: string | number
  active?: boolean
  disabled?: boolean
  children?: React.ReactNode
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, expanded: active }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: colors.card,
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: active
          ? `0 0 0 2px ${colors.ink}, 0 4px 14px rgba(28,25,23,0.18)`
          : floatingShadow(colors.hair),
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      {children ?? (icon ? <Icon name={icon} size={22} color={colors.ink} strokeWidth={2.2} /> : null)}
      {badge !== undefined && badge !== '' ? (
        <View
          style={{
            position: 'absolute',
            top: -3,
            right: -3,
            minWidth: 18,
            height: 18,
            paddingHorizontal: 5,
            borderRadius: 9,
            backgroundColor: colors.btn,
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: `0 0 0 2px ${colors.bg}`,
          }}
        >
          <Text style={{ fontSize: 11, lineHeight: 14, fontWeight: '600', color: colors.btnInk }}>{badge}</Text>
        </View>
      ) : null}
    </Pressable>
  )
}

export type ActionMenuItem =
  | {
      key: string
      label: string
      icon?: IconName
      /** 右侧的计数小胶囊（如“更改 3”）。 */
      count?: number | string
      /** 右侧自定义内容（如“2 项在跑”）；和 count 同时给时 trailing 优先。 */
      trailing?: React.ReactNode
      destructive?: boolean
      disabled?: boolean
      onPress(): void
    }
  | 'separator'

/**
 * “…”会话菜单：白底圆角 16、268 宽，一行 48 高，图标在左（X2 画板）。
 * 和 {@link Menu} 的区别只在外观，锚点语义相同（相对整块屏幕）。
 */
export function ActionMenu({
  visible,
  onClose,
  items,
  anchor,
  width = 268,
  header,
}: {
  visible: boolean
  onClose(): void
  items: ActionMenuItem[]
  anchor: { top: number; right?: number; left?: number }
  width?: number
  /** 菜单顶部的小字区（路径、模型 · 上下文用量），下面有一条分隔线。 */
  header?: React.ReactNode
}) {
  const colors = useColors()
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="关闭菜单"
        onPress={onClose}
        style={{ flex: 1, backgroundColor: colors.scrim }}
      />
      <View
        accessibilityRole="menu"
        accessibilityViewIsModal
        onAccessibilityEscape={onClose}
        style={{
          position: 'absolute',
          top: anchor.top,
          right: anchor.left === undefined ? (anchor.right ?? 16) : undefined,
          left: anchor.left,
          width,
          paddingVertical: 6,
          backgroundColor: colors.card,
          borderRadius: 16,
          boxShadow: `0 10px 32px rgba(28,25,23,0.14), 0 2px 6px rgba(28,25,23,0.06), 0 0 0 1px ${colors.hair}`,
        }}
      >
        {header ? (
          <>
            <View style={{ paddingHorizontal: 16, paddingTop: 4, gap: 2 }}>{header}</View>
            <View aria-hidden style={{ height: 1, backgroundColor: colors.hair, marginTop: 4, marginBottom: 6, marginHorizontal: 16 }} />
          </>
        ) : null}
        {items.map((item, index) => {
          if (item === 'separator')
            return (
              <View
                key={`sep-${index}`}
                aria-hidden
                style={{ height: 1, backgroundColor: colors.hair, marginVertical: 6, marginHorizontal: 16 }}
              />
            )
          const tint = item.destructive ? colors.err : colors.ink
          return (
            <Pressable
              key={item.key}
              accessibilityRole="menuitem"
              accessibilityState={{ disabled: item.disabled }}
              disabled={item.disabled}
              onPress={() => {
                onClose()
                item.onPress()
              }}
              style={({ pressed }) => ({
                height: 48,
                paddingHorizontal: 16,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 14,
                backgroundColor: pressed ? colors.fill : 'transparent',
                opacity: item.disabled ? 0.4 : 1,
              })}
            >
              {item.icon ? <Icon name={item.icon} size={20} color={tint} strokeWidth={1.75} /> : null}
              <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 16, color: tint }}>
                {item.label}
              </Text>
              {item.trailing ??
                (item.count !== undefined ? (
                  <View
                    style={{
                      minWidth: 22,
                      height: 22,
                      paddingHorizontal: 7,
                      borderRadius: 11,
                      backgroundColor: colors.fill,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Mono style={{ fontSize: 13, fontWeight: '600', color: colors.ink2 }}>{item.count}</Mono>
                  </View>
                ) : null)}
            </Pressable>
          )
        })}
      </View>
    </Modal>
  )
}

export function LargeTitle({
  title,
  subtitle,
  onPress,
  chevron,
  accessibilityLabel,
  style,
}: {
  title: string
  subtitle?: React.ReactNode
  onPress?(): void
  chevron?: boolean
  accessibilityLabel?: string
  style?: StyleProp<ViewStyle>
}) {
  const colors = useColors()
  const content = (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text
          numberOfLines={1}
          style={[type.largeTitle, { color: colors.ink, flexShrink: 1 }]}
        >
          {title}
        </Text>
        {chevron && (
          <View style={{ marginTop: 3 }}>
            <Icon name="chevron-down" size={18} color={colors.ink3} strokeWidth={2.2} />
          </View>
        )}
      </View>
      {subtitle ? (
        typeof subtitle === 'string' ? (
          <Text style={[type.meta, { color: colors.ink3 }]}>{subtitle}</Text>
        ) : (
          subtitle
        )
      ) : null}
    </>
  )
  const base: ViewStyle = { gap: 4, paddingHorizontal: 4, paddingBottom: 14 }
  if (!onPress) return <View style={[base, style]}>{content}</View>
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      onPress={onPress}
      style={({ pressed }) => [base, { opacity: pressed ? 0.6 : 1 }, style]}
    >
      {content}
    </Pressable>
  )
}

/** 底部材质栏：上发丝线，自动避让 Home 指示条。 */
export function BottomBar({
  children,
  style,
}: React.PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  return (
    <View
      style={[
        {
          paddingTop: 12,
          paddingHorizontal: 16,
          paddingBottom: Math.max(insets.bottom, 16),
          backgroundColor: colors.bar,
          borderTopWidth: 1,
          borderTopColor: colors.hair,
        },
        style,
      ]}
    >
      {children}
    </View>
  )
}

/* ───────────── 分组列表 ───────────── */

export function SectionHeader({
  title,
  count,
  countColor,
  action,
  style,
}: {
  title: string
  count?: number
  countColor?: string
  action?: { label: string; onPress(): void }
  style?: StyleProp<ViewStyle>
}) {
  const colors = useColors()
  return (
    <View
      accessibilityRole="header"
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingTop: 22,
          paddingBottom: 8,
          paddingHorizontal: 4,
          minHeight: 30,
        },
        style,
      ]}
    >
      <Text style={[type.section, { color: colors.ink2 }]}>{title}</Text>
      {count !== undefined && (
        <Mono style={{ fontSize: 13, color: countColor ?? colors.ink3 }}>{count}</Mono>
      )}
      {action && (
        <Pressable
          accessibilityRole="button"
          onPress={action.onPress}
          hitSlop={8}
          style={{ marginLeft: 'auto' }}
        >
          <Text style={{ fontSize: 14, color: colors.ink2 }}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  )
}

export function Group({
  children,
  style,
}: React.PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const colors = useColors()
  return (
    <View
      style={[
        { backgroundColor: colors.card, borderRadius: 16, overflow: 'hidden' },
        style,
      ]}
    >
      {children}
    </View>
  )
}

export function Card({
  children,
  style,
}: React.PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const colors = useColors()
  return (
    <View
      style={[
        { backgroundColor: colors.card, borderRadius: 18, padding: 14, gap: 10 },
        style,
      ]}
    >
      {children}
    </View>
  )
}

export function Separator({ inset = 14 }: { inset?: number }) {
  const colors = useColors()
  return <View style={{ height: 1, backgroundColor: colors.hair, marginLeft: inset }} />
}

export function Chevron({ color }: { color?: string }) {
  const colors = useColors()
  return (
    <Icon name="chevron-right" size={14} color={color ?? colors.chevron} strokeWidth={2.2} />
  )
}

export function ListRow({
  title,
  subtitle,
  subtitleColor,
  leading,
  value,
  valueColor,
  chevron,
  onPress,
  onLongPress,
  trailing,
  titleMono,
  titleColor,
  destructive,
  disabled,
  minHeight = 50,
  accessibilityLabel,
  style,
}: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  subtitleColor?: string
  leading?: React.ReactNode
  value?: React.ReactNode
  valueColor?: string
  chevron?: boolean
  onPress?(): void
  onLongPress?(): void
  trailing?: React.ReactNode
  titleMono?: boolean
  titleColor?: string
  destructive?: boolean
  disabled?: boolean
  minHeight?: number
  accessibilityLabel?: string
  style?: StyleProp<ViewStyle>
}) {
  const colors = useColors()
  const TitleText = titleMono ? Mono : Text
  const body = (
    <>
      {leading}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        {typeof title === 'string' ? (
          <TitleText
            numberOfLines={1}
            style={{
              fontSize: titleMono ? 14.5 : 16,
              lineHeight: 21,
              color: destructive ? colors.err : (titleColor ?? colors.ink),
            }}
          >
            {title}
          </TitleText>
        ) : (
          title
        )}
        {subtitle ? (
          typeof subtitle === 'string' ? (
            <Text
              numberOfLines={2}
              style={[type.meta, { color: subtitleColor ?? colors.ink3 }]}
            >
              {subtitle}
            </Text>
          ) : (
            subtitle
          )
        ) : null}
      </View>
      {value !== undefined && value !== null ? (
        typeof value === 'string' ? (
          <Text
            numberOfLines={1}
            style={{ fontSize: 14, color: valueColor ?? colors.ink3, flexShrink: 1, maxWidth: '55%' }}
          >
            {value}
          </Text>
        ) : (
          value
        )
      ) : null}
      {trailing}
      {chevron && <Chevron />}
    </>
  )
  const base: ViewStyle = {
    minHeight,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    opacity: disabled ? 0.45 : 1,
  }
  if (!onPress && !onLongPress) return <View style={[base, style]}>{body}</View>
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        base,
        pressed && { backgroundColor: colors.fill },
        style,
      ]}
    >
      {body}
    </Pressable>
  )
}

export function Footnote({
  children,
  style,
}: React.PropsWithChildren<{ style?: StyleProp<TextStyle> }>) {
  const colors = useColors()
  return (
    <Text
      style={[
        { fontSize: 13, lineHeight: 19, color: colors.ink3, paddingHorizontal: 4, paddingTop: 8 },
        style,
      ]}
    >
      {children}
    </Text>
  )
}

/* ───────────── 按钮与控件 ───────────── */

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'outline'
  | 'danger'
  | 'destructive'
  | 'plain'

export function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  pill,
  disabled,
  busy,
  style,
  accessibilityLabel,
  testID,
}: {
  title: string
  onPress?(): void
  variant?: ButtonVariant
  size?: 'sm' | 'md' | 'lg'
  icon?: IconName
  pill?: boolean
  disabled?: boolean
  busy?: boolean
  style?: StyleProp<ViewStyle>
  accessibilityLabel?: string
  testID?: string
}) {
  const colors = useColors()
  const height = size === 'lg' ? 50 : size === 'sm' ? 34 : 44
  const palette: Record<ButtonVariant, { bg: string; fg: string; ring?: string }> = {
    primary: { bg: colors.btn, fg: colors.btnInk },
    secondary: { bg: colors.fill, fg: colors.ink },
    outline: { bg: colors.card, fg: colors.ink, ring: colors.hair },
    danger: { bg: colors.card, fg: colors.err, ring: colors.hair },
    destructive: { bg: colors.err, fg: colors.onErr },
    plain: { bg: 'transparent', fg: colors.ink2 },
  }
  const tone = palette[variant]
  const inactive = disabled || busy
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        {
          height,
          paddingHorizontal: size === 'sm' ? 12 : 18,
          borderRadius: pill ? height / 2 : size === 'sm' ? 17 : size === 'lg' ? 14 : 12,
          backgroundColor:
            variant === 'primary' && inactive ? colors.fill : tone.bg,
          boxShadow: tone.ring ? `inset 0 0 0 1px ${tone.ring}` : undefined,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          opacity: pressed ? 0.7 : inactive && variant !== 'primary' ? 0.45 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator
          size="small"
          color={variant === 'primary' ? colors.ink3 : tone.fg}
        />
      ) : icon ? (
        <Icon
          name={icon}
          size={size === 'sm' ? 14 : 18}
          color={variant === 'primary' && inactive ? colors.ink3 : tone.fg}
          strokeWidth={2}
        />
      ) : null}
      <Text
        numberOfLines={1}
        style={{
          fontSize: size === 'lg' ? 16 : size === 'sm' ? 14 : 15,
          fontWeight: '600',
          color: variant === 'primary' && inactive ? colors.ink3 : tone.fg,
        }}
      >
        {title}
      </Text>
    </Pressable>
  )
}

export function IconButton({
  icon,
  label,
  onPress,
  color,
  size = 44,
  iconSize = 22,
  filled,
  disabled,
  strokeWidth,
}: {
  icon: IconName
  label: string
  onPress?(): void
  color?: string
  size?: number
  iconSize?: number
  filled?: boolean
  disabled?: boolean
  strokeWidth?: number
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: filled ? colors.fill : 'transparent',
        opacity: disabled ? 0.4 : pressed ? 0.5 : 1,
      })}
    >
      <Icon name={icon} size={iconSize} color={color ?? colors.ink} strokeWidth={strokeWidth} />
    </Pressable>
  )
}

export function Chip({
  label,
  icon,
  selected,
  onPress,
  chevron,
  tone = 'default',
  disabled,
  mono,
  accessibilityLabel,
  style,
}: {
  label: string
  icon?: IconName
  selected?: boolean
  onPress?(): void
  chevron?: boolean
  tone?: 'default' | 'run' | 'ghost'
  disabled?: boolean
  mono?: boolean
  accessibilityLabel?: string
  style?: StyleProp<ViewStyle>
}) {
  const colors = useColors()
  const bg = selected
    ? colors.btn
    : tone === 'run'
      ? colors.runTint
      : tone === 'ghost'
        ? 'transparent'
        : colors.card
  const fg = selected ? colors.btnInk : tone === 'run' ? colors.run : colors.ink
  const Label = mono ? Mono : Text
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected, disabled }}
      aria-selected={selected}
      aria-disabled={disabled}
      disabled={disabled || !onPress}
      onPress={onPress}
      style={({ pressed }) => [
        {
          height: 36,
          maxWidth: '100%',
          paddingHorizontal: 12,
          borderRadius: 18,
          backgroundColor: bg,
          boxShadow:
            selected || tone === 'run' ? undefined : `inset 0 0 0 1px ${colors.hair}`,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
        },
        style,
      ]}
    >
      {icon && <Icon name={icon} size={15} color={fg} strokeWidth={2} />}
      <Label
        numberOfLines={1}
        style={{
          flexShrink: 1,
          fontSize: 14,
          color: tone === 'ghost' && !selected ? colors.ink3 : fg,
          fontWeight: selected ? '600' : '400',
        }}
      >
        {label}
      </Label>
      {chevron && (
        <Icon name="chevron-down" size={12} color={selected ? fg : colors.ink3} strokeWidth={2.4} />
      )}
    </Pressable>
  )
}

/** iOS 尺寸开关 51×31。 */
export function Switch({
  value,
  onValueChange,
  label,
  disabled,
}: {
  value: boolean
  onValueChange(value: boolean): void
  label: string
  disabled?: boolean
}) {
  const colors = useColors()
  const [position] = useState(() => new Animated.Value(value ? 1 : 0))
  useEffect(() => {
    Animated.timing(position, {
      toValue: value ? 1 : 0,
      duration: 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start()
  }, [value, position])
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      aria-checked={value}
      aria-disabled={disabled}
      disabled={disabled}
      hitSlop={6}
      onPress={() => onValueChange(!value)}
      style={{
        width: 51,
        height: 31,
        borderRadius: 16,
        backgroundColor: value ? colors.ok : colors.switchOff,
        opacity: disabled ? 0.45 : 1,
        padding: 2,
      }}
    >
      <Animated.View
        style={{
          width: 27,
          height: 27,
          borderRadius: 14,
          backgroundColor: '#FFFFFF',
          boxShadow: '0 2px 4px rgba(0,0,0,0.18)',
          transform: [
            { translateX: position.interpolate({ inputRange: [0, 1], outputRange: [0, 20] }) },
          ],
        }}
      />
    </Pressable>
  )
}

export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  disabled,
  height = 38,
  style,
}: {
  label: string
  options: { label: string; value: T; disabled?: boolean }[]
  value: T
  onChange(value: T): void
  disabled?: boolean
  height?: number
  style?: StyleProp<ViewStyle>
}) {
  const colors = useColors()
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={[
        {
          height,
          borderRadius: 10,
          backgroundColor: colors.fill,
          padding: 2,
          flexDirection: 'row',
          gap: 2,
          opacity: disabled ? 0.5 : 1,
        },
        style,
      ]}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ checked: selected, disabled: disabled || option.disabled }}
            aria-checked={selected}
            aria-disabled={disabled || option.disabled}
            disabled={disabled || option.disabled}
            onPress={() => onChange(option.value)}
            style={{
              flex: 1,
              borderRadius: 8,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: selected ? colors.card : 'transparent',
              boxShadow: selected ? '0 1px 3px rgba(28,25,23,0.12)' : undefined,
              opacity: option.disabled ? 0.4 : 1,
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                fontSize: 14,
                color: selected ? colors.ink : colors.ink2,
                fontWeight: selected ? '600' : '400',
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export function Checkbox({
  checked,
  onChange,
  children,
  disabled,
  accessibilityLabel,
}: React.PropsWithChildren<{
  checked: boolean
  onChange(value: boolean): void
  disabled?: boolean
  accessibilityLabel?: string
}>) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked, disabled }}
      aria-checked={checked}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      style={({ pressed }) => ({
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          backgroundColor: checked ? colors.ink : 'transparent',
          boxShadow: checked ? undefined : `inset 0 0 0 1.5px ${colors.chevron}`,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked && <Icon name="check" size={14} color={colors.btnInk} strokeWidth={3} />}
      </View>
      <View style={{ flex: 1 }}>
        {typeof children === 'string' ? (
          <Text style={{ fontSize: 14, lineHeight: 20, color: colors.ink2 }}>{children}</Text>
        ) : (
          children
        )}
      </View>
    </Pressable>
  )
}

export function RadioMark({ selected, tone }: { selected: boolean; tone?: string }) {
  const colors = useColors()
  const color = tone ?? colors.run
  return (
    <View
      style={{
        width: 22,
        height: 22,
        borderRadius: 11,
        backgroundColor: selected ? color : 'transparent',
        boxShadow: selected ? undefined : `inset 0 0 0 1.5px ${colors.chevron}`,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {selected && (
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#FFFFFF' }} />
      )}
    </View>
  )
}

export function CheckMark({ selected, tone }: { selected: boolean; tone?: string }) {
  const colors = useColors()
  const color = tone ?? colors.run
  return (
    <View
      style={{
        width: 22,
        height: 22,
        borderRadius: 6,
        backgroundColor: selected ? color : 'transparent',
        boxShadow: selected ? undefined : `inset 0 0 0 1.5px ${colors.chevron}`,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {selected && <Icon name="check" size={14} color="#FFFFFF" strokeWidth={3} />}
    </View>
  )
}

/** 带说明的选项卡片（提问选项、回退范围等）。 */
export function OptionCard({
  selected,
  title,
  description,
  badge,
  onPress,
  tone = 'run',
  multiple,
  disabled,
  background,
}: {
  selected: boolean
  title: string
  description?: string
  badge?: string
  onPress(): void
  tone?: 'run' | 'err'
  multiple?: boolean
  disabled?: boolean
  background?: string
}) {
  const colors = useColors()
  const accent = tone === 'err' ? colors.err : colors.run
  return (
    <Pressable
      accessibilityRole={multiple ? 'checkbox' : 'radio'}
      accessibilityLabel={description ? `${title}，${description}` : title}
      accessibilityState={{ checked: selected, disabled }}
      aria-checked={selected}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        borderRadius: 14,
        paddingHorizontal: 14,
        paddingVertical: 12,
        flexDirection: 'row',
        gap: 12,
        backgroundColor: selected && tone === 'run' ? colors.sel : (background ?? 'transparent'),
        boxShadow: selected
          ? `inset 0 0 0 1.5px ${accent}`
          : `inset 0 0 0 1px ${colors.hair}`,
        opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
      })}
    >
      <View style={{ marginTop: 1 }}>
        {multiple ? (
          <CheckMark selected={selected} tone={accent} />
        ) : (
          <RadioMark selected={selected} tone={accent} />
        )}
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text style={{ fontSize: 16, lineHeight: 22, fontWeight: '500', color: colors.ink }}>
            {title}
          </Text>
          {badge ? (
            <Text
              style={{
                fontSize: 11.5,
                fontWeight: '600',
                color: colors.attn,
                backgroundColor: colors.attnSoft,
                borderRadius: 6,
                paddingHorizontal: 6,
                paddingVertical: 1,
                overflow: 'hidden',
              }}
            >
              {badge}
            </Text>
          ) : null}
        </View>
        {description ? (
          <Text style={{ fontSize: 13.5, lineHeight: 19, color: colors.ink2 }}>{description}</Text>
        ) : null}
      </View>
    </Pressable>
  )
}

/** 琥珀提示块：用于“会覆盖文件”“需要先做什么”这类风险说明。 */
export function Callout({
  children,
  tone = 'attention',
  icon,
  style,
}: React.PropsWithChildren<{
  tone?: 'attention' | 'error' | 'info'
  icon?: IconName
  style?: StyleProp<ViewStyle>
}>) {
  const colors = useColors()
  const scheme = {
    attention: { bg: colors.attnSoft, fg: colors.attnInk },
    error: { bg: colors.errSoft, fg: colors.err },
    info: { bg: colors.fill, fg: colors.ink2 },
  }[tone]
  return (
    <View
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
      style={[
        {
          flexDirection: 'row',
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 10,
          borderRadius: 12,
          backgroundColor: scheme.bg,
        },
        style,
      ]}
    >
      <View style={{ marginTop: 1 }}>
        <Icon name={icon ?? (tone === 'info' ? 'info' : 'circle-alert')} size={16} color={scheme.fg} strokeWidth={2} />
      </View>
      {typeof children === 'string' ? (
        <Text selectable style={{ flex: 1, fontSize: 13, lineHeight: 19, color: scheme.fg }}>
          {children}
        </Text>
      ) : (
        <View style={{ flex: 1 }}>{children}</View>
      )}
    </View>
  )
}

/**
 * 顶栏下方的一句短提示（几秒后由调用方清掉），用在点完按钮、界面上原本什么都不会变的时候。
 * 不挡触摸；读屏会念出来。
 */
export function Toast({ text, top }: { text: string; top: number }) {
  const colors = useColors()
  useEffect(() => {
    if (text) AccessibilityInfo.announceForAccessibility(text)
  }, [text])
  if (!text) return null
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top, left: 16, right: 16, alignItems: 'center', zIndex: 20 }}>
      <View
        accessibilityLiveRegion="polite"
        style={{
          minHeight: 40,
          paddingLeft: 12,
          paddingRight: 16,
          paddingVertical: 9,
          borderRadius: 20,
          backgroundColor: colors.btn,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          boxShadow: '0 6px 20px rgba(20,19,17,0.18)',
        }}
      >
        <Icon name="check" size={16} color={colors.btnInk} strokeWidth={2.6} />
        <Text style={{ flexShrink: 1, fontSize: 14, lineHeight: 20, fontWeight: '500', color: colors.btnInk }}>{text}</Text>
      </View>
    </View>
  )
}

/** 行内错误：同一错误只在一处出现。 */
export function InlineError({ text, style }: { text?: string; style?: StyleProp<ViewStyle> }) {
  if (!text) return null
  return (
    <Callout tone="error" style={style}>
      {text}
    </Callout>
  )
}

/* ───────────── 状态标记 ───────────── */

export function Spinner({
  size = 16,
  color,
  track,
  thickness = 2,
}: {
  size?: number
  color?: string
  track?: string
  thickness?: number
}) {
  const colors = useColors()
  const reduced = useReducedMotion()
  const [spin] = useState(() => new Animated.Value(0))
  useEffect(() => {
    if (reduced) return
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 1100,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    )
    loop.start()
    return () => loop.stop()
  }, [spin, reduced])
  const r = 6
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        transform: [
          { rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) },
        ],
      }}
    >
      <Svg width={size} height={size} viewBox="0 0 16 16">
        <Circle cx={8} cy={8} r={r} fill="none" stroke={track ?? colors.runSoft} strokeWidth={thickness} />
        <Path
          d="M8 2a6 6 0 0 1 6 6"
          fill="none"
          stroke={color ?? colors.run}
          strokeWidth={thickness}
          strokeLinecap="round"
        />
      </Svg>
    </Animated.View>
  )
}

/** 琥珀“等你”圆点，带缓慢呼吸光圈。 */
export function HaloDot({ size = 9, color }: { size?: number; color?: string }) {
  const colors = useColors()
  const reduced = useReducedMotion()
  const [pulse] = useState(() => new Animated.Value(0))
  const tint = color ?? colors.attnDot
  useEffect(() => {
    if (reduced) return
    const loop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 2200,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      })
    )
    loop.start()
    return () => loop.stop()
  }, [pulse, reduced])
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {!reduced && (
        <Animated.View
          style={{
            position: 'absolute',
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: tint,
            opacity: pulse.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.38, 0, 0] }),
            transform: [
              { scale: pulse.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 2.1, 2.1] }) },
            ],
          }}
        />
      )}
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: tint }} />
    </View>
  )
}

export type StatusKind =
  | 'attention'
  | 'running'
  | 'stalled'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'idle'
  | 'offline'

/** 会话状态标记：等你=琥珀呼吸点、运行=蓝色转圈、卡住=琥珀虚线圈、完成=绿勾、出错=红叹号、停止=灰方块。 */
export function StatusGlyph({ status, size = 16 }: { status: StatusKind; size?: number }) {
  const colors = useColors()
  let glyph: React.ReactNode
  switch (status) {
    case 'attention':
      glyph = <HaloDot />
      break
    case 'running':
      glyph = <Spinner size={size} />
      break
    case 'stalled':
      glyph = (
        <Svg width={size} height={size} viewBox="0 0 16 16">
          <Circle cx={8} cy={8} r={6} fill="none" stroke={colors.attn} strokeWidth={2} strokeDasharray="2.4 3" />
        </Svg>
      )
      break
    case 'done':
      glyph = <Icon name="circle-check" size={size + 1} color={colors.ok} strokeWidth={2} />
      break
    case 'failed':
      glyph = <Icon name="circle-alert" size={size + 1} color={colors.err} strokeWidth={2} />
      break
    case 'stopped':
      glyph = (
        <Svg width={size + 1} height={size + 1} viewBox="0 0 24 24" fill="none" stroke={colors.ink3} strokeWidth={2}>
          <Circle cx={12} cy={12} r={9.5} />
          <Rect x={9} y={9} width={6} height={6} rx={1} />
        </Svg>
      )
      break
    case 'offline':
      glyph = (
        <View style={{ width: 8, height: 8, borderRadius: 4, boxShadow: `inset 0 0 0 1.5px ${colors.faint}` }} />
      )
      break
    default:
      glyph = (
        <Svg width={size} height={size} viewBox="0 0 16 16">
          <Circle cx={8} cy={8} r={6} fill="none" stroke={colors.faint} strokeWidth={2} />
        </Svg>
      )
  }
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: 16, height: 22, alignItems: 'center', justifyContent: 'center' }}
    >
      {glyph}
    </View>
  )
}

export function Dot({ color, size = 7, ring }: { color: string; size?: number; ring?: boolean }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: ring ? 'transparent' : color,
        boxShadow: ring ? `inset 0 0 0 1.5px ${color}` : undefined,
      }}
    />
  )
}

/* ───────────── 代码、差异与文件 ───────────── */

export function CodeBlock({
  children,
  prompt,
  caption,
  numberOfLines,
  style,
}: {
  children: string
  prompt?: string
  caption?: string
  numberOfLines?: number
  style?: StyleProp<ViewStyle>
}) {
  const colors = useColors()
  return (
    <View
      style={[{ backgroundColor: colors.code, borderRadius: 12, padding: 12, gap: 6 }, style]}
    >
      <Mono
        selectable
        numberOfLines={numberOfLines}
        style={{ fontSize: 13.5, lineHeight: 20, color: colors.ink }}
      >
        {prompt ? <Mono style={{ color: colors.ink3 }}>{prompt}</Mono> : null}
        {children}
      </Mono>
      {caption ? (
        <Mono numberOfLines={1} style={{ fontSize: 12, color: colors.ink3 }}>
          {caption}
        </Mono>
      ) : null}
    </View>
  )
}

export function DiffStat({
  added,
  removed,
  size = 13,
}: {
  added?: number
  removed?: number
  size?: number
}) {
  const colors = useColors()
  return (
    <View style={{ flexDirection: 'row', gap: 6 }}>
      {added ? <Mono style={{ fontSize: size, color: colors.add }}>+{added}</Mono> : null}
      {removed ? <Mono style={{ fontSize: size, color: colors.del }}>−{removed}</Mono> : null}
    </View>
  )
}

export type FileStatus = 'M' | 'A' | 'D' | 'R' | '?'
export function FileBadge({ status, size = 22 }: { status: FileStatus; size?: number }) {
  const colors = useColors()
  const scheme =
    status === 'A' || status === '?'
      ? { bg: colors.okSoft, fg: colors.ok }
      : status === 'D'
        ? { bg: colors.errSoft, fg: colors.err }
        : { bg: colors.attnSoft, fg: colors.attn }
  return (
    <View
      accessibilityLabel={
        { M: '已修改', A: '新增', D: '已删除', R: '已重命名', '?': '未跟踪' }[status]
      }
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.27,
        backgroundColor: scheme.bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ fontSize: size * 0.5, fontWeight: '700', color: scheme.fg }}>{status}</Text>
    </View>
  )
}

/** 统一 diff 视图：旧/新行号两栏 + 增删底色；横向可滚，长行不折。 */
const DIFF_LINE = 21
const DIFF_FONT = 12.5
/** GeistMono 字宽 0.6em；全角字符按 1em 估算，用来给虚拟化列表定宽。 */
function diffTextWidth(text: string) {
  let width = 0
  for (let index = 0; index < text.length; index++)
    width += text.charCodeAt(index) > 0x2e7f ? DIFF_FONT : DIFF_FONT * 0.6
  return width
}

function DiffRow({
  line,
  numbers,
  gutter,
  colors,
  rowHeight,
  fixedHeight,
}: {
  line: DiffLine
  numbers: 'both' | 'single'
  gutter: number
  colors: Colors
  rowHeight: number
  fixedHeight?: boolean
}) {
  const add = line.kind === 'add'
  const del = line.kind === 'remove'
  const hunk = line.kind === 'hunk'
  const meta = line.kind === 'meta'
  const rowBg = add ? colors.addBg : del ? colors.delBg : hunk ? colors.hunk : undefined
  const gutterBg = add ? colors.addGutter : del ? colors.delGutter : undefined
  const fg = add ? colors.addInk : del ? colors.delInk : hunk || meta ? colors.cm : colors.ink
  const num = (value?: number) => (value === undefined ? '' : String(value))
  return (
    <View
      style={[
        { flexDirection: 'row', backgroundColor: rowBg, minHeight: rowHeight },
        fixedHeight && { height: rowHeight, overflow: 'hidden' },
      ]}
    >
      {numbers === 'both' ? (
        <>
          <Mono style={{ width: gutter, textAlign: 'right', paddingRight: 6, fontSize: 12, lineHeight: DIFF_LINE, color: del ? colors.del : colors.faint, backgroundColor: gutterBg }}>
            {num(line.before)}
          </Mono>
          <Mono style={{ width: gutter, textAlign: 'right', paddingRight: 6, fontSize: 12, lineHeight: DIFF_LINE, color: add ? colors.add : colors.faint, backgroundColor: gutterBg }}>
            {num(line.after)}
          </Mono>
        </>
      ) : (
        <Mono style={{ width: gutter, textAlign: 'right', paddingRight: 8, fontSize: 12, lineHeight: DIFF_LINE, color: add ? colors.add : del ? colors.del : colors.faint, backgroundColor: gutterBg }}>
          {num(line.after ?? line.before)}
        </Mono>
      )}
      <Mono selectable style={{ flex: fixedHeight ? 1 : undefined, paddingLeft: 8, paddingRight: 16, fontSize: DIFF_FONT, lineHeight: DIFF_LINE, color: fg }}>
        {add ? '+ ' : del ? '- ' : hunk || meta ? '' : '  '}
        {line.text}
      </Mono>
    </View>
  )
}

/**
 * 统一 diff 视图：旧/新行号两栏 + 增删底色；横向可滚，长行不折。
 * virtualized 用于整页差异：按行虚拟化，几千行的新文件也不会一次全部挂载。
 */
export function DiffView({
  lines,
  numbers = 'both',
  style,
  virtualized,
}: {
  lines: DiffLine[]
  numbers?: 'both' | 'single'
  style?: StyleProp<ViewStyle>
  virtualized?: boolean
}) {
  const colors = useColors()
  const { width: screenWidth, fontScale } = useWindowDimensions()
  const [height, setHeight] = useState(0)
  // Text scales natively; its containing row and virtualized offsets must match.
  const rowHeight = Math.ceil(DIFF_LINE * fontScale)
  const gutter = useMemo(() => {
    let largest = 1
    for (const line of lines) largest = Math.max(largest, line.before ?? 0, line.after ?? 0)
    return Math.max(
      (numbers === 'both' ? 30 : 34) * fontScale,
      String(largest).length * 12 * 0.6 * fontScale + (numbers === 'both' ? 6 : 8),
    )
  }, [lines, numbers, fontScale])
  const contentWidth = useMemo(() => {
    if (!virtualized) return 0
    let widest = 0
    for (const line of lines) widest = Math.max(widest, diffTextWidth(line.text) + DIFF_FONT * 1.2)
    const gutters = numbers === 'both' ? gutter * 2 : gutter
    return Math.min(12000 * fontScale, Math.max(screenWidth, Math.ceil(gutters + 8 + widest * fontScale * 1.04 + 16)))
  }, [virtualized, lines, numbers, gutter, screenWidth, fontScale])
  if (virtualized)
    return (
      <View style={[{ flex: 1 }, style]} onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
        {height > 0 ? (
          <ScrollView horizontal bounces={false} contentContainerStyle={{ minWidth: '100%' }}>
            <FlatList
              style={{ width: contentWidth, height }}
              contentContainerStyle={{ paddingVertical: 6 }}
              data={lines}
              keyExtractor={(_, index) => String(index)}
              getItemLayout={(_, index) => ({ length: rowHeight, offset: 6 + rowHeight * index, index })}
              initialNumToRender={60}
              maxToRenderPerBatch={80}
              windowSize={9}
              renderItem={({ item }) => (
                <DiffRow line={item} numbers={numbers} gutter={gutter} colors={colors} rowHeight={rowHeight} fixedHeight />
              )}
            />
          </ScrollView>
        ) : null}
      </View>
    )
  return (
    <ScrollView horizontal style={style} contentContainerStyle={{ minWidth: '100%' }}>
      <View style={{ minWidth: '100%', paddingVertical: 6 }}>
        {lines.map((line, index) => (
          <DiffRow key={index} line={line} numbers={numbers} gutter={gutter} colors={colors} rowHeight={rowHeight} />
        ))}
      </View>
    </ScrollView>
  )
}

/* ───────────── 弹层 ───────────── */

/** 底部弹层：抓手、圆角 28、点遮罩关闭；内容超高时滚动。 */
export function Sheet({
  visible,
  onClose,
  title,
  left,
  right,
  children,
  scroll = true,
  dismissable = true,
  footer,
  background,
}: React.PropsWithChildren<{
  visible: boolean
  onClose(): void
  title?: string
  left?: React.ReactNode
  right?: React.ReactNode
  scroll?: boolean
  dismissable?: boolean
  footer?: React.ReactNode
  background?: string
}>) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const close = () => {
    if (dismissable) onClose()
  }
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close} statusBarTranslucent>
      <KeyboardViewport style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭"
          onPress={close}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.scrim }}
        />
        <View
          accessibilityViewIsModal
          // 遮罩在面板外，VoiceOver 读不到；双指 Z 手势走这里关闭。
          onAccessibilityEscape={close}
          style={{
            maxHeight: '92%',
            flexShrink: 1,
            backgroundColor: background ?? colors.sheet,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            boxShadow: '0 -8px 30px rgba(0,0,0,0.12)',
            paddingBottom: footer ? 0 : Math.max(insets.bottom, 16),
          }}
        >
          <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: title || left || right ? 2 : 8 }}>
            <View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: colors.chevron, opacity: 0.6 }} />
          </View>
          {(title || left || right) && (
            <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 }}>
              <View style={{ flex: 1, alignItems: 'flex-start' }}>{left}</View>
              {title ? (
                <Text numberOfLines={1} style={[type.nav, { color: colors.ink, flexShrink: 1, textAlign: 'center' }]}>
                  {title}
                </Text>
              ) : null}
              <View style={{ flex: 1, alignItems: 'flex-end' }}>{right}</View>
            </View>
          )}
          {scroll ? (
            <ScrollView
              keyboardShouldPersistTaps="handled"
              style={{ flexGrow: 0, flexShrink: 1 }}
              contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 8, gap: 12 }}
            >
              {children}
            </ScrollView>
          ) : (
            <View style={{ paddingHorizontal: 16, gap: 12, flexShrink: 1, minHeight: 0 }}>{children}</View>
          )}
          {footer ? (
            <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: Math.max(insets.bottom, 16) }}>
              {footer}
            </View>
          ) : null}
        </View>
      </KeyboardViewport>
    </Modal>
  )
}

/** 文字按钮（弹层头部的“取消 / 完成”）。 */
export function TextButton({
  title,
  onPress,
  strong,
  disabled,
  color,
}: {
  title: string
  onPress(): void
  strong?: boolean
  disabled?: boolean
  color?: string
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => ({ height: 44, justifyContent: 'center', opacity: disabled ? 0.4 : pressed ? 0.5 : 1 })}
    >
      <Text style={{ fontSize: 16, fontWeight: strong ? '600' : '400', color: color ?? (strong ? colors.ink : colors.ink2) }}>
        {title}
      </Text>
    </Pressable>
  )
}

/** 全屏页面弹层（iOS pageSheet）：头部“取消 · 标题 · 操作”。 */
export function PageSheet({
  visible,
  onClose,
  title,
  left,
  right,
  children,
  background,
}: React.PropsWithChildren<{
  visible: boolean
  onClose(): void
  title: string
  left?: React.ReactNode
  right?: React.ReactNode
  background?: string
}>) {
  const colors = useColors()
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined}
      onRequestClose={onClose}
    >
      <SafeAreaView
        edges={Platform.OS === 'ios' ? ['left', 'right'] : ['top', 'left', 'right']}
        style={[
          { flex: 1, backgroundColor: background ?? colors.bg },
          Platform.OS === 'web' && { paddingTop: 54 },
        ]}
      >
        <View style={{ height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 }}>
          <View style={{ flex: 1, alignItems: 'flex-start' }}>{left ?? <TextButton title="取消" onPress={onClose} />}</View>
          <Text numberOfLines={1} style={[type.nav, { color: colors.ink }]}>
            {title}
          </Text>
          <View style={{ flex: 1, alignItems: 'flex-end' }}>{right}</View>
        </View>
        {children}
      </SafeAreaView>
    </Modal>
  )
}

export type MenuItem =
  | {
      key: string
      label: string
      detail?: string
      icon?: IconName
      value?: string
      valueColor?: string
      destructive?: boolean
      disabled?: boolean
      onPress(): void
    }
  | 'separator'

/** 弹出菜单（iOS UIMenu 样式）。anchor 是相对整块屏幕（含状态栏）的位置，各平台一致。 */
export function Menu({
  visible,
  onClose,
  items,
  header,
  anchor,
  width = 272,
  scrim = true,
}: {
  visible: boolean
  onClose(): void
  items: MenuItem[]
  header?: React.ReactNode
  anchor: { top: number; right?: number; left?: number }
  width?: number
  scrim?: boolean
}) {
  const colors = useColors()
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="关闭菜单"
        onPress={onClose}
        style={{ flex: 1, backgroundColor: scrim ? 'rgba(20,19,17,0.12)' : 'transparent' }}
      />
      <View
        accessibilityRole="menu"
        accessibilityViewIsModal
        onAccessibilityEscape={onClose}
        style={{
          position: 'absolute',
          top: anchor.top,
          right: anchor.left === undefined ? (anchor.right ?? 12) : undefined,
          left: anchor.left,
          width,
          backgroundColor: colors.sheet,
          borderRadius: 14,
          overflow: 'hidden',
          boxShadow: `0 12px 40px rgba(28,25,23,0.2), 0 0 0 0.5px ${colors.hair}`,
        }}
      >
        {header ? (
          <>
            <View style={{ paddingHorizontal: 16, paddingVertical: 10, gap: 2 }}>{header}</View>
            <View style={{ height: 6, backgroundColor: colors.hair }} />
          </>
        ) : null}
        {items.map((item, index) => {
          if (item === 'separator')
            return <View key={`sep-${index}`} style={{ height: 6, backgroundColor: colors.hair }} />
          const next = items[index + 1]
          return (
            <View key={item.key}>
              <Pressable
                accessibilityRole="menuitem"
                accessibilityState={{ disabled: item.disabled }}
                disabled={item.disabled}
                onPress={() => {
                  onClose()
                  item.onPress()
                }}
                style={({ pressed }) => ({
                  minHeight: item.detail ? 58 : 44,
                  paddingHorizontal: 16,
                  paddingVertical: item.detail ? 8 : 0,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  backgroundColor: pressed ? colors.fill : 'transparent',
                  opacity: item.disabled ? 0.4 : 1,
                })}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ fontSize: 16, color: item.destructive ? colors.err : colors.ink }}>{item.label}</Text>
                  {item.detail ? (
                    <Text style={{ fontSize: 12.5, lineHeight: 17, color: colors.ink3 }}>{item.detail}</Text>
                  ) : null}
                </View>
                {item.value ? (
                  <Text style={{ fontSize: 14, color: item.valueColor ?? colors.ink3 }}>{item.value}</Text>
                ) : null}
                {item.icon ? (
                  <Icon name={item.icon} size={19} color={item.destructive ? colors.err : colors.ink} />
                ) : null}
              </Pressable>
              {next && next !== 'separator' ? (
                <View style={{ height: 0.5, backgroundColor: colors.hair }} />
              ) : null}
            </View>
          )
        })}
      </View>
    </Modal>
  )
}

/* ───────────── 输入与空状态 ───────────── */

/** 分组表单里的一行输入：左标签、右输入。 */
export function FieldRow({
  label,
  trailing,
  mono,
  ...props
}: TextInputProps & { label: string; trailing?: React.ReactNode; mono?: boolean }) {
  const colors = useColors()
  return (
    <View style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 14, paddingRight: trailing ? 8 : 14 }}>
      <Text style={{ fontSize: 16, width: 72, color: colors.ink }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.ink3}
        autoCapitalize="none"
        autoCorrect={false}
        {...props}
        style={[
          { flex: 1, minWidth: 0, fontSize: mono ? 15 : 16, color: colors.ink, paddingVertical: 12 },
          mono && { fontFamily: monoFont },
          Platform.OS === 'web' && ({ outlineStyle: 'none' } as object),
          props.style,
        ]}
      />
      {trailing}
    </View>
  )
}

export function SearchField({
  value,
  onChangeText,
  placeholder,
  autoFocus,
  onFocus,
  editable = true,
}: {
  value: string
  onChangeText(value: string): void
  placeholder: string
  autoFocus?: boolean
  onFocus?(): void
  editable?: boolean
}) {
  const colors = useColors()
  return (
    <View style={{ height: 40, borderRadius: 12, backgroundColor: colors.fill, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 10 }}>
      <Icon name="search" size={17} color={colors.ink3} strokeWidth={2} />
      <TextInput
        accessibilityLabel={placeholder}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.ink3}
        autoFocus={autoFocus}
        onFocus={onFocus}
        editable={editable}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={[
          { flex: 1, minWidth: 0, fontSize: 16, color: colors.ink, paddingVertical: 8 },
          Platform.OS === 'web' && ({ outlineStyle: 'none' } as object),
        ]}
      />
      {value ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="清除搜索"
          hitSlop={8}
          onPress={() => onChangeText('')}
          style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: colors.chevron, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name="x" size={10} color="#FFFFFF" strokeWidth={3.5} />
        </Pressable>
      ) : null}
    </View>
  )
}

export function EmptyState({
  icon,
  title,
  detail,
  action,
}: {
  icon?: IconName
  title: string
  detail?: string
  action?: React.ReactNode
}) {
  const colors = useColors()
  return (
    <View style={{ alignItems: 'center', paddingVertical: 40, paddingHorizontal: 24, gap: 10 }}>
      {icon ? (
        <View style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}>
          <Icon name={icon} size={24} color={colors.ink2} />
        </View>
      ) : null}
      <Text style={[type.headline, { color: colors.ink, textAlign: 'center' }]}>{title}</Text>
      {detail ? (
        <Text style={{ fontSize: 14, lineHeight: 21, color: colors.ink3, textAlign: 'center' }}>{detail}</Text>
      ) : null}
      {action ? <View style={{ marginTop: 8, alignSelf: 'stretch' }}>{action}</View> : null}
    </View>
  )
}

export function Loading() {
  const colors = useColors()
  return <ActivityIndicator style={{ padding: 30 }} color={colors.ink3} />
}

/** cc-haha 标识（陶土底 + 舷窗环），全应用唯一的品牌色出现处。 */
export function BrandMark({ size = 22 }: { size?: number }) {
  const colors = useColors()
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.27, backgroundColor: colors.brand, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: size * 0.46, height: size * 0.46, borderRadius: size, boxShadow: `inset 0 0 0 ${Math.max(2, size * 0.09)}px ${colors.brandSoft}` }} />
    </View>
  )
}
