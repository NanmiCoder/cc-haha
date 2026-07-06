
import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { MessageEntry } from '../../types/session'
import { formatMessageContent } from '../../lib/messageContent'

interface UserMessageProps {
  message: MessageEntry
}

export default function UserMessage({ message }: UserMessageProps) {
  const content = formatMessageContent(message.content)

  return (
    <View style={styles.container}>
      <View style={styles.bubble}>
        <Text style={styles.text}>{content}</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  bubble: {
    backgroundColor: '#172033',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    maxWidth: '80%',
  },
  text: {
    color: '#fff',
    fontSize: 16,
    lineHeight: 22,
  },
})
