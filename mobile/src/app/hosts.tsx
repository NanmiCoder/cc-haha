import { useCallback, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  PanResponder,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from 'react-native'
import { Text } from '../ui/Text'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, useFocusEffect } from 'expo-router'
import { useApp, useConnection } from '../state/AppContext'
import { ApiError } from '../core/client'
import type { Host } from '../core/types'
import {
  CircleButton,
  Empty,
  Icon,
  Notice,
  PrimaryButton,
  Raised,
  errorText,
  mono,
  useTheme,
} from '../ui/theme'
import { Porthole } from '../ui/Porthole'

type HostStatus = {
  state: 'checking' | 'online' | 'offline' | 'unauthorized'
  message?: string
  expiresAt?: number
  running?: number
  checkedAt?: number
}
function HostCard({
  host,
  current,
  refresh,
  onSelect,
  onRemove,
}: {
  host: Host
  current: boolean
  refresh: number
  onSelect(): void
  onRemove(): void
}) {
  const { colors, styles } = useTheme()
  const { client, error } = useConnection(host.id)
  const [status, setStatus] = useState<HostStatus>({ state: 'checking' })
  const [offset] = useState(() => new Animated.Value(0))
  const [opened, setOpened] = useState(false)
  const swipe = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) =>
          Math.abs(gesture.dx) > 12 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
        onPanResponderMove: (_, gesture) =>
          offset.setValue(
            Math.min(0, Math.max(-84, gesture.dx + (opened ? -84 : 0)))
          ),
        onPanResponderRelease: (_, gesture) => {
          const next = gesture.dx < -30 || (opened && gesture.dx < 30)
          setOpened(next)
          Animated.spring(offset, {
            toValue: next ? -84 : 0,
            useNativeDriver: true,
          }).start()
        },
        onPanResponderTerminate: () =>
          Animated.spring(offset, {
            toValue: opened ? -84 : 0,
            useNativeDriver: true,
          }).start(),
      }),
    [offset, opened]
  )
  useFocusEffect(
    useCallback(() => {
      if (!client) return
      void refresh
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout>
      let checking = false
      async function check() {
        if (checking || controller.signal.aborted) return
        checking = true
        try {
          let expiresAt: number | undefined
          if (client!.host.auth === 'remote') {
            const result = await client!.get<{
              authenticated: boolean
              expiresAt?: number
            }>('/api/public-access/session', {
              signal: controller.signal,
              timeoutMs: 6000,
            })
            if (!result.authenticated)
              throw new ApiError('授权已失效，请重新配对', 401)
            expiresAt = result.expiresAt
          } else
            await client!.verify({ signal: controller.signal, timeoutMs: 6000 })
          if (controller.signal.aborted) return
          setStatus({ state: 'online', expiresAt, checkedAt: Date.now() })
          try {
            const live = await client!.get<{
              sessions: { activityState: string }[]
            }>('/api/sessions/live-status', {
              signal: controller.signal,
              timeoutMs: 6000,
            })
            if (!controller.signal.aborted)
              setStatus({
                state: 'online',
                expiresAt,
                running: live.sessions.length,
                checkedAt: Date.now(),
              })
          } catch {
            /* Older desktops can still be connected without live activity metadata. */
          }
        } catch (failure) {
          if (!controller.signal.aborted)
            setStatus({
              state:
                failure instanceof ApiError &&
                [401, 403].includes(failure.status)
                  ? 'unauthorized'
                  : 'offline',
              message: errorText(failure),
            })
        } finally {
          checking = false
          if (!controller.signal.aborted) timer = setTimeout(check, 20000)
        }
      }
      setStatus({ state: 'checking' })
      void check()
      const listener = AppState.addEventListener('change', (state) => {
        if (state === 'active') {
          clearTimeout(timer)
          void check()
        }
      })
      return () => {
        controller.abort()
        clearTimeout(timer)
        listener.remove()
      }
    }, [client, refresh])
  )
  const state = error ? 'unauthorized' : status.state
  const online = state === 'online'
  const days = status.expiresAt
    ? Math.max(
        0,
        Math.ceil(
          (status.expiresAt - (status.checkedAt ?? status.expiresAt)) / 86400000
        )
      )
    : undefined
  const detail =
    state === 'checking'
      ? '正在检查连接…'
      : state === 'unauthorized'
        ? '授权已失效 · 请重新连接'
        : state === 'offline'
          ? '离线 · 暂时无法连接'
          : status.running
            ? `${status.running} 个任务进行中`
            : host.auth === 'remote'
              ? days !== undefined
                ? `已授权 · ${days < 1 ? '不足 1 天' : `${days} 天`}后到期`
                : '已授权 · 在线'
              : '在线 · 可以开始任务'
  return (
    <View
      style={{
        borderRadius: 20,
        backgroundColor: colors.red,
        overflow: 'hidden',
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`移除 ${host.name}`}
        onPress={onRemove}
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          width: 80,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
        }}
      >
        <Icon name="trash-2" color="#fff" />
        <Text style={{ color: '#fff', fontSize: 12 }}>移除</Text>
      </Pressable>
      <Animated.View
        {...swipe.panHandlers}
        style={{ transform: [{ translateX: offset }] }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${host.name}，${detail}${current ? '，当前电脑' : ''}`}
          accessibilityActions={[{ name: 'delete', label: '移除连接' }]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === 'delete') onRemove()
          }}
          onLongPress={onRemove}
          onPress={() => {
            if (opened) {
              setOpened(false)
              Animated.spring(offset, {
                toValue: 0,
                useNativeDriver: true,
              }).start()
            } else onSelect()
          }}
        >
          <Raised
            style={{
              padding: 16,
              borderRadius: 20,
              backgroundColor:
                state === 'offline' ? colors.inset : colors.surface,
              borderWidth: current ? 1.5 : 0,
              borderColor: colors.accent,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 14,
              minHeight: 100,
            }}
          >
            <Porthole
              size={58}
              online={online}
              muted={state === 'offline' || state === 'unauthorized'}
            />
            <View style={{ flex: 1, gap: 5 }}>
              <View
                style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}
              >
                <Text
                  numberOfLines={1}
                  style={{
                    fontSize: 16,
                    fontWeight: '600',
                    color: colors.ink,
                    flexShrink: 1,
                  }}
                >
                  {host.name}
                </Text>
                {current && (
                  <Text
                    style={{
                      color: colors.accent,
                      borderColor: colors.accent,
                      borderWidth: 1,
                      borderRadius: 5,
                      paddingHorizontal: 4,
                      paddingVertical: 1,
                      fontSize: 10,
                    }}
                  >
                    当前
                  </Text>
                )}
              </View>
              <Text
                numberOfLines={1}
                style={{ color: colors.muted, fontFamily: mono, fontSize: 10 }}
              >
                {host.auth === 'lan' ? '局域网' : '公网'} ·{' '}
                {new URL(host.url).host}
              </Text>
              <Text
                style={[
                  styles.small,
                  {
                    fontSize: 11,
                    color: online
                      ? colors.green
                      : state === 'unauthorized'
                        ? colors.red
                        : colors.muted,
                  },
                ]}
              >
                {detail}
              </Text>
            </View>
            {state === 'checking' ? (
              <ActivityIndicator size="small" color={colors.muted} />
            ) : (
              !current && (
                <View
                  style={{
                    minHeight: 36,
                    paddingHorizontal: 12,
                    justifyContent: 'center',
                    borderRadius: 12,
                    backgroundColor: colors.surface,
                    boxShadow: `inset 0 1px 0 ${colors.highlight}, 0 1px 3px rgba(60,45,30,.16)`,
                  }}
                >
                  <Text style={{ fontSize: 12, color: colors.secondary }}>
                    切换
                  </Text>
                </View>
              )
            )}
          </Raised>
        </Pressable>
      </Animated.View>
    </View>
  )
}

export default function Hosts() {
  const { registry, select, remove, error: storageError } = useApp()
  const { colors, styles } = useTheme()
  const insets = useSafeAreaInsets()
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  function removeHost(host: Host) {
    Alert.alert(
      `移除「${host.name}」？`,
      '将注销这台电脑的手机通知并删除手机连接。电脑上的会话会保留。已登记推送时，需要连接电脑完成注销；失败可重试。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '移除连接',
          style: 'destructive',
          onPress: () => {
            void remove(host.id).catch((e) => setError(errorText(e)))
          },
        },
      ]
    )
  }
  async function selectHost(host: Host) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await select(host.id)
      router.replace('/')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <SafeAreaView style={styles.page} edges={['top', 'left', 'right']}>
      <View style={{ paddingHorizontal: 16, paddingTop: 7 }}>
        <CircleButton
          name="chevron-left"
          label="返回"
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace('/')
          }
        />
      </View>
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => setRefresh((value) => value + 1)}
            tintColor={colors.accent}
          />
        }
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 14,
          paddingBottom: 24,
          gap: 10,
          flexGrow: 1,
        }}
      >
        <Text style={[styles.title, { marginLeft: 4, marginBottom: 8 }]}>
          你的电脑
        </Text>
        <Notice text={error || storageError} error />
        {!registry.hosts.length && (
          <Empty
            title="先连接第一台电脑"
            detail="打开电脑上的 cc-haha，在「设置 → H5 访问」或「公网访问」中获取连接二维码。"
          />
        )}
        {registry.hosts.map((host) => (
          <HostCard
            key={host.id}
            host={host}
            current={registry.selectedId === host.id}
            refresh={refresh}
            onSelect={() => {
              void selectHost(host)
            }}
            onRemove={() => removeHost(host)}
          />
        ))}
        <Text
          style={[
            styles.small,
            { paddingHorizontal: 4, marginTop: 6, lineHeight: 19 },
          ]}
        >
          电脑休眠或没打开 cc-haha
          时连不上。左滑可移除，只会删掉手机上的连接，电脑上的会话还在。
        </Text>
      </ScrollView>
      <View
        style={{
          paddingHorizontal: 20,
          paddingTop: 12,
          paddingBottom: Math.max(insets.bottom, 18),
        }}
      >
        <PrimaryButton
          title="扫码添加电脑"
          icon="maximize"
          onPress={() => router.push('/connect')}
        />
      </View>
    </SafeAreaView>
  )
}
