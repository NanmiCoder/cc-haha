import { useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { ApiClient } from '../../core/client'
import type { RecentProject } from '../../core/newTask'
import { createScheduleInput, newScheduleDraft, type ScheduleCreateOptions } from '../../core/scheduleDraft'
import { projectLabel } from '../../core/schedulesView'
import { runtimeProviderIdentity, type Model } from '../../core/runtimeCatalog'
import { Button, Chevron, Group, InlineError, PageSheet, Separator, TextButton, useColors } from '../kit'
import { Text } from '../Text'
import { KeyboardViewport } from '../KeyboardViewport'
import { FormRow } from './parts'
import { ProjectPickerSheet } from './ProjectPickerSheet'
import { ScheduleFields } from './ScheduleFields'
import { ScheduleExecutionFields } from './ScheduleExecutionFields'

const emptyOptions = (): ScheduleCreateOptions => ({ name: '', prompt: '', execution: { kind: 'new-session' }, folderPath: '', useWorktree: false, notificationPolicy: 'none', channels: ['desktop'] })

/** One task, one schedule, and optional execution settings; presets need a single tap. */
export function NewScheduleSheet({ visible, client, onClose, onCreated }: {
  visible: boolean
  client: ApiClient | null
  onClose(): void
  onCreated(): void
}) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const [options, setOptions] = useState(emptyOptions)
  const [schedule, setSchedule] = useState(() => newScheduleDraft())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [picking, setPicking] = useState(false)
  const [pickerKey, setPickerKey] = useState(0)
  const [projects, setProjects] = useState<RecentProject[] | null>(null)
  const [projectsError, setProjectsError] = useState('')
  const [runtimeError, setRuntimeError] = useState('')
  const [reload, setReload] = useState(0)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    if (!visible || !client) return
    const controller = new AbortController()
    client.get<{ projects: RecentProject[] }>('/api/sessions/recent-projects?limit=10', { signal: controller.signal })
      .then(data => {
        if (controller.signal.aborted) return
        setProjects(data.projects ?? [])
        setProjectsError('')
        setOptions(current => current.folderPath ? current : { ...current, folderPath: data.projects?.[0]?.realPath ?? '' })
      }).catch(e => { if (!controller.signal.aborted) setProjectsError(e instanceof Error ? e.message : '读取最近项目失败') })
    Promise.all([
      client.get<{ model: Model }>('/api/models/current', { signal: controller.signal }),
      client.get<{ provider: { id: string } | null; runtimeSource?: 'standalone' }>('/api/models', { signal: controller.signal }),
    ]).then(([current, catalog]) => {
      if (controller.signal.aborted) return
      if (!current.model?.id) throw new Error('电脑没有可用的默认模型，请在执行设置中选择模型')
      setOptions(value => value.runtime ? value : {
        ...value,
        runtime: { providerId: runtimeProviderIdentity(catalog.provider?.id ?? null), modelId: current.model.id },
        followDefaultRuntime: catalog.runtimeSource === 'standalone',
      })
      setRuntimeError('')
    }).catch(e => { if (!controller.signal.aborted) setRuntimeError(e instanceof Error ? e.message : '读取电脑默认模型失败') })
    return () => controller.abort()
  }, [visible, client, reload])
  const edit = (patch: Partial<ScheduleCreateOptions>) => {
    setOptions(value => ({ ...value, ...patch, ...(patch.runtime ? { followDefaultRuntime: false } : {}) }))
    setError('')
  }
  const close = () => {
    if (busy) return
    setPicking(false)
    onClose()
  }
  const create = async () => {
    if (!client || busy) return
    if (options.execution.kind === 'new-session' && !options.runtime) {
      setError(runtimeError || '正在读取电脑默认模型，请稍后再试')
      return
    }
    let payload: ReturnType<typeof createScheduleInput>
    try { payload = createScheduleInput(options, schedule) }
    catch (e) { setError((e as Error).message); return }
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError('')
    try {
      await client.post('/api/scheduled-tasks', payload, { signal: controller.signal })
      if (controller.signal.aborted) return
      setOptions(emptyOptions())
      setSchedule(newScheduleDraft())
      setAdvanced(false)
      onCreated()
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '创建未确认，请刷新后检查')
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false) }
    }
  }
  const project = options.folderPath
    ? projects?.find(item => item.realPath === options.folderPath)?.projectName ?? projectLabel(options.folderPath)
    : '选择电脑上的项目'
  return <PageSheet visible={visible} onClose={close} title="新建定时任务">
    <KeyboardViewport style={{ flex: 1 }}>
      <ScrollView key={visible ? 'open' : 'closed'} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16, gap: 16 }}>
        <Group>
          <View style={{ gap: 6, padding: 14 }}>
            <Text style={{ fontSize: 16, color: colors.ink }}>要做什么</Text>
            <TextInput accessibilityLabel="要做什么" value={options.prompt} onChangeText={prompt => edit({ prompt })} editable={!busy} multiline placeholder="例如：检查项目构建，把失败原因告诉我" placeholderTextColor={colors.ink3} style={{ minHeight: 66, fontSize: 15, lineHeight: 22, color: colors.ink, padding: 0, textAlignVertical: 'top' }} />
          </View>
          <Separator />
          <FormRow label="名称"><TextInput accessibilityLabel="名称（可选）" value={options.name} onChangeText={name => edit({ name })} editable={!busy} placeholder="可选，默认使用执行内容" placeholderTextColor={colors.ink3} style={{ flex: 1, minWidth: 0, fontSize: 15, color: colors.ink, paddingVertical: 12 }} /></FormRow>
          {options.execution.kind === 'new-session' ? <><Separator /><Pressable accessibilityRole="button" accessibilityLabel={`项目，${project}`} disabled={busy} onPress={() => { setPickerKey(value => value + 1); setPicking(true) }} style={({ pressed }) => ({ minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, backgroundColor: pressed ? colors.fill : undefined })}>
            <Text style={{ width: 64, fontSize: 16, color: colors.ink }}>项目</Text><Text numberOfLines={1} style={{ flex: 1, fontSize: 16, color: colors.ink2 }}>{project}</Text><Chevron />
          </Pressable></> : null}
        </Group>
        <ScheduleFields value={schedule} disabled={busy} onChange={value => { setSchedule(value); setError('') }} />
        <TextButton title={advanced ? '收起执行设置' : '执行设置 · 模型、会话、工作树、通知'} disabled={busy} onPress={() => setAdvanced(!advanced)} />
        {advanced ? <ScheduleExecutionFields client={client} value={options} onChange={edit} disabled={busy} /> : null}
        {options.execution.kind === 'new-session' && !options.runtime ? <View><InlineError text={runtimeError} /><TextButton title="重新读取默认模型" disabled={busy} onPress={() => setReload(value => value + 1)} /></View> : null}
        <Text style={{ fontSize: 13, lineHeight: 19, color: colors.ink3 }}>{options.execution.kind === 'session' ? '到点后在所选会话中发送执行内容，沿用会话的项目、模型与权限。' : `到点后新建会话，${options.followDefaultRuntime ? '沿用电脑默认模型' : `使用 ${options.runtime?.modelId ?? '电脑默认模型'}`} 无人值守执行，可修改文件和执行命令。`}</Text>
        <InlineError text={error} />
      </ScrollView>
      <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: Math.max(insets.bottom, 16) }}><Button title="创建定时任务" size="lg" busy={busy} disabled={!client || !options.prompt.trim()} onPress={() => void create()} /></View>
    </KeyboardViewport>
    <ProjectPickerSheet key={pickerKey} visible={picking} value={options.folderPath || null} projects={projects ?? []} loading={projects === null && !projectsError} error={projectsError} onPick={path => { edit({ folderPath: path ?? '' }); setPicking(false) }} onClose={() => setPicking(false)} />
  </PageSheet>
}
