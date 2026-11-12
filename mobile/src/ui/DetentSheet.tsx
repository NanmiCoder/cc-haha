import { useEffect, useState, type PropsWithChildren, type ReactNode } from 'react'
import {
  Animated,
  Easing,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Text } from './Text'
import { KeyboardViewport } from './KeyboardViewport'
import { type } from './palette'
import { useColors } from './kit'
import { detentHeight, settleDetent, sheetAvailable, type Detent } from './detents'

export type DetentSheetProps = PropsWithChildren<{
  visible: boolean
  onClose(): void
  title?: string
  left?: ReactNode
  right?: ReactNode
  /** Content fixed below the title bar and above the list (search box, segmented control). */
  header?: ReactNode
  /** Primary button bar fixed to the bottom. */
  footer?: ReactNode
  /** Controlled detent; when omitted the grabber gesture switches it. */
  detent?: Detent
  onDetentChange?(detent: Detent): void
  initialDetent?: Detent
  /** false only has the half detent (dragging up has no effect). */
  allowFull?: boolean
  scroll?: boolean
  dismissable?: boolean
  background?: string
}>

/**
 * A sheet with detents: half (about 62%) and full (about 94%).
 * The grabber and title bar are draggable: drag up to expand, down to go back to half or close; tap backdrop to close; 
 * when the search box is focused the caller sets detent to 'full'. The content area scrolls itself and does not join the gesture.
 */
export function DetentSheet(props: DetentSheetProps) {
  const colors = useColors()
  const { height: windowHeight } = useWindowDimensions()
  // When the keyboard opens KeyboardViewport shrinks the content area, so what is measured here is the truly available height.
  const [viewportHeight, setViewportHeight] = useState(windowHeight)
  // After closing the subtree unmounts, and onLayout will not restore the small keyboard-state height; the next open would start short then grow.
  // Restore to the window height when collapsed, so the first frame on reopen is correct.
  const [wasVisible, setWasVisible] = useState(props.visible)
  if (props.visible !== wasVisible) {
    setWasVisible(props.visible)
    if (!props.visible) setViewportHeight(windowHeight)
  }
  // Keep up when the window size changes while collapsed (rotation/split screen).
  if (!props.visible && viewportHeight !== windowHeight) setViewportHeight(windowHeight)
  const close = () => {
    if (props.dismissable !== false) props.onClose()
  }
  return (
    <Modal visible={props.visible} transparent animationType="slide" onRequestClose={close} statusBarTranslucent>
      <KeyboardViewport style={{ flex: 1 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={close}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.scrim }}
        />
        <View
          style={{ flex: 1, justifyContent: 'flex-end' }}
          onLayout={(event) => {
            const next = Math.round(event.nativeEvent.layout.height)
            setViewportHeight((previous) => (previous === next ? previous : next))
          }}
        >
          {/* Modal The subtree unmounts on close, so each open starts from initialDetent. */}
          <Panel {...props} onClose={close} viewportHeight={viewportHeight} />
        </View>
      </KeyboardViewport>
    </Modal>
  )
}

type GestureProps = {
  level: Detent
  available: number
  allowFull: boolean
  close(): void
  choose(next: Detent): void
}

/** Grabber gesture: the instance is created only once, and the latest detent and callbacks are updated via sync(), so the responder is not swapped mid-drag. */
class DetentGesture {
  private props: GestureProps = { level: 'half', available: 0, allowFull: true, close() {}, choose() {} }
  readonly responder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_event, state) => Math.abs(state.dy) > 4,
    onPanResponderMove: (_event, state) => {
      const { level, available, allowFull } = this.props
      const max = detentHeight(allowFull ? 'full' : 'half', available)
      this.height.setValue(Math.min(max, Math.max(0, detentHeight(level, available) - state.dy)))
    },
    onPanResponderRelease: (_event, state) => {
      const { level, allowFull } = this.props
      const outcome = settleDetent({ level, dy: state.dy, vy: state.vy, allowFull })
      if (outcome === 'close') this.props.close()
      else if (outcome !== level) this.props.choose(outcome)
      else this.settle(160)
    },
    onPanResponderTerminate: () => this.settle(160),
  })

  constructor(private readonly height: Animated.Value) {}

  sync(props: GestureProps) {
    this.props = props
  }

  private settle(duration: number) {
    const { level, available } = this.props
    Animated.timing(this.height, {
      toValue: detentHeight(level, available),
      duration,
      useNativeDriver: false,
    }).start()
  }
}

function Panel({
  viewportHeight,
  onClose,
  title,
  left,
  right,
  header,
  footer,
  detent,
  onDetentChange,
  initialDetent = 'half',
  allowFull = true,
  scroll = true,
  background,
  children,
}: DetentSheetProps & { viewportHeight: number }) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const available = sheetAvailable(viewportHeight, insets.top)
  const [inner, setInner] = useState<Detent>(initialDetent)
  const level: Detent = allowFull ? (detent ?? inner) : 'half'
  const target = detentHeight(level, available)
  const [height] = useState(() => new Animated.Value(target))
  const [gesture] = useState(() => new DetentGesture(height))
  useEffect(() => {
    gesture.sync({
      level,
      available,
      allowFull,
      close: onClose,
      choose: (next) => {
        setInner(next)
        onDetentChange?.(next)
      },
    })
  })
  useEffect(() => {
    Animated.timing(height, {
      toValue: target,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start()
  }, [height, target])
  const hasTitle = !!(title || left || right)
  return (
    <Animated.View
      accessibilityViewIsModal
      // The backdrop is outside the panel so VoiceOver cannot reach it; the two-finger Z gesture closes via here.
      onAccessibilityEscape={onClose}
      style={{
        height,
        maxHeight: '100%',
        backgroundColor: background ?? colors.sheet,
        borderTopLeftRadius: 28,
        borderTopRightRadius: 28,
        overflow: 'hidden',
        boxShadow: '0 -8px 30px rgba(0,0,0,0.12)',
      }}
    >
      <View {...gesture.responder.panHandlers}>
        <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: hasTitle ? 2 : 8 }}>
          <View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: colors.chevron, opacity: 0.6 }} />
        </View>
        {hasTitle ? (
          <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 }}>
            <View style={{ flex: 1, alignItems: 'flex-start' }}>{left}</View>
            {title ? (
              <Text numberOfLines={1} style={[type.nav, { color: colors.ink, flexShrink: 1, textAlign: 'center' }]}>
                {title}
              </Text>
            ) : null}
            <View style={{ flex: 1, alignItems: 'flex-end' }}>{right}</View>
          </View>
        ) : null}
      </View>
      {header ? <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>{header}</View> : null}
      {scroll ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12, gap: 12 }}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={{ flex: 1, paddingHorizontal: 16, gap: 12, minHeight: 0 }}>{children}</View>
      )}
      {footer ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: Math.max(insets.bottom, 16) }}>
          {footer}
        </View>
      ) : (
        <View style={{ height: Math.max(insets.bottom, 12) }} />
      )}
    </Animated.View>
  )
}
