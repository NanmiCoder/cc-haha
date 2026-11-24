import { useEffect, useRef, useState } from 'react'
import { PanResponder, Pressable, View, type PanResponderInstance } from 'react-native'
import { Text } from '../Text'
import { Icon, IconButton, useColors } from '../kit'
import type { QueuedMessage } from './queue'

/**
 * 移动端排队列表：长按左侧把手后上下拖动改顺序，也可用每行的上/下箭头；
 * 改顺序只调整发送次序，不会立即发送。原来的「引导 / 发送 / 撤回」保持不变。
 */
export function QueuedMessages({
  items,
  paused,
  onWithdraw,
  onSendNow,
  onGuide,
  onMove,
  guiding,
  guideDisabled,
}: {
  items: QueuedMessage[]
  paused?: string
  onWithdraw(id: string): void
  onSendNow(id: string): void
  onGuide(id: string): void
  onMove(id: string, toIndex: number): void
  /** 这一轮正在运行：显示「引导」。 */
  guiding?: boolean
  /** 有决定在等、配置未确认或连接没就绪时不能引导。 */
  guideDisabled?: boolean
}) {
  const colors = useColors()
  const [draggingId, setDraggingId] = useState<string | null>(null)
  if (!items.length) return null
  return (
    <View style={{ gap: 6 }}>
      {paused ? (
        <Text style={{ fontSize: 12.5, lineHeight: 17, color: colors.attn, paddingHorizontal: 4 }}>
          {paused}
        </Text>
      ) : null}
      {items.map((item, index) => (
        <QueuedRow
          key={item.id}
          item={item}
          index={index}
          count={items.length}
          paused={paused}
          guiding={guiding}
          guideDisabled={guideDisabled}
          dragging={draggingId === item.id}
          onDragStateChange={(active) => setDraggingId(active ? item.id : null)}
          onMove={onMove}
          onWithdraw={onWithdraw}
          onSendNow={onSendNow}
          onGuide={onGuide}
        />
      ))}
    </View>
  )
}

/** 每行最小高度 48 加 6 的行距；拖动一格就换一个位置。 */
const ROW_STEP = 54
const LONG_PRESS_MS = 260

function QueuedRow({
  item,
  index,
  count,
  paused,
  guiding,
  guideDisabled,
  dragging,
  onDragStateChange,
  onMove,
  onWithdraw,
  onSendNow,
  onGuide,
}: {
  item: QueuedMessage
  index: number
  count: number
  paused?: string
  guiding?: boolean
  guideDisabled?: boolean
  dragging: boolean
  onDragStateChange(active: boolean): void
  onMove(id: string, toIndex: number): void
  onWithdraw(id: string): void
  onSendNow(id: string): void
  onGuide(id: string): void
}) {
  const colors = useColors()
  // The row moves in the list while the finger stays down; the gesture keeps
  // its own origin so later indexes do not compound the offset. Refs are only
  // read in event handlers; the responder itself is created after render.
  const latest = useRef({ index, itemId: item.id, onMove, onDragStateChange })
  const originIndex = useRef(index)
  const lastStep = useRef(0)
  const draggingRef = useRef(false)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [responder, setResponder] = useState<PanResponderInstance | null>(null)

  useEffect(() => {
    latest.current = { index, itemId: item.id, onMove, onDragStateChange }
  }, [index, item.id, onMove, onDragStateChange])

  useEffect(() => {
    const clearLongPress = () => {
      if (longPressTimer.current) {
        clearTimeout(longPressTimer.current)
        longPressTimer.current = null
      }
    }
    const finishDrag = () => {
      clearLongPress()
      if (!draggingRef.current) return
      draggingRef.current = false
      latest.current.onDragStateChange(false)
    }
    setResponder(PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        originIndex.current = latest.current.index
        lastStep.current = 0
        clearLongPress()
        longPressTimer.current = setTimeout(() => {
          draggingRef.current = true
          latest.current.onDragStateChange(true)
        }, LONG_PRESS_MS)
      },
      onPanResponderMove: (_event, gesture) => {
        if (!draggingRef.current) {
          // Moving before the long press completes is a scroll attempt, not a
          // drag: drop the pending activation instead of reordering later.
          if (Math.abs(gesture.dy) > 8) clearLongPress()
          return
        }
        const step = Math.round(gesture.dy / ROW_STEP)
        if (step === lastStep.current) return
        lastStep.current = step
        latest.current.onMove(latest.current.itemId, originIndex.current + step)
      },
      onPanResponderRelease: finishDrag,
      onPanResponderTerminate: finishDrag,
      onPanResponderTerminationRequest: () => !draggingRef.current,
    }))
    return clearLongPress
  }, [])

  return (
    <View
      style={{
        minHeight: 48,
        borderRadius: 14,
        backgroundColor: colors.card,
        boxShadow: `inset 0 0 0 1px ${dragging ? colors.run : colors.hair}`,
        paddingLeft: 2,
        paddingRight: 4,
        paddingVertical: 6,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        opacity: dragging ? 0.96 : 1,
      }}
    >
      <View
        {...responder?.panHandlers}
        accessible
        accessibilityLabel="拖动调整排队顺序"
        accessibilityHint="长按后上下拖动"
        style={{ width: 24, minHeight: 40, alignItems: 'center', justifyContent: 'center' }}
      >
        <Icon name="grip-vertical" size={15} color={dragging ? colors.run : colors.ink3} />
      </View>
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
      <IconButton
        icon="chevron-up"
        label={`上移排队消息：${item.text}`}
        size={36}
        iconSize={16}
        disabled={index === 0}
        onPress={() => onMove(item.id, index - 1)}
      />
      <IconButton
        icon="chevron-down"
        label={`下移排队消息：${item.text}`}
        size={36}
        iconSize={16}
        disabled={index === count - 1}
        onPress={() => onMove(item.id, index + 1)}
      />
      {guiding ? (
        <QueueAction
          label="引导"
          strong
          disabled={guideDisabled}
          onPress={() => onGuide(item.id)}
          a11y={`立即引导排队的消息：${item.text}`}
        />
      ) : paused && index === 0 ? (
        <QueueAction label="发送" strong onPress={() => onSendNow(item.id)} a11y={`现在发送排队的消息：${item.text}`} />
      ) : null}
      <QueueAction label="撤回" onPress={() => onWithdraw(item.id)} a11y={`撤回排队的消息：${item.text}`} />
    </View>
  )
}

function QueueAction({
  label,
  onPress,
  strong,
  disabled,
  a11y,
}: {
  label: string
  onPress(): void
  strong?: boolean
  disabled?: boolean
  a11y: string
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 36,
        paddingHorizontal: 8,
        justifyContent: 'center',
        opacity: disabled ? 0.4 : pressed ? 0.5 : 1,
      })}
    >
      <Text style={{ fontSize: 14, fontWeight: strong ? '600' : '400', color: strong ? colors.ink : colors.ink2 }}>
        {label}
      </Text>
    </Pressable>
  )
}
