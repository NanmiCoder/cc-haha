import { Fragment, useMemo, useState } from 'react'
import { Alert, Animated, PanResponder, Pressable, RefreshControl, ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import { Text } from '../ui/Text'
import { useApp } from '../state/AppContext'
import type { Host } from '../core/types'
import {
  EmptyState,
  Footnote,
  Group,
  Icon,
  InlineError,
  ListRow,
  Mono,
  NavBar,
  ScreenView,
  Separator,
  Spinner,
  useColors,
} from '../ui/kit'
import { errorText } from '../ui/theme'
import { hostCheckBadge, hostCheckLine } from '../ui/home/homeModel'
import { StatusDot, useNow, useToneColor } from '../ui/home/parts'
import { connectionAddress, removeConfirmText } from '../ui/computer/computerModel'
import { useHostCheck } from '../ui/home/useHostCheck'

const actionWidth = 84

function HostRow({
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
  const colors = useColors()
  const toneColor = useToneColor()
  const check = useHostCheck(host, refresh)
  const now = useNow(60000)
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
            Math.min(0, Math.max(-actionWidth, gesture.dx + (opened ? -actionWidth : 0)))
          ),
        onPanResponderRelease: (_, gesture) => {
          const next = gesture.dx < -30 || (opened && gesture.dx < 30)
          setOpened(next)
          Animated.spring(offset, {
            toValue: next ? -actionWidth : 0,
            useNativeDriver: true,
          }).start()
        },
        onPanResponderTerminate: () =>
          Animated.spring(offset, {
            toValue: opened ? -actionWidth : 0,
            useNativeDriver: true,
          }).start(),
      }),
    [offset, opened]
  )
  const detail = hostCheckLine(host, check, now)
  const badge = hostCheckBadge(check)
  const tone =
    check.state === 'online' ? 'ok' : check.state === 'unauthorized' ? 'err' : 'faint'
  const address = connectionAddress(host)
  return (
    <View style={{ backgroundColor: colors.err }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`移除 ${host.name}`}
        onPress={onRemove}
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          width: actionWidth,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
        }}
      >
        <Icon name="trash" size={20} color="#FFFFFF" />
        <Text style={{ color: colors.onErr, fontSize: 12, fontWeight: '600' }}>移除</Text>
      </Pressable>
      <Animated.View
        {...swipe.panHandlers}
        style={{ backgroundColor: colors.card, transform: [{ translateX: offset }] }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${host.name}，${detail}${badge ? `，${badge.text}` : ''}${current ? '，当前电脑' : ''}`}
          accessibilityActions={[{ name: 'delete', label: '移除连接' }]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === 'delete') onRemove()
          }}
          onLongPress={onRemove}
          onPress={() => {
            if (opened) {
              setOpened(false)
              Animated.spring(offset, { toValue: 0, useNativeDriver: true }).start()
            } else onSelect()
          }}
          style={({ pressed }) => ({
            minHeight: 72,
            paddingHorizontal: 14,
            paddingVertical: 12,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            backgroundColor: pressed ? colors.fill : colors.card,
          })}
        >
          <View style={{ marginHorizontal: 6 }}>
            <StatusDot tone={tone} size={8} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text
              numberOfLines={1}
              style={{
                fontSize: 16,
                lineHeight: 21,
                color: check.state === 'online' ? colors.ink : colors.ink2,
              }}
            >
              {host.name}
            </Text>
            <Text numberOfLines={1} style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>
              {detail}
            </Text>
            <Mono numberOfLines={1} style={{ fontSize: 12.5, lineHeight: 18, color: colors.ink3 }}>
              {address}
            </Mono>
          </View>
          {check.state === 'checking' ? (
            <Spinner color={colors.ink3} track={colors.fill} />
          ) : badge ? (
            <Text style={{ fontSize: 13, color: toneColor(badge.tone) }}>{badge.text}</Text>
          ) : null}
          {current ? (
            <Icon name="check" size={18} color={colors.ink} strokeWidth={2.2} />
          ) : null}
        </Pressable>
      </Animated.View>
    </View>
  )
}

export default function Hosts() {
  const { registry, select, remove, error: storageError } = useApp()
  const colors = useColors()
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  function removeHost(host: Host) {
    const text = removeConfirmText(host.name)
    Alert.alert(text.title, text.message, [
      { text: '取消', style: 'cancel' },
      {
        text: '移除连接',
        style: 'destructive',
        onPress: () => {
          void remove(host.id).catch((e) => setError(errorText(e)))
        },
      },
    ])
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
    <ScreenView>
      <NavBar floating title="你的电脑" />
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => setRefresh((value) => value + 1)}
            tintColor={colors.ink3}
          />
        }
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 }}
      >
        <InlineError text={error || storageError} style={{ marginBottom: 12 }} />
        {registry.hosts.length ? (
          <>
            <Group>
              {registry.hosts.map((host, index) => (
                <Fragment key={host.id}>
                  {index > 0 && <Separator inset={46} />}
                  <HostRow
                    host={host}
                    current={registry.selectedId === host.id}
                    refresh={refresh}
                    onSelect={() => {
                      void selectHost(host)
                    }}
                    onRemove={() => removeHost(host)}
                  />
                </Fragment>
              ))}
            </Group>
            <Footnote>
              电脑休眠或没打开 cc-haha 时连不上。左滑或长按可移除，只会删掉手机上的连接，电脑上的会话还在。
            </Footnote>
          </>
        ) : (
          <EmptyState
            icon="laptop"
            title="先连接第一台电脑"
            detail="打开电脑上的 cc-haha，在「设置 → 手机连接」中开启局域网，或选择 Cloudflare 快速连接 / 固定域名，再用手机扫码。"
          />
        )}
        <Group style={{ marginTop: 22 }}>
          <ListRow
            leading={<Icon name="plus" size={20} color={colors.ink} strokeWidth={2} />}
            title="添加电脑"
            minHeight={52}
            onPress={() => router.push('/connect')}
          />
        </Group>
      </ScrollView>
    </ScreenView>
  )
}
