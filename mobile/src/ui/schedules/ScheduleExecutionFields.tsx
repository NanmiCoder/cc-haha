import { useEffect, useState } from 'react'
import { FlatList, View } from 'react-native'
import type { ApiClient } from '../../core/client'
import type { ScheduleCreateOptions } from '../../core/scheduleDraft'
import type { Session } from '../../core/types'
import { Group, InlineError, SearchField, Segmented, Sheet, Switch, TextButton, useColors } from '../kit'
import { Text } from '../Text'
import { RuntimeSheet } from '../RuntimePicker'
import { ChoiceRow } from '../newtask/ChoiceRow'
import { FormRow } from './parts'
import { ScheduleChoice } from './ScheduleFields'

type NotificationChannels = Record<ScheduleCreateOptions['channels'][number], boolean>

export function ScheduleExecutionFields({ client, value, onChange, disabled }: {
  client: ApiClient | null
  value: ScheduleCreateOptions
  onChange(patch: Partial<ScheduleCreateOptions>): void
  disabled: boolean
}) {
  const colors = useColors()
  const [modelOpen, setModelOpen] = useState(false)
  const [sessionOpen, setSessionOpen] = useState(false)
  const [sessions, setSessions] = useState<Session[]>([])
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [channelRevision, setChannelRevision] = useState(0)
  const [channelState, setChannelState] = useState<{
    client: ApiClient
    revision: number
    channels?: NotificationChannels
    error?: string
  } | null>(null)
  useEffect(() => {
    if (!client) return
    const controller = new AbortController()
    client.get<{ sessions: Session[] }>('/api/sessions?limit=100', { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) { setSessions(data.sessions ?? []); setError('') }
    }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '读取会话失败') })
    return () => controller.abort()
  }, [client])
  useEffect(() => {
    if (!client) return
    const controller = new AbortController()
    client.get<{ channels: NotificationChannels }>('/api/scheduled-tasks/notification-capabilities', { signal: controller.signal })
      .then(data => {
        if (!controller.signal.aborted) setChannelState({ client, revision: channelRevision, channels: data.channels })
      }).catch(e => {
        if (!controller.signal.aborted) setChannelState({ client, revision: channelRevision, error: e instanceof Error ? e.message : '读取通知渠道失败' })
      })
    return () => controller.abort()
  }, [client, channelRevision])
  const channelResult = channelState && channelState.client === client && channelState.revision === channelRevision ? channelState : null
  const channels = channelResult?.channels
  const channelsLoading = !!client && !channelResult
  const selectedSession = value.execution.kind === 'session' ? value.execution.targetSessionId : ''
  return <View style={{ gap: 12 }}>
    <Group style={{ padding: 14, gap: 12 }}>
      <Segmented label="执行位置" value={value.execution.kind} disabled={disabled} options={[{ value: 'new-session', label: '新建会话' }, { value: 'session', label: '已有会话' }]} onChange={kind => {
        if (kind !== value.execution.kind) onChange({ execution: kind === 'session' ? { kind, targetSessionId: '' } : { kind } })
      }} />
      {value.execution.kind === 'session' ? <>
        <TextButton title={sessions.find(session => session.id === selectedSession)?.title || '选择要执行的会话'} disabled={disabled} onPress={() => setSessionOpen(true)} />
        <Text style={{ fontSize: 13, lineHeight: 19, color: colors.ink3 }}>沿用该会话的项目、模型与权限。</Text>
        <InlineError text={error} />
      </> : <>
        <TextButton title={`模型 · ${value.runtime?.modelId ?? '选择模型'}`} disabled={disabled} onPress={() => setModelOpen(true)} />
        <FormRow label="在新工作树中运行" labelFlex><Switch label="在新工作树中运行" value={value.useWorktree} disabled={disabled} onValueChange={useWorktree => onChange({ useWorktree })} /></FormRow>
        <Text style={{ fontSize: 13, lineHeight: 19, color: colors.ink3 }}>工作树需要 Git 项目，基于默认分支创建独立目录。</Text>
      </>}
    </Group>
    <Group style={{ padding: 14, gap: 10 }}>
      <Text style={{ color: colors.ink, fontSize: 15 }}>运行通知</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{([{ value: 'none', label: '不通知' }, { value: 'important', label: '重要结果' }, { value: 'all', label: '每次结果' }, { value: 'failed', label: '仅失败' }] as const).map(policy => <ScheduleChoice key={policy.value} label={policy.label} selected={value.notificationPolicy === policy.value} disabled={disabled} onPress={() => onChange({ notificationPolicy: policy.value })} />)}</View>
      {value.notificationPolicy !== 'none' ? <>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{([{ value: 'desktop', label: '桌面通知' }, { value: 'feishu', label: '飞书' }, { value: 'telegram', label: 'Telegram' }] as const).map(channel => <ScheduleChoice key={channel.value} label={channel.label} selected={value.channels.includes(channel.value)} disabled={disabled || (channel.value !== 'desktop' && !channels?.[channel.value])} onPress={() => onChange({ channels: value.channels.includes(channel.value) ? value.channels.filter(item => item !== channel.value) : [...value.channels, channel.value] })} />)}</View>
        {channelsLoading ? <Text style={{ fontSize: 13, color: colors.ink3 }}>正在读取通知渠道…</Text> : null}
        <InlineError text={channelResult?.error ?? ''} />
        {channelResult?.error ? <TextButton title="重新读取通知渠道" disabled={disabled} onPress={() => setChannelRevision(revision => revision + 1)} /> : null}
        <Text style={{ fontSize: 13, color: colors.ink3 }}>飞书和 Telegram 需先在电脑上完成配置。</Text>
      </> : null}
    </Group>
    <RuntimeSheet visible={modelOpen} onClose={() => setModelOpen(false)} client={client} initial={value.runtime} busy={disabled} onApply={runtime => { onChange({ runtime }); setModelOpen(false) }} />
    <Sheet visible={sessionOpen} onClose={() => setSessionOpen(false)} title="选择会话" scroll={false}>
      <SearchField value={query} onChangeText={setQuery} placeholder="搜索最近 100 个会话" />
      <FlatList style={{ maxHeight: 420 }} data={sessions.filter(session => session.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))} keyExtractor={session => session.id} renderItem={({ item }) => <ChoiceRow title={item.title || '未命名会话'} detail={item.workDir ?? undefined} selected={selectedSession === item.id} disabled={disabled} onPress={() => { onChange({ execution: { kind: 'session', targetSessionId: item.id } }); setSessionOpen(false) }} />} ListEmptyComponent={<Text style={{ padding: 16, color: colors.ink3 }}>没有匹配的会话</Text>} />
    </Sheet>
  </View>
}
