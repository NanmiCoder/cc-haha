
import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { MessageEntry } from '../../types/session'
import { formatMessageContent } from '../../lib/messageContent'

interface AssistantMessageProps {
  message: MessageEntry
}

export default function AssistantMessage({ message }: AssistantMessageProps) {
  let displayText = ''

  if (message.type === 'tool_use') {
    displayText = `[Tool use: ${formatMessageContent(message.content)}]`
  } else if (message.type === 'tool_result') {
    displayText = `[Tool result: ${formatMessageContent(message.content)}]`
  } else {
    displayText = formatMessageContent(message.content)
  }

  return (
    <View style={styles.container}>
      <View style={styles.bubble}>
        <Text style={styles.text}>{displayText}</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  bubble: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    maxWidth: '80%',
    borderWidth: 1,
    borderColor: '#DDE5EE',
  },
  text: {
    color: '#172033',
    fontSize: 16,
    lineHeight: 22,
  },
})
