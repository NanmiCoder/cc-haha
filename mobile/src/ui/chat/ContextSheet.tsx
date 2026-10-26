import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import type { ApiClient } from '../../core/client'
import { formatRate } from '../../core/streamRate'
import type { TokenUsage } from '../../core/types'
import { DetentSheet } from '../DetentSheet'
import { Callout, Icon, Mono, Spinner, useColors } from '../kit'
import { type } from '../palette'
import { Text } from '../Text'
import {
  categoryRows,
  fetchContextInspection,
  formatCacheHit,
  menuContextLine,
  usageRows,
  type ContextSnapshot,
  type ContextSummary,
  type ContextTone,
  type SessionUsageStats,
} from './contextUsage'

type Inspection = {
  sessionId?: string
  snapshot: ContextSnapshot | null
  stats: SessionUsageStats | null
  failed: boolean
  /** 已经完成的那一次请求；和当前请求对不上就是还在读。 */
  settled?: object
}
const empty: Inspection = { snapshot: null, stats: null, failed: false }

/**
 * 按需读取电脑上的上下文快照：只在 `active` 为真时请求（菜单或底单打开），关掉就取消，
 * 后台不轮询。`refreshKey` 变化时重新读（传 `state.usage`，每轮结束都会换一个对象）。
 * 失败时保留上一次读到的数字；换会话时清空。`client` 必须引用稳定，否则每次渲染都会重读。
 */
export function useContextInspection(input: {
  client?: Pick<ApiClient, 'get'> | null
  sessionId?: string
  active: boolean
  refreshKey?: unknown
}) {
  const { client, sessionId, active, refreshKey } = input
  const [state, setState] = useState<Inspection>(empty)
  const [nonce, setNonce] = useState(0)
  // 每组触发条件对应一个新对象，完成时把它记下来，渲染时对比就知道是否还在读。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const request = useMemo(() => ({}), [active, client, sessionId, refreshKey, nonce])
  useEffect(() => {
    if (!active || !client || !sessionId) return
    const controller = new AbortController()
    void fetchContextInspection(client, sessionId, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setState((current) => {
        const same = current.sessionId === sessionId
        return {
          sessionId,
          snapshot: result.snapshot ?? (same ? current.snapshot : null),
          stats: result.stats ?? (same ? current.stats : null),
          failed: result.failed,
          settled: request,
        }
      })
    })
    return () => controller.abort()
  }, [active, client, sessionId, request])
  const reload = useCallback(() => setNonce((value) => value + 1), [])
  const current = state.sessionId === sessionId ? state : empty
  return {
    snapshot: current.snapshot,
    stats: current.stats,
    loading: active && !!client && !!sessionId && state.settled !== request,
    failed: current.failed && state.settled === request,
    reload,
  }
}

function toneColor(tone: ContextTone, colors: ReturnType<typeof useColors>) {
  return tone === 'full' ? colors.err : tone === 'warn' ? colors.attn : colors.ink2
}

/** 一条细进度条；用 fill 0..1，颜色由调用方决定。 */
function Meter({ fill, color, height = 8, label }: { fill: number; color: string; height?: number; label?: string }) {
  const colors = useColors()
  return (
    <View
      accessible={label !== undefined}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(fill * 100) }}
      style={{ height, borderRadius: height / 2, backgroundColor: colors.fill, overflow: 'hidden' }}
    >
      <View style={{ width: `${Math.max(0, Math.min(1, fill)) * 100}%`, height: '100%', borderRadius: height / 2, backgroundColor: color }} />
    </View>
  )
}

function Section({ title, footnote, children }: { title: string; footnote?: string; children: ReactNode }) {
  const colors = useColors()
  return (
    <View style={{ gap: 6 }}>
      <Text style={[type.section, { color: colors.ink3, paddingHorizontal: 4 }]}>{title}</Text>
      <View style={{ borderRadius: 16, backgroundColor: colors.card, paddingHorizontal: 16 }}>{children}</View>
      {footnote ? (
        <Text style={[type.caption, { color: colors.ink3, paddingHorizontal: 4 }]}>{footnote}</Text>
      ) : null}
    </View>
  )
}

function Row({ label, value, fill, first }: { label: string; value: string; fill?: number; first?: boolean }) {
  const colors = useColors()
  return (
    <View
      accessible
      accessibilityLabel={`${label}，${value}`}
      style={{
        minHeight: 44,
        justifyContent: 'center',
        paddingVertical: 8,
        gap: 6,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: colors.hair,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 15, color: colors.ink }}>
          {label}
        </Text>
        <Mono style={{ fontSize: 14, color: colors.ink2 }}>{value}</Mono>
      </View>
      {fill !== undefined ? <Meter fill={fill} color={colors.faint} height={3} /> : null}
    </View>
  )
}

const sourceNote: Record<NonNullable<ContextSummary['source']>, string> = {
  live: '来自电脑上正在运行的会话',
  estimate: '电脑上的会话未在运行，按对话记录估算',
  turn: '按最近一轮的用量估算，可能偏高',
}

/**
 * 上下文底单（半高）：已用 / 窗口、进度条、构成、最近一轮 token 明细、本会话速度与缓存命中。
 * 窗口大小未知时只给已用 token，不给百分比；没有的字段整行不显示。
 */
export function ContextSheet({
  visible,
  onClose,
  summary,
  modelLabel,
  usage,
  snapshot,
  stats,
  loading,
  failed,
  onRetry,
}: {
  visible: boolean
  onClose(): void
  summary: ContextSummary
  modelLabel?: string
  /** `state.usage`：最近一轮结束时的用量。 */
  usage?: TokenUsage
  snapshot?: ContextSnapshot | null
  stats?: SessionUsageStats | null
  loading?: boolean
  failed?: boolean
  onRetry?(): void
}) {
  const colors = useColors()
  const categories = categoryRows(snapshot)
  const turn = usageRows(usage)
  const sessionRows = [
    stats?.tokensPerSecond ? { key: 'speed', label: '生成速度', value: `${formatRate(stats.tokensPerSecond)} tok/s` } : null,
    stats?.cacheHitRate !== null && stats?.cacheHitRate !== undefined
      ? { key: 'cache', label: '缓存命中', value: formatCacheHit(stats.cacheHitRate) }
      : null,
    stats?.cost ? { key: 'cost', label: '会话费用', value: stats.cost } : null,
  ].filter((row): row is { key: string; label: string; value: string } => row !== null)
  const color = toneColor(summary.tone, colors)
  const hasData = summary.source !== null
  return (
    <DetentSheet visible={visible} onClose={onClose} title="上下文" allowFull={false}>
      <View style={{ gap: 14, paddingTop: 4 }}>
        <View style={{ borderRadius: 16, backgroundColor: colors.card, padding: 16, gap: 10 }}>
          <Text
            accessibilityRole="header"
            style={[type.headline, { color: hasData ? colors.ink : colors.ink3, fontVariant: ['tabular-nums'] }]}
          >
            {summary.headline}
          </Text>
          {summary.window ? (
            <Meter
              fill={summary.fill}
              color={summary.tone === 'ok' || summary.tone === 'unknown' ? colors.ink : color}
              label={summary.percentLabel ? `上下文已用 ${summary.percentLabel}` : '上下文用量'}
            />
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 18 }}>
            {loading && !hasData ? <Spinner size={13} thickness={2.4} /> : null}
            <Text style={[type.caption, { flex: 1, color: colors.ink3 }]}>
              {loading && !hasData
                ? '正在读取…'
                : [modelLabel?.trim(), hasData && summary.source ? sourceNote[summary.source] : '']
                    .filter(Boolean)
                    .join(' · ') || '会话开始后才有用量'}
            </Text>
          </View>
        </View>

        {summary.notice ? (
          <Callout tone={summary.tone === 'full' ? 'error' : 'attention'}>{summary.notice}</Callout>
        ) : hasData ? (
          <Text style={[type.caption, { color: colors.ink3, paddingHorizontal: 4 }]}>
            接近上限时，电脑会自动压缩较早的对话。
          </Text>
        ) : null}

        {failed && !snapshot ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}>
            <Text style={[type.caption, { flex: 1, color: colors.ink3 }]}>暂时读不到电脑上的上下文用量。</Text>
            {onRetry ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="重新读取上下文用量"
                onPress={onRetry}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }}
              >
                <Text style={{ fontSize: 14, fontWeight: '600', color: colors.run }}>重试</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {categories.length ? (
          <Section title="构成">
            {categories.map((row, index) => (
              <Row key={row.key} label={row.label} value={row.value} fill={row.fill} first={index === 0} />
            ))}
          </Section>
        ) : null}

        {turn.length ? (
          <Section
            title="最近一轮用量"
            footnote={usage?.cache_read_tokens ? '一轮里多次调用模型时，缓存读取按次累加。' : undefined}
          >
            {turn.map((row, index) => (
              <Row key={row.key} label={row.label} value={row.value} first={index === 0} />
            ))}
          </Section>
        ) : null}

        {sessionRows.length ? (
          <Section title="本会话">
            {sessionRows.map((row, index) => (
              <Row key={row.key} label={row.label} value={row.value} first={index === 0} />
            ))}
          </Section>
        ) : null}
      </View>
    </DetentSheet>
  )
}

/**
 * “…”菜单顶部的一行：模型名 · 上下文 N%，下面一条细进度条，点它打开 {@link ContextSheet}。
 * 窗口未知时没有进度条，仍可点开看已用 token。≥80% 整行转琥珀色。
 */
export function ContextMenuHeader({
  modelLabel,
  summary,
  onPress,
}: {
  modelLabel?: string
  summary: ContextSummary
  onPress(): void
}) {
  const colors = useColors()
  const line = menuContextLine(modelLabel, summary)
  const color = summary.tone === 'full' ? colors.err : summary.tone === 'warn' ? colors.attn : colors.ink3
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${line}，查看上下文用量`}
      onPress={onPress}
      hitSlop={{ left: 16, right: 16 }}
      style={({ pressed }) => ({
        minHeight: 44,
        justifyContent: 'center',
        gap: 6,
        paddingVertical: 6,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text
          numberOfLines={1}
          style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 17, fontWeight: summary.tone === 'ok' || summary.tone === 'unknown' ? '400' : '600', color }}
        >
          {line}
        </Text>
        <Icon name="chevron-right" size={14} color={colors.chevron} strokeWidth={2} />
      </View>
      {summary.window && summary.source ? (
        <Meter fill={summary.fill} color={summary.tone === 'ok' ? colors.faint : color} height={3} />
      ) : null}
    </Pressable>
  )
}
