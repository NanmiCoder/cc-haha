
import React, { useRef, useEffect } from 'react'
import { FlatList, View, StyleSheet } from 'react-native'
import { MessageEntry } from '../../types/session'
import UserMessage from './UserMessage'
import AssistantMessage from './AssistantMessage'

interface MessageListProps {
  messages: MessageEntry[]
  isLoading?: boolean
}

export default function MessageList({ messages, isLoading }: MessageListProps) {
  const flatListRef = useRef<FlatList>(null)

  useEffect(() => {
    if (messages.length > 0 && flatListRef.current) {
      flatListRef.current.scrollToEnd({ animated: true })
    }
  }, [messages.length])

  const renderMessage = ({ item }: { item: MessageEntry }) => {
    switch (item.type) {
      case 'user':
        return <UserMessage message={item} />
      case 'assistant':
      case 'tool_use':
      case 'tool_result':
        return <AssistantMessage message={item} />
      case 'system':
      default:
        return <View style={styles.systemMessage} />
    }
  }

  return (
    <FlatList
      ref={flatListRef}
      data={messages}
      keyExtractor={(item) => item.id}
      renderItem={renderMessage}
      style={styles.list}
      contentContainerStyle={styles.listContent}
      onContentSizeChange={() => {
        if (messages.length > 0) {
          flatListRef.current?.scrollToEnd({ animated: true })
        }
      }}
      showsVerticalScrollIndicator={false}
    />
  )
}

const styles = StyleSheet.create({
  list: {
    flex: 1,
  },
  listContent: {
    paddingVertical: 8,
  },
  systemMessage: {
    padding: 12,
    alignItems: 'center',
  },
})
