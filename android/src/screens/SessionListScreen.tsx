import React, { useEffect, useMemo, useState } from 'react'
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  ActivityIndicator,
  Alert,
  RefreshControl,
  Pressable,
} from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { Ionicons } from '@expo/vector-icons'
import { useSessionStore } from '../stores/sessionStore'
import { groupSessionsByProject } from '../lib/serverEvents'
import type { SessionListItem } from '../types/session'
import { DEFAULT_WORK_DIR } from '../constants/config'

type RootStackParamList = {
  SessionList: undefined
  Chat: undefined
  ServerConfig: undefined
}

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'SessionList'>
type IconName = React.ComponentProps<typeof Ionicons>['name']
type FilterOption = {
  key: string
  label: string
  icon: IconName
  disabled?: boolean
}

export default function SessionListScreen() {
  const navigation = useNavigation<NavigationProp>()
  const {
    sessions,
    isLoading,
    fetchSessions,
    loadSession,
    createSession,
    deleteSession,
  } = useSessionStore()
  const groups = useMemo(() => groupSessionsByProject(sessions), [sessions])
  const [selectedFilterKey, setSelectedFilterKey] = useState('all')
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  useEffect(() => {
    if (
      selectedFilterKey.startsWith('project:')
      && !groups.some((group) => `project:${group.key}` === selectedFilterKey)
    ) {
      setSelectedFilterKey('all')
    }
  }, [groups, selectedFilterKey])

  const filterOptions = useMemo<FilterOption[]>(() => [
    { key: 'all', label: '全部任务', icon: 'grid-outline' },
    { key: 'cloud', label: '云端', icon: 'cloud-outline' },
    ...groups.map((group) => ({
      key: `project:${group.key}`,
      label: group.name,
      icon: 'laptop-outline' as const,
      disabled: group.sessions.length === 0,
    })),
  ], [groups])
  const selectedFilter = filterOptions.find((option) => option.key === selectedFilterKey) ?? filterOptions[0]!
  const selectedProject = selectedFilterKey.startsWith('project:')
    ? groups.find((group) => `project:${group.key}` === selectedFilterKey)
    : null
  const visibleSessions = selectedProject?.sessions ?? sessions

  const handleSessionPress = async (sessionId: string) => {
    try {
      await loadSession(sessionId)
      navigation.navigate('Chat')
    } catch {
      Alert.alert('Error', 'Failed to load session')
    }
  }

  const handleNewSession = async () => {
    try {
      const workDir = selectedProject?.path && selectedProject.path !== 'Unknown project'
        ? selectedProject.path
        : DEFAULT_WORK_DIR
      await createSession(workDir)
      navigation.navigate('Chat')
    } catch {
      Alert.alert('Error', 'Failed to create session')
    }
  }

  const handleDeleteSession = (sessionId: string) => {
    Alert.alert('Delete Session', 'Delete this remote session?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteSession(sessionId)
          } catch {
            Alert.alert('Error', 'Failed to delete session')
          }
        },
      },
    ])
  }

  const handleSelectFilter = (option: FilterOption) => {
    if (option.disabled) return
    setSelectedFilterKey(option.key)
    setMenuOpen(false)
  }

  const renderSession = ({ item }: { item: SessionListItem }) => (
    <TouchableOpacity
      onPress={() => handleSessionPress(item.id)}
      onLongPress={() => handleDeleteSession(item.id)}
      style={styles.sessionRow}
    >
      <View style={styles.sessionIconWrap}>
        <Ionicons name={iconForSession(item)} size={23} color="#222222" />
      </View>
      <View style={styles.sessionBody}>
        <View style={styles.sessionTitleRow}>
          <Text style={styles.sessionTitle} numberOfLines={1}>{item.title || '未命名任务'}</Text>
          <Text style={styles.sessionDate}>{formatTaskDate(item.modifiedAt)}</Text>
        </View>
        <View style={styles.sessionMetaRow}>
          <Ionicons name={item.workDirExists ? 'git-branch-outline' : 'warning-outline'} size={13} color="#8D8D8D" />
          <Text style={styles.sessionMeta} numberOfLines={1}>{formatTaskMeta(item)}</Text>
        </View>
      </View>
    </TouchableOpacity>
  )

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.titleButton} onPress={() => setMenuOpen((open) => !open)}>
          <Text style={styles.title}>{selectedFilter.label}</Text>
          <Ionicons name={menuOpen ? 'caret-up' : 'caret-down'} size={14} color="#111111" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.avatarButton} onPress={() => navigation.navigate('ServerConfig')}>
          <Ionicons name="person" size={22} color="#292033" />
        </TouchableOpacity>

        {menuOpen ? (
          <View style={styles.filterMenu}>
            {filterOptions.slice(0, 5).map((option) => {
              const selected = option.key === selectedFilter.key
              return (
                <Pressable
                  key={option.key}
                  onPress={() => handleSelectFilter(option)}
                  style={[styles.filterOption, option.disabled && styles.filterOptionDisabled]}
                >
                  <Ionicons name={option.icon} size={22} color={option.disabled ? '#A5A5A5' : '#222222'} />
                  <Text
                    style={[styles.filterLabel, option.disabled && styles.filterLabelDisabled]}
                    numberOfLines={1}
                  >
                    {option.label}
                  </Text>
                  {selected ? (
                    <Ionicons name="checkmark-circle-outline" size={22} color="#37308D" />
                  ) : null}
                </Pressable>
              )
            })}
          </View>
        ) : null}
      </View>

      {menuOpen ? (
        <Pressable style={styles.menuScrim} onPress={() => setMenuOpen(false)} />
      ) : null}

      <View style={styles.body}>
        {isLoading && sessions.length === 0 ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#6D4BD8" />
            <Text style={styles.loadingText}>正在加载任务...</Text>
          </View>
        ) : sessions.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Ionicons name="document-text-outline" size={56} color="#BBBBBB" />
            <Text style={styles.emptyText}>暂无任务</Text>
            <Text style={styles.emptySubtext}>连接桌面服务后，可以从手机创建或打开远程会话。</Text>
          </View>
        ) : (
          <FlatList
            data={visibleSessions}
            keyExtractor={(item) => item.id}
            renderItem={renderSession}
            contentContainerStyle={styles.sessionList}
            refreshControl={<RefreshControl refreshing={isLoading} onRefresh={() => fetchSessions()} tintColor="#6D4BD8" />}
            showsVerticalScrollIndicator={false}
          />
        )}

        <TouchableOpacity style={styles.floatingButton} onPress={handleNewSession}>
          <Ionicons name="add" size={24} color="#FFFFFF" />
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  )
}

function iconForSession(item: SessionListItem): IconName {
  const text = `${item.title} ${item.workDir || item.projectPath}`.toLowerCase()
  if (text.includes('game') || text.includes('smartpanel') || text.includes('kpi')) {
    return 'bar-chart-outline'
  }
  if (text.includes('scene') || text.includes('doc') || text.includes('readme')) {
    return 'book-outline'
  }
  if (text.includes('android') || text.includes('mobile')) {
    return 'phone-portrait-outline'
  }
  return 'document-text-outline'
}

function formatTaskMeta(item: SessionListItem) {
  const path = item.workDir || item.projectPath || ''
  const parts = path
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
  const projectParts = parts.slice(-2)
  const location = projectParts.length > 0 ? projectParts.join(' · ') : '云端'
  return `${item.messageCount} 条消息 · ${location}`
}

function formatTaskDate(dateString: string) {
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) return ''
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  const hours = `${date.getHours()}`.padStart(2, '0')
  const minutes = `${date.getMinutes()}`.padStart(2, '0')
  return `${month}月${day}日 ${hours}:${minutes}`
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    position: 'relative',
    zIndex: 20,
    minHeight: 92,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 28,
    paddingTop: 18,
    paddingBottom: 14,
    backgroundColor: '#FFFFFF',
  },
  titleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    maxWidth: '76%',
  },
  title: {
    fontSize: 30,
    lineHeight: 38,
    fontWeight: '900',
    color: '#111111',
  },
  avatarButton: {
    width: 45,
    height: 45,
    borderRadius: 23,
    backgroundColor: '#C979F1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterMenu: {
    position: 'absolute',
    top: 78,
    left: 28,
    right: 28,
    zIndex: 30,
    overflow: 'hidden',
    borderRadius: 18,
    backgroundColor: '#FFFFFF',
    shadowColor: '#000000',
    shadowOpacity: 0.16,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  filterOption: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ECECEC',
  },
  filterOptionDisabled: {
    opacity: 0.58,
  },
  filterLabel: {
    flex: 1,
    color: '#222222',
    fontSize: 17,
    fontWeight: '500',
  },
  filterLabelDisabled: {
    color: '#8F8F8F',
  },
  menuScrim: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
    backgroundColor: 'transparent',
  },
  body: {
    flex: 1,
    zIndex: 1,
  },
  sessionList: {
    paddingBottom: 92,
  },
  sessionRow: {
    minHeight: 91,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 31,
    paddingRight: 20,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#EAEAEA',
  },
  sessionIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    marginRight: 15,
    backgroundColor: '#F3F3F3',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sessionBody: {
    flex: 1,
    minWidth: 0,
  },
  sessionTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
  },
  sessionTitle: {
    flex: 1,
    color: '#151515',
    fontSize: 19,
    lineHeight: 25,
    fontWeight: '700',
  },
  sessionDate: {
    color: '#858585',
    fontSize: 14,
    lineHeight: 21,
  },
  sessionMetaRow: {
    marginTop: 3,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  sessionMeta: {
    flex: 1,
    color: '#898989',
    fontSize: 13,
    lineHeight: 18,
  },
  floatingButton: {
    position: 'absolute',
    right: 28,
    bottom: 27,
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: '#6539C9',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    marginTop: 12,
    color: '#777777',
  },
  emptyContainer: {
    flex: 1,
    paddingHorizontal: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    marginTop: 16,
    color: '#151515',
    fontSize: 20,
    fontWeight: '800',
  },
  emptySubtext: {
    marginTop: 8,
    color: '#777777',
    textAlign: 'center',
    lineHeight: 20,
  },
})
