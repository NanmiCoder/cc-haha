import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { elapsedLabel } from '../../core/dashboard'
import { captionTokens, formatTokenCount, pushRateSample, streamRate, type RateSample } from '../../core/streamRate'
import { HaloDot, Mono, Spinner, useColors } from '../kit'
import { Text } from '../Text'
import { captionParts } from './captionModel'
import type { StepLabel } from './steps'

/**
 * 每秒刷新的本轮时长与输出速度，只重绘这一小段文字，不牵动整页。
 * `tokens` 是本轮累计输出 token（`core/streamRate.ts` 的 `turnOutputTokens`），
 * 速度由这里每秒取一个采样、按最近几秒算出，停顿或采样不足时整段速率不显示。
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
 * 输入框上方唯一的运行提示：一行 13px 灰字，不是按钮也不是卡片。
 * 命令很长时截断中间那段，计时永远完整。等批准时整行变琥珀，不显示计时。
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
  /** 本轮已输出的 token 数（估算或真实）；不传、为 0、等批准或整理上下文时不显示这一段。 */
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
    timed ? `已运行 ${elapsedLabel(startedAt)}` : '',
    liveTokens !== undefined ? `已输出约 ${formatTokenCount(liveTokens)} tokens` : '',
  ]
    .filter(Boolean)
    .join('，')
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
