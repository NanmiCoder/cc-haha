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
  /** The request that already finished; if it does not match the current request it is still loading. */
  settled?: object
}
const empty: Inspection = { snapshot: null, stats: null, failed: false }

/**
 * Read the context snapshot from the computer on demand: only request when `active` is true (menu or sheet open), cancel when closed, 
 * no background polling. Reread when `refreshKey` changes (pass `state.usage`, which becomes a new object every turn end).
 * On failure keep the last read numbers; clear when switching sessions. `client` must be referentially stable, or every render rereads.
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
  // Each set of trigger conditions maps to a new object, recorded on completion, so comparing at render time tells whether it is still loading.
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

/** A thin progress bar; uses fill 0..1, with color decided by the caller. */
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
      accessibilityLabel={`${label}, ${value}`}
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
  live: 'From the session running on the computer',
  estimate: 'The session on the computer is not running; estimated from the transcript',
  turn: 'Estimated from the last turn’s usage; may be high',
}

/**
 * Context sheet (half height): used / window, progress bar, composition, last turn token breakdown, session speed and cache hits.
 * When the window size is unknown give only used tokens without a percentage; rows with missing fields are hidden entirely.
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
  /** `state.usage`: usage at the end of the last turn. */
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
    stats?.tokensPerSecond ? { key: 'speed', label: 'Generation speed', value: `${formatRate(stats.tokensPerSecond)} tok/s` } : null,
    stats?.cacheHitRate !== null && stats?.cacheHitRate !== undefined
      ? { key: 'cache', label: 'Cache hits', value: formatCacheHit(stats.cacheHitRate) }
      : null,
    stats?.cost ? { key: 'cost', label: 'Session cost', value: stats.cost } : null,
  ].filter((row): row is { key: string; label: string; value: string } => row !== null)
  const color = toneColor(summary.tone, colors)
  const hasData = summary.source !== null
  return (
    <DetentSheet visible={visible} onClose={onClose} title="Context" allowFull={false}>
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
              label={summary.percentLabel ? `Context used ${summary.percentLabel}` : 'Context usage'}
            />
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 18 }}>
            {loading && !hasData ? <Spinner size={13} thickness={2.4} /> : null}
            <Text style={[type.caption, { flex: 1, color: colors.ink3 }]}>
              {loading && !hasData
                ? 'Loading…'
                : [modelLabel?.trim(), hasData && summary.source ? sourceNote[summary.source] : '']
                    .filter(Boolean)
                    .join(' · ') || 'Usage is available after the session starts'}
            </Text>
          </View>
        </View>

        {summary.notice ? (
          <Callout tone={summary.tone === 'full' ? 'error' : 'attention'}>{summary.notice}</Callout>
        ) : hasData ? (
          <Text style={[type.caption, { color: colors.ink3, paddingHorizontal: 4 }]}>
            Near the limit, the computer automatically compacts earlier conversation.
          </Text>
        ) : null}

        {failed && !snapshot ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}>
            <Text style={[type.caption, { flex: 1, color: colors.ink3 }]}>Cannot read context usage from the computer right now.</Text>
            {onRetry ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Reload context usage"
                onPress={onRetry}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }}
              >
                <Text style={{ fontSize: 14, fontWeight: '600', color: colors.run }}>Retry</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {categories.length ? (
          <Section title="Composition">
            {categories.map((row, index) => (
              <Row key={row.key} label={row.label} value={row.value} fill={row.fill} first={index === 0} />
            ))}
          </Section>
        ) : null}

        {turn.length ? (
          <Section
            title="Last turn usage"
            footnote={usage?.cache_read_tokens ? 'When a turn calls the model several times, cache reads accumulate per call.' : undefined}
          >
            {turn.map((row, index) => (
              <Row key={row.key} label={row.label} value={row.value} first={index === 0} />
            ))}
          </Section>
        ) : null}

        {sessionRows.length ? (
          <Section title="This session">
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
 * A row at the top of the "…" menu: model name · context N%, with a thin progress bar below; tap it to open {@link ContextSheet}.
 * With an unknown window there is no progress bar but it can still be opened to see used tokens. At ≥80% the whole row turns amber.
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
      accessibilityLabel={`${line}, view context usage`}
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
