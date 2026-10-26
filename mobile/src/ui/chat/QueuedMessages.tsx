import { Pressable, View } from 'react-native'
import { Text } from '../Text'
import { useColors } from '../kit'
import type { QueuedMessage } from './queue'

/**
 * 运行中排队的追加消息：一行一条，可以撤回到输入框。
 * 上一轮出错或没确认送达时暂停自动发送，给出原因，由用户决定发还是撤回。
 */
export function QueuedMessages({
  items,
  paused,
  onWithdraw,
  onSendNow,
}: {
  items: QueuedMessage[]
  paused?: string
  onWithdraw(id: string): void
  onSendNow(id: string): void
}) {
  const colors = useColors()
  if (!items.length) return null
  return (
    <View style={{ gap: 6 }}>
      {paused ? (
        <Text style={{ fontSize: 12.5, lineHeight: 17, color: colors.attn, paddingHorizontal: 4 }}>
          {paused}
        </Text>
      ) : null}
      {items.map((item, index) => (
        <View
          key={item.id}
          style={{
            minHeight: 48,
            borderRadius: 14,
            backgroundColor: colors.card,
            boxShadow: `inset 0 0 0 1px ${colors.hair}`,
            paddingLeft: 12,
            paddingRight: 4,
            paddingVertical: 6,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
            <Text style={{ fontSize: 12, lineHeight: 16, color: colors.ink3 }}>
              {paused ? '排队中 · 暂停' : '排队中 · 这一轮结束后发送'}
              {item.attachments.length ? ` · ${item.attachments.length} 个材料` : ''}
              {item.team ? ' · 团队' : ''}
            </Text>
            <Text numberOfLines={1} style={{ fontSize: 14, lineHeight: 20, color: colors.ink }}>
              {item.text || item.references?.map((reference) => `@${reference.displayName || reference.name}`).join(' ') || '（只有材料）'}
            </Text>
          </View>
          {paused && index === 0 ? (
            <QueueAction label="发送" strong onPress={() => onSendNow(item.id)} a11y={`现在发送排队的消息：${item.text}`} />
          ) : null}
          <QueueAction label="撤回" onPress={() => onWithdraw(item.id)} a11y={`撤回排队的消息：${item.text}`} />
        </View>
      ))}
    </View>
  )
}

function QueueAction({
  label,
  onPress,
  strong,
  a11y,
}: {
  label: string
  onPress(): void
  strong?: boolean
  a11y: string
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 36,
        paddingHorizontal: 10,
        justifyContent: 'center',
        opacity: pressed ? 0.5 : 1,
      })}
    >
      <Text style={{ fontSize: 14, fontWeight: strong ? '600' : '400', color: strong ? colors.ink : colors.ink2 }}>
        {label}
      </Text>
    </Pressable>
  )
}
