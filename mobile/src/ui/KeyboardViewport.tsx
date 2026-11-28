import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react'
import { Dimensions, Keyboard, Platform, View, type ViewProps } from 'react-native'
import { IOS_KEYBOARD_EVENTS, iosKeyboardInset, keyboardOverlap, nextIosKeyboardState, type IosKeyboardState } from './keyboardLayout'

/** Android edge-to-edge windows can overlay the IME even with adjustResize enabled. */
function AndroidKeyboardViewport({ style, onLayout, ...props }: ViewProps) {
  const view = useRef<ComponentRef<typeof View>>(null)
  const keyboardTop = useRef<number | null>(Keyboard.metrics()?.screenY ?? null)
  const [bottom, setBottom] = useState(0)
  const measure = useCallback(() => {
    view.current?.measureInWindow((_x, screenY, _width, height) => {
      setBottom(keyboardOverlap({ screenY, height }, keyboardTop.current))
    })
  }, [])

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (event) => {
      keyboardTop.current = event.endCoordinates.screenY
      measure()
    })
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      keyboardTop.current = null
      setBottom(0)
    })
    // A nested modal can mount after the keyboard is already visible.
    keyboardTop.current = Keyboard.metrics()?.screenY ?? null
    measure()
    return () => {
      show.remove()
      hide.remove()
    }
  }, [measure])

  return (
    <View
      {...props}
      ref={view}
      collapsable={false}
      style={[style, { paddingBottom: bottom }]}
      onLayout={(event) => {
        onLayout?.(event)
        measure()
      }}
    />
  )
}

/**
 * Every caller fills its screen to the bottom, including native iOS page sheets.
 * React Native's KeyboardAvoidingView only follows WillShow/WillHide, so a keyboard that
 * comes back from another app at a transitional height left the composer stranded.
 */
function IosKeyboardViewport({ style, ...props }: ViewProps) {
  const [bottom, setBottom] = useState(() => {
    // A nested sheet can mount while the keyboard is already up.
    const metrics = Keyboard.metrics()
    return metrics
      ? iosKeyboardInset('keyboardDidShow', { endCoordinates: metrics }, Dimensions.get('window').height) ?? 0
      : 0
  })
  const state = useRef<IosKeyboardState>({ inset: bottom, hiding: false })

  useEffect(() => {
    const subscriptions = IOS_KEYBOARD_EVENTS.map((name) =>
      Keyboard.addListener(name, (event) => {
        const prev = state.current
        const next = nextIosKeyboardState(prev, name, event, Dimensions.get('window').height)
        state.current = next
        if (next.inset === prev.inset) return
        if (name.startsWith('keyboardWill')) Keyboard.scheduleLayoutAnimation(event)
        setBottom(next.inset)
      }),
    )
    return () => subscriptions.forEach((subscription) => subscription.remove())
  }, [])

  return <View {...props} style={[style, { paddingBottom: bottom }]} />
}

/** Keep input and footer together inside the space above the software keyboard. */
export function KeyboardViewport(props: ViewProps) {
  if (Platform.OS === 'android') return <AndroidKeyboardViewport {...props} />
  if (Platform.OS === 'ios') return <IosKeyboardViewport {...props} />
  return <View {...props} />
}
