import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import { Text } from '../ui/Text'
import { useConnection } from '../state/AppContext'
import {
  checkpointDiff,
  listCheckpoints,
  parseDiff,
} from '../core/operations'
import {
  diffTotals,
  errorMessage,
  splitPath,
  stepPath,
  translateReason,
  visibleDiffLines,
  workspaceDiffProblem,
} from '../core/changesView'
import {
  BottomBar,
  Callout,
  DiffView,
  Icon,
  IconButton,
  InlineError,
  Loading,
  Mono,
  useColors,
  type IconName,
} from '../ui/kit'
import { ReaderScreen, SubtitleLine } from '../ui/results/parts'
import { checkpointDiffKey } from '../ui/results/hooks'
import {
  checkpointDiffs,
  checkpointLists,
  sessionKey,
  workspaceStatuses,
  type WorkspaceStatus,
} from '../ui/results/resultsCache'

type Source = 'turn' | 'workspace'
type Loaded = { path: string; diff?: string; problem?: string; error?: string }

/**
 * 文件差异。source=turn 时比较检查点（target 为这一轮的用户消息 id），
 * source=workspace 时比较工作区里没提交的改动。左右切换只改 path 参数。
 */
export default function Diff() {
  const params = useLocalSearchParams<{
    id: string
    host: string
    source?: string
    target?: string
    path: string
  }>()
  const source: Source = params.source === 'workspace' ? 'workspace' : 'turn'
  return (
    <DiffPage
      key={`${params.host}:${params.id}:${source}:${params.target ?? ''}`}
      hostId={params.host}
      id={params.id}
      source={source}
      target={params.target ?? ''}
      path={params.path ?? ''}
    />
  )
}

const cachedCheckpoint = (hostId: string, id: string, target: string) =>
  checkpointLists
    .get(sessionKey(hostId, id))
    ?.find((item) => item.target.targetUserMessageId === target)

function fromTurn(response: { state: string; diff?: string; error?: string }, path: string): Loaded {
  if (response.state === 'ok') return { path, diff: response.diff ?? '' }
  const reason = translateReason(response.error)
  return {
    path,
    problem: `这个检查点暂时无法比较此文件。${reason ? `\n${reason}` : ''}`,
  }
}

function DiffPage({
  hostId,
  id,
  source,
  target,
  path,
}: {
  hostId: string
  id: string
  source: Source
  target: string
  path: string
}) {
  const colors = useColors()
  const { client, error: connectionError } = useConnection(hostId)
  const key = sessionKey(hostId, id)
  const root = `/api/sessions/${encodeURIComponent(id)}/workspace`
  const [files, setFiles] = useState<string[] | null>(() =>
    source === 'turn'
      ? (cachedCheckpoint(hostId, id, target)?.code.filesChanged ?? null)
      : (workspaceStatuses.get(key)?.changedFiles.map((file) => file.path) ?? null)
  )
  const [loaded, setLoaded] = useState<Loaded | null>(() => {
    const cached = cachedCheckpoint(hostId, id, target)
    const response =
      source === 'turn' && cached
        ? checkpointDiffs.get(checkpointDiffKey(hostId, id, cached, path))
        : undefined
    return response ? fromTurn(response, path) : null
  })
  const [copied, setCopied] = useState(false)

  // 用于左右切换的文件列表：检查点的文件，或工作区的改动文件。
  useFocusEffect(
    useCallback(() => {
      if (!client) return
      const controller = new AbortController()
      const { signal } = controller
      const request =
        source === 'turn'
          ? listCheckpoints(client, id, signal).then(({ checkpoints }) => {
              checkpointLists.set(key, checkpoints)
              const found = checkpoints.find(
                (item) => item.target.targetUserMessageId === target
              )
              if (signal.aborted) return
              setFiles(found?.code.filesChanged ?? [])
            })
          : client.get<WorkspaceStatus>(`${root}/status`, { signal }).then((status) => {
              workspaceStatuses.set(key, status)
              if (!signal.aborted)
                setFiles(Array.isArray(status.changedFiles) ? status.changedFiles.map((file) => file.path) : [])
            })
      // 列表取不到只影响左右切换，差异本身照常显示。
      request.catch(() => {})
      return () => controller.abort()
    }, [client, id, key, root, source, target])
  )

  // 当前文件的差异。
  useFocusEffect(
    useCallback(() => {
      if (!client || !path) return
      const controller = new AbortController()
      const { signal } = controller
      const request: Promise<Loaded> =
        source === 'turn'
          ? checkpointDiff(
              client,
              id,
              { targetUserMessageId: target, userMessageIndex: 0, userMessageCount: 0 },
              path,
              signal
            ).then((response) => {
              const known = cachedCheckpoint(hostId, id, target)
              if (known && response.state !== 'error')
                checkpointDiffs.set(checkpointDiffKey(hostId, id, known, path), response)
              return fromTurn(response, path)
            })
          : client
              .get<{ state: string; diff?: string; error?: string }>(
                `${root}/diff?path=${encodeURIComponent(path)}`,
                { signal }
              )
              .then((response) => {
                const problem = workspaceDiffProblem(response)
                return problem ? { path, problem } : { path, diff: response.diff ?? '' }
              })
      request
        .then((next) => {
          if (!signal.aborted) setLoaded(next)
        })
        .catch((error) => {
          if (!signal.aborted) setLoaded({ path, error: errorMessage(error) })
        })
      return () => controller.abort()
    }, [client, hostId, id, path, root, source, target])
  )

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const current = loaded?.path === path ? loaded : undefined
  const lines = useMemo(
    () => (current?.diff !== undefined ? visibleDiffLines(parseDiff(current.diff)) : []),
    [current]
  )
  const totals = diffTotals(lines)
  const { name, dir } = splitPath(path)
  const position = files ? files.indexOf(path) : -1
  const previous = files ? stepPath(files, path, -1) : undefined
  const next = files ? stepPath(files, path, 1) : undefined
  const go = (nextPath?: string) => {
    if (!nextPath) return
    setCopied(false)
    router.setParams({ path: nextPath })
  }
  const copy = async () => {
    if (!current?.diff) return
    await Clipboard.setStringAsync(current.diff)
    setCopied(true)
  }

  let body: ReactNode
  if (connectionError) body = <InlineError text={connectionError} style={{ margin: 16 }} />
  else if (!current) body = <Loading />
  else if (current.error) body = <InlineError text={current.error} style={{ margin: 16 }} />
  else if (current.problem) body = <Callout style={{ margin: 16 }}>{current.problem}</Callout>
  else if (!lines.length)
    body = (
      <Callout tone="info" style={{ margin: 16 }}>
        没有可显示的文本差异
      </Callout>
    )
  else
    body = <DiffView lines={lines} virtualized />

  const stats =
    totals.added || totals.removed ? (
      <>
        {totals.added ? <Mono style={{ fontSize: 12, color: colors.add }}>+{totals.added}</Mono> : null}
        {totals.added && totals.removed ? ' ' : null}
        {totals.removed ? <Mono style={{ fontSize: 12, color: colors.del }}>−{totals.removed}</Mono> : null}
      </>
    ) : null

  return (
    <ReaderScreen
      title={name || '文件差异'}
      subtitle={
        dir || stats ? (
          <SubtitleLine>
            {dir ? <Mono style={{ fontSize: 12 }}>{dir}</Mono> : null}
            {dir && stats ? ' · ' : null}
            {stats}
          </SubtitleLine>
        ) : undefined
      }
      right={
        <IconButton
          icon={copied ? 'check' : 'copy'}
          label={copied ? '已复制差异' : '复制差异'}
          iconSize={20}
          strokeWidth={copied ? 2.4 : 1.75}
          color={copied ? colors.ok : colors.ink2}
          disabled={!current?.diff}
          onPress={() => void copy()}
        />
      }
      footer={
        <BottomBar
          style={{
            paddingTop: 6,
            paddingHorizontal: 12,
            flexDirection: 'row',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
          }}
        >
          <StepButton icon="chevron-left" label="上一个文件" target={previous} onPress={go} />
          <View style={{ height: 44, flexDirection: 'row', alignItems: 'center' }}>
            {files && position >= 0 ? (
              <Text style={{ fontSize: 14, color: colors.ink2 }}>
                <Mono style={{ fontSize: 14, color: colors.ink2 }}>
                  {position + 1} / {files.length}
                </Mono>
                {' 个文件'}
              </Text>
            ) : null}
          </View>
          <StepButton icon="chevron-right" label="下一个文件" target={next} onPress={go} />
        </BottomBar>
      }
    >
      {body}
    </ReaderScreen>
  )
}

/** 工具栏的左右箭头：到头时变成浅灰并禁用（不再额外降透明度）。 */
function StepButton({
  icon,
  label,
  target,
  onPress,
}: {
  icon: IconName
  label: string
  target?: string
  onPress(target?: string): void
}) {
  const colors = useColors()
  const disabled = !target
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={4}
      onPress={() => onPress(target)}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.5 : 1,
      })}
    >
      <Icon name={icon} size={22} color={disabled ? colors.chevron : colors.ink} strokeWidth={2.2} />
    </Pressable>
  )
}
