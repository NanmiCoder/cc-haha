import { useEffect, useState } from 'react'
import { Animated, PanResponder, View } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { Text } from '../Text'
import { useColors } from '../kit'
import { effortStopAt, effortStopX } from './runLogic'

// 滑块比轨道大一圈（和 Codex 一样），轨道两端的圆头始终能被滑块盖住。
const TRACK = 36
const THUMB = 44
const DOT = 6

type SliderProps = {
  options: { value: string; label: string }[]
  selected: number
  disabled: boolean
  onChange(value: string): void
  width: number
}

/**
 * 拖动手势：实例只创建一次，最新的档位和回调通过 sync() 更新，拖动中不会换掉响应器。
 * 拖动时滑块直接跟手（只改动画值，不重渲染），松手吸附到最近一档并弹过去。
 */
class SliderGesture {
  private props: SliderProps = { options: [], selected: -1, disabled: true, onChange() {}, width: 0 }
  private startX = 0
  private dragging = false
  private index = -1
  readonly x = new Animated.Value(THUMB / 2)
  readonly responder = PanResponder.create({
    onStartShouldSetPanResponder: () => this.enabled(),
    onMoveShouldSetPanResponder: () => this.enabled(),
    // 横向拖动不让外层滚动或底单接走。
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (event) => {
      this.startX = event.nativeEvent.locationX
      this.dragging = false
      this.x.stopAnimation()
      // 点击保留当前位置，松手后再向目标档位过渡；只有拖动才直接跟手。
    },
    onPanResponderMove: (_event, state) => {
      if (!this.enabled()) return
      if (Math.abs(state.dx) > 3) this.dragging = true
      if (this.dragging) this.follow(this.startX + state.dx)
    },
    onPanResponderRelease: (_event, state) => this.commit(this.startX + state.dx),
    onPanResponderTerminate: () => {
      this.release()
      this.settle(true)
    },
  })

  constructor(private readonly onDrag: (index: number | null) => void) {}

  sync(props: SliderProps) {
    this.props = props
  }

  /** 滑到选中的那一档；刚量好宽度时直接放好，之后弹过去。 */
  settle(animated: boolean) {
    const { selected, width, options } = this.props
    if (selected < 0 || !width) return
    const target = effortStopX(selected, { width, count: options.length, thumb: THUMB })
    if (!animated) this.x.setValue(target)
    else Animated.spring(this.x, { toValue: target, useNativeDriver: false, speed: 22, bounciness: 6 }).start()
  }

  private enabled() {
    return !this.props.disabled && this.props.width > 0 && this.props.options.length > 0
  }

  private geometry() {
    return { width: this.props.width, count: this.props.options.length, thumb: THUMB }
  }

  private follow(x: number) {
    const { width } = this.props
    const clamped = Math.min(Math.max(x, THUMB / 2), Math.max(THUMB / 2, width - THUMB / 2))
    this.x.setValue(clamped)
    // 只在跨过档位时更新一次标签高亮，拖动中不逐帧重渲染。
    const index = effortStopAt(clamped, this.geometry())
    if (index !== this.index) {
      this.index = index
      this.onDrag(index)
    }
  }

  private commit(x: number) {
    if (!this.enabled()) {
      this.release()
      this.settle(true)
      return
    }
    const { options, selected, onChange } = this.props
    const index = effortStopAt(x, this.geometry())
    this.release()
    const next = options[index]
    if (next && index !== selected) onChange(next.value)
    else this.settle(true)
  }

  private release() {
    this.dragging = false
    this.index = -1
    this.onDrag(null)
  }
}

/**
 * 思考强度滑块（参考 Codex）：轨道上铺一条从浅到深的墨色渐变，滑块滑到哪里就露出到哪里，
 * 强度越高颜色越浓。用墨色而不是蓝色：这个 App 里蓝色表示「正在运行」。
 * 只在松手时提交，拖动过程中不改电脑上的配置。还没设过强度（沿用默认）时不画滑块。
 */
export function EffortSlider({
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
  // 拖动中手指下最近的那一档，用来高亮标签；没在拖时为 null。
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [gesture] = useState(() => new SliderGesture(setDragIndex))
  const selected = options.findIndex((option) => option.value === value)
  // 上一次放好滑块时的宽度和档位：宽度刚量好（打开底单、转屏）时直接放到位，只有档位变了才弹过去。
  const count = options.length
  const [placed, setPlaced] = useState({ width: 0, selected: -1, count, animate: false })
  if (placed.width !== width || placed.selected !== selected || placed.count !== count)
    setPlaced({ width, selected, count, animate: placed.width === width && placed.count === count && width > 0 })
  useEffect(() => {
    gesture.sync({ options, selected, disabled: !!disabled, onChange, width })
  })
  useEffect(() => {
    gesture.settle(placed.animate)
  }, [gesture, placed])
  useEffect(() => () => gesture.x.stopAnimation(), [gesture])

  const geometry = { width, count: options.length, thumb: THUMB }
  const showThumb = !!width && (selected >= 0 || dragIndex !== null)
  const active = dragIndex ?? selected
  const step = (delta: number) => {
    const next = options[Math.min(options.length - 1, Math.max(0, (selected < 0 ? 0 : selected) + delta))]
    if (next && next.value !== value) onChange(next.value)
  }
  const dots = (color: string) =>
    options.map((option, index) => (
      <View
        key={option.value}
        style={{
          position: 'absolute',
          left: effortStopX(index, geometry) - DOT / 2,
          top: (TRACK - DOT) / 2,
          width: DOT,
          height: DOT,
          borderRadius: DOT / 2,
          backgroundColor: color,
        }}
      />
    ))

  return (
    <View style={{ gap: 8, opacity: disabled ? 0.45 : 1 }}>
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
        style={{ height: THUMB, justifyContent: 'center' }}
      >
        {/* 子元素都不接触摸：locationX 始终相对整个滑块区域。 */}
        <View
          pointerEvents="none"
          style={{ position: 'absolute', left: 0, right: 0, height: TRACK, borderRadius: TRACK / 2, backgroundColor: colors.fill }}
        >
          {width ? dots(colors.chevron) : null}
        </View>
        {showThumb ? (
          <>
            {/* 露出的部分：右端圆头和滑块同心、藏在滑块下面，在最左一档时整段被盖住。 */}
            <Animated.View
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: 0,
                width: Animated.add(gesture.x, TRACK / 2),
                height: TRACK,
                borderRadius: TRACK / 2,
                overflow: 'hidden',
              }}
            >
              <LinearGradient
                colors={[`${colors.ink}40`, `${colors.ink}B3`, colors.ink]}
                locations={[0, 0.55, 1]}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                style={{ position: 'absolute', left: 0, top: 0, width, height: TRACK }}
              />
              <View style={{ position: 'absolute', left: 0, top: 0, width, height: TRACK, opacity: 0.6 }}>
                {dots(colors.btnInk)}
              </View>
            </Animated.View>
            <Animated.View
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: 0,
                width: THUMB,
                height: THUMB,
                borderRadius: THUMB / 2,
                backgroundColor: colors.card,
                boxShadow: `0 0 0 0.5px ${colors.hair}, 0 1px 2px rgba(28,25,23,0.18), 0 3px 10px rgba(28,25,23,0.16)`,
                transform: [{ translateX: Animated.subtract(gesture.x, THUMB / 2) }],
              }}
            />
          </>
        ) : null}
      </View>
      <View style={{ height: 18 }}>
        {width
          ? options.map((option, index) => (
              <Text
                key={option.value}
                numberOfLines={1}
                style={{
                  position: 'absolute',
                  left: effortStopX(index, geometry) - 32,
                  width: 64,
                  textAlign: 'center',
                  fontSize: 13,
                  lineHeight: 18,
                  fontWeight: index === active ? '600' : '400',
                  color: index === active ? colors.ink : colors.ink3,
                }}
              >
                {option.label}
              </Text>
            ))
          : null}
      </View>
    </View>
  )
}
