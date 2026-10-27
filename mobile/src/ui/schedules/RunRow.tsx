import { Pressable, View } from 'react-native'
import { dayTimeLabel, runDuration, runResultLine, type RunSummary } from '../../core/schedulesView'
import { Chevron, Dot, Mono, useColors } from '../kit'
import { Text } from '../Text'
import { useToneColor } from './parts'

/** 最近运行一行：圆点 · 时间与结果 · 等宽时长 · chevron。 */
export function RunRow({
  run,
  now,
  disabled,
  onPress,
}: {
  run: RunSummary
  now: number
  disabled?: boolean
  onPress(): void
}) {
  const colors = useColors()
  const toneColor = useToneColor()
  const result = runResultLine(run)
  const when = dayTimeLabel(run.startedAt, new Date(now))
  const duration = runDuration(run, now)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${when}，${result.text}${run.sessionId ? '，打开会话' : '，查看结果'}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 14,
        backgroundColor: pressed ? colors.fill : undefined,
      })}
    >
      <Dot color={toneColor(result.tone)} size={8} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text numberOfLines={1} style={{ fontSize: 15, lineHeight: 20, color: colors.ink }}>
          {when}
        </Text>
        <Text
          numberOfLines={1}
          style={{
            fontSize: 13,
            lineHeight: 18,
            color: result.tone === 'err' ? colors.err : result.tone === 'attn' ? colors.attn : colors.ink3,
          }}
        >
          {result.text}
        </Text>
      </View>
      {duration ? <Mono style={{ fontSize: 13, color: colors.ink3 }}>{duration}</Mono> : null}
      <Chevron />
    </Pressable>
  )
}
