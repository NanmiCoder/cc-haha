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
  /** 标题栏下、列表上方固定的内容（搜索框、分段控件）。 */
  header?: ReactNode
  /** 贴底固定的主按钮栏。 */
  footer?: ReactNode
  /** 受控档位；不传时由抓手手势自己切换。 */
  detent?: Detent
  onDetentChange?(detent: Detent): void
  initialDetent?: Detent
  /** false 时只有半高一档（向上拖没有效果）。 */
  allowFull?: boolean
  scroll?: boolean
  dismissable?: boolean
  background?: string
}>

/**
 * 可定档的底单：半高（约 62%）与全高（约 94%）两档。
 * 抓手和标题栏可以拖：向上拖展开，向下拖回半高或关闭；点遮罩关闭；
 * 搜索框聚焦时由调用方把 detent 设为 'full'。内容区自己滚动，不参与手势。
 */
export function DetentSheet(props: DetentSheetProps) {
  const colors = useColors()
  const { height: windowHeight } = useWindowDimensions()
  // 键盘弹出时 KeyboardViewport 会缩小内容区，这里量到的就是真正可用的高度。
  const [viewportHeight, setViewportHeight] = useState(windowHeight)
  // 关闭后子树被卸载，onLayout 不会再把键盘态的小高度改回来；下次打开会先矮后长。
  // 收起时恢复成窗口高度，重新打开的首帧就是对的。
  const [wasVisible, setWasVisible] = useState(props.visible)
  if (props.visible !== wasVisible) {
    setWasVisible(props.visible)
    if (!props.visible) setViewportHeight(windowHeight)
  }
  // 收起状态下窗口尺寸变了（旋转/分屏）也要跟上。
  if (!props.visible && viewportHeight !== windowHeight) setViewportHeight(windowHeight)
  const close = () => {
    if (props.dismissable !== false) props.onClose()
  }
  return (
    <Modal visible={props.visible} transparent animationType="slide" onRequestClose={close} statusBarTranslucent>
      <KeyboardViewport style={{ flex: 1 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭"
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
          {/* Modal 关闭时子树被卸载，所以每次打开都从 initialDetent 开始。 */}
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

/** 抓手手势：实例只创建一次，最新的档位和回调通过 sync() 更新，拖动中不会换掉响应器。 */
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
      // 遮罩在面板外，VoiceOver 读不到；双指 Z 手势走这里关闭。
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
