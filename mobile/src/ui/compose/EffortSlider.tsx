import { useEffect, useState } from 'react'
import { Animated, PanResponder, View } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { Text } from '../Text'
import { useColors } from '../kit'
import { effortStopAt, effortStopX } from './runLogic'

// The thumb is a size larger than the track (like Codex), so the rounded ends of the track are always covered by the thumb.
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
 * Drag gesture: the instance is created only once, and the latest tier and callbacks are updated via sync(), so the responder is not swapped mid-drag.
 * While dragging the thumb follows the finger directly (only changing the animated value, no rerender), snapping to the nearest tier on release.
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
    // Horizontal drags are not taken over by outer scrolling or the sheet.
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (event) => {
      this.startX = event.nativeEvent.locationX
      this.dragging = false
      this.x.stopAnimation()
      // A tap keeps the current position and transitions to the target tier on release; only dragging follows the finger directly.
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

  /** Slide to the selected tier; place directly when the width was just measured, spring afterwards. */
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
    // Update the label highlight only when crossing a tier, without rerendering every frame while dragging.
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
 * Thinking effort slider (inspired by Codex): the track carries an ink gradient from light to dark, revealed up to where the thumb is, 
 * with stronger effort meaning deeper color. Ink rather than blue: in this app blue means "running".
 * Commit only on release; dragging does not change the computer configuration. When no effort has been set (default) no thumb is drawn.
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
  // The nearest tier under the finger while dragging, used to highlight the label; null when not dragging.
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [gesture] = useState(() => new SliderGesture(setDragIndex))
  const selected = options.findIndex((option) => option.value === value)
  // Width and tier when the thumb was last placed: when the width was just measured (sheet opened, rotation) place it directly, and only spring when the tier changes.
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
        accessibilityValue={{ text: options[selected]?.label ?? 'Default' }}
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
        {/* Children do not take touches: locationX is always relative to the whole slider area. */}
        <View
          pointerEvents="none"
          style={{ position: 'absolute', left: 0, right: 0, height: TRACK, borderRadius: TRACK / 2, backgroundColor: colors.fill }}
        >
          {width ? dots(colors.chevron) : null}
        </View>
        {showThumb ? (
          <>
            {/* Revealed part: the right rounded end is concentric with the thumb and hidden beneath it, fully covered at the leftmost tier. */}
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
