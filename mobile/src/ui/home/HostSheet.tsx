import { Fragment, useEffect, useState } from 'react'
import { Platform, Pressable, View } from 'react-native'
import { router } from 'expo-router'
import { Text } from '../Text'
import {
  Group,
  Icon,
  InlineError,
  type IconName,
  ListRow,
  Mono,
  SectionHeader,
  Separator,
  Sheet,
  useColors,
} from '../kit'
import { effortName } from '../modes'
import { errorText } from '../theme'
import { useApp, useConnection } from '../../state/AppContext'
import { loadHostBackgroundTasks, runningTaskCount } from '../../core/hostActivity'
import type { ScheduledTask } from '../../core/operations'
import type { Host } from '../../core/types'
import {
  hostAddress,
  hostCheckBadge,
  hostCheckLine,
  hostStateName,
  scheduleSummary,
  type HostLink,
} from './homeModel'
import { StatusDot, useNow, useToneColor } from './parts'
import { useHostCheck } from './useHostCheck'

/** 点大标题弹出：这台电脑的概况 + 切换电脑。 */
export function HostSheet({
  visible,
  onClose,
  host,
  link,
  activeSessionIds,
}: {
  visible: boolean
  onClose(): void
  host: Host
  link: HostLink
  /** 首页快照里正在跑和等你的会话，用来汇总后台任务。 */
  activeSessionIds: string[]
}) {
  return (
    <Sheet visible={visible} onClose={onClose}>
      {visible ? (
        <HostSheetBody
          host={host}
          link={link}
          activeSessionIds={activeSessionIds}
          onClose={onClose}
        />
      ) : null}
    </Sheet>
  )
}

type Values = { schedules?: string; activity?: string; model?: string }

function HostSheetBody({
  host,
  link,
  activeSessionIds,
  onClose,
}: {
  host: Host
  link: HostLink
  activeSessionIds: string[]
  onClose(): void
}) {
  const colors = useColors()
  const toneColor = useToneColor()
  const { registry, select } = useApp()
  const { client } = useConnection(host.id)
  const [values, setValues] = useState<{ hostId: string; values: Values } | null>(null)
  const [error, setError] = useState('')
  const [switching, setSwitching] = useState<string | null>(null)
  const sessionKey = activeSessionIds.join('\n')
  useEffect(() => {
    if (!client) return
    const controller = new AbortController()
    const signal = controller.signal
    const hostId = client.host.id
    const put = (patch: Values) => {
      if (!signal.aborted)
        setValues((current) => ({
          hostId,
          values: { ...(current?.hostId === hostId ? current.values : {}), ...patch },
        }))
    }
    client
      .get<{ tasks: ScheduledTask[] }>('/api/scheduled-tasks', { signal })
      .then((result) => put({ schedules: scheduleSummary(result.tasks ?? [], new Date()) }))
      .catch(() => {})
    const ids = sessionKey ? sessionKey.split('\n') : []
    loadHostBackgroundTasks(client, ids, signal)
      .then((groups) => {
        const count = runningTaskCount(groups)
        // 有会话没读到时不能断言“空闲”，只报读到的部分；一个都没读到就留空。
        if (count) put({ activity: `${count} 项在跑` })
        else if (groups.length === ids.length) put({ activity: '空闲' })
      })
      .catch(() => {})
    Promise.all([
      client.get<{ model: { id: string; name?: string } }>('/api/models/current', { signal }),
      client.get<{ level: string }>('/api/effort', { signal }),
    ])
      .then(([model, effort]) =>
        put({ model: `${model.model.name || model.model.id} · ${effortName(effort.level)}` })
      )
      .catch(() => {})
    return () => controller.abort()
  }, [client, sessionKey])
  const shown = values?.hostId === host.id ? values.values : {}
  const state = hostStateName(link)
  const others = registry.hosts.filter((item) => item.id !== host.id)
  const go = (pathname: '/schedules' | '/activity' | '/models') => {
    onClose()
    router.push({ pathname, params: { host: host.id } })
  }
  async function switchTo(next: Host) {
    if (switching) return
    setSwitching(next.id)
    setError('')
    try {
      await select(next.id)
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSwitching(null)
    }
  }
  return (
    <View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingTop: 4,
          paddingHorizontal: 4,
          paddingBottom: 16,
        }}
      >
        <View
          style={{
            width: 48,
            height: 48,
            borderRadius: 14,
            backgroundColor: colors.card,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="laptop" size={26} color={colors.ink} strokeWidth={1.6} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={{ fontSize: 20, lineHeight: 26, fontWeight: '600', color: colors.ink }}
          >
            {host.name}
          </Text>
          <Mono numberOfLines={1} style={{ fontSize: 12.5, lineHeight: 18, color: colors.ink3 }}>
            {hostAddress(host)}
          </Mono>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <StatusDot tone={state.tone} />
          <Text style={{ fontSize: 13, color: toneColor(state.tone === 'faint' ? 'ink3' : state.tone) }}>
            {state.text}
          </Text>
        </View>
      </View>

      <Group>
        <OverviewRow
          icon="clock"
          title="定时任务"
          value={shown.schedules}
          onPress={() => go('/schedules')}
        />
        <Separator inset={46} />
        <OverviewRow
          icon="activity"
          title="后台活动"
          value={shown.activity}
          onPress={() => go('/activity')}
        />
        <Separator inset={46} />
        <OverviewRow
          icon="cpu"
          title="新任务默认模型"
          value={shown.model}
          onPress={() => go('/models')}
        />
      </Group>

      <SectionHeader
        title="切换电脑"
        action={{
          label: '编辑',
          onPress: () => {
            onClose()
            router.push('/hosts')
          },
        }}
      />
      <InlineError text={error} style={{ marginBottom: 8 }} />
      <Group>
        {others.map((item) => (
          <Fragment key={item.id}>
            <SwitchRow
              host={item}
              busy={switching === item.id}
              onPress={() => {
                void switchTo(item)
              }}
            />
            <Separator inset={34} />
          </Fragment>
        ))}
        <ListRow
          leading={<Icon name="plus" size={20} color={colors.ink} strokeWidth={2} />}
          title="添加电脑"
          minHeight={52}
          onPress={() => {
            onClose()
            // iOS 上一个弹层还在收起时 present 全屏页会失败，等它收起再打开扫码页。
            setTimeout(() => router.push('/connect'), Platform.OS === 'ios' ? 350 : 0)
          }}
        />
      </Group>
    </View>
  )
}

/** 另一台电脑：状态点 · 名字 · 连通检查结果 · 等你的数量。 */
function SwitchRow({ host, busy, onPress }: { host: Host; busy: boolean; onPress(): void }) {
  const colors = useColors()
  const toneColor = useToneColor()
  const check = useHostCheck(host)
  const now = useNow(60000)
  const detail = hostCheckLine(host, check, now)
  const badge = hostCheckBadge(check)
  const tone =
    check.state === 'online' ? 'ok' : check.state === 'unauthorized' ? 'err' : 'faint'
  return (
    <ListRow
      leading={
        <View style={{ marginHorizontal: 6 }}>
          <StatusDot tone={tone} size={8} />
        </View>
      }
      title={host.name}
      titleColor={check.state === 'online' ? colors.ink : colors.ink2}
      subtitle={detail}
      value={
        badge ? (
          <Text style={{ fontSize: 13, color: toneColor(badge.tone) }}>{badge.text}</Text>
        ) : undefined
      }
      minHeight={60}
      disabled={busy}
      accessibilityLabel={`切换到 ${host.name}，${detail}${badge ? `，${badge.text}` : ''}`}
      onPress={onPress}
    />
  )
}

/** 概况行：标题完整显示，值在剩余宽度里截断（kit ListRow 的值会挤掉长标题）。 */
function OverviewRow({
  icon,
  title,
  value,
  onPress,
}: {
  icon: IconName
  title: string
  value?: string
  onPress(): void
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={value ? `${title}，${value}` : title}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 52,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 14,
        backgroundColor: pressed ? colors.fill : 'transparent',
      })}
    >
      <Icon name={icon} size={20} color={colors.ink2} />
      <Text style={{ fontSize: 16, color: colors.ink }}>{title}</Text>
      <Text
        numberOfLines={1}
        style={{ flex: 1, minWidth: 0, textAlign: 'right', fontSize: 14, color: colors.ink3 }}
      >
        {value ?? ''}
      </Text>
      <Icon name="chevron-right" size={16} color={colors.chevron} strokeWidth={2} />
    </Pressable>
  )
}
