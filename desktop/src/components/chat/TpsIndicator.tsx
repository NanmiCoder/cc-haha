import { useEffect, useState } from 'react'
import { getSessionTpsMeter, getSubordinateTpsMeters } from '../../stores/chatStore'
import { aggregateMeterReadings, isTpsEnabled, type TpsSource } from '../../lib/tpsMeter'
import { useTranslation } from '../../i18n'
import { useSettingsStore } from '../../stores/settingsStore'

/**
 * Real-time decode-speed (TPS) indicator.
 *
 * Lifecycle:
 *  - Before this session has ever streamed (no input/decoded tokens yet) →
 *    hidden.
 *  - After the first streamed chunk it stays visible for the rest of the
 *    session. While decoding, value() is the live window speed and updates
 *    every poll; when decoding pauses it holds the last speed.
 *  - If no new data arrives for HIDE_AFTER_IDLE_MS (5 min) it hides again.
 *
 * This session's own decode is aggregated with its subagents/team-members so
 * the main view shows the team-wide total; a "Σn" badge appears while at least
 * one subagent is actively emitting (see aggregateMeterReadings).
 *
 * Rendered as plain text `TPS {n}t/s` (no pill background) — the chat header
 * stacks it under the cost badge in a two-line block. Coloring: <27 red, <53
 * orange, <80 green, >=80 purple. Polled at POLL_MS (≈5-6 Hz). Meter is
 * per-session (see getSessionTpsMeter), so parallel sessions each show their
 * own decode speed.
 */

const POLL_MS = 180
const LOW_TIER = 27
const MED_TIER = 53
const HIGH_TIER = 80
const HIDE_AFTER_IDLE_MS = 5 * 60 * 1000
// 显示口径：数值最多 4 位（用户要求 "TPS XXt/s" 最多四位数）。聚合/保持值
// 偶可超 4 位（子代理汇聚或移动端批量突发），封顶显示避免撑破固定栏宽。
const MAX_DISPLAY_TPS = 9999

type TpsTier = 'red' | 'orange' | 'green' | 'purple'

/** Display integer, capped at 4 digits (see MAX_DISPLAY_TPS). */
function formatTps(tps: number): string {
  const rounded = Math.round(tps)
  return String(Math.min(rounded, MAX_DISPLAY_TPS))
}

function tierFor(tps: number): TpsTier {
  if (tps < LOW_TIER) return 'red'
  if (tps < MED_TIER) return 'orange'
  if (tps < HIGH_TIER) return 'green'
  return 'purple'
}

const TIER_STYLE: Record<TpsTier, { color: string }> = {
  red: { color: 'var(--color-error)' },
  orange: { color: '#f59e0b' },
  green: { color: 'var(--color-success)' },
  purple: { color: '#a855f7' },
}

export function TpsIndicator({ sessionId, vertical = false }: { sessionId: string; vertical?: boolean }) {
  const t = useTranslation()
  const sessionExtendedInfo = useSettingsStore((state) => state.sessionExtendedInfo)
  const [tps, setTps] = useState(0)
  const [visible, setVisible] = useState(false)
  const [activeSubs, setActiveSubs] = useState(0)
  const [source, setSource] = useState<TpsSource>('char')

  // Master switch: when disabled the indicator renders nothing and never polls
  // the meter (the meter itself is also not fed in the content_delta path).
  // 会话扩展信息关闭时同样整块隐藏——TPS 是本 fork 新增读数，缺省视为开启。
  // 两个渲染分支（vertical/横向）都在此处之后，故单次提前返回即可覆盖。
  if (!isTpsEnabled() || sessionExtendedInfo === false) return null

  useEffect(() => {
    const meter = getSessionTpsMeter(sessionId)
    const tick = () => {
      // Own session + its subagent/team-member meters, folded into one
      // team-wide reading (visibility/idle-hide judged across the whole group).
      const { visible: shown, tps: value, activeSubs: subs } = aggregateMeterReadings(
        meter,
        getSubordinateTpsMeters(sessionId),
        performance.now(),
        HIDE_AFTER_IDLE_MS,
      )
      if (!shown) {
        setVisible(false)
        return
      }
      setActiveSubs(subs)
      setSource(meter.source())
      // A near-zero read at a stream boundary (text↔thinking↔tool) is not a
      // real decode speed — hold the previous reading instead of flashing 0.
      setTps((prev) => {
        if (value < 0.5) return prev > 0.5 ? prev : value
        // opt23 §11.27: 指数平滑（新值 30% + 上次 70%）抑制移动端突发导致
        // 的 TPS 忽高忽低；首次读取直接采用。
        return prev > 0.5 ? prev * 0.7 + value * 0.3 : value
      })
      setVisible(true)
    }
    tick()
    const timer = setInterval(tick, POLL_MS)
    return () => clearInterval(timer)
  }, [sessionId])

  if (!visible) return null
  const tier = tierFor(tps)
  const style = TIER_STYLE[tier]
  const baseTitle = activeSubs > 0
    ? t('chat.tpsAggregateTitle', { count: String(activeSubs) })
    : t('chat.tpsSpeedTitle')
  // `ids` is the engine's own token count; the other tiers are learned
  // approximations, so the tooltip says so rather than implying precision.
  const approximate = source !== 'ids'
  const title = approximate ? `${baseTitle} · ≈` : baseTitle

  if (vertical) {
    return (
      <span
        data-testid="tps-indicator"
        data-tps-source={source}
        className="inline-flex shrink-0 flex-col items-center justify-center font-mono text-[10px] font-semibold leading-none tabular-nums"
        style={{ color: style.color }}
        title={title}
      >
        <span className="inline-block text-center leading-none">
          TPS {formatTps(tps)}t/s
        </span>
        {activeSubs > 0 ? (
          <span data-testid="tps-subagent-badge" className="mt-0.5 leading-none">
            Σ{activeSubs}
          </span>
        ) : null}
      </span>
    )
  }

  return (
    <span
      data-testid="tps-indicator"
      data-tps-source={source}
      className="inline-flex shrink-0 items-center font-mono text-[10px] font-semibold leading-tight tabular-nums"
      style={{ color: style.color }}
      title={title}
    >
      <span className="inline-block">TPS {formatTps(tps)}t/s</span>
      {activeSubs > 0 ? (
        <span data-testid="tps-subagent-badge" className="ml-1">
          Σ{activeSubs}
        </span>
      ) : null}
    </span>
  )
}
