import { useEffect, useState } from 'react'
import { AccessibilityInfo, Animated, Easing, Keyboard, Platform } from 'react-native'

/** 系统「减弱动态效果」打开时，扫描线和光圈都停在静止状态。 */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    let alive = true
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => alive && setReduced(value))
      .catch(() => {})
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduced
    )
    return () => {
      alive = false
      subscription.remove()
    }
  }, [])
  return reduced
}

/** 键盘是否弹出：手动连接面板在键盘弹出时放弃固定高度，让输入框留在可见区。 */
export function useKeyboardShown() {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setShown(true)
    )
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setShown(false)
    )
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])
  return shown
}

/** 扫描框里的扫描线：2.4s 缓入缓出，上下往返 212pt。 */
export function ScanLine() {
  const reduced = useReducedMotion()
  const [progress] = useState(() => new Animated.Value(0))
  useEffect(() => {
    if (reduced) return
    const timing = (toValue: number) =>
      Animated.timing(progress, {
        toValue,
        duration: 2400,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: Platform.OS !== 'web',
      })
    const loop = Animated.loop(Animated.sequence([timing(1), timing(0)]))
    loop.start()
    return () => loop.stop()
  }, [progress, reduced])
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 14,
        left: 18,
        right: 18,
        height: 2,
        borderRadius: 1,
        backgroundColor: 'rgba(255,255,255,0.85)',
        boxShadow: '0 0 12px rgba(255,255,255,0.6)',
        transform: [
          {
            translateY: reduced
              ? 106
              : progress.interpolate({ inputRange: [0, 1], outputRange: [0, 212] }),
          },
        ],
      }}
    />
  )
}

/** 等电脑批准时的外圈光圈：从 0.85 倍扩散到 1.35 倍并淡出，2s 一轮。 */
export function PulseRing({ color, size = 120 }: { color: string; size?: number }) {
  const reduced = useReducedMotion()
  const [progress] = useState(() => new Animated.Value(0))
  useEffect(() => {
    if (reduced) return
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 2000,
        easing: Easing.out(Easing.ease),
        useNativeDriver: Platform.OS !== 'web',
      })
    )
    loop.start()
    return () => loop.stop()
  }, [progress, reduced])
  if (reduced) return null
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 2,
        borderColor: color,
        opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
        transform: [
          { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.35] }) },
        ],
      }}
    />
  )
}
