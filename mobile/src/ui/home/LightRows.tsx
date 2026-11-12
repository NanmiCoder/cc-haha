import type { ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Text } from '../Text'
import { Icon, IconButton, Mono, StatusGlyph, useColors, type StatusKind } from '../kit'
import { relativeLabel, type DashboardRow } from '../../core/dashboard'
import { pendingWhileOffline } from './homeModel'
import {
  projectBadge,
  projectTrailing,
  recentLine,
  rowState,
  stateWords,
  type LineTone,
  type ProjectGroup,
  type RowState,
} from './homeList'
import { Elapsed, TimeLabel, useNow } from './parts'
import { plural } from '../../core/plural'

const floatShadow = (hair: string) =>
  `0 1px 2px rgba(28,25,23,0.06), 0 4px 14px rgba(28,25,23,0.09), 0 0 0 1px ${hair}`

const glyphOf: Record<RowState, StatusKind> = {
  waiting: 'attention',
  running: 'running',
  stalled: 'stalled',
  done: 'done',
  review: 'done',
  failed: 'failed',
  stopped: 'stopped',
  unknown: 'idle',
}

const title = (row: DashboardRow) => row.session.title || 'Untitled task'

function useTone() {
  const colors = useColors()
  return (tone: LineTone | 'run') =>
    tone === 'attn'
      ? colors.attn
      : tone === 'err'
        ? colors.err
        : tone === 'run'
          ? colors.run
          : colors.ink3
}

/* ───────────── Top floating buttons ───────────── */

/** 44pt White round floating button. */
export function FloatButton({
  label,
  onPress,
  disabled,
  children,
}: {
  label: string
  onPress(): void
  disabled?: boolean
  children: ReactNode
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: colors.card,
        boxShadow: floatShadow(colors.hair),
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      {children}
    </Pressable>
  )
}

/* ───────────── Scope pills ───────────── */

export function FilterPills<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; count?: number }[]
  value: T
  onChange(value: T): void
}) {
  const colors = useColors()
  const tone = (option: T) => (option === 'waiting' ? colors.attn : colors.run)
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel="View by status"
      style={{ flexDirection: 'row', gap: 4, marginHorizontal: -6 }}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.count ? `${option.label} ${option.count}` : option.label}
            accessibilityState={{ checked: selected }}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => ({
              height: 40,
              paddingHorizontal: 14,
              borderRadius: 20,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              backgroundColor: selected ? colors.fill : 'transparent',
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text
              style={{
                fontSize: 15,
                fontWeight: selected ? '600' : '500',
                color: selected ? colors.ink : colors.ink2,
              }}
            >
              {option.label}
            </Text>
            {option.count ? (
              <Text style={{ fontSize: 15, fontWeight: '600', color: tone(option.value) }}>
                {option.count}
              </Text>
            ) : null}
          </Pressable>
        )
      })}
    </View>
  )
}

/** Fixed column for the leading status marker: 16×24, matching .lead in the design. */
function Lead({ children }: { children: ReactNode }) {
  return <View style={{ width: 16, height: 24, alignItems: 'center', justifyContent: 'center' }}>{children}</View>
}

/** Group title (design: 18 above, 6 below; 4 below "Projects", followed directly by project rows). */
export function SectionTitle({ children, bottom = 6 }: { children: string; bottom?: number }) {
  const colors = useColors()
  return (
    <Text
      accessibilityRole="header"
      style={{
        fontSize: 15,
        lineHeight: 18,
        fontWeight: '600',
        color: colors.ink,
        paddingTop: 18,
        paddingBottom: bottom,
      }}
    >
      {children}
    </Text>
  )
}

/* ───────────── Session rows ───────────── */

/** "Recent" row: status marker · title + subline (project · status/current step) · time or ticking seconds on the right. */
export function RecentRow({
  row,
  background,
  onPress,
}: {
  row: DashboardRow
  /** Number of background tasks running in this session; hidden when unknown. */
  background?: number
  onPress?(): void
}) {
  const colors = useColors()
  const toneColor = useTone()
  const now = useNow(30000, rowState(row) === 'stalled')
  const state = rowState(row)
  const line = recentLine(row, now)
  const Sub = line.mono ? Mono : Text
  const body = (
    <>
      <Lead>
        <StatusGlyph status={glyphOf[state]} />
      </Lead>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          numberOfLines={1}
          style={{ fontSize: 16, lineHeight: 23, fontWeight: state === 'review' ? '600' : '500', color: colors.ink }}
        >
          {title(row)}
        </Text>
        <Sub
          numberOfLines={1}
          style={{
            fontSize: line.mono ? 12.5 : 13,
            lineHeight: 18,
            color: toneColor(line.tone),
          }}
        >
          {line.text}
        </Sub>
      </View>
      {state === 'running' || state === 'stalled' ? (
        <View style={{ alignItems: 'flex-end', gap: 2 }}>
          {row.activity?.startedAt ? <Elapsed since={row.activity.startedAt} /> : null}
          {background ? (
            <Text style={{ fontSize: 12, lineHeight: 16, color: colors.ink3 }}>background {background}</Text>
          ) : null}
        </View>
      ) : (
        <TimeLabel text={relativeLabel(row.session.modifiedAt)} unread={state === 'review'} />
      )}
    </>
  )
  const base = {
    minHeight: 60,
    flexDirection: 'row' as const,
    alignItems: 'flex-start' as const,
    gap: 12,
    paddingVertical: 6,
    paddingHorizontal: 16,
    marginHorizontal: -16,
  }
  if (!onPress) return <View style={base}>{body}</View>
  const words = stateWords(state)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title(row), words, line.text].filter(Boolean).join(', ')}
      onPress={onPress}
      style={({ pressed }) => [base, pressed && { backgroundColor: colors.fill }]}
    >
      {body}
    </Pressable>
  )
}

/** Snapshot from before disconnecting: waiting and running cannot be confirmed, so just say so; finished ones show as usual. */
export function OfflineRow({ row }: { row: DashboardRow }) {
  const colors = useColors()
  const state = row.activity?.activityState
  if (state !== 'waiting' && state !== 'running') return <RecentRow row={row} />
  return (
    <View
      style={{
        minHeight: 60,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        paddingVertical: 6,
        paddingHorizontal: 16,
        marginHorizontal: -16,
      }}
    >
      <Lead>
        <StatusGlyph status={state === 'waiting' ? 'attention' : 'idle'} />
      </Lead>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ fontSize: 16, lineHeight: 23, fontWeight: '500', color: colors.ink }}>
          {title(row)}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>
          {state === 'waiting' ? pendingWhileOffline(row.activity) : 'Was running when disconnected · status unknown'}
        </Text>
      </View>
    </View>
  )
}

/* ───────────── Projects ───────────── */

/** Project header: folder + project name (tap to expand/collapse); when collapsed the right side hints someone is waiting/running, and the far right starts a new task in this project. */
export function ProjectHeader({
  group,
  canStart,
  onToggle,
  onNewTask,
}: {
  group: ProjectGroup
  canStart: boolean
  onToggle(): void
  onNewTask(): void
}) {
  const colors = useColors()
  const toneColor = useTone()
  const badge = group.expanded ? null : projectBadge(group)
  return (
    <View style={{ height: 48, flexDirection: 'row', alignItems: 'center', marginHorizontal: -16, paddingLeft: 16, paddingRight: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${group.name}, ${plural(group.total, 'task')}${badge ? `, ${badge.text}` : ''}`}
        accessibilityState={group.expandable ? { expanded: group.expanded } : undefined}
        disabled={!group.expandable}
        onPress={onToggle}
        style={({ pressed }) => ({
          flex: 1,
          minWidth: 0,
          height: 48,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <View style={{ width: 22, alignItems: 'center' }}>
          <Icon name="folder" size={22} color={colors.ink2} />
        </View>
        <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 16, fontWeight: '600', color: colors.ink }}>
          {group.name}
        </Text>
        {badge ? (
          <Text style={{ marginLeft: 'auto', paddingRight: 2, fontSize: 13, color: toneColor(badge.tone) }}>
            {badge.text}
          </Text>
        ) : (
          <Text style={{ marginLeft: 'auto', paddingRight: 2, fontSize: 13, color: colors.ink3 }}>
            {plural(group.total, 'task')}
          </Text>
        )}
      </Pressable>
      <IconButton
        icon="compose"
        label={`New task in ${group.name}`}
        color={colors.ink2}
        iconSize={20}
        strokeWidth={1.75}
        disabled={!canStart}
        onPress={onNewTask}
      />
    </View>
  )
}

/** Indented session rows under a project: title only; states needing attention are text on the right, running ticks seconds, others show relative time. */
export function ProjectSessionRow({
  row,
  onPress,
}: {
  row: DashboardRow
  onPress(): void
}) {
  const colors = useColors()
  const toneColor = useTone()
  const state = rowState(row)
  const trailing = projectTrailing(row)
  const lit = state === 'waiting' || state === 'running' || state === 'stalled' || state === 'failed'
  const words = stateWords(state)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title(row), words].filter(Boolean).join(', ')}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 0,
        paddingLeft: 16,
        paddingRight: 16,
        marginHorizontal: -16,
        backgroundColor: pressed ? colors.fill : 'transparent',
      })}
    >
      {/* The status icon sits in the same column as the project header folder icon, with the title aligned to the project name. */}
      <View style={{ width: 22, alignItems: 'center' }}>
        {lit ? <StatusGlyph status={glyphOf[state]} /> : null}
      </View>
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 15, color: colors.ink }}>
        {title(row)}
      </Text>
      {trailing ? (
        <Text style={{ fontSize: 13, color: toneColor(trailing.tone) }}>{trailing.text}</Text>
      ) : state === 'running' && row.activity?.startedAt ? (
        <Elapsed since={row.activity.startedAt} />
      ) : (
        <TimeLabel text={relativeLabel(row.session.modifiedAt)} unread={state === 'review'} />
      )}
    </Pressable>
  )
}

/** "Show N earlier" under a project. */
export function MoreSessions({ count, onPress }: { count: number; onPress(): void }) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        justifyContent: 'center',
        paddingLeft: 50,
        marginHorizontal: -16,
        backgroundColor: pressed ? colors.fill : 'transparent',
      })}
    >
      <Text style={{ fontSize: 14, color: colors.ink2 }}>Show {count} earlier</Text>
    </Pressable>
  )
}

/* ───────────── Bottom floating input ───────────── */

/** Fake input: tapping anywhere goes to the new task page (the real input is there), looking the same as the session page input. */
export function FloatingComposer({
  disabled,
  onPress,
}: {
  disabled?: boolean
  onPress(): void
}) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 12, paddingBottom: Math.max(insets.bottom, 12) }}
    >
      <LinearGradient
        pointerEvents="none"
        colors={[`${colors.bg}00`, `${colors.bg}E6`, colors.bg]}
        locations={[0, 0.45, 1]}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, top: -40 }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New task, what should the computer do"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => ({
          minHeight: 56,
          borderRadius: 22,
          backgroundColor: colors.card,
          boxShadow: `0 1px 2px rgba(28,25,23,0.05), 0 6px 20px rgba(28,25,23,0.10), 0 0 0 1px ${colors.hair}`,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingLeft: 16,
          paddingRight: 10,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        })}
      >
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 16, color: colors.ink3 }}>
          What should the computer do…
        </Text>
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: colors.btn,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="arrow-up" size={18} color={colors.btnInk} strokeWidth={2.4} />
        </View>
      </Pressable>
    </View>
  )
}
