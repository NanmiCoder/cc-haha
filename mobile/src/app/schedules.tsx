import { useCallback, useState } from 'react'
import { Modal, Pressable, ScrollView, View } from 'react-native'
import { Text } from '../ui/Text'
import { router, useLocalSearchParams } from 'expo-router'
import { useApp, useConnection } from '../state/AppContext'
import {
  dailyCron,
  latestRuns,
  scheduleLabel,
  type ScheduledTask,
  type TaskRun,
} from '../core/operations'
import { useFocusedResource } from '../core/useFocusedResource'
import {
  Button,
  CircleButton,
  Divider,
  Empty,
  Field,
  Icon,
  Inset,
  Loading,
  Notice,
  PrimaryButton,
  Raised,
  Screen,
  Segment,
  Toggle,
  mono,
  useTheme,
} from '../ui/theme'

export default function Schedules() {
  const { host } = useLocalSearchParams<{ host: string }>()
  const { registry } = useApp()
  const hostId = host ?? registry.selectedId ?? ''
  return <SchedulesPage key={hostId} hostId={hostId} />
}
function SchedulesPage({ hostId }: { hostId: string }) {
  const { host, client, error: connectionError } = useConnection(hostId)
  const { colors, styles } = useTheme()
  const resource = useFocusedResource(
    useCallback(
      async (signal: AbortSignal) => {
        if (!client) throw new Error('正在连接电脑')
        const [tasks, runs] = await Promise.all([
          client.get<{ tasks: ScheduledTask[] }>('/api/scheduled-tasks', {
            signal,
          }),
          client.get<{ runs: TaskRun[] }>(
            '/api/scheduled-tasks/runs?limit=100&summaryOnly=true',
            { signal }
          ),
        ])
        return { tasks: tasks.tasks, runs: runs.runs }
      },
      [client]
    ),
    5000
  )
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [folder, setFolder] = useState('')
  const [time, setTime] = useState('09:00')
  const [frequency, setFrequency] = useState<'daily' | 'weekdays'>('daily')
  const [accepted, setAccepted] = useState(false)
  const [confirm, setConfirm] = useState<{
    task: ScheduledTask
    action: 'run' | 'delete'
  } | null>(null)
  const [detail, setDetail] = useState<TaskRun | null>(null)
  const runs = latestRuns(resource.value?.runs ?? [])
  const openResult = (run: TaskRun) => {
    if (run.sessionId) {
      router.push({
        pathname: '/chat/[id]',
        params: { id: run.sessionId, host: hostId },
      })
      return
    }
    if (client)
      void resource.run(
        (signal) =>
          client.get<{ run: TaskRun }>(
            `/api/scheduled-tasks/runs/${encodeURIComponent(run.id)}`,
            { signal }
          ),
        (result) => setDetail(result.run)
      )
  }
  const create = () => {
    if (!client) return
    let cron: string
    try {
      cron = dailyCron(time, frequency === 'weekdays')
    } catch (e) {
      resource.setError((e as Error).message)
      return
    }
    if (!name.trim() || !prompt.trim()) {
      resource.setError('请填写任务名称和执行内容')
      return
    }
    void resource.run(
      (signal) =>
        client.post(
          '/api/scheduled-tasks',
          {
            name: name.trim(),
            prompt: prompt.trim(),
            cron,
            enabled: true,
            recurring: true,
            permanent: true,
            ...(folder.trim() ? { folderPath: folder.trim() } : {}),
          },
          { signal }
        ),
      () => {
        setCreating(false)
        setName('')
        setPrompt('')
        setFolder('')
        setAccepted(false)
      }
    )
  }
  const confirmAction = () => {
    if (!client || !confirm) return
    const { task, action } = confirm
    void resource.run(
      (signal) =>
        client.request(
          `/api/scheduled-tasks/${encodeURIComponent(task.id)}${action === 'run' ? '/run' : ''}`,
          {
            method: action === 'run' ? 'POST' : 'DELETE',
            ...(action === 'run' ? { body: {} } : {}),
            signal,
          }
        ),
      () => setConfirm(null)
    )
  }
  return (
    <Screen
      right={
        <CircleButton
          name="plus"
          label="新建定时任务"
          onPress={() => {
            resource.setError('')
            setCreating(true)
          }}
        />
      }
    >
      <View style={{ marginHorizontal: 4, gap: 6, marginTop: -2 }}>
        <Text style={styles.title}>定时任务</Text>
        <Text style={styles.small}>只在电脑开机、cc-haha 运行时执行</Text>
      </View>
      <Notice text={connectionError || resource.error} error />
      {resource.loading ? (
        <Loading />
      ) : (
        <View style={{ gap: 10 }}>
          {resource.value?.tasks.length ? (
            resource.value.tasks.map((task) => {
              const run = runs.get(task.id)
              const enabled = task.enabled !== false
              const Container = enabled ? Raised : Inset
              return (
                <Container
                  key={task.id}
                  style={{
                    borderRadius: 18,
                    paddingTop: 14,
                    paddingBottom: 12,
                    paddingHorizontal: 16,
                  }}
                >
                  <View style={[styles.between, { alignItems: 'flex-start' }]}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`管理 ${task.name ?? '定时任务'}`}
                      onPress={() => setConfirm({ task, action: 'delete' })}
                      style={{ flex: 1, gap: 4 }}
                    >
                      <Text
                        style={{
                          color: enabled ? colors.ink : colors.muted,
                          fontWeight: '600',
                          fontSize: 15,
                        }}
                      >
                        {task.name || '未命名任务'}
                      </Text>
                      <Text style={styles.small} numberOfLines={1}>
                        {task.folderPath
                          ?.split(/[\\/]/)
                          .filter(Boolean)
                          .pop() ??
                          host?.name ??
                          '当前电脑'}
                      </Text>
                    </Pressable>
                    <Toggle
                      label={`${task.name ?? '任务'}开关`}
                      value={enabled}
                      disabled={resource.busy || !client}
                      onChange={(value) => {
                        if (client)
                          void resource.run((signal) =>
                            client.request(
                              `/api/scheduled-tasks/${encodeURIComponent(task.id)}`,
                              {
                                method: 'PUT',
                                body: { enabled: value },
                                signal,
                              }
                            )
                          )
                      }}
                    />
                  </View>
                  <View style={[styles.between, { marginTop: 10 }]}>
                    <Text
                      style={{
                        fontSize: 12,
                        fontFamily: mono,
                        color: enabled ? colors.screenText : colors.muted,
                        backgroundColor: enabled ? colors.well : 'transparent',
                        borderRadius: 6,
                        overflow: 'hidden',
                        paddingVertical: 4,
                        paddingHorizontal: 8,
                      }}
                    >
                      {scheduleLabel(task.cron)}
                    </Text>
                    {!enabled && <Text style={styles.small}>已暂停</Text>}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`删除 ${task.name ?? '任务'}`}
                      onPress={() => setConfirm({ task, action: 'delete' })}
                    >
                      <Icon
                        name="more-horizontal"
                        size={18}
                        color={colors.muted}
                      />
                    </Pressable>
                  </View>
                  {enabled && (
                    <>
                      <View style={{ marginTop: 10 }}>
                        <Divider inset={0} />
                      </View>
                      <View style={[styles.between, { marginTop: 10, gap: 8 }]}>
                        <Pressable
                          disabled={!run}
                          accessibilityRole={run ? 'button' : undefined}
                          accessibilityLabel="查看最近运行结果"
                          onPress={() => run && openResult(run)}
                          style={{
                            flex: 1,
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          <View
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: 3,
                              backgroundColor:
                                run?.status === 'failed' ||
                                run?.status === 'timeout'
                                  ? colors.amber
                                  : run
                                    ? colors.green
                                    : colors.muted,
                            }}
                          />
                          <Text
                            numberOfLines={1}
                            style={[styles.small, { color: colors.secondary }]}
                          >
                            {run
                              ? `${new Date(run.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${run.status === 'completed' ? '执行完成' : run.status === 'running' ? '正在执行' : run.status === 'timeout' ? '执行超时' : '执行失败'}`
                              : '还没有执行记录'}
                          </Text>
                          {run && <Icon name="chevron-right" size={12} />}
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          disabled={resource.busy || run?.status === 'running'}
                          onPress={() => setConfirm({ task, action: 'run' })}
                          style={{
                            height: 32,
                            borderRadius: 10,
                            paddingHorizontal: 12,
                            justifyContent: 'center',
                            backgroundColor: colors.surface,
                            boxShadow: `inset 0 1px 0 ${colors.highlight},0 1px 2px rgba(60,45,30,.2)`,
                            opacity:
                              resource.busy || run?.status === 'running'
                                ? 0.4
                                : 1,
                          }}
                        >
                          <Text
                            style={{
                              fontSize: 12,
                              fontWeight: '600',
                              color: colors.secondary,
                            }}
                          >
                            立即运行
                          </Text>
                        </Pressable>
                      </View>
                    </>
                  )}
                  {!enabled && run && (
                    <Pressable
                      onPress={() => openResult(run)}
                      style={{ marginTop: 8 }}
                    >
                      <Text style={[styles.small, { color: colors.accent }]}>
                        查看最近结果
                      </Text>
                    </Pressable>
                  )}
                </Container>
              )
            })
          ) : (
            <Empty
              title="还没有定时任务"
              detail="添加任务后，由这台电脑按自己的本地时间执行。"
            />
          )}
          <Button
            title="刷新"
            secondary
            onPress={() => void resource.refresh()}
          />
        </View>
      )}
      <Modal
        visible={creating}
        transparent
        animationType="slide"
        onRequestClose={() => {
          if (!resource.busy) setCreating(false)
        }}
      >
        <View
          style={{
            flex: 1,
            justifyContent: 'flex-end',
            backgroundColor: '#0005',
          }}
        >
          <View
            style={{
              backgroundColor: colors.paper,
              borderTopLeftRadius: 26,
              borderTopRightRadius: 26,
              maxHeight: '92%',
            }}
          >
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{
                padding: 20,
                paddingBottom: 34,
                gap: 16,
              }}
            >
              <Text style={styles.title}>新建定时任务</Text>
              <Field
                label="名称"
                value={name}
                onChangeText={setName}
                editable={!resource.busy}
              />
              <Field
                label="执行内容"
                multiline
                value={prompt}
                onChangeText={setPrompt}
                editable={!resource.busy}
                style={{ minHeight: 100, textAlignVertical: 'top' }}
              />
              <Field
                label="电脑项目目录（可选）"
                value={folder}
                onChangeText={setFolder}
                editable={!resource.busy}
              />
              <Segment<'daily' | 'weekdays'>
                label="重复频率"
                value={frequency}
                onChange={setFrequency}
                options={[
                  { label: '每天', value: 'daily' },
                  { label: '工作日', value: 'weekdays' },
                ]}
                disabled={resource.busy}
              />
              <Field
                label="电脑本地时间（HH:mm）"
                value={time}
                onChangeText={setTime}
                keyboardType="numbers-and-punctuation"
                editable={!resource.busy}
              />
              <Notice text="任务沿用电脑当前模型配置，以无人值守模式运行，可修改文件和执行命令，不会逐项请求手机批准。" />
              <View style={styles.between}>
                <Text style={[styles.small, { flex: 1 }]}>
                  我已确认任务内容与执行目录
                </Text>
                <Toggle
                  label="确认定时任务执行权限"
                  value={accepted}
                  onChange={setAccepted}
                  disabled={resource.busy}
                />
              </View>
              <Notice text={resource.error} error />
              <PrimaryButton
                title="创建任务"
                icon="plus"
                disabled={
                  !accepted || !client || !name.trim() || !prompt.trim()
                }
                busy={resource.busy}
                onPress={create}
              />
              <Button
                title="取消"
                secondary
                disabled={resource.busy}
                onPress={() => setCreating(false)}
              />
            </ScrollView>
          </View>
        </View>
      </Modal>
      <Modal
        visible={!!confirm}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!resource.busy) setConfirm(null)
        }}
      >
        <View
          style={{
            flex: 1,
            justifyContent: 'center',
            padding: 24,
            backgroundColor: '#0005',
          }}
        >
          <Raised style={{ padding: 20, gap: 16 }}>
            <Text style={styles.title}>
              {confirm?.action === 'delete'
                ? '删除这个定时任务？'
                : '现在执行这个任务？'}
            </Text>
            <Text style={styles.text}>{confirm?.task.name}</Text>
            <Text style={styles.small}>
              {confirm?.action === 'delete'
                ? '删除后不再触发后续执行。已经运行的任务与执行记录不会因此删除。'
                : '将在电脑上立即运行，可修改文件和执行命令。已有运行记录可从结果入口查看。'}
            </Text>
            <Notice text={resource.error} error />
            <Button
              title={confirm?.action === 'delete' ? '确认删除' : '立即运行'}
              danger={confirm?.action === 'delete'}
              busy={resource.busy}
              onPress={confirmAction}
            />
            <Button
              title="取消"
              secondary
              disabled={resource.busy}
              onPress={() => setConfirm(null)}
            />
          </Raised>
        </View>
      </Modal>
      <Modal
        visible={!!detail}
        animationType="slide"
        onRequestClose={() => setDetail(null)}
      >
        <Screen
          title="执行结果"
          subtitle={detail?.taskName ?? '定时任务'}
          right={
            <CircleButton
              name="x"
              label="关闭结果"
              onPress={() => setDetail(null)}
            />
          }
          back={false}
        >
          <Notice text={detail?.error} error />
          <Text
            selectable
            style={[styles.text, { fontFamily: mono, fontSize: 12 }]}
          >
            {detail?.output || detail?.error || '电脑尚未记录输出。'}
          </Text>
        </Screen>
      </Modal>
    </Screen>
  )
}
