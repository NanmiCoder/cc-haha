import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform, ScrollView, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { useConnection } from '../../state/AppContext'
import { useDashboard } from '../../state/DashboardContext'
import { buildSocketOptions } from '../../core/connection'
import {
  activityFromEvent,
  isAgent,
  sessionPath,
  type BackgroundSnapshot,
  type BackgroundTask,
} from '../../core/operations'
import type { Session } from '../../core/types'
import type { SocketLike } from '../../core/sessionTransport'
import { useFocusedResource } from '../../core/useFocusedResource'
import {
  BottomBar,
  Button,
  EmptyState,
  Footnote,
  Group,
  Icon,
  InlineError,
  Loading,
  NavBar,
  ScreenView,
  SectionHeader,
  Separator,
  TextButton,
  useColors,
} from '../kit'
import { Text } from '../Text'
import { ConfirmSheet } from './ConfirmSheet'
import { TaskOutputSheet } from './TaskOutputSheet'
import { TaskRow } from './TaskRow'
import { stopTargets } from './taskLabels'
import { useNow } from './useNow'
import { WorkSections } from './WorkSections'

const NativeSocket = WebSocket as unknown as new (
  url: string,
  protocols?: string[],
  options?: { headers?: Record<string, string> }
) => SocketLike

type SocketState = 'connecting' | 'open' | 'closed'

/** 会话标题：先用首页快照，没有再读一次会话摘要。 */
function useSessionTitle(hostId: string, id: string) {
  const { client } = useConnection(hostId)
  const { snapshot } = useDashboard()
  const known =
    snapshot?.hostId === hostId
      ? snapshot.sessions.find((session) => session.id === id)?.title
      : undefined
  const [fetched, setFetched] = useState<string>()
  useEffect(() => {
    if (known || !client) return
    const controller = new AbortController()
    client
      .get<Session>(`${sessionPath(id)}/summary`, { signal: controller.signal })
      .then((session) => {
        if (!controller.signal.aborted) setFetched(session.title)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [client, id, known])
  return known || fetched
}

/** 单个会话的后台活动（Activity 稿）：子 Agent / 后台命令，可逐项或全部停止。 */
const STOP_TIMEOUT_MS = 15_000

export function SessionActivity({ hostId, id }: { hostId: string; id: string }) {
  const colors = useColors()
  const { client, host, credential, error: connectionError } = useConnection(hostId)
  const title = useSessionTitle(hostId, id)
  const resource = useFocusedResource(
    useCallback(
      async (signal: AbortSignal) => {
        if (!client) throw new Error('正在连接电脑')
        return client.get<BackgroundSnapshot>(`${sessionPath(id)}/background-tasks`, {
          signal,
        })
      },
      [client, id]
    ),
    3000
  )
  const [socketState, setSocketState] = useState<SocketState>('connecting')
  const [socketError, setSocketError] = useState('')
  const [slow, setSlow] = useState(false)
  const [everOpened, setEverOpened] = useState(false)
  const [socketEpoch, setSocketEpoch] = useState(0)
  const [confirm, setConfirm] = useState<BackgroundTask[] | null>(null)
  const [stopping, setStopping] = useState<string[]>([])
  const [stopError, setStopError] = useState('')
  // 停止请求发出后电脑一直不回（既没有结束通知也没有失败消息）时，不能让按钮永远转圈。
  const stopTimers = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const timers = stopTimers.current
    return () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
  }, [])
  const [detail, setDetail] = useState<BackgroundTask | null>(null)
  const socket = useRef<SocketLike | null>(null)
  const update = resource.setValue
  useFocusEffect(useCallback(() => () => setDetail(null), []))
  useFocusEffect(
    useCallback(() => {
      if (!host || !credential) return
      let active = true
      setSocketState('connecting')
      setSocketError('')
      setSlow(false)
      setStopping([])
      const slowTimer = setTimeout(() => active && setSlow(true), 2000)
      let ws: SocketLike
      try {
        const options = buildSocketOptions(
          host,
          credential,
          id,
          Platform.OS === 'web' ? 'web' : 'native'
        )
        ws =
          Platform.OS === 'web'
            ? (new WebSocket(options.url) as unknown as SocketLike)
            : new NativeSocket(options.url, undefined, { headers: options.headers })
      } catch (e) {
        clearTimeout(slowTimer)
        setSocketState('closed')
        setSocketError(e instanceof Error ? e.message : '活动通道连接失败')
        return
      }
      socket.current = ws
      ws.onopen = () => {
        if (!active) return
        setSocketState('open')
        setEverOpened(true)
        // 通道重新连上后，“连接已断开”之类的旧提示就过时了。
        setStopError('')
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
          setStopping((current) => current.filter((taskId) => taskId !== message.taskId))
          setStopError(
            typeof message.message === 'string' ? message.message : '停止未完成，请重试'
          )
        }
        if (message.type === 'system_notification' && message.subtype === 'task_notification') {
          const data = message.data as Record<string, unknown> | undefined
          if (data && data.status !== 'running')
            setStopping((current) => current.filter((taskId) => taskId !== data.task_id))
        }
      }
      ws.onclose = () => {
        if (!active) return
        setSocketState('closed')
        setStopping([])
      }
      ws.onerror = () => {
        if (active) setSocketState('closed')
      }
      const heartbeat = setInterval(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }))
      }, 20000)
      return () => {
        active = false
        clearTimeout(slowTimer)
        clearInterval(heartbeat)
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
        ws.close()
        if (socket.current === ws) socket.current = null
      }
      // A manual reconnect deliberately creates a new focus subscription.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [host, credential, id, socketEpoch, update])
  )
  const tasks = resource.value?.tasks ?? []
  const running = tasks.filter((task) => task.status === 'running')
  const now = useNow(running.length > 0)
  const connected = socketState === 'open'
  const pendingStops = stopping.filter((taskId) =>
    running.some((task) => task.taskId === taskId)
  )
  const stop = () => {
    const ws = socket.current
    const selected = confirm ?? []
    setConfirm(null)
    if (!connected || ws?.readyState !== 1) {
      setStopError('连接已断开，请重新连接')
      return
    }
    const targets = stopTargets(selected, tasks)
    setStopError('')
    try {
      for (const task of targets)
        ws.send(JSON.stringify({ type: 'stop_background_task', taskId: task.taskId }))
      const ids = targets.map((task) => task.taskId)
      setStopping((current) => [...new Set([...current, ...ids])])
      const timer = setTimeout(() => {
        stopTimers.current.delete(timer)
        setStopping((current) => {
          if (current.some((taskId) => ids.includes(taskId)))
            queueMicrotask(() => setStopError('电脑没有回应停止请求，刷新后看看任务状态。'))
          return current.filter((taskId) => !ids.includes(taskId))
        })
      }, STOP_TIMEOUT_MS)
      stopTimers.current.add(timer)
    } catch {
      setStopError('停止请求未确认，请刷新后检查任务状态')
    }
  }
  const reconnect = () => {
    setSocketEpoch((value) => value + 1)
    void resource.refresh()
  }
  // 通道没连上：给出原因并提供重连；刚进页面的头两秒不打扰。
  const showChannelNotice =
    !!host &&
    !!credential &&
    running.length > 0 &&
    (socketState === 'closed' || (socketState === 'connecting' && slow))
  const channelNotice =
    socketError ||
    (everOpened ? '活动连接已断开，请重新连接后再停止任务' : '尚未连接活动通道，停止按钮暂不可用。')
  const groups = [
    { label: '子 Agent', rows: tasks.filter(isAgent) },
    { label: '后台命令', rows: tasks.filter((task) => !isAgent(task)) },
  ].filter((group) => group.rows.length)
  // 停止失败的提示只在还有任务在跑时有意义；全部结束后自动消失。
  const error = connectionError || (running.length ? stopError : '') || resource.error
  return (
    <ScreenView>
      <NavBar title="活动" subtitle={title} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24 }}>
        {error || showChannelNotice ? (
          <View style={{ gap: 8, paddingBottom: 8 }}>
            <InlineError text={error} />
            {showChannelNotice && (
              <View
                accessibilityRole="alert"
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  paddingLeft: 12,
                  paddingRight: 8,
                  paddingVertical: 4,
                  borderRadius: 12,
                  backgroundColor: colors.attnSoft,
                }}
              >
                <Icon name="circle-alert" size={16} color={colors.attnInk} strokeWidth={2} />
                <Text style={{ flex: 1, fontSize: 13, lineHeight: 19, color: colors.attnInk, paddingVertical: 6 }}>
                  {channelNotice}
                </Text>
                <TextButton title="重新连接" strong color={colors.attnInk} onPress={reconnect} />
              </View>
            )}
          </View>
        ) : null}
        <WorkSections client={client} sessionId={id} />
        {resource.loading ? (
          <Loading />
        ) : tasks.length === 0 ? (
          <EmptyState
            title="没有后台活动"
            detail="子 Agent 和后台命令开始后会显示在这里。"
          />
        ) : (
          <>
            {groups.map((group, groupIndex) => (
              <View key={group.label}>
                <SectionHeader
                  title={group.label}
                  style={groupIndex === 0 ? { paddingTop: 4 } : undefined}
                />
                <Group>
                  {group.rows.map((task, index) => (
                    <View key={task.taskId}>
                      {index > 0 && <Separator inset={40} />}
                      <TaskRow
                        task={task}
                        now={now}
                        onOpen={() => setDetail(task)}
                        onStop={() => setConfirm([task])}
                        stopDisabled={
                          !connected || stopping.includes(task.taskId) || !!task.stopping
                        }
                        stopping={stopping.includes(task.taskId) || !!task.stopping}
                      />
                    </View>
                  ))}
                </Group>
              </View>
            ))}
            {!resource.value?.historyComplete && (
              <Footnote style={{ paddingTop: 10 }}>
                这里显示全部当前活动与最近的完成记录，更早输出可在会话中查看。
              </Footnote>
            )}
          </>
        )}
      </ScrollView>
      {running.length > 0 && (
        <BottomBar style={{ gap: 8 }}>
          <Button
            title={pendingStops.length ? '等电脑停止…' : `全部停止（${running.length} 项）`}
            variant="danger"
            size="lg"
            disabled={!connected || pendingStops.length > 0}
            onPress={() => setConfirm(running)}
          />
          <Text style={{ textAlign: 'center', fontSize: 12.5, lineHeight: 17, color: colors.ink3 }}>
            停下后，已经改好的文件会保留
          </Text>
        </BottomBar>
      )}
      <ConfirmSheet
        visible={!!confirm}
        title={`停止 ${confirm?.length ?? 0} 项后台活动？`}
        detail="已修改的文件会保留，尚未完成的输出可能不完整。"
        confirmTitle="确认停止"
        destructive
        disabled={!connected}
        onConfirm={stop}
        onClose={() => setConfirm(null)}
      />
      <TaskOutputSheet
        task={detail ? (tasks.find((task) => task.taskId === detail.taskId) ?? detail) : null}
        client={client}
        sessionId={id}
        onClose={() => setDetail(null)}
      />
    </ScreenView>
  )
}
