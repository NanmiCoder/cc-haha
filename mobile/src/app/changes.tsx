import { useCallback, useState, type ReactNode } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { markSessionStale } from '../core/sessionStale'
import { router, useLocalSearchParams } from 'expo-router'
import { Text } from '../ui/Text'
import { useConnection } from '../state/AppContext'
import {
  listCheckpoints,
  rewind,
  type Checkpoint,
  type RewindMode,
} from '../core/operations'
import { useFocusedResource } from '../core/useFocusedResource'
import {
  defaultRewindMode,
  latestCheckpoint,
  translateReason,
  turnNumber,
  turnTimeLabel,
} from '../core/changesView'
import {
  BottomBar,
  Button,
  DiffStat,
  EmptyState,
  Footnote,
  Group,
  Icon,
  InlineError,
  Loading,
  NavBar,
  ScreenView,
  Separator,
  type,
  useColors,
} from '../ui/kit'
import { FileChangeRow } from '../ui/results/parts'
import { RewindSheet, TurnSheet } from '../ui/results/sheets'
import { useCheckpointFileSummaries, useTurnPrompt } from '../ui/results/hooks'
import { checkpointLists, sessionKey } from '../ui/results/resultsCache'

export default function Changes() {
  const { host, id } = useLocalSearchParams<{ host: string; id: string }>()
  return <ChangesPage key={`${host}:${id}`} hostId={host} id={id} />
}

function TurnCard({
  checkpoint,
  latest,
  prompt,
  onPress,
}: {
  checkpoint: Checkpoint
  latest: boolean
  prompt?: string
  onPress(): void
}) {
  const colors = useColors()
  const time = turnTimeLabel(checkpoint.startedAt, latest)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[`第 ${turnNumber(checkpoint)} 轮`, time, prompt].filter(Boolean).join('，')}
      accessibilityHint="换一轮"
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: colors.card,
        borderRadius: 16,
        paddingVertical: 12,
        paddingHorizontal: 14,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
          <Text style={{ fontSize: 16, lineHeight: 21, fontWeight: '600', color: colors.ink }}>
            第 {turnNumber(checkpoint)} 轮
          </Text>
          {time ? <Text style={{ fontSize: 13, color: colors.ink3 }}>{time}</Text> : null}
        </View>
        {prompt ? (
          <View style={{ flexDirection: 'row' }}>
            <Text style={{ fontSize: 14, lineHeight: 18, color: colors.ink2 }}>「</Text>
            <Text
              numberOfLines={1}
              style={{ flexShrink: 1, fontSize: 14, lineHeight: 18, color: colors.ink2 }}
            >
              {prompt}
            </Text>
            <Text style={{ fontSize: 14, lineHeight: 18, color: colors.ink2 }}>」</Text>
          </View>
        ) : null}
      </View>
      <Text style={{ fontSize: 14, color: colors.ink2 }}>换一轮</Text>
      <Icon name="chevron-down" size={14} color={colors.ink3} strokeWidth={2.2} />
    </Pressable>
  )
}

function ChangesPage({ hostId, id }: { hostId: string; id: string }) {
  const colors = useColors()
  const { client, error: connectionError } = useConnection(hostId)
  const key = sessionKey(hostId, id)
  const resource = useFocusedResource(
    useCallback(
      async (signal: AbortSignal) => {
        if (!client) return null
        const result = await listCheckpoints(client, id, signal)
        checkpointLists.set(key, result.checkpoints)
        return result
      },
      [client, id, key]
    )
  )
  const [turn, setTurn] = useState<string>()
  const [picking, setPicking] = useState(false)
  const [preview, setPreview] = useState<Checkpoint | null>(null)
  const [mode, setMode] = useState<RewindMode>('both')
  const checkpoints = resource.value?.checkpoints ?? []
  const latest = latestCheckpoint(checkpoints)
  const checkpoint =
    checkpoints.find((item) => item.target.targetUserMessageId === turn) ?? latest
  const files = checkpoint?.code.filesChanged ?? []
  const summary = useCheckpointFileSummaries(client, hostId, id, checkpoint)
  const prompt = useTurnPrompt(client, hostId, id, checkpoint?.target.targetUserMessageId)

  const beginRewind = () => {
    if (!client || !checkpoint) return
    void resource.run(
      (signal) => rewind(client, id, checkpoint.target, 'both', true, signal),
      (result) => {
        setMode(defaultRewindMode(result))
        setPreview(result)
      }
    )
  }
  const apply = () => {
    if (!client || !preview) return
    void resource.run(
      (signal) => rewind(client, id, preview.target, mode, false, signal),
      () => {
        setPreview(null)
        // 改了对话记录之后回到会话页重新读取历史。从会话页进来的就返回原页（让它刷新），
        // 不再在旧会话页上面再叠一个新的，否则返回时会看到回退前的内容。
        markSessionStale(hostId, id)
        if (router.canGoBack()) router.back()
        else router.replace({ pathname: '/chat/[id]', params: { id, host: hostId } })
      }
    )
  }
  const cancelRewind = () => {
    if (resource.busy) return
    setPreview(null)
    resource.setError('')
  }
  const openDiff = (path: string) => {
    if (!checkpoint) return
    router.push({
      pathname: '/diff',
      params: {
        id,
        host: hostId,
        source: 'turn',
        target: checkpoint.target.targetUserMessageId,
        path,
      },
    })
  }
  const openWorkspace = () =>
    router.push({ pathname: '/workspace', params: { id, host: hostId } })

  const pageError = connectionError || (preview ? '' : resource.error)
  const loaded = resource.value !== null

  let body: ReactNode
  if (!loaded) {
    body = pageError ? (
      <View style={{ padding: 16, gap: 12 }}>
        <InlineError text={pageError} />
        <Button title="重试" variant="secondary" onPress={() => void resource.refresh()} />
      </View>
    ) : (
      <Loading />
    )
  } else if (!checkpoint) {
    body = (
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8 }}>
        <InlineError text={pageError} />
        <EmptyState
          icon="rotate-ccw"
          title="还没有改动记录"
          detail="电脑会在会话运行后记录可用的文件检查点。"
          action={
            <Button title="刷新" variant="secondary" onPress={() => void resource.refresh()} />
          }
        />
      </ScrollView>
    )
  } else {
    body = (
      <>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24 }}>
          <InlineError text={pageError} style={{ marginBottom: 12 }} />
          <TurnCard
            checkpoint={checkpoint}
            latest={checkpoint === latest}
            prompt={prompt}
            onPress={() => setPicking(true)}
          />
          {files.length ? (
            <>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'baseline',
                  gap: 10,
                  paddingTop: 22,
                  paddingBottom: 8,
                  paddingHorizontal: 4,
                }}
              >
                <Text accessibilityRole="header" style={[type.section, { flex: 1, color: colors.ink2 }]}>
                  {files.length} 个文件
                </Text>
                <DiffStat added={checkpoint.code.insertions} removed={checkpoint.code.deletions} />
              </View>
              <Group>
                {files.map((path, index) => {
                  const file = summary(path)
                  return (
                    <View key={path}>
                      {index ? <Separator inset={48} /> : null}
                      <FileChangeRow
                        path={path}
                        status={file?.badge}
                        added={file?.added}
                        removed={file?.removed}
                        onPress={() => openDiff(path)}
                      />
                    </View>
                  )
                })}
              </Group>
              <Footnote style={{ paddingTop: 10 }}>
                这是 cc-haha 在这一轮开始前存下的检查点。想看工作区里所有没提交的改动，去「
                <Text
                  accessibilityRole="link"
                  onPress={openWorkspace}
                  style={{ color: colors.ink2, textDecorationLine: 'underline' }}
                >
                  项目文件
                </Text>
                」。
              </Footnote>
            </>
          ) : (
            <EmptyState
              icon="file"
              title="这一轮没有可比较的文件"
              detail={translateReason(checkpoint.code.reason) ?? '仍可选择只回退对话。'}
            />
          )}
        </ScrollView>
        <BottomBar>
          <Button
            title="回退到这一轮之前…"
            variant="danger"
            size="lg"
            icon="rotate-ccw"
            busy={resource.busy && !preview}
            disabled={!client}
            onPress={beginRewind}
          />
        </BottomBar>
      </>
    )
  }

  return (
    <ScreenView>
      <NavBar title="改动与回退" />
      {body}
      <TurnSheet
        visible={picking}
        onClose={() => setPicking(false)}
        checkpoints={checkpoints}
        selectedId={checkpoint?.target.targetUserMessageId}
        onSelect={(target) => {
          setTurn(target)
          setPicking(false)
        }}
      />
      <RewindSheet
        preview={preview}
        mode={mode}
        onMode={setMode}
        busy={resource.busy}
        error={preview ? resource.error : undefined}
        onCancel={cancelRewind}
        onConfirm={apply}
      />
    </ScreenView>
  )
}
