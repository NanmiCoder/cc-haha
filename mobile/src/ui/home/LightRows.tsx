import type { ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import Svg, { Path } from 'react-native-svg'
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

const title = (row: DashboardRow) => row.session.title || '未命名任务'

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

/* ───────────── 顶部浮动按钮 ───────────── */

/** 设计稿的“两条线”菜单图标。 */
export function MenuGlyph({ color, size = 22 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round">
      <Path d="M4 9h16" />
      <Path d="M4 15h10" />
    </Svg>
  )
}

/** 44pt 白色圆形浮动按钮。 */
export function FloatButton({
  label,
  onPress,
  children,
}: {
  label: string
  onPress(): void
  children: ReactNode
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: colors.card,
        boxShadow: floatShadow(colors.hair),
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {children}
    </Pressable>
  )
}

/* ───────────── 范围药丸 ───────────── */

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
      accessibilityLabel="按状态查看"
      style={{ flexDirection: 'row', gap: 2, marginHorizontal: -6, marginBottom: 4 }}
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

export function SectionTitle({ children }: { children: string }) {
  const colors = useColors()
  return (
    <Text
      accessibilityRole="header"
      style={{ fontSize: 15, fontWeight: '600', color: colors.ink, paddingTop: 16, paddingBottom: 2 }}
    >
      {children}
    </Text>
  )
}

/* ───────────── 会话行 ───────────── */

/** 「最近」行：状态标记 · 标题 + 副行（项目 · 状态/当前一步）· 右侧时间或走秒。 */
export function RecentRow({
  row,
  background,
  onPress,
}: {
  row: DashboardRow
  /** 这个会话正在跑的后台任务数；未知时不显示。 */
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
      <StatusGlyph status={glyphOf[state]} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          numberOfLines={1}
          style={{ fontSize: 16, lineHeight: 22, fontWeight: state === 'review' ? '600' : '500', color: colors.ink }}
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
        <View style={{ alignItems: 'flex-end' }}>
          {row.activity?.startedAt ? <Elapsed since={row.activity.startedAt} /> : null}
          {background ? (
            <Text style={{ fontSize: 12, lineHeight: 18, color: colors.ink3 }}>后台 {background}</Text>
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
    gap: 10,
    paddingVertical: 7,
    paddingHorizontal: 16,
    marginHorizontal: -16,
  }
  if (!onPress) return <View style={base}>{body}</View>
  const words = stateWords(state)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title(row), words, line.text].filter(Boolean).join('，')}
      onPress={onPress}
      style={({ pressed }) => [base, pressed && { backgroundColor: colors.fill }]}
    >
      {body}
    </Pressable>
  )
}

/** 断开前的快照：等待和运行都无法确认，只如实说明；已结束的照常显示。 */
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
        gap: 10,
        paddingVertical: 7,
        paddingHorizontal: 16,
        marginHorizontal: -16,
      }}
    >
      <StatusGlyph status={state === 'waiting' ? 'attention' : 'idle'} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ fontSize: 16, lineHeight: 22, fontWeight: '500', color: colors.ink }}>
          {title(row)}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>
          {state === 'waiting' ? pendingWhileOffline(row.activity) : '断开时在运行 · 状态未知'}
        </Text>
      </View>
    </View>
  )
}

/* ───────────── 项目 ───────────── */

/** 项目头：文件夹 + 项目名（点开/收起），折叠时右侧提示有人在等/在跑，最右是在此项目新任务。 */
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
        accessibilityLabel={`${group.name}，${group.total} 个任务${badge ? `，${badge.text}` : ''}`}
        accessibilityState={group.expandable ? { expanded: group.expanded } : undefined}
        disabled={!group.expandable}
        onPress={onToggle}
        style={({ pressed }) => ({
          flex: 1,
          minWidth: 0,
          height: 48,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
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
            {`${group.total} 个任务`}
          </Text>
        )}
      </Pressable>
      <IconButton
        icon="compose"
        label={`在 ${group.name} 新任务`}
        color={colors.ink2}
        iconSize={20}
        strokeWidth={1.75}
        disabled={!canStart}
        onPress={onNewTask}
      />
    </View>
  )
}

/** 项目下缩进的会话行：只有标题，需要说话的状态在右侧用文字，运行中走秒，其余是相对时间。 */
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
      accessibilityLabel={[title(row), words].filter(Boolean).join('，')}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 4,
        paddingLeft: 16,
        paddingRight: 16,
        marginHorizontal: -16,
        backgroundColor: pressed ? colors.fill : 'transparent',
      })}
    >
      {/* 状态图标和项目头的文件夹图标同一列，标题与项目名左对齐。 */}
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

/** 项目下“显示更早的 N 个”。 */
export function MoreSessions({ count, onPress }: { count: number; onPress(): void }) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        justifyContent: 'center',
        paddingLeft: 48,
        marginHorizontal: -16,
        backgroundColor: pressed ? colors.fill : 'transparent',
      })}
    >
      <Text style={{ fontSize: 14, color: colors.ink2 }}>显示更早的 {count} 个</Text>
    </Pressable>
  )
}

/* ───────────── 底部浮动输入框 ───────────── */

/** 假输入框：点哪里都进入新任务页（真正的输入在那边），样子与会话页的输入框一致。 */
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
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, top: -34 }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="新任务，想让电脑做什么"
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
          想让电脑做什么…
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
