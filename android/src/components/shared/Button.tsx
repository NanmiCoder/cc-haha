import React from 'react'
import { TouchableOpacity, Text, StyleSheet, ViewStyle, TextStyle } from 'react-native'

interface ButtonProps {
  title: string
  onPress: () => void
  style?: ViewStyle
  textStyle?: TextStyle
  disabled?: boolean
}

export default function Button({ title, onPress, style, textStyle, disabled }: ButtonProps) {
  return (
    <TouchableOpacity
      style={[styles.button, style, disabled && styles.disabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[styles.text, textStyle, disabled && styles.disabledText]}>
        {title}
      </Text>
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  disabled: {
    backgroundColor: '#ccc',
  },
  text: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  disabledText: {
    color: '#999',
  },
})
