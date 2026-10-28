import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react'
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  View,
  useWindowDimensions,
  type ViewProps,
} from 'react-native'
import { bottomAlignedKeyboardOffset, keyboardOverlap } from './keyboardLayout'

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

/** Every caller fills its screen to the bottom, including native iOS page sheets. */
function IosKeyboardViewport({ onLayout, ...props }: ViewProps) {
  const { height: windowHeight } = useWindowDimensions()
  const [frame, setFrame] = useState({ y: 0, height: windowHeight })
  return (
    <KeyboardAvoidingView
      {...props}
      behavior="padding"
      keyboardVerticalOffset={bottomAlignedKeyboardOffset(windowHeight, frame)}
      onLayout={(event) => {
        const { y, height } = event.nativeEvent.layout
        setFrame((previous) => previous.y === y && previous.height === height ? previous : { y, height })
        onLayout?.(event)
      }}
    />
  )
}

/** Keep input and footer together inside the space above the software keyboard. */
export function KeyboardViewport(props: ViewProps) {
  if (Platform.OS === 'android') return <AndroidKeyboardViewport {...props} />
  if (Platform.OS === 'ios') return <IosKeyboardViewport {...props} />
  return <View {...props} />
}
