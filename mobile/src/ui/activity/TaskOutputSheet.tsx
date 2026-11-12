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
    'No output yet.'
  )
}

/** Task output sheet: title "Task output", subtitle is the task description; refreshes every 3 seconds while running. */
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
            <Text style={[type.nav, { color: colors.ink }]}>Task output</Text>
            <Text numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, color: colors.ink3 }}>
              {taskTitle(task)}
            </Text>
          </View>
          {/* key Cancel old requests along with component unmount when switching tasks. */}
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
        if (!client) throw new Error('Connecting to computer')
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
            ? 'Log is long; showing the last 64 KiB; refreshes every 3 seconds while running.'
            : 'Output is long; showing the excerpt returned by the computer.'}
        </Callout>
      ) : null}
      <Button
        title="Refresh output"
        variant="secondary"
        icon="refresh-cw"
        onPress={() => void output.refresh()}
      />
    </View>
  )
}
