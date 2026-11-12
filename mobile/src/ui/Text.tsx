import { forwardRef, type ComponentRef } from 'react'
import { Text as NativeText, type TextProps } from 'react-native'

/** System font (SF Pro / PingFang / Roboto), keeping the system accessibility font scaling. */
export const Text = forwardRef<ComponentRef<typeof NativeText>, TextProps>(
  function Text(props, ref) {
    return <NativeText {...props} ref={ref} />
  }
)
