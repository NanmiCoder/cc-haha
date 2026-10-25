import { clearParkedComposer, parkComposer, parkedComposer } from '../ui/chat/queue'
import { ChatComposer } from '../ui/ChatComposer'
import { EffortControl } from '../ui/EffortControl'
import { GitSheet } from '../ui/newtask/GitSheet'
import { serializeComposer, type ComposerReference } from '../core/composerReferences'
import { KeyboardViewport } from '../ui/KeyboardViewport'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  BackHandler,
  Platform,
  ScrollView,
  View,
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
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
  runtimeProviderIdentity,
  runtimeSelection,
  type Model,
} from '../core/runtimeCatalog'
import { modeName, modes, profileDescription, profileName } from '../ui/modes'
import { RuntimeSheet } from '../ui/RuntimePicker'
import {
  Group,
  InlineError,
  OptionCard,
  Separator,
  Sheet,
  TextButton,
  goBack,
  useColors,
} from '../ui/kit'
import { errorText } from '../ui/theme'
import { ChoiceRow } from '../ui/newtask/ChoiceRow'
import { TargetCard } from '../ui/newtask/TargetCard'
import { WherePanel } from '../ui/newtask/WherePanel'
import {
  TaskChip,
} from '../ui/newtask/parts'

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

type Panel = 'mode' | 'runtime' | 'profile' | 'git' | null

function NewTask({ hostId, initialDir }: { hostId: string; initialDir: string }) {
  const { host, client, error: connectionError } = useConnection(hostId)
  const { drafts } = useApp()
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const draftKey = `${hostId}:new`
  const [content, setContent] = useState(drafts.get(draftKey) ?? '')
  const [parked] = useState(() => parkedComposer(draftKey))
  const [references, setReferences] = useState<ComposerReference[]>(parked?.references ?? [])
  const [repoEpoch, setRepoEpoch] = useState(0)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(parked?.attachments ?? [])
  const [path, setPath] = useState(initialDir)
  const [projects, setProjects] = useState<RecentProject[]>([])
  const [profile, setProfile] = useState<'standard' | 'lean'>('standard')
  const [mode, setMode] = useState<PermissionMode>('default')
  const [runtime, setRuntime] = useState<{ config: RuntimeConfig; name: string }>()
  const [team, setTeam] = useState(parked?.team ?? false)
  const [worktree, setWorktree] = useState(false)
  const [repo, setRepo] = useState<RepositoryContext | null>(null)
  const [branch, setBranch] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'compose' | 'where'>('compose')
  const [panel, setPanel] = useState<Panel>(null)
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
    if (view !== 'where') return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setView('compose')
      return true
    })
    return () => subscription.remove()
  }, [view])
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
      client.get<{ activeId: string | null }>('/api/providers', { signal }),
      client.get<{ model: { id: string } }>('/api/models/current', { signal }),
      client.get<{ level: string }>('/api/effort', { signal }),
      client.get<{ models: Model[] }>('/api/models', { signal }),
    ])
      .then(([provider, model, effort, catalog]) => {
        if (signal.aborted || touchedRuntime.current) return
        const current = catalog.models.find(
          (value) => value.id === model.model.id
        ) ?? { id: model.model.id, name: model.model.id }
        setRuntime({
          config: runtimeSelection(
            runtimeProviderIdentity(provider.activeId),
            current,
            effort.level,
            false
          ),
          name: current.name,
        })
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
  const lean = profile === 'lean'
  const teamOn = team && !lean
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
    const request = creation.begin()
    if (!request) return
    setBusy(true)
    setError('')
    try {
      const message = buildComposerMessage(serializeComposer(content, references), attachments, teamOn)
      validateMessageSize(message, client.host.auth)
      // Refresh at submission: a checkout may have changed while this draft was open.
      const context = path.trim()
        ? await client.get<RepositoryContext>(repositoryUrl(path.trim()))
        : null
      if (!request.isCurrent()) return
      const repository = newTaskRepository(context, branch, worktree)
      const result = await client.createSession({
        workDir: path.trim() || undefined,
        ...(lean ? { agentProfile: profile } : {}),
        permissionMode: mode,
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
  const target = targetSummary({ path, projects, repo, branch, worktree })
  const failure =
    connectionError ||
    error ||
    (repo?.state === 'missing_workdir' ? '这个目录不存在，请重新选择。' : '')
  const bottom = Platform.OS === 'web' ? 34 : Math.max(insets.bottom, 16)
  return (
    <SafeAreaView
      edges={Platform.OS === 'ios' ? ['left', 'right'] : ['top', 'left', 'right']}
      style={[
        { flex: 1, backgroundColor: colors.bg },
        Platform.OS === 'web' && { paddingTop: 47 },
      ]}
    >
      {view === 'where' ? (
        <WherePanel
          projects={projectChoices(projects, path)}
          path={path}
          onPath={changePath}
          client={client}
          busy={busy}
          onBack={() => setView('compose')}
          bottomInset={bottom}
        />
      ) : (
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
          <ScrollView style={{ flex: 1, minHeight: 0 }} keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingHorizontal: 16, gap: 12, paddingBottom: 12 }}
          >
            <TargetCard
              name={target.name}
              hostName={host?.name}
              disabled={busy}
              onPress={() => setView('where')}
            />
            {repo?.state !== 'not_git_repo' && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <TaskChip icon="git-branch" label={target.branch ? `${target.branch} · ${target.mode}` : 'Git 选项'}
                accessibilityLabel="Git 分支和工作树" disabled={busy} onPress={() => setPanel('git')} />
            </View>}
            <Text style={{ paddingTop: 24, paddingHorizontal: 4, fontSize: 25, fontWeight: '600', color: colors.ink }}>想让电脑做什么？</Text>
            <Text style={{ paddingHorizontal: 4, fontSize: 15, lineHeight: 22, color: colors.ink3 }}>选好工作目录，描述任务。也可以输入 / 查找命令，或 @ 引用技能。</Text>
            <InlineError text={failure} />
          </ScrollView>
          <ChatComposer client={client} workDir={path || undefined} runtime={runtime?.config}
            draft={content} onDraft={changeContent} references={references} onReferences={setReferences}
            attachments={attachments} onAttachments={setAttachments} team={teamOn} onTeam={setTeam}
            lean={lean} empty busy={busy} disabled={!client || busy || repo?.state === 'missing_workdir'}
            mode={modeName(mode)} model={runtime?.name ?? '电脑默认模型'} onMode={() => setPanel('mode')}
            onModel={() => setPanel('runtime')} onSend={() => void create()} onError={setError}
            effortControl={<EffortControl client={client} runtime={runtime?.config} disabled={!client || busy}
              onApply={(value) => {
                touchedRuntime.current = true
                setRuntime((previous) => ({ config: value, name: previous?.name ?? value.modelId }))
              }} />}
            profileControl={<TaskChip label={profileName(profile)} accessibilityLabel={`运行档位：${profileName(profile)}`}
              disabled={busy} onPress={() => setPanel('profile')} />}
          />
        </KeyboardViewport>
      )}

      <Sheet visible={panel === 'mode'} onClose={() => setPanel(null)} title="权限模式">
        <Group>
          {modes
            .filter((item) => !lean || item.id !== 'plan')
            .map((item, index) => (
              <React.Fragment key={item.id}>
                {index > 0 && <Separator inset={14} />}
                <ChoiceRow
                  title={item.title}
                  detail={item.description}
                  selected={mode === item.id}
                  onPress={() => {
                    changeMode(item.id)
                    setPanel(null)
                  }}
                />
              </React.Fragment>
            ))}
        </Group>
      </Sheet>

      <Sheet visible={panel === 'profile'} onClose={() => setPanel(null)} title="运行档位">
        {(['standard', 'lean'] as const).map((value) => (
          <OptionCard
            key={value}
            title={profileName(value)}
            description={profileDescription(value)}
            selected={profile === value}
            background={colors.card}
            onPress={() => {
              changeProfile(value)
              setPanel(null)
            }}
          />
        ))}
      </Sheet>

      <GitSheet visible={panel === 'git'} onClose={() => setPanel(null)} path={path} repo={repo}
        branch={branch} onBranch={setBranch} worktree={worktree} onWorktree={setWorktree} busy={busy}
        onRetry={() => setRepoEpoch((value) => value + 1)} />

      <RuntimeSheet
        visible={panel === 'runtime'}
        onClose={() => setPanel(null)}
        title="这次任务的模型"
        client={client}
        initial={runtime?.config}
        onApply={(value, model) => {
          touchedRuntime.current = true
          setRuntime({ config: value, name: model?.name ?? value.modelId })
          setPanel(null)
        }}
      />
    </SafeAreaView>
  )
}
