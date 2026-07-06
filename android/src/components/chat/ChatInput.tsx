import React, { useState } from 'react'
import { View, TextInput, TouchableOpacity, StyleSheet } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

interface ChatInputProps {
  onSend: (text: string) => void
  disabled?: boolean
}

export default function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [text, setText] = useState('')

  const handleSend = () => {
    if (text.trim()) {
      onSend(text.trim())
      setText('')
    }
  }

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder={disabled ? 'Waiting for remote action...' : 'Message remote session...'}
        placeholderTextColor="#8A94A6"
        multiline
        editable={!disabled}
      />
      <TouchableOpacity
        style={[styles.sendButton, !text.trim() && styles.disabled]}
        onPress={handleSend}
        disabled={!text.trim() || disabled}
      >
        <Ionicons name="send" size={20} color="#fff" />
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    padding: 12,
    backgroundColor: '#F9FBFC',
    borderTopWidth: 1,
    borderTopColor: '#DDE5EE',
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#DDE5EE',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginRight: 12,
    maxHeight: 100,
    fontSize: 16,
    color: '#172033',
    backgroundColor: '#FFFFFF',
  },
  sendButton: {
    backgroundColor: '#172033',
    width: 42,
    height: 42,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  disabled: {
    backgroundColor: '#A8B2C3',
  },
})
