import React, { useEffect, useRef } from 'react'
import {
  View,
  StyleSheet,
  SafeAreaView,
  ActivityIndicator,
  TouchableOpacity,
  Text,
} from 'react-native'
import { useNavigation } from '@react-navigation/native'
import { Ionicons } from '@expo/vector-icons'
import { useSessionStore } from '../stores/sessionStore'
import MessageList from '../components/chat/MessageList'
import ChatInput from '../components/chat/ChatInput'
import { wsManager } from '../api/websocket'
import {
  buildPermissionResponsePayload,
  buildUserMessagePayload,
  createLocalUserMessage,
  projectNameFromPath,
} from '../lib/serverEvents'

export default function ChatScreen() {
  const navigation = useNavigation()
  const {
    activeSessionId,
    activeMessages,
    sessions,
    appendMessage,
    setSending,
    handleServerEvent,
    clearPendingPermission,
    pendingPermission,
    isSending,
    isLoadingMessages,
    loadSession,
  } = useSessionStore()
  const wsSubscriptionRef = useRef<(() => void) | null>(null)
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const projectPath = activeSession?.workDir || activeSession?.projectPath || ''
  const projectName = projectPath ? projectNameFromPath(projectPath) : 'Remote project'

  useEffect(() => {
    if (!activeSessionId) {
      navigation.goBack()
      return
    }

    wsManager.connect(activeSessionId)
    wsSubscriptionRef.current = wsManager.onMessage(activeSessionId, (message) => {
      handleServerEvent(message)
      if (message.type === 'error') {
        console.error('WebSocket error:', message)
      }
    })

    return () => {
      if (wsSubscriptionRef.current) {
        wsSubscriptionRef.current()
      }
      wsManager.disconnect(activeSessionId)
    }
  }, [activeSessionId, handleServerEvent, navigation])

  const handleSend = async (text: string) => {
    if (!activeSessionId || !text.trim()) return

    appendMessage(createLocalUserMessage(text))
    setSending(true)
    wsManager.send(activeSessionId, buildUserMessagePayload(text))
  }

  const respondToPermission = (allowed: boolean) => {
    if (!activeSessionId || !pendingPermission) return
    wsManager.send(
      activeSessionId,
      buildPermissionResponsePayload(pendingPermission.requestId, allowed),
    )
    clearPendingPermission()
    setSending(allowed)
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.iconButton} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={22} color="#172033" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.projectName} numberOfLines={1}>{projectName}</Text>
          <Text style={styles.sessionTitle} numberOfLines={1}>
            {activeSession?.title || 'Remote session'}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.iconButton}
          onPress={() => {
            if (activeSessionId) {
              loadSession(activeSessionId)
            }
          }}
        >
          <Ionicons name="refresh" size={21} color="#172033" />
        </TouchableOpacity>
      </View>

      {projectPath ? (
        <View style={styles.pathStrip}>
          <Ionicons name="folder-outline" size={14} color="#52627A" />
          <Text style={styles.pathText} numberOfLines={1}>{projectPath}</Text>
        </View>
      ) : null}

      {isLoadingMessages ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#172033" />
          <Text style={styles.loadingText}>Loading conversation...</Text>
        </View>
      ) : (
        <View style={styles.content}>
          <MessageList messages={activeMessages} isLoading={isSending} />
          {pendingPermission ? (
            <View style={styles.permissionPanel}>
              <View style={styles.permissionIcon}>
                <Ionicons name="shield-checkmark-outline" size={20} color="#172033" />
              </View>
              <View style={styles.permissionBody}>
                <Text style={styles.permissionTitle}>
                  Allow {pendingPermission.toolName}?
                </Text>
                <Text style={styles.permissionText} numberOfLines={3}>
                  {pendingPermission.description || summarizePermissionInput(pendingPermission.input)}
                </Text>
                <View style={styles.permissionActions}>
                  <TouchableOpacity
                    style={[styles.permissionButton, styles.denyButton]}
                    onPress={() => respondToPermission(false)}
                  >
                    <Text style={styles.denyButtonText}>Deny</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.permissionButton, styles.allowButton]}
                    onPress={() => respondToPermission(true)}
                  >
                    <Text style={styles.allowButtonText}>Allow</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          ) : null}
          <ChatInput onSend={handleSend} disabled={isSending || !!pendingPermission} />
        </View>
      )}
    </SafeAreaView>
  )
}

function summarizePermissionInput(input: unknown): string {
  if (!input || typeof input !== 'object') return 'The assistant wants to run a protected action.'
  const record = input as Record<string, unknown>
  const path = record.file_path || record.path || record.command
  return typeof path === 'string'
    ? `The assistant wants permission for ${path}.`
    : 'The assistant wants to run a protected action.'
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#EEF2F6',
  },
  header: {
    minHeight: 70,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#F9FBFC',
    borderBottomWidth: 1,
    borderBottomColor: '#DDE5EE',
  },
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: 10,
    backgroundColor: '#E7EDF4',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    flex: 1,
    minWidth: 0,
  },
  projectName: {
    color: '#172033',
    fontSize: 17,
    fontWeight: '800',
  },
  sessionTitle: {
    marginTop: 2,
    color: '#607089',
    fontSize: 12,
    fontWeight: '700',
  },
  pathStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#DCE7F3',
  },
  pathText: {
    flex: 1,
    color: '#52627A',
    fontSize: 12,
    fontWeight: '600',
  },
  content: {
    flex: 1,
    backgroundColor: '#EEF2F6',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    color: '#607089',
  },
  permissionPanel: {
    marginHorizontal: 12,
    marginBottom: 10,
    flexDirection: 'row',
    gap: 12,
    padding: 14,
    borderRadius: 8,
    backgroundColor: '#FFF7ED',
    borderWidth: 1,
    borderColor: '#FDBA74',
  },
  permissionIcon: {
    width: 34,
    height: 34,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FED7AA',
  },
  permissionBody: {
    flex: 1,
  },
  permissionTitle: {
    color: '#172033',
    fontSize: 15,
    fontWeight: '800',
  },
  permissionText: {
    marginTop: 4,
    color: '#7C4A1D',
    fontSize: 12,
    lineHeight: 17,
  },
  permissionActions: {
    marginTop: 12,
    flexDirection: 'row',
    gap: 10,
  },
  permissionButton: {
    flex: 1,
    height: 40,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  denyButton: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#FDBA74',
  },
  allowButton: {
    backgroundColor: '#172033',
  },
  denyButtonText: {
    color: '#9A3412',
    fontSize: 14,
    fontWeight: '800',
  },
  allowButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
})
