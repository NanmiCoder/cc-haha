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
    }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Failed to read sessions') })
    return () => controller.abort()
  }, [client])
  useEffect(() => {
    if (!client) return
    const controller = new AbortController()
    client.get<{ channels: NotificationChannels }>('/api/scheduled-tasks/notification-capabilities', { signal: controller.signal })
      .then(data => {
        if (!controller.signal.aborted) setChannelState({ client, revision: channelRevision, channels: data.channels })
      }).catch(e => {
        if (!controller.signal.aborted) setChannelState({ client, revision: channelRevision, error: e instanceof Error ? e.message : 'Failed to read notification channels' })
      })
    return () => controller.abort()
  }, [client, channelRevision])
  const channelResult = channelState && channelState.client === client && channelState.revision === channelRevision ? channelState : null
  const channels = channelResult?.channels
  const channelsLoading = !!client && !channelResult
  const selectedSession = value.execution.kind === 'session' ? value.execution.targetSessionId : ''
  return <View style={{ gap: 12 }}>
    <Group style={{ padding: 14, gap: 12 }}>
      <Segmented label="Where to run" value={value.execution.kind} disabled={disabled} options={[{ value: 'new-session', label: 'New session' }, { value: 'session', label: 'Existing session' }]} onChange={kind => {
        if (kind !== value.execution.kind) onChange({ execution: kind === 'session' ? { kind, targetSessionId: '' } : { kind } })
      }} />
      {value.execution.kind === 'session' ? <>
        <TextButton title={sessions.find(session => session.id === selectedSession)?.title || 'Choose the session to run in'} disabled={disabled} onPress={() => setSessionOpen(true)} />
        <Text style={{ fontSize: 13, lineHeight: 19, color: colors.ink3 }}>Reuse the session’s project, model and permissions.</Text>
        <InlineError text={error} />
      </> : <>
        <TextButton title={`Model · ${value.runtime?.modelId ?? 'Choose model'}`} disabled={disabled} onPress={() => setModelOpen(true)} />
        <FormRow label="Run in a new worktree" labelFlex><Switch label="Run in a new worktree" value={value.useWorktree} disabled={disabled} onValueChange={useWorktree => onChange({ useWorktree })} /></FormRow>
        <Text style={{ fontSize: 13, lineHeight: 19, color: colors.ink3 }}>Worktrees require a Git project; creates a separate directory from the default branch.</Text>
      </>}
    </Group>
    <Group style={{ padding: 14, gap: 10 }}>
      <Text style={{ color: colors.ink, fontSize: 15 }}>Run notifications</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{([{ value: 'none', label: 'Don’t notify' }, { value: 'important', label: 'Important results' }, { value: 'all', label: 'Every result' }, { value: 'failed', label: 'Failures only' }] as const).map(policy => <ScheduleChoice key={policy.value} label={policy.label} selected={value.notificationPolicy === policy.value} disabled={disabled} onPress={() => onChange({ notificationPolicy: policy.value })} />)}</View>
      {value.notificationPolicy !== 'none' ? <>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{([{ value: 'desktop', label: 'Desktop notification' }, { value: 'feishu', label: 'Feishu' }, { value: 'telegram', label: 'Telegram' }] as const).map(channel => <ScheduleChoice key={channel.value} label={channel.label} selected={value.channels.includes(channel.value)} disabled={disabled || (channel.value !== 'desktop' && !channels?.[channel.value])} onPress={() => onChange({ channels: value.channels.includes(channel.value) ? value.channels.filter(item => item !== channel.value) : [...value.channels, channel.value] })} />)}</View>
        {channelsLoading ? <Text style={{ fontSize: 13, color: colors.ink3 }}>Reading notification channels…</Text> : null}
        <InlineError text={channelResult?.error ?? ''} />
        {channelResult?.error ? <TextButton title="Reload notification channels" disabled={disabled} onPress={() => setChannelRevision(revision => revision + 1)} /> : null}
        <Text style={{ fontSize: 13, color: colors.ink3 }}>Feishu and Telegram must be configured on the computer first.</Text>
      </> : null}
    </Group>
    <RuntimeSheet visible={modelOpen} onClose={() => setModelOpen(false)} client={client} initial={value.runtime} busy={disabled} onApply={runtime => { onChange({ runtime }); setModelOpen(false) }} />
    <Sheet visible={sessionOpen} onClose={() => setSessionOpen(false)} title="Choose session" scroll={false}>
      <SearchField value={query} onChangeText={setQuery} placeholder="Search the latest 100 sessions" />
      <FlatList style={{ maxHeight: 420 }} data={sessions.filter(session => session.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))} keyExtractor={session => session.id} renderItem={({ item }) => <ChoiceRow title={item.title || 'Untitled session'} detail={item.workDir ?? undefined} selected={selectedSession === item.id} disabled={disabled} onPress={() => { onChange({ execution: { kind: 'session', targetSessionId: item.id } }); setSessionOpen(false) }} />} ListEmptyComponent={<Text style={{ padding: 16, color: colors.ink3 }}>No matching sessions</Text>} />
    </Sheet>
  </View>
}
