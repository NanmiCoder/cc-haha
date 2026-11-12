import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { elapsedLabel } from '../../core/dashboard'
import { captionTokens, formatTokenCount, pushRateSample, streamRate, type RateSample } from '../../core/streamRate'
import { HaloDot, Mono, Spinner, useColors } from '../kit'
import { Text } from '../Text'
import { captionParts } from './captionModel'
import type { StepLabel } from './steps'

/**
 * This turn's duration and output speed refreshed every second, redrawing only this small text without touching the whole page.
 * `tokens` is the cumulative output tokens this turn (`turnOutputTokens` in `core/streamRate.ts`), 
 * and speed is sampled here once per second and computed over the last few seconds; during pauses or with too few samples the rate segment is hidden.
 */
function LiveMeta({
  since,
  tokens,
  compact,
}: {
  since?: number
  tokens?: number
  compact: boolean
}) {
  const colors = useColors()
  const [now, setNow] = useState(() => Date.now())
  const [rate, setRate] = useState<number | null>(null)
  const latest = useRef(tokens)
  const samples = useRef<RateSample[]>([])
  useEffect(() => {
    latest.current = tokens
  })
  useEffect(() => {
    const tick = () => {
      const at = Date.now()
      if (latest.current !== undefined)
        samples.current = pushRateSample(samples.current, { at, tokens: latest.current })
      setNow(at)
      setRate(streamRate(samples.current, at))
    }
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [])
  const stats = captionTokens({ tokens, rate, compact })
  return (
    <>
      {since !== undefined ? (
        <Mono style={{ flexShrink: 0, fontSize: 13, lineHeight: 18, color: colors.ink3 }}>
          {`· ${elapsedLabel(since, now)}`}
        </Mono>
      ) : null}
      {stats ? (
        <Mono style={{ flexShrink: 0, fontSize: 12, lineHeight: 18, color: colors.ink3 }}>{`· ${stats}`}</Mono>
      ) : null}
    </>
  )
}

/**
 * The single run hint above the input: one line of 13px grey text, neither a button nor a card.
 * When the command is long the middle is truncated and the timer is always complete. While waiting for approval the whole row turns amber and the timer is hidden.
 */
export function StatusCaption({
  step,
  waiting,
  compacting,
  startedAt,
  tokens,
}: {
  step?: StepLabel | null
  waiting?: boolean
  compacting?: boolean
  startedAt?: number
  /** Tokens output this turn (estimated or real); hidden when omitted, 0, waiting for approval or compacting context. */
  tokens?: number
}) {
  const colors = useColors()
  const parts = captionParts({ step, waiting, compacting })
  const attention = parts.tone === 'attention'
  const text = [parts.lead, parts.object].filter(Boolean).join(' ')
  const showTokens = !attention && !compacting && typeof tokens === 'number' && tokens > 0
  const liveTokens = showTokens ? tokens : undefined
  const timed = startedAt !== undefined && !attention
  const label = [
    text,
    timed ? `Running for ${elapsedLabel(startedAt)}` : '',
    liveTokens !== undefined ? `Output about ${formatTokenCount(liveTokens)} tokens` : '',
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <View
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      accessibilityLabel={label}
      style={{ height: 24, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 6 }}
    >
      {attention ? (
        <View style={{ marginHorizontal: 2 }}>
          <HaloDot size={8} />
        </View>
      ) : (
        <Spinner size={13} thickness={2.4} />
      )}
      <Text
        style={{
          flexShrink: 0,
          fontSize: 13,
          lineHeight: 18,
          fontWeight: attention ? '600' : '400',
          color: attention ? colors.attn : colors.ink3,
        }}
      >
        {parts.lead}
      </Text>
      {parts.object ? (
        parts.mono ? (
          <Mono
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{ flexShrink: 1, minWidth: 0, fontSize: 13, lineHeight: 18, color: attention ? colors.attn : colors.ink2 }}
          >
            {parts.object}
          </Mono>
        ) : (
          <Text
            numberOfLines={1}
            style={{ flexShrink: 1, minWidth: 0, fontSize: 13, lineHeight: 18, color: attention ? colors.attn : colors.ink2 }}
          >
            {parts.object}
          </Text>
        )
      ) : null}
      {timed || liveTokens !== undefined ? (
        <LiveMeta since={timed ? startedAt : undefined} tokens={liveTokens} compact={!!parts.object} />
      ) : null}
    </View>
  )
}
