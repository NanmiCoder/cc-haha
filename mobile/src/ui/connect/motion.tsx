import { useEffect, useState } from 'react'
import { AccessibilityInfo, Animated, Easing, Keyboard, Platform } from 'react-native'

/** When system "Reduce Motion" is on, the scan line and halo stay still. */
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

/** Whether the keyboard is up: the manual connect panel drops its fixed height when the keyboard is up so the input stays visible. */
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

/** Scan line inside the scan frame: 2.4s ease-in-out, moving 212pt up and down. */
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

/** Outer halo while waiting for computer approval: spreads from 0.85x to 1.35x and fades out, 2s per cycle. */
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
