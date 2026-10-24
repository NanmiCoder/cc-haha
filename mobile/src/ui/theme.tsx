import React from 'react'
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useColorScheme,
  type TextInputProps,
  type ViewStyle,
  type StyleProp,
} from 'react-native'
import { Text } from './Text'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { Feather } from '@expo/vector-icons'
import { LinearGradient } from 'expo-linear-gradient'
import Svg, { Circle, Path } from 'react-native-svg'
import { router } from 'expo-router'
import { usePreferences } from '../state/PreferencesContext'

export const c = {
  paper: '#E8E7E3',
  surface: '#F4F3F0',
  ink: '#23201C',
  muted: '#6A655E',
  line: '#D3D0C9',
  accent: '#B4553A',
  tint: '#E2D3C8',
  green: '#8FA35A',
  greenTint: '#E1E4D7',
  red: '#B24B3C',
  inset: '#E1DFDA',
  secondary: '#4A4640',
  highlight: '#FFFFFF',
  well: '#22211E',
  screenText: '#A9C27A',
  amber: '#E39A3B',
}
export type Colors = typeof c
const darkColors: Colors = {
  ...c,
  paper: '#1C1B19',
  surface: '#292724',
  ink: '#ECE8E0',
  muted: '#9C968C',
  line: '#0E0D0C',
  tint: '#44332B',
  greenTint: '#353A2C',
  inset: '#141311',
  secondary: '#C4BEB4',
  highlight: '#3C3934',
  well: '#141311',
}
export const mono = Platform.select({
  ios: 'GeistMono',
  android: 'GeistMono',
  default: 'GeistMono',
})
export const raisedShadow =
  'inset 0 1px 0 #FFFFFF, 0 1px 2px rgba(60,45,30,0.12), 0 6px 16px rgba(60,45,30,0.07)'
function styles(colors: Colors) {
  return StyleSheet.create({
    page: { flex: 1, backgroundColor: colors.paper },
    body: {
      paddingHorizontal: 16,
      paddingTop: 18,
      paddingBottom: 36,
      gap: 22,
      width: '100%',
      maxWidth: 800,
      alignSelf: 'center',
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    between: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    title: {
      fontFamily: 'Geist',
      fontSize: 24,
      lineHeight: 30,
      color: colors.ink,
      fontWeight: '600',
    },
    text: {
      fontFamily: 'Geist',
      color: colors.ink,
      fontSize: 15,
      lineHeight: 23,
    },
    small: {
      fontFamily: 'Geist',
      color: colors.muted,
      fontSize: 12,
      lineHeight: 18,
    },
    label: {
      fontFamily: 'Geist',
      color: colors.muted,
      fontSize: 12,
      fontWeight: '500',
    },
    card: {
      padding: 16,
      backgroundColor: colors.surface,
      borderRadius: 18,
      gap: 12,
      boxShadow:
        colors === c
          ? raisedShadow
          : 'inset 0 1px 0 rgba(255,255,255,0.06), 0 1px 2px rgba(0,0,0,0.45), 0 6px 16px rgba(0,0,0,0.35)',
    },
    input: {
      fontFamily: 'Geist',
      borderRadius: 13,
      paddingHorizontal: 14,
      paddingVertical: 12,
      color: colors.ink,
      fontSize: 15,
      backgroundColor: colors.inset,
      minHeight: 46,
      boxShadow: 'inset 0 1px 3px rgba(40,30,20,0.18)',
    },
    button: {
      minHeight: 48,
      paddingVertical: 13,
      paddingHorizontal: 18,
      borderRadius: 15,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: 8,
    },
    buttonText: { fontSize: 15, fontWeight: '600', color: '#fff' },
    iconButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors === c ? '#F2F1EE' : '#2C2A27',
      boxShadow:
        colors === c
          ? 'inset 0 1px 0 #FFFFFF, 0 1px 2px rgba(60,45,30,0.14), 0 3px 8px rgba(60,45,30,0.08)'
          : 'inset 0 1px 0 rgba(255,255,255,0.06), 0 2px 5px rgba(0,0,0,0.5)',
    },
    header: {
      minHeight: 40,
      paddingHorizontal: 16,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
  })
}
export const s = styles(c)
const darkStyles = styles(darkColors)
export function useTheme() {
  const { preferences, update } = usePreferences()
  const system = useColorScheme()
  const dark =
    preferences.appearance === 'dark' ||
    (preferences.appearance === 'system' && system === 'dark')
  return {
    colors: dark ? darkColors : c,
    styles: dark ? darkStyles : s,
    dark,
    appearance: preferences.appearance,
    setAppearance: (appearance: 'light' | 'dark' | 'system') =>
      update({ appearance }),
  }
}
export function Icon({
  name,
  size = 18,
  color,
}: {
  name: React.ComponentProps<typeof Feather>['name']
  size?: number
  color?: string
}) {
  const { colors } = useTheme()
  if (name === 'sliders')
    return (
      <Svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color ?? colors.secondary}
        strokeWidth={2}
        strokeLinecap="round"
      >
        <Path d="M10 6h10M4 18h10" />
        <Circle cx={7} cy={6} r={3} />
        <Circle cx={17} cy={18} r={3} />
      </Svg>
    )
  return <Feather name={name} size={size} color={color ?? colors.secondary} />
}
export function IconButton({
  name,
  label,
  onPress,
}: {
  name: React.ComponentProps<typeof Feather>['name']
  label: string
  onPress(): void
}) {
  const { styles } = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.iconButton,
        pressed && { opacity: 0.65, transform: [{ translateY: 1 }] },
      ]}
      onPress={onPress}
    >
      <Icon name={name} />
    </Pressable>
  )
}
export const CircleButton = IconButton
export function Button({
  title,
  onPress,
  secondary,
  disabled,
  busy,
  danger,
  testID,
}: {
  title: string
  onPress(): void
  secondary?: boolean
  disabled?: boolean
  busy?: boolean
  danger?: boolean
  testID?: string
}) {
  const { colors, styles } = useTheme()
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && {
          backgroundColor: colors.surface,
          boxShadow: raisedShadow,
        },
        danger && { backgroundColor: colors.red },
        (disabled || busy) && { opacity: 0.45 },
        pressed && { opacity: 0.75 },
      ]}
    >
      {busy && <ActivityIndicator color={secondary ? colors.ink : '#fff'} />}
      <Text style={[styles.buttonText, secondary && { color: colors.ink }]}>
        {title}
      </Text>
    </Pressable>
  )
}
export function PrimaryButton({
  title,
  onPress,
  disabled,
  busy,
  danger,
  secondary,
  icon,
  style,
}: React.ComponentProps<typeof Button> & {
  icon?: React.ComponentProps<typeof Feather>['name']
  style?: StyleProp<ViewStyle>
}) {
  const { colors } = useTheme()
  if (secondary)
    return (
      <Button
        title={title}
        onPress={onPress}
        secondary
        disabled={disabled}
        busy={busy}
        danger={danger}
      />
    )
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        {
          borderRadius: 18,
          boxShadow: pressed
            ? '0 1px 0 #7E3824'
            : '0 3px 0 #7E3824, 0 10px 18px rgba(126,56,36,0.25)',
          opacity: disabled || busy ? 0.45 : 1,
          transform: [{ translateY: pressed ? 2 : 0 }],
        },
        style,
      ]}
    >
      <LinearGradient
        colors={danger ? [colors.red, '#84382F'] : ['#C1603F', '#A64D33']}
        style={{
          minHeight: 56,
          borderRadius: 18,
          flexDirection: 'row',
          gap: 8,
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.28)',
        }}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          icon && <Icon name={icon} color="#fff" size={18} />
        )}
        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>
          {title}
        </Text>
      </LinearGradient>
    </Pressable>
  )
}
export function Raised({
  children,
  style,
}: React.PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const { styles } = useTheme()
  return (
    <View style={[styles.card, { padding: 0, gap: 0 }, style]}>{children}</View>
  )
}
export function Inset({
  children,
  style,
}: React.PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const { colors, dark } = useTheme()
  return (
    <View
      style={[
        {
          backgroundColor: colors.inset,
          borderRadius: 18,
          boxShadow: `inset 0 1px 3px rgba(40,30,20,${dark ? '.6' : '.14'}), 0 1px 0 ${dark ? '#33312D' : '#F6F5F2'}`,
        },
        style,
      ]}
    >
      {children}
    </View>
  )
}
export function Divider({ inset = 16 }: { inset?: number }) {
  const { colors } = useTheme()
  return (
    <View
      style={{
        height: 1,
        marginHorizontal: inset,
        backgroundColor: colors.line,
        boxShadow: `0 1px 0 ${colors.highlight}`,
      }}
    />
  )
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const { colors, styles } = useTheme()
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        textContentType="none"
        importantForAutofill="no"
        {...props}
        secureTextEntry={props.secureTextEntry ?? false}
        style={[styles.input, props.style]}
      />
    </View>
  )
}
export function PageHeader({
  title,
  subtitle,
  right,
  back = true,
  onBack,
}: {
  title?: string
  subtitle?: string
  right?: React.ReactNode
  back?: boolean
  onBack?(): void
}) {
  const { colors, styles } = useTheme()
  return (
    <View
      style={[styles.header, { marginTop: 7, marginBottom: title ? 0 : 2 }]}
    >
      {back && (
        <CircleButton
          name="chevron-left"
          label="返回"
          onPress={
            onBack ??
            (() => (router.canGoBack() ? router.back() : router.replace('/')))
          }
        />
      )}
      <View style={{ flex: 1 }}>
        {subtitle && (
          <>
            <Text
              numberOfLines={1}
              style={{ color: colors.ink, fontSize: 15, fontWeight: '600' }}
            >
              {title}
            </Text>
            <Text style={styles.small}>{subtitle}</Text>
          </>
        )}
      </View>
      {right}
    </View>
  )
}
export function Screen({
  title,
  subtitle,
  children,
  back = true,
  right,
  scroll = true,
}: React.PropsWithChildren<{
  title?: string
  subtitle?: string
  back?: boolean
  right?: React.ReactNode
  scroll?: boolean
}>) {
  const { styles } = useTheme()
  const body = (
    <>
      {title && !subtitle && (
        <Text
          style={[
            styles.title,
            { marginHorizontal: 4, marginTop: -4, marginBottom: -4 },
          ]}
        >
          {title}
        </Text>
      )}
      {children}
    </>
  )
  return (
    <SafeAreaView
      style={[styles.page, Platform.OS === 'web' && { paddingTop: 47 }]}
      edges={['top', 'left', 'right']}
    >
      <PageHeader title={title} subtitle={subtitle} back={back} right={right} />
      {scroll ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.body}
        >
          {body}
        </ScrollView>
      ) : (
        <View style={{ flex: 1 }}>{body}</View>
      )}
    </SafeAreaView>
  )
}
export function BottomBar({ children }: React.PropsWithChildren) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <View
      style={{
        paddingTop: 14,
        paddingHorizontal: 20,
        paddingBottom: Math.max(insets.bottom, 18),
        backgroundColor: colors.paper,
        boxShadow: `0 -1px 0 ${colors.line}, 0 -2px 0 ${colors.highlight}`,
      }}
    >
      {children}
    </View>
  )
}
export function Toggle({
  value,
  onChange,
  label,
  disabled,
}: {
  value: boolean
  onChange(value: boolean): void
  label: string
  disabled?: boolean
}) {
  const { colors } = useTheme()
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={{
        width: 46,
        height: 26,
        borderRadius: 13,
        backgroundColor: value ? colors.green : colors.line,
        opacity: disabled ? 0.4 : 1,
        boxShadow: 'inset 0 1px 3px rgba(40,50,20,0.35)',
        padding: 3,
        alignItems: value ? 'flex-end' : 'flex-start',
      }}
    >
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          backgroundColor: '#F6F5F2',
          boxShadow: 'inset 0 1px 0 #FFFFFF, 0 1px 3px rgba(40,30,20,0.3)',
        }}
      />
    </Pressable>
  )
}
export function Segment<T extends string | number>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string
  options: { label: string; value: T }[]
  value: T
  onChange(value: T): void
  disabled?: boolean
}) {
  const { colors, dark } = useTheme()
  return (
    <Inset
      style={{
        flexDirection: 'row',
        padding: 3,
        gap: 3,
        minHeight: 42,
        borderRadius: 13,
      }}
    >
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={label}
        style={{ flexDirection: 'row', flex: 1, gap: 3 }}
      >
        {options.map((option) => (
          <Pressable
            key={String(option.value)}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ checked: option.value === value, disabled }}
            onPress={() => onChange(option.value)}
            style={{
              flex: 1,
              minHeight: 36,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 10,
              backgroundColor:
                option.value === value ? colors.surface : 'transparent',
              boxShadow:
                option.value === value
                  ? `inset 0 1px 0 ${colors.highlight}, 0 1px 2px rgba(60,45,30,${dark ? '.5' : '.2'})`
                  : undefined,
            }}
          >
            <Text
              style={{
                fontSize: 13,
                color: colors.secondary,
                fontWeight: option.value === value ? '600' : '400',
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </Inset>
  )
}
export function Notice({
  text,
  error = false,
}: {
  text?: string
  error?: boolean
}) {
  const { colors, styles } = useTheme()
  if (!text) return null
  return (
    <View
      accessibilityRole="alert"
      style={{
        padding: 14,
        borderRadius: 14,
        backgroundColor: error ? colors.tint : colors.greenTint,
      }}
    >
      <Text
        selectable
        style={[styles.small, { color: error ? colors.red : colors.secondary }]}
      >
        {text}
      </Text>
    </View>
  )
}
export function Row({
  title,
  detail,
  icon,
  onPress,
  trailing,
  style,
}: {
  title: string
  detail?: string
  icon?: React.ComponentProps<typeof Feather>['name']
  onPress?: () => void
  trailing?: React.ReactNode
  style?: ViewStyle
}) {
  const { colors, styles } = useTheme()
  return (
    <Pressable
      accessible={Boolean(onPress)}
      accessibilityRole={onPress ? 'button' : undefined}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        styles.row,
        { paddingVertical: 13, minHeight: 52 },
        pressed && { opacity: 0.6 },
        style,
      ]}
    >
      {icon && <Icon name={icon} color={colors.muted} size={16} />}
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={styles.text}>{title}</Text>
        {detail && (
          <Text numberOfLines={2} style={styles.small}>
            {detail}
          </Text>
        )}
      </View>
      {trailing ??
        (onPress && (
          <Icon name="chevron-right" size={14} color={colors.muted} />
        ))}
    </Pressable>
  )
}
export function Empty({ title, detail }: { title: string; detail: string }) {
  const { styles } = useTheme()
  return (
    <View style={{ paddingVertical: 26, gap: 12 }}>
      <Text style={[styles.title, { fontSize: 22 }]}>{title}</Text>
      <Text style={styles.small}>{detail}</Text>
    </View>
  )
}
export function Loading() {
  const { colors } = useTheme()
  return <ActivityIndicator style={{ padding: 30 }} color={colors.accent} />
}
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : '操作未完成，请重试'
