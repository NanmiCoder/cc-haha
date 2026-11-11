import { useCallback } from 'react'
import { ScrollView, View, useWindowDimensions } from 'react-native'
import type { ApiClient } from '../../core/client'
import { normalizeHistory } from '../../core/chat'
import {
  loadTaskOutput,
  shellOutputText,
  type BackgroundTask,
  type TaskOutput,
} from '../../core/operations'
import { useFocusedResource } from '../../core/useFocusedResource'
import { Button, Callout, InlineError, Loading, Mono, Sheet, type, useColors } from '../kit'
import { Text } from '../Text'
import { taskTitle } from './taskLabels'

export function outputText(value: TaskOutput | null) {
  if (!value) return ''
  if (value.kind === 'shell') return shellOutputText(value.output)
  if (value.kind === 'notice') return value.text
  return (
    value.output.result ||
    value.output.summary ||
    normalizeHistory(value.output.messages)
      .map((item) => item.text || (item.result ? JSON.stringify(item.result) : ''))
      .filter(Boolean)
      .join('\n\n') ||
    '暂时没有输出。'
  )
}

/** 任务输出弹层：标题“任务输出”，副标题是任务描述；运行中每 3 秒刷新。 */
export function TaskOutputSheet({
  task,
  client,
  sessionId,
  onClose,
}: {
  task: BackgroundTask | null
  client: ApiClient | null
  sessionId: string
  onClose(): void
}) {
  const colors = useColors()
  const { height } = useWindowDimensions()
  return (
    <Sheet visible={!!task} onClose={onClose} scroll={false}>
      {task && (
        <View style={{ gap: 12 }}>
          <View style={{ alignItems: 'center', gap: 2, paddingTop: 6, paddingBottom: 4 }}>
            <Text style={[type.nav, { color: colors.ink }]}>任务输出</Text>
            <Text numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, color: colors.ink3 }}>
              {taskTitle(task)}
            </Text>
          </View>
          {/* key 让切换任务时旧请求随组件卸载一起取消。 */}
          <OutputBody
            key={`${sessionId}:${task.taskId}`}
            client={client}
            sessionId={sessionId}
            task={task}
            maxHeight={height * 0.55}
          />
        </View>
      )}
    </Sheet>
  )
}

function OutputBody({
  client,
  sessionId,
  task,
  maxHeight,
}: {
  client: ApiClient | null
  sessionId: string
  task: BackgroundTask
  maxHeight: number
}) {
  const colors = useColors()
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
  const text = outputText(value)
  const truncated = value && value.kind !== 'notice' && value.output.truncated
  return (
    <View style={{ gap: 12 }}>
      <InlineError text={output.error} />
      {output.loading && !value ? (
        <Loading />
      ) : text ? (
        <ScrollView
          style={{ maxHeight, borderRadius: 12, backgroundColor: colors.code }}
          contentContainerStyle={{ padding: 12 }}
        >
          <Mono selectable style={{ fontSize: 12, lineHeight: 18, color: colors.ink }}>
            {text}
          </Mono>
        </ScrollView>
      ) : null}
      {truncated ? (
        <Callout tone="info">
          {value.kind === 'shell'
            ? '日志较长，当前显示最后 64 KiB；运行中每 3 秒刷新。'
            : '输出较长，当前显示电脑返回的片段。'}
        </Callout>
      ) : null}
      <Button
        title="刷新输出"
        variant="secondary"
        icon="refresh-cw"
        onPress={() => void output.refresh()}
      />
    </View>
  )
}
