import { useEffect, useState } from 'react'
import { getAgentRunTpsMeter, getAgentRunTpsMeters, getSessionTpsMeter } from '../../stores/chatStore'
import { aggregateMeterReadings, isTpsEnabled, type TpsSource } from '../../lib/tpsMeter'
import { useTranslation } from '../../i18n'
import { useSettingsStore } from '../../stores/settingsStore'

/**
 * Real-time decode-speed (TPS) indicator.
 *
 * Two modes:
 *  - Session mode (default): the session's own decode **plus every subagent
 *    currently decoding for it**, summed (see aggregateMeterReadings). Each
 *    stream is rated on its own meter, so a run that has finished drops out the
 *    moment its window drains and the reading falls back to the session's own
 *    held speed.
 *  - Run mode (`runAgentId`): that one subagent run's own decode speed, for its
 *    page's header. Independent runs each show their own number.
 *
 * Lifecycle:
 *  - Before the meter has ever streamed (no input/decoded tokens yet) → hidden.
 *  - After the first streamed chunk it stays visible while the session is in
 *    use. While decoding, value() is the live window speed and updates every
 *    poll; when decoding pauses it holds the last speed.
 *  - If no new data arrives for HIDE_AFTER_IDLE_MS (5 min) it hides again.
 *
 * Rendered as plain text `TPS {n}t/s` (no pill background) — the chat header
 * stacks it under the cost badge in a two-line block. Coloring: <27 red, <53
 * orange, <80 green, >=80 purple. Meters are per-session / per-run, so parallel
 * sessions and runs never cross-talk.
 *
 * The readout refreshes 4–8 times a second (250 ms, or 125 ms while the stream
 * is fast enough for the shorter cadence to keep up with the meter's own bucket
 * grid) and only redraws when the digit the user reads actually changes — the
 * value moves by fractions of a token on every poll, and re-rendering for those
 * made the number look like it was churning dozens of times a second.
 */

const POLL_SLOW_MS = 250
const POLL_FAST_MS = 125
/** At or above this speed, refresh on the fast cadence. */
const FAST_CADENCE_TPS = 50
const LOW_TIER = 27
const MED_TIER = 53
const HIGH_TIER = 80
const HIDE_AFTER_IDLE_MS = 5 * 60 * 1000
/**
 * How long a near-zero read may hold the previous number.
 *
 * The hold exists for the moment a stream crosses a boundary (text↔thinking↔tool)
 * where the instantaneous rate dips to nothing although decoding has not stopped.
 * Bounded, because a dip that *persists* is not a boundary — it is a real, very
 * slow rate. Holding it indefinitely freezes the display on the last speed while
 * the stream runs on, which is the "reading stuck, never moves" failure. A little
 * over one reading window is enough to cover a boundary.
 */
const HOLD_UNCHANGED_MAX_MS = 1500
// 显示口径：数值最多 4 位，封顶避免撑破固定栏宽。生成钟（serverTs）落地后读数
// 理论上不会再超引擎真实能力，此处仅留作极端兜底。
const MAX_DISPLAY_TPS = 9999

type TpsTier = 'red' | 'orange' | 'green' | 'purple'

/** Display integer, capped at 4 digits (see MAX_DISPLAY_TPS). */
export function formatTps(tps: number): string {
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

export function TpsIndicator({
  sessionId,
  runAgentId,
  vertical = false,
}: {
  sessionId: string
  /** Run mode: show this subagent run's own speed instead of the session total. */
  runAgentId?: string
  vertical?: boolean
}) {
  const t = useTranslation()
  const sessionExtendedInfo = useSettingsStore((state) => state.sessionExtendedInfo)
  const [tps, setTps] = useState(0)
  const [visible, setVisible] = useState(false)
  const [activeSubs, setActiveSubs] = useState(0)
  const [source, setSource] = useState<TpsSource>('char')

  // Master switch: when disabled the indicator renders nothing and never polls
  // the meter (the meter itself is also not fed in the content_delta path).
  // 会话扩展信息关闭时同样整块隐藏——TPS 是本 fork 新增读数，缺省视为开启。
  // The check is resolved here but acted on *after* the effect below: returning
  // early at this point would make the component call a different number of
  // hooks depending on the setting, and React rejects that outright (rendering
  // fewer hooks than the previous render throws). The effect carries the same
  // guard, so a disabled indicator still starts no polling.
  const tpsSuppressed = !isTpsEnabled() || sessionExtendedInfo === false

  useEffect(() => {
    if (tpsSuppressed) return
    const own = runAgentId
      ? getAgentRunTpsMeter(sessionId, runAgentId)
      : getSessionTpsMeter(sessionId)
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    /** Last number put on screen, and since when a near-zero has been holding it. */
    let lastShown = 0
    let heldSince = 0

    const tick = () => {
      // Resolved per tick, not once per effect: runs start and finish while the
      // effect is alive, so a list captured at mount would be permanently empty
      // for a session whose subagents are dispatched later (the common case —
      // the indicator mounts with the session, the agents come after).
      // In run mode there is nothing to aggregate: the run's meter is the reading.
      const subordinates = runAgentId ? [] : getAgentRunTpsMeters(sessionId)
      // Own decode + every run currently decoding, summed; visibility and the
      // idle-hide rule are judged across the whole group.
      const { visible: shown, tps: value, activeSubs: subs } = aggregateMeterReadings(
        own,
        subordinates,
        performance.now(),
        HIDE_AFTER_IDLE_MS,
      )
      if (!shown) {
        setVisible(false)
      } else {
        setActiveSubs(subs)
        setSource(own.source())
        // A near-zero read at a stream boundary (text↔thinking↔tool) is not a
        // real decode speed — hold the previous reading instead of flashing 0.
        // No exponential smoothing on top: the meter's value is already a mean
        // over a second of 125 ms buckets, and smoothing a mean again only adds
        // lag. (opt23 §11.27 used to stack a 30/70 EWMA here.)
        let next = value
        if (value < 0.5 && lastShown > 0.5) {
          const at = performance.now()
          if (heldSince === 0) heldSince = at
          // Bounded: past the window this is a real slow rate, not a boundary.
          if (at - heldSince < HOLD_UNCHANGED_MAX_MS) next = lastShown
          else heldSince = 0
        } else {
          heldSince = 0
        }
        lastShown = next
        setTps((prev) => {
          // Returning `prev` lets React bail out of the render, so a move of a
          // fraction of a token does not redraw the digits.
          return Math.round(next) === Math.round(prev) ? prev : next
        })
        setVisible(true)
      }
      schedule()
    }

    // 4–8 Hz: the shorter cadence only while there is speed to show, so a slow
    // stream reads as steady instead of flickering.
    const schedule = () => {
      if (stopped) return
      const cadence = own.value() >= FAST_CADENCE_TPS ? POLL_FAST_MS : POLL_SLOW_MS
      timer = setTimeout(tick, cadence)
    }

    tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [sessionId, runAgentId, tpsSuppressed])

  // Past every hook, so switching the setting off can only change what renders.
  if (tpsSuppressed) return null
  if (!visible) return null
  const tier = tierFor(tps)
  const style = TIER_STYLE[tier]
  // Run mode names the run; session mode names the group when runs are decoding.
  const baseTitle = runAgentId
    ? t('chat.tpsRunTitle')
    : activeSubs > 0
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
    </span>
  )
}
