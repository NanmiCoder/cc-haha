import { useEffect, useState } from 'react'
import { Animated, PanResponder, View } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { Text } from '../Text'
import { useColors } from '../kit'
import { EFFORT_TRACK, effortTrackIndex, effortTrackStops } from './computerModel'

type Props = {
  options: { value: string; label: string }[]
  selected: number
  disabled: boolean
  onChange(value: string): void
  width: number
}

/**
 * 拖动手势：实例只创建一次，最新的档位和回调通过 sync() 更新。
 * 滑块直接跟手（只改动画值），松手吸附到最近一档；只在松手时提交。
 */
class TrackGesture {
  private props: Props = { options: [], selected: -1, disabled: true, onChange() {}, width: 0 }
  private startX = 0
  private index = -1
  readonly x = new Animated.Value(0)
  readonly responder = PanResponder.create({
    onStartShouldSetPanResponder: () => this.enabled(),
    onMoveShouldSetPanResponder: () => this.enabled(),
    // 横向拖动不让外层滚动接走。
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (event) => {
      this.startX = event.nativeEvent.locationX
      this.x.stopAnimation()
      this.follow(this.startX)
    },
    onPanResponderMove: (_event, state) => this.follow(this.startX + state.dx),
    onPanResponderRelease: (_event, state) => this.commit(this.startX + state.dx),
    onPanResponderTerminate: () => {
      this.release()
      this.settle(true)
    },
  })

  constructor(private readonly onDrag: (index: number | null) => void) {}

  sync(props: Props) {
    this.props = props
  }

  settle(animated: boolean) {
    const { selected, width, options } = this.props
    if (selected < 0 || !width) return
    const target = effortTrackStops(width, options.length)[selected]
    if (target === undefined) return
    if (!animated) this.x.setValue(target)
    else Animated.spring(this.x, { toValue: target, useNativeDriver: false, speed: 22, bounciness: 6 }).start()
  }

  private enabled() {
    return !this.props.disabled && this.props.width > 0
  }

  private follow(x: number) {
    const { width, options } = this.props
    const stops = effortTrackStops(width, options.length)
    const first = stops[0] ?? 0
    const last = stops[stops.length - 1] ?? 0
    this.x.setValue(Math.min(Math.max(x, first), last))
    const index = effortTrackIndex(x, width, options.length)
    if (index !== this.index) {
      this.index = index
      this.onDrag(index)
    }
  }

  private commit(x: number) {
    const { options, selected, onChange, width } = this.props
    const index = effortTrackIndex(x, width, options.length)
    this.release()
    const next = options[index]
    if (next && index !== selected) onChange(next.value)
    else this.settle(true)
  }

  private release() {
    this.index = -1
    this.onDrag(null)
  }
}

/**
 * P2 思考强度滑条：40pt 圆头轨道铺满浅到深的整条渐变，6pt 圆点标出各档，
 * 44pt 白色滑块压在选中档上；下方一行档位名，选中的墨色加粗。
 * 还没设过强度（沿用电脑默认）时不画滑块。
 */
export function EffortTrack({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  label: string
  options: { value: string; label: string }[]
  value: string
  disabled?: boolean
  onChange(value: string): void
}) {
  const colors = useColors()
  const [width, setWidth] = useState(0)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [gesture] = useState(() => new TrackGesture(setDragIndex))
  const selected = options.findIndex((option) => option.value === value)
  // 宽度刚量好时直接放到位，只有档位变了才弹过去。
  const [placed, setPlaced] = useState({ width: 0, selected: -1, animate: false })
  if (placed.width !== width || placed.selected !== selected)
    setPlaced({ width, selected, animate: placed.width === width && width > 0 })
  useEffect(() => {
    gesture.sync({ options, selected, disabled: !!disabled, onChange, width })
  })
  useEffect(() => {
    gesture.settle(placed.animate)
  }, [gesture, placed])

  const { height, inset, thumb } = EFFORT_TRACK
  const stops = width ? effortTrackStops(width, options.length) : []
  const active = dragIndex ?? selected
  const showThumb = !!width && (selected >= 0 || dragIndex !== null)
  const step = (delta: number) => {
    const next = options[Math.min(options.length - 1, Math.max(0, (selected < 0 ? 0 : selected) + delta))]
    if (next && next.value !== value) onChange(next.value)
  }

  return (
    <View style={{ opacity: disabled ? 0.45 : 1 }}>
      {/* 触摸区比轨道上下各多 2pt，装下伸出轨道的滑块；负外边距让占位仍是 40pt。 */}
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ text: options[selected]?.label ?? '默认' }}
        accessibilityState={{ disabled: !!disabled }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (disabled) return
          if (nativeEvent.actionName === 'increment') step(1)
          if (nativeEvent.actionName === 'decrement') step(-1)
        }}
        onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
        {...gesture.responder.panHandlers}
        style={{ height: thumb, marginVertical: (height - thumb) / 2 }}
      >
        {/* 子元素都不接触摸：locationX 始终相对整个滑条区域。 */}
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: inset,
            right: inset,
            top: (thumb - height) / 2,
            height,
            borderRadius: height / 2,
            overflow: 'hidden',
          }}
        >
          <LinearGradient
            colors={[colors.chevron, colors.ink]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={{ flex: 1 }}
          />
        </View>
        {stops.map((x, index) => (
          <View
            key={options[index]?.value ?? index}
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: x - 3,
              top: thumb / 2 - 3,
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: 'rgba(255,255,255,0.75)',
            }}
          />
        ))}
        {showThumb ? (
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: thumb,
              height: thumb,
              borderRadius: thumb / 2,
              backgroundColor: colors.card,
              boxShadow: '0 2px 8px rgba(0,0,0,0.22)',
              transform: [{ translateX: Animated.subtract(gesture.x, thumb / 2) }],
            }}
          />
        ) : null}
      </View>
      <View style={{ height: 20, marginTop: 10 }}>
        {stops.map((x, index) => {
          const option = options[index]
          if (!option) return null
          return (
            <Text
              key={option.value}
              numberOfLines={1}
              style={{
                position: 'absolute',
                left: x - 24,
                width: 48,
                textAlign: 'center',
                fontSize: 14,
                lineHeight: 20,
                fontWeight: index === active ? '600' : '400',
                color: index === active ? colors.ink : colors.ink3,
              }}
            >
              {option.label}
            </Text>
          )
        })}
      </View>
    </View>
  )
}
