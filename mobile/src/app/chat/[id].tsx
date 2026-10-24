import { useEffect, useEffectEvent, useRef, useState } from 'react'
import {
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native'
import { Text } from '../../ui/Text'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router, useLocalSearchParams } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import { useApp, useConnection } from '../../state/AppContext'
import { createChatState } from '../../core/chat'
import { ChatRecovery } from '../../core/chatRecovery'
import {
  buildComposerMessage,
  persistedMessageId,
  validateMessageSize,
  visibleMessageText,
  type ComposerAttachment,
} from '../../core/chatComposer'
import {
  notificationPermissionResponse,
  runtimeMatches,
} from '../../core/chatActions'
import { clearPendingTask, peekPendingTask } from '../../core/pendingTask'
import {
  SessionTransport,
  type ConnectionState,
  type SocketLike,
} from '../../core/sessionTransport'
import type {
  ChatItem,
  ChatState,
  ClientMessage,
  Session,
} from '../../core/types'
import { Approval, PlanPreview } from '../../ui/Approval'
import { ChatComposer } from '../../ui/ChatComposer'
import { Message } from '../../ui/Message'
import { RuntimePicker } from '../../ui/RuntimePicker'
import { SessionChangesCard } from '../../ui/SessionChangesCard'
import { modeName, modes } from '../../ui/modes'
import {
  Button,
  CircleButton,
  Empty,
  Field,
  Icon,
  Notice,
  PageHeader,
  PrimaryButton,
  Raised,
  Row,
  errorText,
  mono,
  useTheme,
} from '../../ui/theme'

const labels: Record<ConnectionState, string> = {
  connecting: '连接电脑中',
  syncing: '同步会话中',
  ready: '已连接',
  reconnecting: '正在重连',
  offline: '连接已断开',
  pairing_required: '需要重新配对',
}
const NativeSocket = WebSocket as unknown as new (
  url: string,
  protocols?: string[],
  options?: { headers?: Record<string, string> }
) => SocketLike
type Panel = 'model' | 'mode' | 'more' | 'stop' | 'message' | 'edit' | null
type RewindPreview = {
  target: { targetUserMessageId: string }
  conversation: { messagesRemoved: number }
}
export default function Chat() {
  const { id, host, notificationAction, requestId } = useLocalSearchParams<{
    id: string
    host: string
    notificationAction?: string
    requestId?: string
  }>()
  return (
    <ChatSession
      key={`${host}:${id}`}
      id={id}
      hostId={host}
      notificationAction={notificationAction}
      notificationRequestId={requestId}
    />
  )
}
function ChatSession({
  id,
  hostId,
  notificationAction,
  notificationRequestId,
}: {
  id: string
  hostId: string
  notificationAction?: string
  notificationRequestId?: string
}) {
  const {
    client,
    host,
    credential,
    error: connectionError,
  } = useConnection(hostId)
  const { drafts } = useApp()
  const { colors: c, styles: s } = useTheme()
  const draftKey = `${hostId}:${id}`
  const [initialTask] = useState(() => peekPendingTask(hostId, id))
  const handoff = useRef({
    task: initialTask,
    phase: 'initial' as 'initial' | 'config' | 'done' | 'failed',
  })
  const [draft, setDraft] = useState(
    initialTask?.content ?? drafts.get(draftKey) ?? ''
  )
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(
    initialTask?.attachments ?? []
  )
  const [team, setTeam] = useState(false)
  const [state, setState] = useState<ChatState>(() => createChatState(id))
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState('')
  const [recoveryError, setRecoveryError] = useState('')
  const [notice, setNotice] = useState('')
  const [panel, setPanel] = useState<Panel>(null)
  const [title, setTitle] = useState('')
  const [working, setWorking] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [selected, setSelected] = useState<ChatItem | null>(null)
  const [editText, setEditText] = useState('')
  const [rewindPreview, setRewindPreview] = useState<RewindPreview | null>(null)
  const [revision, setRevision] = useState(0)
  const transport = useRef<SessionTransport | null>(null)
  const list = useRef<FlatList>(null)
  const follow = useRef(true)
  const notificationSeen = useRef(new Set<string>())
  const mounted = useRef(true)
  const [hasOlder, setHasOlder] = useState(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!client || !credential) return
    let alive = true
    const recovery = new ChatRecovery({
      loadSummary: (signal) =>
        client.get<Session>(`/api/sessions/${encodeURIComponent(id)}/summary`, {
          signal,
        }),
      onSummary: (value) => {
        if (alive) {
          setSession(value)
          setTitle(value.title)
        }
      },
      onConnectionError: (message) => {
        if (alive) setRecoveryError(message)
      },
      onBusinessError: (value) => {
        if (alive) setError(value.message)
      },
    })
    const channel = new SessionTransport({
      client,
      credential,
      sessionId: id,
      platform: Platform.OS === 'web' ? 'web' : 'native',
      socketFactory: (options) =>
        Platform.OS === 'web'
          ? (new WebSocket(options.url) as unknown as SocketLike)
          : new NativeSocket(options.url, undefined, {
              headers: options.headers,
            }),
      onState: (value) => {
        if (alive) {
          setState(value)
          setHasOlder(Boolean(channel.historyPage?.page?.nextCursor))
        }
      },
      onConnection: (value) => {
        if (alive) {
          setConnection(value)
          recovery.onConnection(value)
          if (
            value !== 'ready' &&
            value !== 'syncing' &&
            handoff.current.phase === 'config'
          )
            handoff.current.phase = 'failed'
        }
      },
      onError: (value) => {
        if (alive) {
          handoff.current.phase = 'failed'
          recovery.onTransportError(value)
        }
      },
    })
    transport.current = channel
    recovery.start()
    channel.start()
    const listener = AppState.addEventListener('change', (value) => {
      if (value === 'active') channel.reconnect()
    })
    return () => {
      alive = false
      recovery.dispose()
      listener.remove()
      channel.dispose()
      if (transport.current === channel) transport.current = null
    }
  }, [client, credential, id, revision])
  const ready = connection === 'ready'
  const busy =
    state.turnActive ||
    state.permissions.length > 0 ||
    state.computerUsePermissions.length > 0 ||
    state.items.some((item) => item.type === 'user' && item.pending)
  const workspaceMissing =
    session?.workspaceState === 'missing' ||
    session?.workspaceState === 'worktree_removed' ||
    session?.workDirExists === false
  const approval = state.permissions[0]
  const runtime =
    state.runtime ??
    (session?.runtimeModelId
      ? {
          providerId: session.runtimeProviderId ?? null,
          modelId: session.runtimeModelId,
          effortLevel: session.effortLevel,
        }
      : undefined)
  const deliverPendingTask = useEffectEvent(() => {
    const value = handoff.current
    if (
      !value.task ||
      value.phase === 'done' ||
      value.phase === 'failed' ||
      !ready ||
      !session ||
      state.configPending
    )
      return
    if (busy || workspaceMissing) {
      value.phase = 'failed'
      setNotice('首条任务保留在输入框，确认会话状态后再发送。')
      return
    }
    try {
      const desired = value.task.runtime
      if (desired && !runtimeMatches(state.runtime, desired)) {
        if (value.phase === 'config') {
          value.phase = 'failed'
          setError('电脑未应用所选模型，首条任务保留在输入框。')
          return
        }
        value.phase = 'config'
        if (
          !transport.current?.send({ type: 'set_runtime_config', ...desired })
        ) {
          value.phase = 'failed'
          setError('模型尚未准备好，首条任务保留在输入框。')
        }
        return
      }
      const message = buildComposerMessage(
        value.task.content,
        value.task.attachments,
        false
      )
      validateMessageSize(message, host?.auth ?? 'lan')
      value.phase = 'done'
      if (transport.current?.send(message)) {
        clearPendingTask(hostId, id)
        setDraft('')
        setAttachments([])
        drafts.delete(draftKey)
      } else {
        value.phase = 'failed'
        setError('首条任务未发出，请确认连接后手动发送。')
      }
    } catch (e) {
      value.phase = 'failed'
      setError(errorText(e))
    }
  })
  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) deliverPendingTask()
    })
    return () => {
      active = false
    }
  }, [
    ready,
    session,
    busy,
    workspaceMissing,
    state.configPending,
    state.runtime,
  ])
  const respondToNotification = useEffectEvent(() => {
    if (!ready || !notificationAction || !notificationRequestId) return
    const key = `${notificationRequestId}:${notificationAction}`
    if (notificationSeen.current.has(key)) return
    notificationSeen.current.add(key)
    const response = notificationPermissionResponse(
      state,
      notificationAction,
      notificationRequestId
    )
    if (!response) {
      setNotice('这条审批已处理或需要在会话里作答，请核对当前状态。')
      return
    }
    if (transport.current?.send(response))
      setNotice(
        notificationAction === 'allow'
          ? '已提交这一次允许，等待电脑确认。'
          : '已提交这一次拒绝，等待电脑确认。'
      )
    else setError('通知操作未发出，请在当前审批面板重试。')
  })
  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) respondToNotification()
    })
    return () => {
      active = false
    }
  }, [ready, notificationAction, notificationRequestId, state])
  function send(message: ClientMessage) {
    setError('')
    try {
      const sent = transport.current?.send(message) ?? false
      if (!sent)
        setError('操作尚未发出。请等待会话同步完成，或核对当前任务状态。')
      return sent
    } catch (e) {
      setError(errorText(e))
      return false
    }
  }
  function submit() {
    if (busy || workspaceMissing) return
    try {
      const message = buildComposerMessage(draft, attachments, team)
      validateMessageSize(message, host?.auth ?? 'lan')
      if (send(message)) {
        setDraft('')
        setAttachments([])
        setTeam(false)
        drafts.delete(draftKey)
        clearPendingTask(hostId, id)
        handoff.current.phase = 'done'
        follow.current = true
        setNotice('')
      }
    } catch (e) {
      setError(errorText(e))
    }
  }
  async function rename() {
    const nextTitle = title.trim()
    if (!client || !nextTitle || working) return
    setWorking(true)
    try {
      await client.request(`/api/sessions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { title: nextTitle },
      })
      if (!mounted.current) return
      transport.current?.confirmTitle(nextTitle)
      setSession((value) => (value ? { ...value, title: nextTitle } : null))
      setPanel(null)
    } catch (e) {
      if (mounted.current) setError(errorText(e))
    } finally {
      if (mounted.current) setWorking(false)
    }
  }
  async function fork() {
    const targetMessageId = selected && persistedMessageId(selected)
    if (!client || !targetMessageId || working) return
    setWorking(true)
    try {
      const result = await client.post<{ sessionId: string }>(
        `/api/sessions/${encodeURIComponent(id)}/branch`,
        { targetMessageId }
      )
      if (mounted.current) {
        setPanel(null)
        router.push({
          pathname: '/chat/[id]',
          params: { id: result.sessionId, host: hostId },
        })
      }
    } catch (e) {
      if (mounted.current) setError(errorText(e))
    } finally {
      if (mounted.current) setWorking(false)
    }
  }
  async function previewEdit() {
    const targetUserMessageId = selected && persistedMessageId(selected)
    if (!client || !targetUserMessageId || busy || working) return
    setWorking(true)
    try {
      const preview = await client.post<RewindPreview>(
        `/api/sessions/${encodeURIComponent(id)}/rewind`,
        { targetUserMessageId, dryRun: true, mode: 'conversation' }
      )
      if (mounted.current) {
        setRewindPreview(preview)
        setEditText(
          visibleMessageText(selected!.editableText ?? selected!.text)
        )
        setPanel('edit')
      }
    } catch (e) {
      if (mounted.current) setError(errorText(e))
    } finally {
      if (mounted.current) setWorking(false)
    }
  }
  async function resendEdit() {
    if (!client || !rewindPreview || !editText.trim() || busy || working) return
    setWorking(true)
    try {
      await client.post(`/api/sessions/${encodeURIComponent(id)}/rewind`, {
        targetUserMessageId: rewindPreview.target.targetUserMessageId,
        mode: 'conversation',
      })
      if (!mounted.current) return
      // A new controller must hydrate the truncated transcript before this intentional resend.
      handoff.current = {
        task: { content: editText.trim(), attachments: [] },
        phase: 'initial',
      }
      setDraft(editText.trim())
      setAttachments([])
      drafts.set(draftKey, editText.trim())
      setPanel(null)
      setState(createChatState(id))
      setConnection('connecting')
      setNotice('已回退对话，正在重新同步并发送修改后的消息。')
      setRevision((value) => value + 1)
    } catch (e) {
      if (mounted.current) setError(errorText(e))
    } finally {
      if (mounted.current) setWorking(false)
    }
  }
  return (
    <SafeAreaView style={s.page} edges={['top', 'left', 'right']}>
      <View
        style={[
          s.header,
          {
            paddingTop: 7,
            paddingBottom: 12,
            boxShadow: `0 1px 0 ${c.line}, 0 2px 0 ${c.highlight}`,
          },
        ]}
      >
        <CircleButton
          name="chevron-left"
          label="返回会话列表"
          onPress={() => router.replace('/')}
        />
        <View style={{ flex: 1, gap: 4 }}>
          <Text
            numberOfLines={1}
            style={{ color: c.ink, fontSize: 15, fontWeight: '600' }}
          >
            {state.title || session?.title || '会话'}
          </Text>
          <Text
            numberOfLines={1}
            style={{ color: c.muted, fontFamily: mono, fontSize: 10 }}
          >
            {host?.name} ·{' '}
            {ready
              ? session?.workDir?.split(/[\\/]/).filter(Boolean).at(-1) ||
                '默认目录'
              : labels[connection]}
          </Text>
        </View>
        <CircleButton
          name="more-horizontal"
          label="会话操作"
          onPress={() => setPanel('more')}
        />
      </View>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {approval?.toolName === 'ExitPlanMode' ? (
          <ScrollView
            key={approval.requestId}
            contentContainerStyle={{ padding: 16 }}
          >
            <Notice
              text={
                connectionError || error || state.error?.message || recoveryError
              }
              error
            />
            <PlanPreview request={approval} />
          </ScrollView>
        ) : (
          <FlatList
            ref={list}
            data={state.items}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingTop: 8,
              paddingBottom: 18,
              gap: 14,
              flexGrow: 1,
              width: '100%',
              maxWidth: 800,
              alignSelf: 'center',
            }}
            keyboardShouldPersistTaps="handled"
            onScroll={({ nativeEvent: value }) => {
              follow.current =
                value.contentSize.height -
                  value.contentOffset.y -
                  value.layoutMeasurement.height <
                150
            }}
            scrollEventThrottle={100}
            onContentSizeChange={() => {
              if (follow.current) list.current?.scrollToEnd({ animated: false })
            }}
            ListHeaderComponent={
              <View style={{ gap: 9 }}>
                <Notice
                  text={
                    connectionError || error || state.error?.message || recoveryError
                  }
                  error
                />
                <Notice text={notice} />
                {state.configPending && (
                  <Notice text="正在等待电脑确认运行配置…" />
                )}
                {workspaceMissing && (
                  <Notice
                    text="这段会话的工作目录已不可用。请在电脑上恢复目录后继续。"
                    error
                  />
                )}
                {hasOlder && (
                  <Button
                    title="加载更早的消息"
                    secondary
                    onPress={() => {
                      follow.current = false
                      transport.current
                        ?.loadOlder()
                        .catch((e) => setError(errorText(e)))
                    }}
                  />
                )}
                {!ready && (
                  <Button
                    title={`${labels[connection]} · 重试`}
                    secondary
                    onPress={() => transport.current?.reconnect()}
                  />
                )}
              </View>
            }
            ListEmptyComponent={
              <Empty
                title="从这里开始。"
                detail={`你的任务会在 ${host?.name ?? '电脑'} 上执行。选择模型和权限，然后告诉我你想做什么。`}
              />
            }
            renderItem={({ item }) => (
              <Message
                item={item}
                onLongPress={(value) => {
                  setSelected(value)
                  setPanel('message')
                }}
              />
            )}
            ListFooterComponent={
              <View style={{ gap: 14 }}>
                {state.computerUsePermissions.map((request) => (
                  <Raised
                    style={{ padding: 16, gap: 12 }}
                    key={request.requestId}
                  >
                    <Text style={s.text}>Computer Use 需要电脑端确认</Text>
                    <Text style={s.small}>
                      {request.request.reason}{' '}
                      请在电脑设置中完成全局启用和系统权限授权。
                    </Text>
                    <Button
                      title="刷新授权状态"
                      secondary
                      onPress={() => transport.current?.reconnect()}
                    />
                    <Button
                      title="拒绝本次请求"
                      secondary
                      disabled={!ready}
                      onPress={() =>
                        send({
                          type: 'computer_use_permission_response',
                          requestId: request.requestId,
                          response: {
                            granted: [],
                            denied: request.request.apps.map((app) => ({
                              bundleId:
                                app.resolved?.bundleId ?? app.requestedName,
                              reason: 'user_denied',
                            })),
                            flags: {
                              clipboardRead: false,
                              clipboardWrite: false,
                              systemKeyCombos: false,
                            },
                            userConsented: false,
                          },
                        })
                      }
                    />
                  </Raised>
                ))}
                {state.turnActive && !approval && (
                  <View style={[s.row, { gap: 7 }]}>
                    <View
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: c.accent,
                      }}
                    />
                    <Text style={[s.small, { color: c.accent }]}>
                      {state.status === 'compacting'
                        ? '正在整理上下文…'
                        : state.status === 'tool_executing'
                          ? '正在执行工具…'
                          : '正在处理…'}
                    </Text>
                  </View>
                )}
                {state.backgroundTaskIds.length > 0 && (
                  <Raised style={{ padding: 14 }}>
                    <Row
                      title="后台活动"
                      detail={`${state.backgroundTaskIds.length} 项在跑`}
                      onPress={() =>
                        router.push({
                          pathname: '/activity',
                          params: { id, host: hostId },
                        })
                      }
                    />
                    {state.backgroundTaskIds.map((taskId) => (
                      <Row
                        key={taskId}
                        title={taskId}
                        trailing={
                          <Button
                            title="停止"
                            secondary
                            disabled={!ready}
                            onPress={() =>
                              send({ type: 'stop_background_task', taskId })
                            }
                          />
                        }
                      />
                    ))}
                  </Raised>
                )}
                {state.items.length > 0 &&
                  approval?.toolName !== 'ExitPlanMode' && (
                    <SessionChangesCard
                      client={client}
                      sessionId={id}
                      revision={`${connection}:${state.turnActive}:${approval?.requestId ?? ''}`}
                      onOpen={() =>
                        router.push({
                          pathname: '/changes',
                          params: { id, host: hostId },
                        })
                      }
                    />
                  )}
                {state.items.length > 0 &&
                  approval?.toolName !== 'ExitPlanMode' && (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        router.push({
                          pathname: '/workspace',
                          params: { id, host: hostId },
                        })
                      }
                    >
                      <Raised
                        style={{
                          padding: 14,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 10,
                        }}
                      >
                        <Icon name="folder" size={16} />
                        <View style={{ flex: 1 }}>
                          <Text style={[s.text, { fontSize: 13 }]}>
                            工作区与文件
                          </Text>
                          <Text style={[s.small, { fontSize: 10 }]}>
                            查看电脑上的最新文件和变更
                          </Text>
                        </View>
                        <Icon name="chevron-right" size={14} />
                      </Raised>
                    </Pressable>
                  )}
              </View>
            }
          />
        )}
        {approval ? (
          <Approval
            key={approval.requestId}
            request={approval}
            client={client}
            runtime={runtime}
            ready={ready}
            send={send}
            serverError={state.error}
          />
        ) : (
          <ChatComposer
            client={client}
            sessionId={id}
            draft={draft}
            onDraft={(value) => {
              setDraft(value)
              drafts.set(draftKey, value)
            }}
            attachments={attachments}
            onAttachments={setAttachments}
            team={team}
            onTeam={setTeam}
            lean={session?.agentProfile === 'lean'}
            model={runtime?.modelId ?? '选择模型'}
            mode={modeName(state.permissionMode ?? session?.permissionMode)}
            disabled={
              !ready || state.configPending || workspaceMissing || working
            }
            busy={busy}
            onSend={submit}
            onStop={() => setPanel('stop')}
            onModel={() => setPanel('model')}
            onMode={() => setPanel('mode')}
            onError={setError}
          />
        )}
      </KeyboardAvoidingView>
      <Modal
        visible={panel !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          if (!working) setPanel(null)
        }}
      >
        <SafeAreaView style={s.page}>
          <PageHeader
            title={
              panel === 'model'
                ? '这段会话的模型'
                : panel === 'mode'
                  ? '权限模式'
                  : panel === 'stop'
                    ? '停止任务'
                    : panel === 'message'
                      ? '消息操作'
                      : panel === 'edit'
                        ? '编辑并重新发送'
                        : '会话操作'
            }
            subtitle="cc-haha"
            back={false}
            right={
              <CircleButton
                name="x"
                label="关闭面板"
                onPress={() => {
                  if (!working) setPanel(null)
                }}
              />
            }
          />
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={s.body}
          >
            <Notice text={error} error />
            {panel === 'model' && client && (
              <>
                {state.backgroundTaskIds.length > 0 && (
                  <Notice text="更改模型或思考强度会重启执行环境，当前后台任务也会停止。" />
                )}
                <RuntimePicker
                  client={client}
                  initial={runtime}
                  busy={busy || state.configPending || !ready}
                  onApply={(value) => {
                    if (send({ type: 'set_runtime_config', ...value }))
                      setPanel(null)
                  }}
                />
              </>
            )}
            {panel === 'mode' &&
              modes
                .filter(
                  (item) =>
                    session?.agentProfile !== 'lean' || item.id !== 'plan'
                )
                .map((item) => (
                  <Row
                    key={item.id}
                    title={item.title}
                    detail={item.description}
                    onPress={
                      busy || state.configPending || !ready
                        ? undefined
                        : () => {
                            if (
                              send({
                                type: 'set_permission_mode',
                                mode: item.id,
                              })
                            )
                              setPanel(null)
                          }
                    }
                  />
                ))}
            {panel === 'stop' && (
              <>
                <Text style={s.text}>停止这段会话的当前生成和后台任务？</Text>
                <Text style={s.small}>已完成的文件修改会保留。</Text>
                <PrimaryButton
                  title="停止会话任务"
                  danger
                  disabled={!ready}
                  onPress={() => {
                    if (send({ type: 'stop_generation' })) setPanel(null)
                  }}
                />
              </>
            )}
            {panel === 'message' && selected && (
              <>
                <Text numberOfLines={5} style={s.small}>
                  {visibleMessageText(selected.text) || '附件消息'}
                </Text>
                <Row
                  icon="copy"
                  title="复制"
                  onPress={() => {
                    void Clipboard.setStringAsync(
                      visibleMessageText(selected.text)
                    )
                      .then((ok) => {
                        if (!ok)
                          throw new Error('系统未允许复制，请长按文本选择。')
                        setNotice('已复制消息。')
                        setPanel(null)
                      })
                      .catch((e) => setError(errorText(e)))
                  }}
                />
                <Row
                  icon="git-branch"
                  title="从这里分叉会话"
                  detail={
                    session?.agentProfile === 'lean'
                      ? 'Lean 会话不支持分叉'
                      : !persistedMessageId(selected)
                        ? '等待电脑保存这条消息后可用'
                        : '保留到这条消息，开启一段新会话'
                  }
                  onPress={
                    session?.agentProfile === 'lean' ||
                    !persistedMessageId(selected) ||
                    working
                      ? undefined
                      : () => void fork()
                  }
                />
                {selected.type === 'user' && (
                  <Row
                    icon="edit-3"
                    title="编辑并重新发送"
                    detail={
                      busy
                        ? '请先等待当前任务完成'
                        : selected.editableText === undefined
                          ? '带材料的消息请复制文字后重新添加材料'
                          : '回退到这条消息后重新发送，文件修改会保留'
                    }
                    onPress={
                      busy ||
                      working ||
                      !persistedMessageId(selected) ||
                      selected.editableText === undefined
                        ? undefined
                        : () => void previewEdit()
                    }
                  />
                )}
                {working && <Notice text="正在处理…" />}
              </>
            )}
            {panel === 'edit' && rewindPreview && (
              <>
                <Notice
                  text={`将回退这条消息及之后的 ${rewindPreview.conversation.messagesRemoved} 条对话记录。电脑文件保持当前内容。`}
                />
                <Field
                  label="修改后的消息"
                  value={editText}
                  onChangeText={setEditText}
                  multiline
                  editable={!working}
                />
                <PrimaryButton
                  title="确认回退并重新发送"
                  busy={working}
                  disabled={busy || !editText.trim()}
                  onPress={() => void resendEdit()}
                />
              </>
            )}
            {panel === 'more' && (
              <>
                <Text style={s.small}>
                  {host?.name} · {session?.workDir || '默认目录'}
                </Text>
                <Field
                  label="会话名称"
                  value={title}
                  onChangeText={setTitle}
                  editable={!working}
                />
                <PrimaryButton
                  title="保存名称"
                  busy={working}
                  onPress={() => void rename()}
                />
                <Row
                  icon="git-commit"
                  title="本轮改动与回退"
                  onPress={() => {
                    setPanel(null)
                    router.push({
                      pathname: '/changes',
                      params: { id, host: hostId },
                    })
                  }}
                />
                <Row
                  icon="activity"
                  title="后台活动"
                  onPress={() => {
                    setPanel(null)
                    router.push({
                      pathname: '/activity',
                      params: { id, host: hostId },
                    })
                  }}
                />
                <Row
                  icon="folder"
                  title="工作区与文件"
                  onPress={() => {
                    setPanel(null)
                    router.push({
                      pathname: '/workspace',
                      params: { id, host: hostId },
                    })
                  }}
                />
                <Row
                  icon="refresh-cw"
                  title="重新同步会话"
                  onPress={() => {
                    transport.current?.reconnect()
                    setPanel(null)
                  }}
                />
                <Button
                  title={deleteConfirm ? '确认从电脑删除会话' : '删除会话'}
                  danger
                  busy={working}
                  onPress={async () => {
                    if (!client || working) return
                    if (!deleteConfirm) {
                      setDeleteConfirm(true)
                      return
                    }
                    setWorking(true)
                    try {
                      await client.delete(
                        `/api/sessions/${encodeURIComponent(id)}`
                      )
                      if (mounted.current) {
                        setPanel(null)
                        router.replace('/')
                      }
                    } catch (e) {
                      if (mounted.current) setError(errorText(e))
                    } finally {
                      if (mounted.current) setWorking(false)
                    }
                  }}
                />
                {deleteConfirm && (
                  <Notice text="这会删除电脑上保存的这段会话，并停止它的任务。" />
                )}
              </>
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  )
}
