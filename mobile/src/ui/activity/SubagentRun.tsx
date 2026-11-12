import { useCallback, useEffect, useRef, useState } from 'react'
import { FlatList, Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Svg, { Path, Rect } from 'react-native-svg'
import { useConnection } from '../../state/AppContext'
import { sendToSession } from '../../core/sessionSender'
import {
  loadSubagentRun,
  sessionPath,
  type BackgroundSnapshot,
  type BackgroundTask,
  type SubagentOutput,
} from '../../core/operations'
import { useFocusedResource } from '../../core/useFocusedResource'
import {
  Footnote,
  InlineError,
  Loading,
  Mono,
  NavBar,
  ScreenView,
  Spinner,
  useColors,
} from '../kit'
import { Text } from '../Text'
import { Message } from '../Message'
import { StepGroup, TurnFold, type StepContext, type StepUi } from '../chat/StepGroup'
import { StatusCaption } from '../chat/StatusCaption'
import { toggleGroupOpen, visibleChatRows, type ChatRow } from '../chat/steps'
import { ConfirmSheet } from './ConfirmSheet'
import { agentStatusText, clock } from './activityView'
import { subagentHeader, subagentRunView } from './subagentView'
import { useNow } from './useNow'

const REFRESH_MS = 2000
const STOP_TIMEOUT_MS = 15_000

type Loaded = { output: SubagentOutput; task?: BackgroundTask }

const toggle = (set: ReadonlySet<string>, key: string) => {
  const next = new Set(set)
  if (!next.delete(key)) next.add(key)
  return next
}

/** Tasks given by the main agent to a subagent (or by the lead to a member) are often dozens of lines: show only the first few by default, tap to expand. */
export function TaskPrompt({ text }: { text: string }) {
  const colors = useColors()
  const [open, setOpen] = useState(false)
  const long = text.length > 220 || text.split('\n').length > 6
  return (
    <View style={{ maxWidth: '88%', backgroundColor: colors.bubble, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10, gap: 6 }}>
      <Text numberOfLines={open || !long ? undefined : 6} style={{ fontSize: 15, lineHeight: 22, color: colors.ink }}>
        {text}
      </Text>
      {long ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((value) => !value)}
          hitSlop={8}
          style={{ minHeight: 28, justifyContent: 'center' }}
        >
          <Text style={{ fontSize: 13, color: colors.run }}>{open ? 'Collapse' : 'Show all'}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

function LockIcon({ color }: { color: string }) {
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect width={18} height={11} x={3} y={11} rx={2} />
      <Path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </Svg>
  )
}

/** Fixed "Read-only" note at the bottom: records are visible here, but you cannot reply. */
export function ReadOnlyBar() {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  return (
    <View style={{ paddingHorizontal: 12, paddingBottom: Math.max(insets.bottom, 12), paddingTop: 6 }}>
      <View
        accessibilityRole="text"
        accessibilityLabel="Read-only, cannot reply here"
        style={{
          height: 44,
          borderRadius: 22,
          backgroundColor: colors.fill,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 7,
        }}
      >
        <LockIcon color={colors.ink3} />
        <Text style={{ fontSize: 14, color: colors.ink3 }}>Read-only · cannot reply here</Text>
      </View>
    </View>
  )
}

/**
 * Subagent full-screen page: read-only transcript. The header is name + status + elapsed, with "Stop" at top right while running; 
 * content uses the same timeline as the main conversation (task given to it, aggregated tool rows, current step, replies).
 * Refreshes every 2 seconds while running; a fixed "Read-only" note at the bottom.
 */
export function SubagentRun({
  hostId,
  sessionId,
  taskId,
  toolUseId,
}: {
  hostId: string
  sessionId: string
  taskId?: string
  toolUseId: string
}) {
  const colors = useColors()
  const { client, error: connectionError } = useConnection(hostId)
  const [running, setRunning] = useState(true)
  const resource = useFocusedResource<Loaded>(
    useCallback(
      async (signal: AbortSignal) => {
        if (!client) throw new Error('Connecting to computer')
        // Run state and elapsed time come from the background task list; when the list cannot be read only the transcript is shown.
        const [output, snapshot] = await Promise.all([
          loadSubagentRun(client, sessionId, toolUseId, taskId, signal),
          client
            .get<BackgroundSnapshot>(`${sessionPath(sessionId)}/background-tasks`, { signal })
            .catch(() => null),
        ])
        const task = snapshot?.tasks.find(
          (item) => (taskId && item.taskId === taskId) || item.toolUseId === toolUseId
        )
        return { output, task }
      },
      [client, sessionId, taskId, toolUseId]
    ),
    running ? REFRESH_MS : 0
  )
  const header = subagentHeader(resource.value?.task, resource.value?.output ?? null)
  const live = header.status === 'running'
  // Polling interval follows run state: refreshing stops after it ends.
  if (resource.value && live !== running) setRunning(live)
  const now = useNow(live)
  const view = subagentRunView(resource.value?.output ?? null, live)
  const [ui, setUi] = useState<StepUi>({ expanded: new Set(), open: new Set(), closed: new Set(), revealed: new Set() })
  const context: StepContext = {
    workDir: undefined,
    waiting: new Set(),
    background: new Set(),
    turnActive: live,
  }
  const [confirm, setConfirm] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState('')
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const liveRef = useRef(live)
  useEffect(() => {
    liveRef.current = live
  })
  useEffect(
    () => () => {
      if (stopTimer.current) clearTimeout(stopTimer.current)
    },
    []
  )
  const stop = () => {
    setConfirm(false)
    const id = resource.value?.task?.taskId ?? taskId
    if (!id) return
    if (!sendToSession(sessionId, { type: 'stop_background_task', taskId: id })) {
      setStopError('Connection lost; go back to the session and reconnect before stopping.')
      return
    }
    setStopError('')
    setStopping(true)
    if (stopTimer.current) clearTimeout(stopTimer.current)
    stopTimer.current = setTimeout(() => {
      setStopping(false)
      // No error needed if already stopped.
      if (liveRef.current) setStopError('The computer did not respond to the stop request; refresh later to check the status.')
    }, STOP_TIMEOUT_MS)
    void resource.refresh()
  }
  const stoppingNow = stopping && live
  const rows = visibleChatRows(view.rows, ui.open)
  const list = useRef<FlatList<ChatRow>>(null)
  const stick = useRef(true)
  const status = stoppingNow ? 'Stopping' : agentStatusText(header.status)
  const statusColor =
    header.status === 'running'
      ? colors.run
      : header.status === 'completed'
        ? colors.ok
        : header.status === 'failed'
          ? colors.err
          : colors.ink3
  const time = live ? clock(header.startedAt, now) : ''
  return (
    <ScreenView>
      <NavBar
        title={header.title}
        subtitle={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            {live ? <Spinner size={11} thickness={2.6} /> : null}
            <Text style={{ fontSize: 12, lineHeight: 16, fontWeight: '500', color: statusColor }}>{status}</Text>
            <Text style={{ fontSize: 12, lineHeight: 16, color: colors.ink3 }}>· subagent</Text>
            {time ? <Mono style={{ fontSize: 12, lineHeight: 16, color: colors.ink3 }}>{`· ${time}`}</Mono> : null}
          </View>
        }
        right={
          live ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Stop ${header.title}`}
              accessibilityState={{ disabled: stoppingNow, busy: stoppingNow }}
              disabled={stoppingNow}
              onPress={() => setConfirm(true)}
              style={({ pressed }) => ({ height: 44, justifyContent: 'center', opacity: stoppingNow ? 0.5 : pressed ? 0.6 : 1 })}
            >
              <View
                style={{
                  height: 36,
                  paddingLeft: 12,
                  paddingRight: 14,
                  borderRadius: 18,
                  backgroundColor: colors.card,
                  boxShadow: `0 1px 2px rgba(28,25,23,0.06), 0 2px 8px rgba(28,25,23,0.07), 0 0 0 1px ${colors.hair}`,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <View style={{ width: 12, height: 12, borderRadius: 2.4, backgroundColor: colors.err }} />
                <Text style={{ fontSize: 15, fontWeight: '600', color: colors.err }}>{stoppingNow ? 'Stopping' : 'Stop'}</Text>
              </View>
            </Pressable>
          ) : undefined
        }
      />
      <View style={{ paddingHorizontal: 16 }}>
        <InlineError text={stopError || connectionError || (resource.value ? '' : resource.error)} />
      </View>
      {resource.loading && !resource.value ? (
        <Loading />
      ) : (
        <FlatList
          ref={list}
          data={rows}
          keyExtractor={(row) => row.key}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24, gap: 14 }}
          onScroll={({ nativeEvent }) => {
            const { contentOffset, contentSize, layoutMeasurement } = nativeEvent
            stick.current = contentSize.height - (contentOffset.y + layoutMeasurement.height) < 80
          }}
          scrollEventThrottle={64}
          onContentSizeChange={() => {
            if (live && stick.current) list.current?.scrollToEnd({ animated: false })
          }}
          ListEmptyComponent={
            <Footnote>{live ? 'It has not left anything to view yet; wait a moment.' : 'No conversation records to show.'}</Footnote>
          }
          ListFooterComponent={
            <View style={{ gap: 8 }}>
              {view.truncated ? <Footnote>The record is long; showing the most recent part returned by the computer.</Footnote> : null}
              {live && view.current ? <StatusCaption step={view.current} /> : null}
            </View>
          }
          renderItem={({ item: row }) =>
            row.kind === 'turn' ? (
              <TurnFold
                label={row.label}
                open={ui.open.has(row.key)}
                onToggle={() => setUi((value) => ({ ...value, open: toggle(value.open, row.key) }))}
              />
            ) : row.kind === 'message' && row.item.id === view.prompt?.id ? (
              <View style={{ alignItems: 'flex-end', gap: 5 }}>
                <Text style={{ fontSize: 12, color: colors.ink3, paddingRight: 4 }}>Task given by the main agent</Text>
                <TaskPrompt text={row.item.text ?? ''} />
              </View>
            ) : row.kind === 'message' ? (
              <Message item={row.item} />
            ) : (
              <StepGroup
                row={row}
                context={context}
                ui={ui}
                onToggleStep={(key) => setUi((value) => ({ ...value, expanded: toggle(value.expanded, key) }))}
                onToggleOpen={(key, live) => setUi((value) => toggleGroupOpen(value, key, live))}
                onReveal={(key) => setUi((value) => ({ ...value, revealed: toggle(value.revealed, key) }))}
              />
            )
          }
        />
      )}
      <ReadOnlyBar />
      <ConfirmSheet
        visible={confirm}
        title="Stop this subagent?"
        subject={header.title}
        detail="Modified files are kept; unfinished output may be incomplete."
        confirmTitle="Confirm stop"
        destructive
        onConfirm={stop}
        onClose={() => setConfirm(false)}
      />
    </ScreenView>
  )
}
