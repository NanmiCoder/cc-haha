import { forwardRef, type ComponentRef } from 'react'
import { Text as NativeText, type TextProps } from 'react-native'

/** Shared typeface; explicit mono styles and accessibility scaling remain native. */
export const Text = forwardRef<ComponentRef<typeof NativeText>, TextProps>(
  function Text({ style, ...props }, ref) {
    return (
      <NativeText
        {...props}
        ref={ref}
        style={[{ fontFamily: 'Geist' }, style]}
      />
    )
  }
)
