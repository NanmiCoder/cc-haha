import { KeyboardViewport } from '../KeyboardViewport'
import { useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { ApiClient } from '../../core/client'
import type { RecentProject } from '../../core/newTask'
import { dailyCron } from '../../core/operations'
import { projectLabel } from '../../core/schedulesView'
import {
  Button,
  Callout,
  Checkbox,
  Chevron,
  Group,
  InlineError,
  PageSheet,
  Segmented,
  Separator,
  useColors,
} from '../kit'
import { Text } from '../Text'
import { FormRow, TimeField } from './parts'
import { ProjectPickerSheet } from './ProjectPickerSheet'

type Frequency = 'daily' | 'weekdays'

/** 新建定时任务（ScheduleNew 稿）：取消 · 新建定时任务；必须勾选确认才能创建。 */
export function NewScheduleSheet({
  visible,
  client,
  onClose,
  onCreated,
}: {
  visible: boolean
  client: ApiClient | null
  onClose(): void
  onCreated(): void
}) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [folder, setFolder] = useState<string | null>(null)
  const [frequency, setFrequency] = useState<Frequency>('daily')
  const [time, setTime] = useState('09:00')
  const [accepted, setAccepted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [picking, setPicking] = useState(false)
  // 每次打开换一个 key：手动路径输入框从当前选择重新开始，关闭时保留动画。
  const [pickerKey, setPickerKey] = useState(0)
  // null = 还没读到；之后每次打开在后台刷新，列表先用上一次的。
  const [projects, setProjects] = useState<RecentProject[] | null>(null)
  const [projectsError, setProjectsError] = useState('')
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    if (!visible || !client) return
    const controller = new AbortController()
    client
      .get<{ projects: RecentProject[] }>('/api/sessions/recent-projects?limit=10', {
        signal: controller.signal,
      })
      .then((data) => {
        if (controller.signal.aborted) return
        setProjects(data.projects ?? [])
        setProjectsError('')
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setProjectsError(e instanceof Error ? e.message : '读取最近项目失败')
      })
    return () => controller.abort()
  }, [visible, client])
  // 用户一改输入，上一次的校验错误就不再成立。
  const edit =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setter(value)
      setError('')
    }
  const close = () => {
    if (busy) return
    setPicking(false)
    onClose()
  }
  const create = async () => {
    if (!client || busy) return
    let cron: string
    try {
      cron = dailyCron(time, frequency === 'weekdays')
    } catch (e) {
      setError((e as Error).message)
      return
    }
    if (!name.trim() || !prompt.trim()) {
      setError('请填写任务名称和执行内容')
      return
    }
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError('')
    try {
      await client.post(
        '/api/scheduled-tasks',
        {
          name: name.trim(),
          prompt: prompt.trim(),
          cron,
          enabled: true,
          recurring: true,
          permanent: true,
          ...(folder?.trim() ? { folderPath: folder.trim() } : {}),
        },
        { signal: controller.signal }
      )
      if (controller.signal.aborted) return
      setName('')
      setPrompt('')
      setFolder(null)
      setFrequency('daily')
      setTime('09:00')
      setAccepted(false)
      onCreated()
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : '创建未确认，请刷新后检查')
    } finally {
      if (request.current === controller) {
        request.current = null
        setBusy(false)
      }
    }
  }
  const project = folder
    ? (projects?.find((item) => item.realPath === folder)?.projectName ?? projectLabel(folder))
    : '电脑默认目录'
  return (
    <PageSheet visible={visible} onClose={close} title="新建定时任务">
      <KeyboardViewport style={{ flex: 1 }}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16 }}
        >
          <Group>
            <FormRow label="名称">
              <TextInput
                accessibilityLabel="名称"
                value={name}
                onChangeText={edit(setName)}
                editable={!busy}
                placeholder="给它起个名字"
                placeholderTextColor={colors.ink3}
                returnKeyType="next"
                style={{ flex: 1, minWidth: 0, fontSize: 16, color: colors.ink, paddingVertical: 12 }}
              />
            </FormRow>
            <Separator />
            <View style={{ gap: 6, paddingVertical: 12, paddingHorizontal: 14 }}>
              <Text style={{ fontSize: 16, color: colors.ink }}>要做什么</Text>
              <TextInput
                accessibilityLabel="要做什么"
                value={prompt}
                onChangeText={edit(setPrompt)}
                editable={!busy}
                multiline
                placeholder="到点后让它在电脑上做的事"
                placeholderTextColor={colors.ink3}
                style={{
                  minHeight: 66,
                  fontSize: 15,
                  lineHeight: 22,
                  color: colors.ink2,
                  padding: 0,
                  textAlignVertical: 'top',
                }}
              />
            </View>
            <Separator />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`项目，${project}`}
              disabled={busy}
              onPress={() => {
                setPickerKey((value) => value + 1)
                setPicking(true)
              }}
              style={({ pressed }) => ({
                height: 50,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingHorizontal: 14,
                backgroundColor: pressed ? colors.fill : undefined,
              })}
            >
              <Text style={{ width: 64, fontSize: 16, color: colors.ink }}>项目</Text>
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 16, color: colors.ink2 }}>
                {project}
              </Text>
              <Chevron />
            </Pressable>
          </Group>
          <Group style={{ marginTop: 16 }}>
            <FormRow label="重复" labelFlex minHeight={52}>
              <Segmented<Frequency>
                label="重复"
                value={frequency}
                onChange={setFrequency}
                disabled={busy}
                height={34}
                style={{ width: 150, borderRadius: 9 }}
                options={[
                  { label: '每天', value: 'daily' },
                  { label: '工作日', value: 'weekdays' },
                ]}
              />
            </FormRow>
            <Separator />
            <FormRow label="电脑本地时间" labelFlex minHeight={52}>
              <TimeField value={time} onChangeText={edit(setTime)} editable={!busy} />
            </FormRow>
          </Group>
          <Callout tone="attention" style={{ marginTop: 16 }}>
            用电脑当前的模型无人值守地跑：会改文件、执行命令，不会逐项问你。
          </Callout>
          <View style={{ marginTop: 8, paddingHorizontal: 4 }}>
            <Checkbox
              checked={accepted}
              onChange={setAccepted}
              disabled={busy}
              accessibilityLabel="我确认过要做的事和项目目录"
            >
              <Text style={{ fontSize: 15, lineHeight: 21, color: colors.ink }}>
                我确认过要做的事和项目目录
              </Text>
            </Checkbox>
          </View>
          <InlineError text={error} style={{ marginTop: 8 }} />
        </ScrollView>
        <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: Math.max(insets.bottom, 16) }}>
          <Button
            title="创建"
            size="lg"
            busy={busy}
            disabled={!accepted || !client}
            onPress={() => void create()}
          />
        </View>
      </KeyboardViewport>
      <ProjectPickerSheet
        key={pickerKey}
        visible={picking}
        value={folder}
        projects={projects ?? []}
        loading={projects === null && !projectsError}
        error={projectsError}
        onPick={(path) => {
          setFolder(path)
          setPicking(false)
        }}
        onClose={() => setPicking(false)}
      />
    </PageSheet>
  )
}
