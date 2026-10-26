import { forwardRef, type ComponentRef } from 'react'
import { Text as NativeText, type TextProps } from 'react-native'

/** 系统字体（SF Pro / PingFang / Roboto），保留系统的辅助功能字号缩放。 */
export const Text = forwardRef<ComponentRef<typeof NativeText>, TextProps>(
  function Text(props, ref) {
    return <NativeText {...props} ref={ref} />
  }
)
