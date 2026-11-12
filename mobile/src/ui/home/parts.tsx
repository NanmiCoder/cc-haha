import React, { Fragment, useEffect, useState } from 'react'
import { Pressable, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import { Text } from '../Text'
import { Dot, Mono, useColors } from '../kit'
import { elapsedLabel } from '../../core/dashboard'
import { highlightParts, type StatusTone } from './homeModel'

/** Current time refreshed every intervalMs; only small components that need ticking seconds rerender. */
export function useNow(intervalMs: number, enabled = true) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs, enabled])
  return now
}

export function useToneColor() {
  const colors = useColors()
  return (tone: StatusTone | 'ink3') =>
    tone === 'ok'
      ? colors.ok
      : tone === 'err'
        ? colors.err
        : tone === 'attn'
          ? colors.attn
          : tone === 'ink3'
            ? colors.ink3
            : colors.faint
}

/** Status dot: hollow ring when offline, solid dot otherwise. */
export function StatusDot({ tone, size = 7 }: { tone: StatusTone; size?: number }) {
  const color = useToneColor()(tone)
  return <Dot color={color} size={size} ring={tone === 'faint'} />
}

/** A "waiting" dot without the breathing halo (used in search results and offline snapshots, which are not live states). */
export function PlainDot() {
  const colors = useColors()
  return (
    <View style={{ width: 16, height: 22, alignItems: 'center', justifyContent: 'center' }}>
      <Dot color={colors.attnDot} size={9} />
    </View>
  )
}

/** Card-style list container: radius 18, hairlines between rows inset to where the title starts. */
export function RowGroup({
  children,
  style,
}: React.PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const colors = useColors()
  const items = React.Children.toArray(children).filter(Boolean)
  return (
    <View style={[{ backgroundColor: colors.card, borderRadius: 18, overflow: 'hidden' }, style]}>
      {items.map((child, index) => (
        <Fragment key={index}>
          {index > 0 && (
            <View style={{ height: 1, backgroundColor: colors.hair, marginLeft: 40 }} />
          )}
          {child}
        </Fragment>
      ))}
    </View>
  )
}

/** Task row: status marker · title/subline · time on the right. */
export function TaskRow({
  glyph,
  title,
  titleWeight = '500',
  subtitle,
  subtitleColor,
  subtitleMono,
  trailing,
  onPress,
  accessibilityLabel,
}: {
  glyph: React.ReactNode
  title: React.ReactNode
  titleWeight?: '500' | '600'
  subtitle?: React.ReactNode
  subtitleColor?: string
  subtitleMono?: boolean
  trailing?: React.ReactNode
  onPress?(): void
  accessibilityLabel?: string
}) {
  const colors = useColors()
  const Sub = subtitleMono ? Mono : Text
  const body = (
    <>
      <View style={{ width: 16, height: 22, alignItems: 'center', justifyContent: 'center' }}>
        {glyph}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text
          numberOfLines={1}
          style={{ fontSize: 16, lineHeight: 22, fontWeight: titleWeight, color: colors.ink }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Sub
            numberOfLines={1}
            style={
              subtitleMono
                ? { fontSize: 12.5, lineHeight: 18, color: subtitleColor ?? colors.ink3 }
                : { fontSize: 13, lineHeight: 18, color: subtitleColor ?? colors.ink3 }
            }
          >
            {subtitle}
          </Sub>
        ) : null}
      </View>
      {trailing}
    </>
  )
  const base: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 13,
    paddingHorizontal: 14,
  }
  if (!onPress) return <View style={base}>{body}</View>
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [base, pressed && { backgroundColor: colors.fill }]}
    >
      {body}
    </Pressable>
  )
}

/** Plain time on the right (relative), optionally with an "unviewed" blue dot. */
export function TimeLabel({ text, unread }: { text: string; unread?: boolean }) {
  const colors = useColors()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 23 }}>
      {unread ? <Dot color={colors.run} size={8} /> : null}
      <Text style={{ fontSize: 13, lineHeight: 23, color: colors.ink3 }}>{text}</Text>
    </View>
  )
}

/** Duration ticking every second from startedAt (m:ss / h:mm:ss). */
export function Elapsed({ since, style }: { since: number; style?: StyleProp<TextStyle> }) {
  const colors = useColors()
  const now = useNow(1000)
  return (
    <Mono style={[{ fontSize: 13, lineHeight: 23, color: colors.ink2 }, style]}>
      {elapsedLabel(since, now)}
    </Mono>
  )
}

/** Keyword highlight in the title (mark background). */
export function Highlight({ text, query }: { text: string; query: string }) {
  const colors = useColors()
  return (
    <>
      {highlightParts(text, query).map((part, index) =>
        part.match ? (
          <Text key={index} style={{ backgroundColor: colors.mark, borderRadius: 3 }}>
            {part.text}
          </Text>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        )
      )}
    </>
  )
}
