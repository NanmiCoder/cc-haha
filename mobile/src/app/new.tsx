import { clearParkedComposer, parkComposer, parkedComposer } from '../ui/chat/queue'
import { ChatComposer } from '../ui/ChatComposer'
import { RunSheet } from '../ui/compose/RunSheet'
import { runCapsule } from '../ui/compose/runLogic'
import { useComputerUse } from '../core/useComputerUse'
import { isComputerUseReference } from '../core/computerUse'
import { WherePage } from '../ui/newtask/WherePage'
import { serializeComposer, type ComposerReference } from '../core/composerReferences'
import { KeyboardViewport } from '../ui/KeyboardViewport'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Platform,
  ScrollView,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { Text } from '../ui/Text'
import { useApp, useConnection } from '../state/AppContext'
import type { PermissionMode, RuntimeConfig } from '../core/types'
import { FocusedRequests } from '../core/focusedRequests'
import {
  newTaskRepository,
  projectChoices,
  targetSummary,
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
  ANTIGRAVITY_DEFAULT_MODEL,
  ANTIGRAVITY_LOGIN_GUIDANCE,
  ANTIGRAVITY_PERMISSION_MODES,
  ANTIGRAVITY_PROVIDER_ID,
  antigravityNeedsDiscovery,
  antigravityStatusLabel,
  defaultAntigravitySelection,
  discoverAntigravity,
  parseAntigravityStatus,
  resolveAntigravityRuntimeAfterDiscover,
  runtimeProviderIdentity,
  runtimeSelection,
  type AntigravityStatus,
  type Model,
} from '../core/runtimeCatalog'
import { Button, Callout, InlineError, Segmented, TextButton, goBack, useColors } from '../ui/kit'
import { errorText } from '../ui/theme'
import { TargetCard } from '../ui/newtask/TargetCard'
import { toggleWorktree } from '../ui/newtask/whereModel'
import { simulatedPhoneChrome } from '../ui/webChrome'

const EXCLUDE_ANTIGRAVITY = [ANTIGRAVITY_PROVIDER_ID] as const

const repositoryUrl = (path: string) =>
  `/api/sessions/repository-context?workDir=${encodeURIComponent(path)}`

export default function NewSession() {
  const { host: hostId, dir } = useLocalSearchParams<{
    host?: string
    dir?: string
  }>()
  const { registry } = useApp()
  const id = hostId || registry.selectedId || ''
  const initialDir = typeof dir === 'string' ? dir.trim() : ''
  return <NewTask key={`${id}\n${initialDir}`} hostId={id} initialDir={initialDir} />
}

function NewTask({ hostId, initialDir }: { hostId: string; initialDir: string }) {
  const { host, client, error: connectionError } = useConnection(hostId)
  const { drafts } = useApp()
  const colors = useColors()
  const draftKey = `${hostId}:new`
  const [content, setContent] = useState(drafts.get(draftKey) ?? '')
  const [parked] = useState(() => parkedComposer(draftKey))
  const [references, setReferences] = useState<ComposerReference[]>(parked?.references ?? [])
  const [repoEpoch, setRepoEpoch] = useState(0)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(parked?.attachments ?? [])
  const [path, setPath] = useState(initialDir)
  const [projects, setProjects] = useState<RecentProject[]>([])
  const [profile, setProfile] = useState<'standard' | 'lean'>('standard')
  const [engine, setEngine] = useState<'cc-haha' | 'antigravity'>('cc-haha')
  const engineRef = useRef<'cc-haha' | 'antigravity'>('cc-haha')
  const [antigravity, setAntigravity] = useState<AntigravityStatus | null>(null)
  const [refreshingAntigravity, setRefreshingAntigravity] = useState(false)
  const [mode, setMode] = useState<PermissionMode>('default')
  const [runtime, setRuntime] = useState<{ config: RuntimeConfig; name: string }>()
  const standardRuntime = useRef<{ config: RuntimeConfig; name: string } | undefined>(undefined)
  const antigravityRuntime = useRef<{ config: RuntimeConfig; name: string } | undefined>(undefined)
  const [team, setTeam] = useState(parked?.team ?? false)
  const [worktree, setWorktree] = useState(false)
  const [repo, setRepo] = useState<RepositoryContext | null>(null)
  const [branch, setBranch] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [whereOpen, setWhereOpen] = useState(false)
  const [runOpen, setRunOpen] = useState(false)
  const computer = useComputerUse(client)
  const [creation] = useState(() => new FocusedRequests())
  // A directory passed from the home filter is an explicit choice, like picking one here.
  const submitted = useRef(false)
  const leaving = useRef({ attachments, references, team })
  useEffect(() => { leaving.current = { attachments, references, team } }, [attachments, references, team])
  useEffect(() => {
    clearParkedComposer(draftKey)
    return () => { if (!submitted.current) parkComposer(draftKey, leaving.current) }
  }, [draftKey])
  const touchedPath = useRef(Boolean(initialDir))
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
    const signal = controller.signal
    client
      .get<{ projects: RecentProject[] }>(
        '/api/sessions/recent-projects?limit=10',
        { signal }
      )
      .then((data) => {
        if (signal.aborted) return
        setProjects(data.projects)
        if (!touchedPath.current && data.projects[0])
          setPath(data.projects[0].realPath)
      })
      .catch((e) => {
        if (!signal.aborted) setError(errorText(e))
      })
    Promise.all([
      client.get<{ activeId: string | null; antigravity?: unknown }>('/api/providers', { signal }),
      client.get<{ model: { id: string } }>('/api/models/current', { signal }),
      client.get<{ level: string }>('/api/effort', { signal }),
      client.get<{ models: Model[] }>('/api/models', { signal }),
    ])
      .then(([provider, model, effort, catalog]) => {
        if (signal.aborted) return
        setAntigravity(parseAntigravityStatus(provider.antigravity))
        if (touchedRuntime.current) return
        const current = catalog.models.find(
          (value) => value.id === model.model.id
        ) ?? { id: model.model.id, name: model.model.id }
        const initial = {
          config: runtimeSelection(
            runtimeProviderIdentity(provider.activeId),
            current,
            effort.level,
            false
          ),
          name: current.name,
        }
        standardRuntime.current = initial
        setRuntime(initial)
      })
      .catch((e) => {
        if (!signal.aborted) setError(errorText(e))
      })
    client
      .get<{ mode: PermissionMode }>('/api/permissions/mode', { signal })
      .then((value) => {
        if (!signal.aborted && !touchedMode.current) setMode(value.mode)
      })
      .catch((e) => {
        if (!signal.aborted) setError(errorText(e))
      })
    return () => controller.abort()
  }, [client])
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      if (path.trim() && client)
        client
          .get<RepositoryContext>(repositoryUrl(path.trim()), {
            signal: controller.signal,
          })
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
  }, [client, path, repoEpoch])
  const antigravityInstalled = Boolean(
    antigravity && antigravity.status !== 'not_installed'
  )
  const isAntigravity = engine === 'antigravity' && antigravityInstalled
  const lean = !isAntigravity && profile === 'lean'
  const teamOn = team && !lean
  const effectiveWorktree = !isAntigravity && worktree
  const antigravityBlocked =
    isAntigravity &&
    (antigravity?.status === 'login_required' || antigravity?.status === 'error')
  async function refreshAntigravityStatus() {
    if (!client || refreshingAntigravity) return
    setRefreshingAntigravity(true)
    setError('')
    try {
      const fresh = await discoverAntigravity(client)
      setAntigravity(fresh)
      if (!fresh || fresh.status === 'not_installed') {
        antigravityRuntime.current = undefined
        if (engineRef.current === 'antigravity') {
          engineRef.current = 'cc-haha'
          setEngine('cc-haha')
          if (standardRuntime.current) setRuntime(standardRuntime.current)
        }
        return
      }
      const next = resolveAntigravityRuntimeAfterDiscover(
        antigravityRuntime.current,
        fresh
      )
      antigravityRuntime.current = next
      if (engineRef.current === 'antigravity') setRuntime(next)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setRefreshingAntigravity(false)
    }
  }
  function changeEngine(next: 'cc-haha' | 'antigravity') {
    if (next === engine) return
    setError('')
    engineRef.current = next
    setEngine(next)
    touchedRuntime.current = true
    if (next === 'antigravity') {
      if (runtime && runtime.config.providerId !== ANTIGRAVITY_PROVIDER_ID)
        standardRuntime.current = runtime
      const cached = antigravityRuntime.current
      const chosen =
        cached &&
        (cached.config.modelId !== ANTIGRAVITY_DEFAULT_MODEL ||
          !antigravity?.models.length)
          ? cached
          : defaultAntigravitySelection(antigravity)
      antigravityRuntime.current = chosen
      setRuntime(chosen)
      setReferences((previous) => previous.filter(isComputerUseReference))
      if (worktree) {
        const reset = toggleWorktree(repo, branch, false)
        setBranch(reset.branch)
        setWorktree(false)
      }
      if (!ANTIGRAVITY_PERMISSION_MODES.includes(mode)) changeMode('default')
      if (antigravityNeedsDiscovery(antigravity, { includeError: true }))
        void refreshAntigravityStatus()
      return
    }
    if (runtime?.config.providerId === ANTIGRAVITY_PROVIDER_ID)
      antigravityRuntime.current = runtime
    if (standardRuntime.current) setRuntime(standardRuntime.current)
  }
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
  function changeProfile(value: 'standard' | 'lean') {
    setProfile(value)
    if (value !== 'lean') return
    setTeam(false)
    if (mode === 'plan') changeMode('default')
  }
  function changeContent(value: string) {
    setContent(value)
    drafts.set(draftKey, value)
  }
  async function create() {
    if (
      !client ||
      busy ||
      (!content.trim() && !attachments.length && !references.length)
    )
      return
    if (isAntigravity && antigravity?.status === 'login_required') {
      setError(ANTIGRAVITY_LOGIN_GUIDANCE)
      return
    }
    if (isAntigravity && antigravity?.status === 'error') {
      setError(antigravity.error || 'Antigravity 状态异常，请先刷新状态。')
      return
    }
    const request = creation.begin()
    if (!request) return
    setBusy(true)
    setError('')
    try {
      const message = buildComposerMessage(
        serializeComposer(content, isAntigravity ? [] : references),
        attachments,
        teamOn,
        { antigravity: isAntigravity }
      )
      validateMessageSize(message, client.host.auth)
      // Refresh at submission: a checkout may have changed while this draft was open.
      const context = path.trim()
        ? await client.get<RepositoryContext>(repositoryUrl(path.trim()))
        : null
      if (!request.isCurrent()) return
      const repository = newTaskRepository(context, branch, effectiveWorktree)
      const effectiveMode =
        isAntigravity && !ANTIGRAVITY_PERMISSION_MODES.includes(mode)
          ? 'default'
          : mode
      const result = await client.createSession({
        workDir: path.trim() || undefined,
        ...(isAntigravity
          ? {
              providerId: ANTIGRAVITY_PROVIDER_ID,
              modelId: runtime?.config.modelId || ANTIGRAVITY_DEFAULT_MODEL,
              ...(runtime?.config.effortLevel
                ? { effortLevel: runtime.config.effortLevel }
                : {}),
            }
          : lean
            ? { agentProfile: profile }
            : {}),
        permissionMode: effectiveMode,
        ...(repository ? { repository } : {}),
      })
      if (!request.isCurrent()) return
      // The team block travels inside the content; the chat page sends it unchanged.
      putPendingTask(client.host.id, result.sessionId, {
        content: message.content,
        displayText: content,
        references,
        attachments,
        runtime: runtime?.config,
      })
      submitted.current = true
      clearParkedComposer(draftKey)
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
  const target = targetSummary({ path, projects, repo, branch, worktree: effectiveWorktree })
  const failure =
    connectionError ||
    error ||
    (repo?.state === 'missing_workdir' ? '这个目录不存在，请重新选择。' : '')
  const run = runCapsule({
    mode: isAntigravity && !ANTIGRAVITY_PERMISSION_MODES.includes(mode) ? 'default' : mode,
    model: runtime?.name,
    effort: runtime?.config.effortLevel,
    disabled: busy,
  })
  return (
    <SafeAreaView
      edges={Platform.OS === 'ios' ? ['left', 'right'] : ['top', 'left', 'right']}
      style={[
        { flex: 1, backgroundColor: colors.bg },
        simulatedPhoneChrome && { paddingTop: 47 },
      ]}
    >
      <KeyboardViewport style={{ flex: 1 }}>
        <View
          style={{
            height: 56,
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 8,
          }}
        >
          <View style={{ paddingHorizontal: 10 }}>
            <TextButton title="取消" onPress={goBack} />
          </View>
          <Text
            accessibilityRole="header"
            style={{
              flex: 1,
              textAlign: 'center',
              fontSize: 17,
              lineHeight: 22,
              fontWeight: '600',
              color: colors.ink,
            }}
          >
            新任务
          </Text>
          <View style={{ width: 60 }} />
        </View>
        <ScrollView
          style={{ flex: 1, minHeight: 0 }}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 16, gap: 12, paddingBottom: 12 }}
        >
          <TargetCard
            name={target.name}
            branch={target.branch}
            status={target.status}
            worktree={effectiveWorktree}
            disabled={busy}
            onPress={() => setWhereOpen(true)}
          />
          {antigravityInstalled ? (
            <Segmented<'cc-haha' | 'antigravity'>
              label="运行引擎"
              height={40}
              disabled={busy}
              options={[
                { label: 'cc-haha', value: 'cc-haha' },
                { label: 'Antigravity', value: 'antigravity' },
              ]}
              value={isAntigravity ? 'antigravity' : 'cc-haha'}
              onChange={changeEngine}
            />
          ) : null}
          {isAntigravity && antigravity ? (
            <Callout
              tone={
                antigravity.status === 'error'
                  ? 'error'
                  : antigravity.status === 'login_required'
                    ? 'attention'
                    : 'info'
              }
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Text
                  style={{
                    flex: 1,
                    fontSize: 13,
                    lineHeight: 19,
                    color:
                      antigravity.status === 'error'
                        ? colors.err
                        : antigravity.status === 'login_required'
                          ? colors.attnInk
                          : colors.ink2,
                  }}
                >
                  {antigravity.status === 'login_required'
                    ? ANTIGRAVITY_LOGIN_GUIDANCE
                    : antigravity.status === 'error'
                      ? (antigravity.error || '无法读取 Antigravity 状态，请点击刷新重试。')
                      : antigravity.status === 'unchecked' || refreshingAntigravity
                        ? '正在检测电脑端 Antigravity 状态与可用模型…'
                        : `Antigravity ${antigravityStatusLabel(antigravity)}${antigravity.tier?.name ? ` · ${antigravity.tier.name}` : ''}${antigravity.version ? ` · v${antigravity.version}` : ''}（不支持新开工作树）`}
                </Text>
                <Button
                  title={refreshingAntigravity ? '刷新中' : '刷新'}
                  size="sm"
                  variant="outline"
                  pill
                  disabled={busy || refreshingAntigravity}
                  onPress={() => {
                    void refreshAntigravityStatus()
                  }}
                />
              </View>
            </Callout>
          ) : null}
          <InlineError text={failure} />
        </ScrollView>
        <ChatComposer
          client={client}
          workDir={path || undefined}
          runtime={runtime?.config}
          draft={content}
          onDraft={changeContent}
          references={references}
          onReferences={setReferences}
          attachments={attachments}
          onAttachments={setAttachments}
          team={teamOn}
          onTeam={setTeam}
          computer={computer}
          lean={lean}
          empty
          busy={busy}
          disabled={!client || busy || repo?.state === 'missing_workdir' || antigravityBlocked}
          run={run}
          onOpenRun={() => setRunOpen(true)}
          onSend={() => void create()}
          onError={setError}
        />
      </KeyboardViewport>

      <RunSheet
        visible={runOpen}
        onClose={() => setRunOpen(false)}
        client={client}
        mode={isAntigravity && !ANTIGRAVITY_PERMISSION_MODES.includes(mode) ? 'default' : mode}
        onMode={changeMode}
        runtime={runtime?.config}
        onRuntime={(value, model) => {
          touchedRuntime.current = true
          setRuntime((previous) => {
            const next = {
              config: value,
              name: model?.name ?? (previous?.config.modelId === value.modelId ? previous.name : value.modelId),
            }
            if (value.providerId === ANTIGRAVITY_PROVIDER_ID)
              antigravityRuntime.current = next
            else standardRuntime.current = next
            return next
          })
        }}
        lean={lean}
        disabled={busy ? { mode: '正在创建任务。', runtime: '正在创建任务。' } : undefined}
        profile={
          isAntigravity
            ? undefined
            : { value: profile, onChange: changeProfile, disabled: busy ? '正在创建任务。' : undefined }
        }
        workDir={path || undefined}
        lockedProviderId={isAntigravity ? ANTIGRAVITY_PROVIDER_ID : undefined}
        excludeProviderIds={isAntigravity ? undefined : EXCLUDE_ANTIGRAVITY}
        allowedModes={isAntigravity ? ANTIGRAVITY_PERMISSION_MODES : undefined}
      />

      <WherePage
        visible={whereOpen}
        onClose={() => setWhereOpen(false)}
        projects={projectChoices(projects, path)}
        path={path}
        onPath={changePath}
        repo={repo}
        branch={branch}
        onBranch={setBranch}
        worktree={effectiveWorktree}
        onWorktree={setWorktree}
        client={client}
        hostName={host?.name}
        busy={busy}
        onRetry={() => setRepoEpoch((value) => value + 1)}
        worktreeSupported={!isAntigravity}
      />
    </SafeAreaView>
  )
}
