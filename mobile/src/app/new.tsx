import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentRef,
} from 'react'
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native'
import { Text } from '../ui/Text'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useApp, useConnection } from '../state/AppContext'
import type { PermissionMode, RuntimeConfig } from '../core/types'
import { FocusedRequests } from '../core/focusedRequests'
import {
  newTaskRepository,
  type RecentProject,
  type RepositoryContext,
} from '../core/newTask'
import { putPendingTask } from '../core/pendingTask'
import {
  buildComposerMessage,
  validateMessageSize,
  type ComposerAttachment,
} from '../core/chatComposer'
import {
  runtimeProviderIdentity,
  runtimeSelection,
  type Model,
} from '../core/runtimeCatalog'
import { modes } from '../ui/modes'
import { RuntimePicker } from '../ui/RuntimePicker'
import { pickChatMaterial } from '../ui/chatMaterials'
import {
  CircleButton,
  Divider,
  Field,
  Icon,
  Inset,
  Notice,
  PrimaryButton,
  Raised,
  Row,
  Toggle,
  errorText,
  mono,
  useTheme,
} from '../ui/theme'

const permissionLabel = (mode: PermissionMode) =>
  mode === 'default'
    ? '逐项确认'
    : (modes.find((item) => item.id === mode)?.title ?? mode)
const effortLabel = (effort?: string) =>
  effort
    ? ({
        low: '低',
        medium: '中',
        high: '高',
        xhigh: '超高',
        max: '最高',
        minimal: '最低',
        none: '关闭',
      }[effort] ?? effort)
    : '默认'
export default function NewSession() {
  const { host: hostId } = useLocalSearchParams<{ host: string }>()
  const { registry } = useApp()
  const id = hostId || registry.selectedId || ''
  return <NewTask key={id} hostId={id} />
}
function NewTask({ hostId }: { hostId: string }) {
  const { host, client, error: connectionError } = useConnection(hostId)
  const { drafts } = useApp()
  const { colors, styles, dark } = useTheme()
  const insets = useSafeAreaInsets()
  const draftKey = `${hostId}:new`
  const [content, setContent] = useState(drafts.get(draftKey) ?? '')
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [path, setPath] = useState('')
  const [customPath, setCustomPath] = useState('')
  const [projects, setProjects] = useState<RecentProject[]>([])
  const [profile, setProfile] = useState<'standard' | 'lean'>('standard')
  const [mode, setMode] = useState<PermissionMode>('default')
  const [runtime, setRuntime] = useState<RuntimeConfig>()
  const [worktree, setWorktree] = useState(false)
  const [repo, setRepo] = useState<RepositoryContext | null>(null)
  const [branch, setBranch] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [materialBusy, setMaterialBusy] = useState(false)
  const [panel, setPanel] = useState<
    'project' | 'branch' | 'runtime' | 'materials' | null
  >(null)
  const [creation] = useState(() => new FocusedRequests())
  const composer = useRef<ComponentRef<typeof TextInput>>(null)
  const touchedPath = useRef(false)
  const touchedRuntime = useRef(false)
  const touchedMode = useRef(false)
  useFocusEffect(
    useCallback(() => {
      creation.focus()
      setBusy(false)
      return () => creation.blur()
    }, [creation])
  )
  useEffect(() => {
    if (!client) return
    const controller = new AbortController()
    client
      .get<{ projects: RecentProject[] }>(
        '/api/sessions/recent-projects?limit=10',
        { signal: controller.signal }
      )
      .then((data) => {
        if (!controller.signal.aborted) {
          setProjects(data.projects)
          if (!touchedPath.current && data.projects[0])
            setPath(data.projects[0].realPath)
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e))
      })
    Promise.all([
      client.get<{ activeId: string | null }>('/api/providers', {
        signal: controller.signal,
      }),
      client.get<{ model: { id: string } }>('/api/models/current', {
        signal: controller.signal,
      }),
      client.get<{ level: string }>('/api/effort', {
        signal: controller.signal,
      }),
      client.get<{ models: Model[] }>('/api/models', {
        signal: controller.signal,
      }),
    ])
      .then(([provider, model, effort, catalog]) => {
        if (!controller.signal.aborted && !touchedRuntime.current)
          setRuntime(
            runtimeSelection(
              runtimeProviderIdentity(provider.activeId),
              catalog.models.find((value) => value.id === model.model.id) ?? {
                id: model.model.id,
                name: model.model.id,
              },
              effort.level,
              false
            )
          )
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e))
      })
    client
      .get<{ mode: PermissionMode }>('/api/permissions/mode', {
        signal: controller.signal,
      })
      .then((value) => {
        if (!controller.signal.aborted && !touchedMode.current)
          setMode(value.mode)
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e))
      })
    return () => controller.abort()
  }, [client])
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      if (path.trim() && client)
        client
          .get<RepositoryContext>(
            `/api/sessions/repository-context?workDir=${encodeURIComponent(path.trim())}`,
            { signal: controller.signal }
          )
          .then((value) => {
            if (!controller.signal.aborted) setRepo(value)
          })
          .catch((e) => {
            if (!controller.signal.aborted)
              setRepo({
                state: 'error',
                currentBranch: null,
                branches: [],
                error: errorText(e),
              })
          })
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [client, path])
  function changePath(value: string) {
    touchedPath.current = true
    setPath(value)
    setRepo(null)
    setBranch(null)
    setWorktree(false)
  }
  function changeMode(value: PermissionMode) {
    touchedMode.current = true
    setMode(value)
  }
  async function material(kind: 'camera' | 'photos' | 'file') {
    if (materialBusy || busy) return
    setMaterialBusy(true)
    setError('')
    try {
      const result = await pickChatMaterial(kind)
      if (!result.length) return
      const next = [...attachments, ...result]
      validateMessageSize(
        buildComposerMessage(content, next, false),
        host?.auth ?? 'lan'
      )
      setAttachments(next)
      setPanel(null)
    } catch (e) {
      setError(errorText(e))
      setPanel(null)
    } finally {
      setMaterialBusy(false)
    }
  }
  async function create() {
    if (
      !client ||
      busy ||
      materialBusy ||
      (!content.trim() && !attachments.length)
    )
      return
    const request = creation.begin()
    if (!request) return
    setBusy(true)
    setError('')
    try {
      validateMessageSize(
        buildComposerMessage(content, attachments, false),
        client.host.auth
      )
      // Refresh at submission: a checkout may have changed while this draft was open.
      const context = path.trim()
        ? await client.get<RepositoryContext>(
            `/api/sessions/repository-context?workDir=${encodeURIComponent(path.trim())}`
          )
        : null
      if (!request.isCurrent()) return
      const repository = newTaskRepository(context, branch, worktree)
      const result = await client.createSession({
        workDir: path.trim() || undefined,
        ...(profile === 'lean' ? { agentProfile: profile } : {}),
        permissionMode: mode,
        ...(repository ? { repository } : {}),
      })
      if (!request.isCurrent()) return
      putPendingTask(client.host.id, result.sessionId, {
        content: content.trim(),
        attachments,
        runtime,
      })
      drafts.delete(draftKey)
      router.replace({
        pathname: '/chat/[id]',
        params: { id: result.sessionId, host: client.host.id },
      })
    } catch (e) {
      if (request.isCurrent()) setError(errorText(e))
    } finally {
      if (request.isCurrent()) setBusy(false)
    }
  }
  const projectRows =
    projects.some((project) => project.realPath === path) || !path
      ? projects
      : [
          {
            realPath: path,
            projectName: path.split('/').filter(Boolean).at(-1) || path,
          },
          ...projects,
        ]
  const branchLabel =
    branch ||
    repo?.currentBranch ||
    (repo?.state === 'ok'
      ? '当前工作树'
      : path && !repo
        ? '读取中…'
        : '无 Git 分支')
  const dismiss = () =>
    router.canGoBack() ? router.back() : router.replace('/')
  return (
    <View style={{ flex: 1, backgroundColor: dark ? '#0D0D0C' : '#6F6C66' }}>
      <View
        style={{
          position: 'absolute',
          top: Math.max(insets.top, 48),
          left: 16,
          right: 16,
          height: 40,
          borderTopLeftRadius: 22,
          borderTopRightRadius: 22,
          backgroundColor: dark ? '#3B3832' : '#B9B6AF',
        }}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{
          flex: 1,
          marginTop: Math.max(insets.top + 10, 58),
          backgroundColor: colors.paper,
          borderTopLeftRadius: 26,
          borderTopRightRadius: 26,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            height: 56,
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 18,
          }}
        >
          <Pressable
            accessibilityRole="button"
            onPress={dismiss}
            style={{ width: 60, paddingVertical: 12 }}
          >
            <Text style={{ color: colors.secondary, fontSize: 15 }}>取消</Text>
          </Pressable>
          <Text
            style={{
              flex: 1,
              textAlign: 'center',
              color: colors.ink,
              fontSize: 16,
              fontWeight: '600',
            }}
          >
            新任务
          </Text>
          <View style={{ width: 60 }} />
        </View>
        <View
          style={{
            flex: 1,
            paddingHorizontal: 18,
            gap: 16,
            paddingBottom: Math.max(insets.bottom, 18),
          }}
        >
          <View style={{ gap: 8 }}>
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <Text style={styles.label}>项目</Text>
              <Pressable
                disabled={busy}
                accessibilityRole="button"
                onPress={() => {
                  setCustomPath(path)
                  setPanel('project')
                }}
              >
                <Text
                  numberOfLines={1}
                  style={{ fontSize: 11, color: colors.muted, maxWidth: 200 }}
                >
                  {host?.name ?? '未连接电脑'} · 更换目录
                </Text>
              </Pressable>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 10, paddingBottom: 3 }}
            >
              {projectRows.map((project) => (
                <Pressable
                  key={project.realPath}
                  disabled={busy}
                  accessibilityRole="radio"
                  accessibilityState={{
                    checked: path === project.realPath,
                    disabled: busy,
                  }}
                  onPress={() => changePath(project.realPath)}
                >
                  <Raised
                    style={{
                      width: 156,
                      padding: 12,
                      gap: 8,
                      borderRadius: 16,
                      borderWidth: path === project.realPath ? 1.5 : 0,
                      borderColor: '#C1603F',
                      minHeight: 90,
                    }}
                  >
                    <View
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <View
                        style={{
                          width: 22,
                          height: 22,
                          borderWidth: 5,
                          borderColor:
                            path === project.realPath
                              ? colors.accent
                              : colors.line,
                          borderRadius: 11,
                        }}
                      />
                      {path === project.realPath && (
                        <View
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: 4,
                            backgroundColor: colors.accent,
                          }}
                        />
                      )}
                    </View>
                    <Text
                      numberOfLines={1}
                      style={{
                        fontSize: 14,
                        fontWeight: '600',
                        color: colors.ink,
                      }}
                    >
                      {project.projectName}
                    </Text>
                    <Text
                      numberOfLines={1}
                      ellipsizeMode="middle"
                      style={{
                        color: colors.muted,
                        fontSize: 10,
                        fontFamily: mono,
                      }}
                    >
                      {project.realPath}
                    </Text>
                  </Raised>
                </Pressable>
              ))}
              <Pressable
                disabled={busy}
                accessibilityRole="button"
                onPress={() => {
                  setCustomPath(path)
                  setPanel('project')
                }}
              >
                <Raised
                  style={{
                    width: projectRows.length ? 84 : 180,
                    minHeight: 104,
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 9,
                    borderRadius: 16,
                  }}
                >
                  <Icon
                    name={projectRows.length ? 'plus' : 'folder'}
                    color={colors.muted}
                  />
                  <Text style={{ color: colors.muted, fontSize: 12 }}>
                    {projectRows.length
                      ? '其他目录'
                      : path || '选择电脑上的目录'}
                  </Text>
                </Raised>
              </Pressable>
            </ScrollView>
          </View>
          <Raised style={{ borderRadius: 16 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="选择起始分支"
              disabled={busy || repo?.state !== 'ok'}
              onPress={() => setPanel('branch')}
              style={{
                height: 50,
                paddingHorizontal: 14,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Icon name="git-branch" size={17} />
              <Text style={{ flex: 1, color: colors.ink, fontSize: 14 }}>
                分支
              </Text>
              <Text
                numberOfLines={1}
                style={{
                  maxWidth: '56%',
                  color: colors.secondary,
                  fontFamily: mono,
                  fontSize: 12,
                }}
              >
                {branchLabel}
              </Text>
              <Icon name="chevron-right" size={14} />
            </Pressable>
            <Divider inset={14} />
            <View
              style={{
                paddingVertical: 11,
                paddingHorizontal: 14,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={{ color: colors.ink, fontSize: 14 }}>
                  在独立工作树里做
                </Text>
                <Text style={{ color: colors.muted, fontSize: 11 }}>
                  {repo?.state === 'not_git_repo'
                    ? '当前目录不是 Git 项目'
                    : '不碰你电脑上正在改的代码'}
                </Text>
              </View>
              <Toggle
                label="在独立工作树里做"
                value={worktree}
                onChange={setWorktree}
                disabled={busy || repo?.state !== 'ok'}
              />
            </View>
          </Raised>
          <Inset
            style={{ flex: 1, minHeight: 130, borderRadius: 18, padding: 14 }}
          >
            <TextInput
              ref={composer}
              accessibilityLabel="新任务内容"
              value={content}
              onChangeText={(value) => {
                setContent(value)
                drafts.set(draftKey, value)
              }}
              placeholder="想让电脑帮你做什么？"
              placeholderTextColor={colors.muted}
              multiline
              editable={!busy}
              textAlignVertical="top"
              style={{
                fontFamily: 'Geist',
                flex: 1,
                padding: 0,
                color: colors.ink,
                fontSize: 16,
                lineHeight: 25,
                minHeight: 56,
              }}
            />
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'flex-end',
                gap: 10,
                paddingTop: 12,
              }}
            >
              <ScrollView
                horizontal
                style={{ flex: 1 }}
                contentContainerStyle={{ gap: 8 }}
                showsHorizontalScrollIndicator={false}
              >
                {attachments.map((item) => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityLabel={`移除附件 ${item.name ?? '材料'}`}
                    disabled={busy}
                    onPress={() =>
                      setAttachments((values) =>
                        values.filter((value) => value.id !== item.id)
                      )
                    }
                    style={{
                      width: 46,
                      height: 46,
                      borderRadius: 8,
                      backgroundColor: colors.surface,
                      justifyContent: 'center',
                      alignItems: 'center',
                      overflow: 'hidden',
                    }}
                  >
                    {item.type === 'image' && item.uri ? (
                      <Image
                        source={{ uri: item.uri }}
                        style={{ width: 46, height: 46 }}
                      />
                    ) : (
                      <Icon name="file-text" size={20} />
                    )}
                    <View
                      style={{
                        position: 'absolute',
                        right: 1,
                        top: 1,
                        backgroundColor: colors.surface,
                        borderRadius: 6,
                      }}
                    >
                      <Icon name="x" size={12} />
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
              <View
                style={{
                  flexDirection: 'row',
                  gap: 8,
                  opacity: busy || materialBusy ? 0.45 : 1,
                }}
              >
                <CircleButton
                  name="camera"
                  label="拍照添加材料"
                  onPress={() => {
                    void material('camera')
                  }}
                />
                <CircleButton
                  name="paperclip"
                  label="添加材料"
                  onPress={() => {
                    if (!busy && !materialBusy) setPanel('materials')
                  }}
                />
                <CircleButton
                  name="mic"
                  label="使用键盘听写"
                  onPress={() => {
                    if (busy) return
                    composer.current?.focus()
                    Alert.alert(
                      '使用键盘听写',
                      '点击系统键盘上的麦克风，说出你的任务。文字会填入这里，确认后再开始。'
                    )
                  }}
                />
              </View>
            </View>
          </Inset>
          {(connectionError || error || repo?.state === 'missing_workdir') && (
            <Notice
              text={connectionError || error || '这个目录不存在，请重新选择。'}
              error
            />
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="选择这次任务的模型、思考和权限"
            disabled={busy}
            onPress={() => setPanel('runtime')}
            style={{
              height: 46,
              borderRadius: 14,
              paddingHorizontal: 12,
              backgroundColor: '#22211E',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              boxShadow:
                'inset 0 1px 3px rgba(0,0,0,.6), 0 1px 0 rgba(255,255,255,.3)',
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                color: '#D5D2CB',
                fontFamily: mono,
                fontSize: 11,
                flex: 1,
              }}
            >
              {runtime?.modelId ?? '电脑默认模型'} · 思考{' '}
              {effortLabel(runtime?.effortLevel)} · {permissionLabel(mode)}
              {profile === 'lean' ? ' · Lean' : ''}
            </Text>
            <Icon name="chevron-down" color="#B3ADA3" size={14} />
          </Pressable>
          <PrimaryButton
            title="开始"
            busy={busy}
            disabled={
              !client ||
              materialBusy ||
              (!content.trim() && !attachments.length) ||
              repo?.state === 'missing_workdir'
            }
            onPress={() => {
              void create()
            }}
          />
        </View>
      </KeyboardAvoidingView>
      <Modal
        visible={panel !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setPanel(null)}
      >
        <SafeAreaView
          style={styles.page}
          edges={['top', 'left', 'right', 'bottom']}
        >
          <View
            style={{
              padding: 18,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Text
              style={{ color: colors.ink, fontSize: 18, fontWeight: '600' }}
            >
              {panel === 'project'
                ? '选择项目目录'
                : panel === 'branch'
                  ? '选择分支'
                  : panel === 'materials'
                    ? '添加材料'
                    : '这次任务的运行设置'}
            </Text>
            <CircleButton
              name="x"
              label="关闭面板"
              onPress={() => setPanel(null)}
            />
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: 20, gap: 20 }}
          >
            {panel === 'project' && (
              <>
                <Field
                  label="电脑上的目录路径"
                  value={customPath}
                  onChangeText={setCustomPath}
                  placeholder="例如 /Users/you/projects/app"
                />
                <PrimaryButton
                  title="使用这个目录"
                  onPress={() => {
                    changePath(customPath.trim())
                    setPanel(null)
                  }}
                />
                <Row
                  title="使用电脑默认目录"
                  icon="monitor"
                  onPress={() => {
                    changePath('')
                    setPanel(null)
                  }}
                />
                {projects.map((project) => (
                  <Row
                    key={project.realPath}
                    title={project.projectName}
                    detail={project.realPath}
                    icon="folder"
                    onPress={() => {
                      changePath(project.realPath)
                      setPanel(null)
                    }}
                  />
                ))}
              </>
            )}
            {panel === 'branch' && (
              <>
                <Row
                  title="沿用当前工作树"
                  detail={
                    repo?.currentBranch ?? '保持电脑当前的提交，不切换分支'
                  }
                  trailing={
                    !branch ? (
                      <Icon name="check" color={colors.accent} />
                    ) : undefined
                  }
                  onPress={() => {
                    setBranch(null)
                    setPanel(null)
                  }}
                />
                {repo?.branches.map((item) => (
                  <Row
                    key={item.name}
                    title={item.name}
                    detail={
                      item.checkedOut && item.name !== repo.currentBranch
                        ? '已被其他工作树使用，建议启用独立工作树'
                        : item.current
                          ? '当前分支'
                          : undefined
                    }
                    trailing={
                      branch === item.name ? (
                        <Icon name="check" color={colors.accent} />
                      ) : undefined
                    }
                    onPress={() => {
                      setBranch(item.name)
                      setPanel(null)
                    }}
                  />
                ))}
                {repo?.dirty && (
                  <Notice text="项目中有未提交修改。切换分支可能被 Git 阻止，独立工作树会保留当前目录。" />
                )}
              </>
            )}
            {panel === 'materials' && (
              <>
                <Row
                  title="从相册选择"
                  icon="image"
                  onPress={() => {
                    void material('photos')
                  }}
                />
                <Row
                  title="拍照"
                  icon="camera"
                  onPress={() => {
                    void material('camera')
                  }}
                />
                <Row
                  title="选择文件"
                  icon="file-text"
                  onPress={() => {
                    void material('file')
                  }}
                />
                {materialBusy && (
                  <Text style={styles.small}>正在准备材料…</Text>
                )}
              </>
            )}
            {panel === 'runtime' && (
              <>
                <Text style={styles.small}>
                  只用于这次新任务，保留 {host?.name ?? '电脑'} 的默认设置。
                </Text>
                <Raised style={{ paddingHorizontal: 16 }}>
                  <Text style={[styles.label, { paddingTop: 14 }]}>权限</Text>
                  {modes
                    .filter((item) => profile !== 'lean' || item.id !== 'plan')
                    .map((item) => (
                      <Row
                        key={item.id}
                        title={item.id === 'default' ? '逐项确认' : item.title}
                        detail={item.description}
                        trailing={
                          mode === item.id ? (
                            <Icon name="check" color={colors.accent} />
                          ) : undefined
                        }
                        onPress={() => changeMode(item.id)}
                      />
                    ))}
                </Raised>
                <Raised style={{ paddingHorizontal: 16 }}>
                  {(['standard', 'lean'] as const).map((value) => (
                    <Row
                      key={value}
                      title={
                        value === 'standard'
                          ? 'Standard · 完整协作'
                          : 'Lean · 轻量执行'
                      }
                      detail={
                        value === 'lean'
                          ? '精简工具环境，不支持计划模式'
                          : '完整工具、计划与团队能力'
                      }
                      trailing={
                        profile === value ? (
                          <Icon name="check" color={colors.accent} />
                        ) : undefined
                      }
                      onPress={() => {
                        setProfile(value)
                        if (value === 'lean' && mode === 'plan')
                          changeMode('default')
                      }}
                    />
                  ))}
                </Raised>
                {client && (
                  <RuntimePicker
                    client={client}
                    initial={runtime}
                    applyLabel="完成"
                    onApply={(value) => {
                      touchedRuntime.current = true
                      setRuntime(value)
                      setPanel(null)
                    }}
                  />
                )}
              </>
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </View>
  )
}
