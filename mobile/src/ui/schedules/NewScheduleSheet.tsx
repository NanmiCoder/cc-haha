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
      }).catch(e => { if (!controller.signal.aborted) setProjectsError(e instanceof Error ? e.message : 'Failed to read recent projects') })
    Promise.all([
      client.get<{ model: Model }>('/api/models/current', { signal: controller.signal }),
      client.get<{ provider: { id: string } | null; runtimeSource?: 'standalone' }>('/api/models', { signal: controller.signal }),
    ]).then(([current, catalog]) => {
      if (controller.signal.aborted) return
      if (!current.model?.id) throw new Error('The computer has no usable default model; choose a model in execution settings')
      setOptions(value => value.runtime ? value : {
        ...value,
        runtime: { providerId: runtimeProviderIdentity(catalog.provider?.id ?? null), modelId: current.model.id },
        followDefaultRuntime: catalog.runtimeSource === 'standalone',
      })
      setRuntimeError('')
    }).catch(e => { if (!controller.signal.aborted) setRuntimeError(e instanceof Error ? e.message : 'Failed to read the computer default model') })
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
      setError(runtimeError || 'Reading the computer default model; please try again shortly')
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
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Creation not confirmed; refresh to check')
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false) }
    }
  }
  const project = options.folderPath
    ? projects?.find(item => item.realPath === options.folderPath)?.projectName ?? projectLabel(options.folderPath)
    : 'Choose a project on the computer'
  return <PageSheet visible={visible} onClose={close} title="New scheduled task">
    <KeyboardViewport style={{ flex: 1 }}>
      <ScrollView key={visible ? 'open' : 'closed'} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16, gap: 16 }}>
        <Group>
          <View style={{ gap: 6, padding: 14 }}>
            <Text style={{ fontSize: 16, color: colors.ink }}>What to do</Text>
            <TextInput accessibilityLabel="What to do" value={options.prompt} onChangeText={prompt => edit({ prompt })} editable={!busy} multiline placeholder="e.g. check the project build and tell me why it failed" placeholderTextColor={colors.ink3} style={{ minHeight: 66, fontSize: 15, lineHeight: 22, color: colors.ink, padding: 0, textAlignVertical: 'top' }} />
          </View>
          <Separator />
          <FormRow label="Name"><TextInput accessibilityLabel="Name (optional)" value={options.name} onChangeText={name => edit({ name })} editable={!busy} placeholder="Optional; defaults to the task content" placeholderTextColor={colors.ink3} style={{ flex: 1, minWidth: 0, fontSize: 15, color: colors.ink, paddingVertical: 12 }} /></FormRow>
          {options.execution.kind === 'new-session' ? <><Separator /><Pressable accessibilityRole="button" accessibilityLabel={`Project, ${project}`} disabled={busy} onPress={() => { setPickerKey(value => value + 1); setPicking(true) }} style={({ pressed }) => ({ minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, backgroundColor: pressed ? colors.fill : undefined })}>
            <Text style={{ width: 64, fontSize: 16, color: colors.ink }}>Projects</Text><Text numberOfLines={1} style={{ flex: 1, fontSize: 16, color: colors.ink2 }}>{project}</Text><Chevron />
          </Pressable></> : null}
        </Group>
        <ScheduleFields value={schedule} disabled={busy} onChange={value => { setSchedule(value); setError('') }} />
        <TextButton title={advanced ? 'Collapse execution settings' : 'Execution settings · model, session, worktree, notifications'} disabled={busy} onPress={() => setAdvanced(!advanced)} />
        {advanced ? <ScheduleExecutionFields client={client} value={options} onChange={edit} disabled={busy} /> : null}
        {options.execution.kind === 'new-session' && !options.runtime ? <View><InlineError text={runtimeError} /><TextButton title="Reload default model" disabled={busy} onPress={() => setReload(value => value + 1)} /></View> : null}
        <Text style={{ fontSize: 13, lineHeight: 19, color: colors.ink3 }}>{options.execution.kind === 'session' ? 'When due, sends the content in the chosen session, reusing the session’s project, model and permissions.' : `When due, creates a new session, ${options.followDefaultRuntime ? 'using the computer default model' : `using ${options.runtime?.modelId ?? 'Computer default model'}`} Runs unattended and can modify files and run commands.`}</Text>
        <InlineError text={error} />
      </ScrollView>
      <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: Math.max(insets.bottom, 16) }}><Button title="Create scheduled task" size="lg" busy={busy} disabled={!client || !options.prompt.trim()} onPress={() => void create()} /></View>
    </KeyboardViewport>
    <ProjectPickerSheet key={pickerKey} visible={picking} value={options.folderPath || null} projects={projects ?? []} loading={projects === null && !projectsError} error={projectsError} onPick={path => { edit({ folderPath: path ?? '' }); setPicking(false) }} onClose={() => setPicking(false)} />
  </PageSheet>
}
