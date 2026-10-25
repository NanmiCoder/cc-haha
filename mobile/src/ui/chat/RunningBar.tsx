import { useEffect, useState } from 'react'
import { Pressable, View } from 'react-native'
import { Text } from '../Text'
import { elapsedLabel } from '../../core/dashboard'
import { Icon, Mono, Spinner, useColors } from '../kit'

const pill = (hair: string) => ({
  height: 40,
  borderRadius: 20,
  boxShadow: `0 1px 2px rgba(28,25,23,0.06), 0 0 0 1px ${hair}`,
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
})

/** 每秒刷新的本轮时长，只重绘这一小段文字。 */
function Elapsed({ since }: { since: number }) {
  const colors = useColors()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <Mono style={{ fontSize: 13, color: colors.ink2 }}>{elapsedLabel(since, now)}</Mono>
}

/** 运行中输入框上方的状态条：左侧进入后台活动，右侧停止（先确认）。 */
export function RunningBar({
  compacting,
  startedAt,
  backgroundCount,
  onOpen,
  onStop,
  stopDisabled,
}: {
  compacting: boolean
  startedAt?: number
  backgroundCount: number
  onOpen(): void
  onStop(): void
  stopDisabled?: boolean
}) {
  const colors = useColors()
  const label = compacting ? '正在整理上下文' : '运行中'
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}${backgroundCount ? `，后台 ${backgroundCount} 项` : ''}，查看后台活动`}
        onPress={onOpen}
        style={({ pressed }) => ({
          ...pill(colors.hair),
          flex: 1,
          minWidth: 0,
          gap: 8,
          paddingHorizontal: 12,
          backgroundColor: pressed ? colors.fill : colors.card,
        })}
      >
        <Spinner size={14} thickness={2.4} />
        <Text style={{ fontSize: 14, fontWeight: '600', color: colors.ink }}>{label}</Text>
        {startedAt !== undefined ? <Elapsed since={startedAt} /> : null}
        {backgroundCount > 0 ? (
          <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13, color: colors.ink3 }}>
            · 后台 {backgroundCount} 项
          </Text>
        ) : null}
        <View style={{ marginLeft: 'auto' }}>
          <Icon name="chevron-right" size={14} color={colors.ink3} strokeWidth={2.2} />
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="停止这段会话"
        accessibilityState={{ disabled: stopDisabled }}
        disabled={stopDisabled}
        onPress={onStop}
        style={({ pressed }) => ({
          ...pill(colors.hair),
          gap: 6,
          paddingHorizontal: 14,
          backgroundColor: pressed ? colors.fill : colors.card,
          opacity: stopDisabled ? 0.45 : 1,
        })}
      >
        <Icon name="stop" size={12} color={colors.err} />
        <Text style={{ fontSize: 14, fontWeight: '600', color: colors.err }}>停止</Text>
      </Pressable>
    </View>
  )
}
