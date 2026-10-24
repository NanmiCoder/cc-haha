import { useCallback, useRef, useState } from 'react'
import { Modal, Platform, Pressable, ScrollView, View } from 'react-native'
import { Text } from '../ui/Text'
import { useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useConnection } from '../state/AppContext'
import { buildSocketOptions } from '../core/connection'
import {
  activityFromEvent,
  isAgent,
  loadTaskOutput,
  sessionPath,
  shellOutputText,
  taskElapsed,
  type BackgroundSnapshot,
  type BackgroundTask,
} from '../core/operations'
import type { ApiClient } from '../core/client'
import { useFocusedResource } from '../core/useFocusedResource'
import type { SocketLike } from '../core/sessionTransport'
import { normalizeHistory } from '../core/chat'
import {
  BottomBar,
  Button,
  CircleButton,
  Divider,
  Empty,
  Icon,
  Loading,
  Notice,
  Raised,
  Screen,
  mono,
  useTheme,
} from '../ui/theme'

const NativeSocket = WebSocket as unknown as new (
  url: string,
  protocols?: string[],
  options?: { headers?: Record<string, string> }
) => SocketLike
export default function Activity() {
  const { host, id } = useLocalSearchParams<{ host: string; id: string }>()
  return <ActivityPage key={`${host}:${id}`} hostId={host} id={id} />
}
function ActivityPage({ hostId, id }: { hostId: string; id: string }) {
  const {
    client,
    host,
    credential,
    error: connectionError,
  } = useConnection(hostId)
  const { colors, styles } = useTheme()
  const resource = useFocusedResource(
    useCallback(
      async (signal: AbortSignal) => {
        if (!client) throw new Error('正在连接电脑')
        return client.get<BackgroundSnapshot>(
          `${sessionPath(id)}/background-tasks`,
          { signal }
        )
      },
      [client, id]
    ),
    3000
  )
  const [connected, setConnected] = useState(false)
  const [socketEpoch, setSocketEpoch] = useState(0)
  const [confirm, setConfirm] = useState<BackgroundTask[] | null>(null)
  const [stopping, setStopping] = useState<string[]>([])
  const [detail, setDetail] = useState<BackgroundTask | null>(null)
  const socket = useRef<SocketLike | null>(null)
  const update = resource.setValue
  const setError = resource.setError
  useFocusEffect(
    useCallback(() => () => setDetail(null), [])
  )
  useFocusEffect(
    useCallback(() => {
      if (!host || !credential) return
      let active = true
      setConnected(false)
      setStopping([])
      const options = buildSocketOptions(
        host,
        credential,
        id,
        Platform.OS === 'web' ? 'web' : 'native'
      )
      const ws =
        Platform.OS === 'web'
          ? (new WebSocket(options.url) as unknown as SocketLike)
          : new NativeSocket(options.url, undefined, {
              headers: options.headers,
            })
      socket.current = ws
      ws.onopen = () => {
        if (active) setConnected(true)
      }
      ws.onmessage = (event) => {
        if (!active || typeof event.data !== 'string') return
        let message: Record<string, unknown>
        try {
          message = JSON.parse(event.data)
        } catch {
          return
        }
        update((previous) => ({
          tasks: activityFromEvent(previous?.tasks ?? [], message),
          historyComplete: previous?.historyComplete ?? false,
        }))
        if (message.type === 'background_task_stop_failed') {
          setStopping((current) =>
            current.filter((taskId) => taskId !== message.taskId)
          )
          setError(
            typeof message.message === 'string'
              ? message.message
              : '停止未完成，请重试'
          )
        }
        if (
          message.type === 'system_notification' &&
          message.subtype === 'task_notification'
        ) {
          const data = message.data as Record<string, unknown> | undefined
          if (data && data.status !== 'running')
            setStopping((current) =>
              current.filter((taskId) => taskId !== data.task_id)
            )
        }
      }
      ws.onclose = () => {
        if (active) {
          setConnected(false)
          setStopping([])
        }
      }
      ws.onerror = () => {
        if (active) {
          setConnected(false)
          setError('活动连接已断开，请重新连接后再停止任务')
        }
      }
      const heartbeat = setInterval(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }))
      }, 20000)
      return () => {
        active = false
        clearInterval(heartbeat)
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
        ws.close()
        if (socket.current === ws) socket.current = null
      }
      // A manual reconnect deliberately creates a new focus subscription.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [host, credential, id, socketEpoch, update, setError])
  )
  const tasks = resource.value?.tasks ?? []
  const running = tasks.filter((task) => task.status === 'running')
  const pendingStops = stopping.filter((taskId) =>
    running.some((task) => task.taskId === taskId)
  )
  const stop = () => {
    const ws = socket.current
    if (!connected || ws?.readyState !== 1 || !confirm) {
      setError('连接已断开，请重新连接')
      return
    }
    const targets = confirm.filter((task) =>
      tasks.some(
        (current) =>
          current.taskId === task.taskId && current.status === 'running'
      )
    )
    try {
      for (const task of targets)
        ws.send(
          JSON.stringify({ type: 'stop_background_task', taskId: task.taskId })
        )
      setStopping((current) => [
        ...new Set([...current, ...targets.map((task) => task.taskId)]),
      ])
      setConfirm(null)
    } catch {
      setError('停止请求未确认，请刷新后检查任务状态')
      setConfirm(null)
    }
  }
  const open = (task: BackgroundTask) => {
    setDetail(task)
  }
  const renderTask = (task: BackgroundTask, index: number) => (
    <View key={task.taskId}>
      {index > 0 && <Divider />}
      <View
        style={{
          paddingVertical: 14,
          paddingLeft: 16,
          paddingRight: 12,
          gap: 10,
        }}
      >
        <View style={[styles.row, { gap: 12 }]}>
          <View
            style={{
              width: 7,
              height: 7,
              borderRadius: 4,
              backgroundColor:
                task.status === 'running'
                  ? colors.green
                  : task.status === 'failed'
                    ? colors.amber
                    : colors.muted,
              boxShadow:
                task.status === 'running'
                  ? '0 0 0 3px rgba(143,163,90,.15)'
                  : undefined,
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`查看 ${task.description ?? task.taskId} 输出`}
            style={{ flex: 1, gap: 4 }}
            onPress={() => open(task)}
          >
            <Text
              numberOfLines={1}
              style={{ color: colors.ink, fontSize: 15, fontWeight: '600' }}
            >
              {task.description || task.taskId}
            </Text>
            <Text
              numberOfLines={1}
              style={[styles.small, { fontFamily: mono, fontSize: 11 }]}
            >
              {task.summary ||
                (task.status === 'running'
                  ? '正在执行'
                  : task.status === 'completed'
                    ? '已完成'
                    : task.status === 'stopped'
                      ? '已停止'
                      : '执行失败')}
            </Text>
          </Pressable>
          {task.status === 'running' && !!taskElapsed(task) && (
            <Text
              style={{
                fontFamily: mono,
                fontSize: 12,
                color: colors.screenText,
                backgroundColor: colors.well,
                borderRadius: 6,
                overflow: 'hidden',
                paddingVertical: 4,
                paddingHorizontal: 7,
              }}
            >
              {taskElapsed(task)}
            </Text>
          )}
          {task.status === 'running' && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`停止 ${task.description ?? task.taskId}`}
              disabled={
                !connected || stopping.includes(task.taskId) || task.stopping
              }
              onPress={() => setConfirm([task])}
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: colors.surface,
                boxShadow: `inset 0 1px 0 ${colors.highlight},0 2px 5px rgba(60,45,30,.15)`,
                opacity:
                  connected && !stopping.includes(task.taskId) && !task.stopping
                    ? 1
                    : 0.35,
              }}
            >
              <Icon name="square" size={12} />
            </Pressable>
          )}
        </View>
        {!isAgent(task) && (task.result || task.summary) && (
          <Pressable
            onPress={() => open(task)}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 10,
              borderRadius: 10,
              backgroundColor: colors.well,
            }}
          >
            <Text
              numberOfLines={3}
              style={{
                color: '#CFCBC2',
                fontFamily: mono,
                fontSize: 11,
                lineHeight: 18,
              }}
            >
              {task.result || task.summary}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  )
  return (
    <Screen
      title="当前会话"
      subtitle={host?.name ?? '后台活动'}
      scroll={false}
      right={
        <CircleButton
          name="refresh-cw"
          label="重新连接活动"
          onPress={() => {
            setSocketEpoch((value) => value + 1)
            void resource.refresh()
          }}
        />
      }
    >
      <View style={{ height: 46 }} />
      <View
        style={{
          flex: 1,
          backgroundColor: colors.paper,
          borderTopLeftRadius: 26,
          borderTopRightRadius: 26,
          boxShadow: '0 -8px 30px rgba(30,25,20,.07)',
        }}
      >
        <View
          style={{
            width: 36,
            height: 4,
            borderRadius: 2,
            backgroundColor: colors.line,
            alignSelf: 'center',
            marginTop: 10,
            marginBottom: 20,
          }}
        />
        <View
          style={[styles.between, { paddingHorizontal: 20, marginBottom: 20 }]}
        >
          <Text style={{ color: colors.ink, fontSize: 18, fontWeight: '600' }}>
            后台活动
          </Text>
          <Text style={[styles.small, { fontFamily: mono }]}>
            {running.length} 项在跑
          </Text>
        </View>
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 16,
            gap: 18,
            paddingBottom: 24,
          }}
        >
          <Notice text={connectionError || resource.error} error />
          {!connected && <Notice text="尚未连接活动通道，停止按钮暂不可用。" />}
          {resource.loading ? (
            <Loading />
          ) : tasks.length === 0 ? (
            <Empty
              title="没有后台活动"
              detail="子 Agent 与后台命令开始后会显示在这里。"
            />
          ) : (
            <>
              {[
                { label: '子 Agent', rows: tasks.filter(isAgent) },
                {
                  label: '后台命令',
                  rows: tasks.filter((task) => !isAgent(task)),
                },
              ]
                .filter((group) => group.rows.length)
                .map((group) => (
                  <View key={group.label} style={{ gap: 8 }}>
                    <Text style={[styles.label, { marginLeft: 4 }]}>
                      {group.label}
                    </Text>
                    <Raised style={{ borderRadius: 18 }}>
                      {group.rows.map(renderTask)}
                    </Raised>
                  </View>
                ))}
              {!resource.value?.historyComplete && (
                <Text style={styles.small}>
                  这里显示全部当前活动与最近的完成记录，更早输出可在会话中查看。
                </Text>
              )}
            </>
          )}
        </ScrollView>
        <BottomBar>
          <Text
            style={[styles.small, { textAlign: 'center', marginBottom: 12 }]}
          >
            停止后，已经改好的文件会保留
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={!connected || !running.length || pendingStops.length > 0}
            onPress={() => setConfirm(running)}
            style={{
              minHeight: 54,
              borderRadius: 17,
              backgroundColor: colors.well,
              flexDirection: 'row',
              justifyContent: 'center',
              alignItems: 'center',
              gap: 8,
              opacity:
                connected && running.length && !pendingStops.length ? 1 : 0.4,
            }}
          >
            <Icon name="square" color="#F4F3F0" size={14} />
            <Text style={{ color: '#F4F3F0', fontSize: 15, fontWeight: '600' }}>
              {pendingStops.length ? '等待电脑停止…' : '全部停止'}
            </Text>
          </Pressable>
        </BottomBar>
      </View>
      <Modal
        visible={!!confirm}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirm(null)}
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
              停止 {confirm?.length ?? 0} 项后台活动？
            </Text>
            <Text style={styles.small}>
              已修改的文件会保留，尚未完成的输出可能不完整。
            </Text>
            <Button
              title="确认停止"
              danger
              disabled={!connected}
              onPress={stop}
            />
            <Button title="取消" secondary onPress={() => setConfirm(null)} />
          </Raised>
        </View>
      </Modal>
      <Modal
        visible={!!detail}
        animationType="slide"
        onRequestClose={() => setDetail(null)}
      >
        <Screen
          title="任务输出"
          subtitle={
            detail?.description || detail?.taskId || '后台活动'
          }
          back={false}
          right={
            <CircleButton
              name="x"
              label="关闭输出"
              onPress={() => setDetail(null)}
            />
          }
        >
          {detail && (
            <TaskOutputView
              key={`${hostId}:${id}:${detail.taskId}`}
              client={client}
              sessionId={id}
              task={tasks.find((task) => task.taskId === detail.taskId) ?? detail}
            />
          )}
        </Screen>
      </Modal>
    </Screen>
  )
}

/** The selected task owns its request state. Closing/changing the modal unmounts and aborts it. */
function TaskOutputView({
  client,
  sessionId,
  task,
}: {
  client: ApiClient | null
  sessionId: string
  task: BackgroundTask
}) {
  const { styles } = useTheme()
  const { taskId, taskType, toolUseId, status, result, summary } = task
  const output = useFocusedResource(
    useCallback(
      (signal: AbortSignal) => {
        if (!client) throw new Error('正在连接电脑')
        return loadTaskOutput(
          client,
          sessionId,
          { taskId, taskType, toolUseId, status, result, summary },
          signal
        )
      },
      [client, sessionId, taskId, taskType, toolUseId, status, result, summary]
    ),
    status === 'running' ? 3000 : 0
  )
  const value = output.value
  const text = value?.kind === 'shell'
    ? shellOutputText(value.output)
    : value?.kind === 'notice'
      ? value.text
      : value?.kind === 'agent'
        ? value.output.result || value.output.summary || normalizeHistory(value.output.messages)
          .map((item) => item.text || (item.result ? JSON.stringify(item.result) : ''))
          .filter(Boolean).join('\n\n') || '暂时没有输出。'
        : ''
  return (
    <View style={{ gap: 12 }}>
      <Notice text={output.error} error />
      {output.loading && <Loading />}
      <Text selectable style={[styles.text, { fontSize: 12, fontFamily: mono }]}>{text}</Text>
      {value && value.kind !== 'notice' && value.output.truncated && (
        <Notice text={value.kind === 'shell' ? '日志较长，当前显示最后 64 KiB；运行中每 3 秒刷新。' : '输出较长，当前显示电脑返回的片段。'} />
      )}
      <Button title="刷新输出" secondary onPress={() => void output.refresh()} />
    </View>
  )
}
