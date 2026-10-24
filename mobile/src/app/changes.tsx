import { useCallback, useState } from 'react'
import { Modal, Pressable, ScrollView, View } from 'react-native'
import { Text } from '../ui/Text'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useConnection } from '../state/AppContext'
import {
  canRestoreCode,
  checkpointDiff,
  listCheckpoints,
  parseDiff,
  rewind,
  type Checkpoint,
  type DiffResponse,
  type RewindMode,
} from '../core/operations'
import { useFocusedResource } from '../core/useFocusedResource'
import {
  BottomBar,
  Button,
  CircleButton,
  Empty,
  Inset,
  Loading,
  Notice,
  Raised,
  Screen,
  Segment,
  mono,
  useTheme,
} from '../ui/theme'

export default function Changes() {
  const { host, id } = useLocalSearchParams<{ host: string; id: string }>()
  return <ChangesPage key={`${host}:${id}`} hostId={host} id={id} />
}
function ChangesPage({ hostId, id }: { hostId: string; id: string }) {
  const { client, error: connectionError } = useConnection(hostId)
  const { colors, styles, dark } = useTheme()
  const resource = useFocusedResource(
    useCallback(
      async (signal: AbortSignal) => {
        if (!client) throw new Error('正在连接电脑')
        return listCheckpoints(client, id, signal)
      },
      [client, id]
    )
  )
  const [turn, setTurn] = useState<string>()
  const [file, setFile] = useState<string>()
  const [diffResult, setDiffResult] = useState<{
    key: string
    response?: DiffResponse
    error?: string
  } | null>(null)
  const [chooseTurn, setChooseTurn] = useState(false)
  const [preview, setPreview] = useState<Checkpoint | null>(null)
  const [mode, setMode] = useState<RewindMode>('both')
  const checkpoints = resource.value?.checkpoints ?? []
  const latest = checkpoints.reduce<Checkpoint | undefined>(
    (result, item) =>
      !result || item.target.userMessageIndex > result.target.userMessageIndex
        ? item
        : result,
    undefined
  )
  const checkpoint =
    checkpoints.find((item) => item.target.targetUserMessageId === turn) ??
    latest
  const files = checkpoint?.code.filesChanged ?? []
  const selectedFile =
    file && files.includes(file)
      ? String(file)
      : files[0] === undefined
        ? undefined
        : String(files[0])
  const targetId = checkpoint
    ? String(checkpoint.target.targetUserMessageId)
    : undefined
  const diffKey = `${targetId}:${selectedFile}`
  const diff = diffResult?.key === diffKey ? diffResult.response : undefined
  const diffError = diffResult?.key === diffKey ? diffResult.error : undefined
  useFocusEffect(
    useCallback(() => {
      const controller = new AbortController()
      let active = true
      if (client && targetId && selectedFile)
        checkpointDiff(
          client,
          id,
          {
            targetUserMessageId: targetId,
            userMessageIndex: 0,
            userMessageCount: 0,
          },
          selectedFile,
          controller.signal
        )
          .then((response) => {
            if (active) setDiffResult({ key: diffKey, response })
          })
          .catch((error) => {
            if (active) setDiffResult({ key: diffKey, error: error.message })
          })
      return () => {
        active = false
        controller.abort()
      }
    }, [client, id, targetId, selectedFile, diffKey])
  )
  const beginRewind = () => {
    if (!client || !checkpoint) return
    void resource.run(
      (signal) => rewind(client, id, checkpoint.target, 'both', true, signal),
      (result) => {
        setMode(canRestoreCode(result) ? 'both' : 'conversation')
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
        // Re-enter chat with fresh history after a transcript-changing operation.
        router.replace({ pathname: '/chat/[id]', params: { id, host: hostId } })
      }
    )
  }
  const moveFile = (delta: number) => {
    const index = files.indexOf(selectedFile ?? '')
    if (files.length)
      setFile(files[(index + delta + files.length) % files.length])
  }
  return (
    <Screen
      title={
        checkpoint
          ? `第 ${checkpoint.target.userMessageIndex + 1} 轮改动`
          : '本轮改动'
      }
      subtitle={`${files.length} 个文件 · +${checkpoint?.code.insertions ?? 0} −${checkpoint?.code.deletions ?? 0}`}
      scroll={false}
      right={
        <CircleButton
          name="list"
          label="选择轮次"
          onPress={() => setChooseTurn(true)}
        />
      }
    >
      <View style={{ padding: 16, paddingBottom: 0 }}>
        <Notice text={connectionError || resource.error || diffError} error />
      </View>
      {resource.loading ? (
        <Loading />
      ) : !checkpoint ? (
        <View style={{ padding: 20 }}>
          <Empty
            title="还没有本轮改动"
            detail="电脑会在会话运行后记录可用的文件检查点。"
          />
          <Button
            title="刷新"
            secondary
            onPress={() => void resource.refresh()}
          />
        </View>
      ) : (
        <>
          <View style={{ marginHorizontal: 16, marginTop: 12 }}>
            <Inset style={{ borderRadius: 14, padding: 4 }}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 4 }}
              >
                {files.map((path) => (
                  <Pressable
                    accessibilityRole="tab"
                    accessibilityState={{ selected: selectedFile === path }}
                    key={path}
                    onPress={() => setFile(path)}
                    style={{
                      minHeight: 36,
                      paddingHorizontal: 12,
                      borderRadius: 10,
                      justifyContent: 'center',
                      backgroundColor:
                        selectedFile === path ? colors.surface : 'transparent',
                      boxShadow:
                        selectedFile === path
                          ? `inset 0 1px 0 ${colors.highlight},0 1px 2px rgba(60,45,30,.2)`
                          : undefined,
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 12,
                        fontFamily: mono,
                        color:
                          selectedFile === path ? colors.ink : colors.muted,
                      }}
                    >
                      {path.split(/[\\/]/).pop()}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </Inset>
          </View>
          <ScrollView
            contentContainerStyle={{ padding: 16, paddingTop: 14, flexGrow: 1 }}
          >
            {!selectedFile ? (
              <Empty
                title="这一轮没有可比较的文件"
                detail={checkpoint.code.reason ?? '仍可选择仅回退对话。'}
              />
            ) : (
              <Raised
                style={{
                  borderRadius: 16,
                  overflow: 'hidden',
                  backgroundColor: dark ? colors.surface : '#FBFAF8',
                }}
              >
                <Text
                  selectable
                  style={{
                    fontSize: 11,
                    fontFamily: mono,
                    color: colors.muted,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                  }}
                >
                  {selectedFile}
                </Text>
                {!diff && !diffError ? (
                  <Loading />
                ) : diff?.state !== 'ok' ? (
                  <View style={{ padding: 16 }}>
                    <Notice
                      text={diff?.error ?? '这个检查点暂时无法比较此文件。'}
                    />
                  </View>
                ) : (
                  <ScrollView horizontal>
                    <View style={{ minWidth: 358, paddingBottom: 12 }}>
                      {parseDiff(diff.diff ?? '').map((line, index) =>
                        line.kind === 'hunk' || line.kind === 'meta' ? (
                          <Text
                            selectable
                            key={index}
                            style={{
                              backgroundColor:
                                line.kind === 'hunk'
                                  ? colors.well
                                  : 'transparent',
                              color:
                                line.kind === 'hunk'
                                  ? colors.screenText
                                  : colors.muted,
                              fontFamily: mono,
                              fontSize: 11,
                              lineHeight: 20,
                              paddingHorizontal: 14,
                            }}
                          >
                            {line.text}
                          </Text>
                        ) : (
                          <View
                            key={index}
                            style={{
                              flexDirection: 'row',
                              backgroundColor:
                                line.kind === 'add'
                                  ? dark
                                    ? '#25321F'
                                    : '#E6EDD8'
                                  : line.kind === 'remove'
                                    ? dark
                                      ? '#422C26'
                                      : '#F4E1D9'
                                    : 'transparent',
                            }}
                          >
                            <Text
                              style={{
                                width: 26,
                                textAlign: 'right',
                                color: colors.muted,
                                fontFamily: mono,
                                fontSize: 10,
                                lineHeight: 21,
                              }}
                            >
                              {line.before ?? ''}
                            </Text>
                            <Text
                              style={{
                                width: 26,
                                textAlign: 'right',
                                color: colors.muted,
                                fontFamily: mono,
                                fontSize: 10,
                                lineHeight: 21,
                              }}
                            >
                              {line.after ?? ''}
                            </Text>
                            <Text
                              style={{
                                width: 14,
                                textAlign: 'center',
                                fontFamily: mono,
                                fontSize: 11,
                                lineHeight: 21,
                                color: colors.muted,
                              }}
                            >
                              {line.kind === 'add'
                                ? '+'
                                : line.kind === 'remove'
                                  ? '−'
                                  : ' '}
                            </Text>
                            <Text
                              selectable
                              style={{
                                paddingRight: 16,
                                fontFamily: mono,
                                fontSize: 11.5,
                                lineHeight: 21,
                                color: dark
                                  ? colors.ink
                                  : line.kind === 'add'
                                    ? '#2F4417'
                                    : line.kind === 'remove'
                                      ? '#6E2C1C'
                                      : colors.ink,
                              }}
                            >
                              {line.text || ' '}
                            </Text>
                          </View>
                        )
                      )}
                    </View>
                  </ScrollView>
                )}
              </Raised>
            )}
          </ScrollView>
          <BottomBar>
            <View style={[styles.row, { gap: 12 }]}>
              <CircleButton
                name="chevron-left"
                label="上一个文件"
                onPress={() => moveFile(-1)}
              />
              <View style={{ flex: 1 }}>
                <Button
                  title="回退这一轮…"
                  secondary
                  busy={resource.busy}
                  onPress={beginRewind}
                />
              </View>
              <CircleButton
                name="chevron-right"
                label="下一个文件"
                onPress={() => moveFile(1)}
              />
            </View>
          </BottomBar>
        </>
      )}
      <Modal
        visible={chooseTurn}
        transparent
        animationType="slide"
        onRequestClose={() => setChooseTurn(false)}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: '#0005',
            justifyContent: 'flex-end',
          }}
        >
          <View
            style={{
              backgroundColor: colors.paper,
              padding: 20,
              borderTopLeftRadius: 26,
              borderTopRightRadius: 26,
              maxHeight: '75%',
              gap: 16,
            }}
          >
            <Text style={styles.title}>选择一轮</Text>
            <ScrollView>
              {checkpoints.map((item) => (
                <Pressable
                  key={item.target.targetUserMessageId}
                  onPress={() => {
                    setTurn(item.target.targetUserMessageId)
                    setFile(undefined)
                    setChooseTurn(false)
                  }}
                  style={{
                    paddingVertical: 15,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.line,
                  }}
                >
                  <Text style={styles.text}>
                    第 {item.target.userMessageIndex + 1} 轮 ·{' '}
                    {item.code.filesChanged.length} 个文件
                  </Text>
                  <Text style={styles.small}>
                    +{item.code.insertions} −{item.code.deletions}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <Button
              title="取消"
              secondary
              onPress={() => setChooseTurn(false)}
            />
          </View>
        </View>
      </Modal>
      <Modal
        visible={!!preview}
        transparent
        animationType="slide"
        onRequestClose={() => {
          if (!resource.busy) setPreview(null)
        }}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: '#0005',
            justifyContent: 'flex-end',
          }}
        >
          <View
            style={{
              backgroundColor: colors.paper,
              padding: 20,
              paddingBottom: 34,
              borderTopLeftRadius: 26,
              borderTopRightRadius: 26,
              gap: 16,
            }}
          >
            <Text style={styles.title}>回退到这一轮开始前</Text>
            <Text style={styles.small}>
              会先停止当前运行。代码恢复会覆盖检查点之后的文件修改，请确认其他窗口没有继续编辑。
            </Text>
            <Segment<RewindMode>
              label="回退范围"
              options={
                canRestoreCode(preview ?? checkpoint!)
                  ? [
                      { label: '两者', value: 'both' },
                      { label: '仅代码', value: 'code' },
                      { label: '仅对话', value: 'conversation' },
                    ]
                  : [{ label: '仅对话', value: 'conversation' }]
              }
              value={mode}
              onChange={setMode}
              disabled={resource.busy}
            />
            <Text style={styles.text}>
              {mode === 'code'
                ? '聊天记录保留。'
                : `将移除 ${preview?.conversation?.messagesRemoved ?? 0} 条消息。`}
              {mode !== 'conversation' &&
                `恢复 ${preview?.code.filesChanged.length ?? 0} 个文件。`}
            </Text>
            {mode !== 'conversation' &&
              !!preview?.unverifiedChangeSources?.length && (
                <Notice
                  text={`这些工具的改动未被完整验证：${preview.unverifiedChangeSources.join('、')}。回退只恢复检查点中可恢复的文件，其他改动可能保留。`}
                />
              )}
            {preview && !canRestoreCode(preview) && (
              <Notice text="文件检查点不完整，只能回退对话。" />
            )}
            <Notice text={resource.error} error />
            <Button
              title="确认回退"
              danger
              busy={resource.busy}
              onPress={apply}
            />
            <Button
              title="取消"
              secondary
              disabled={resource.busy}
              onPress={() => setPreview(null)}
            />
          </View>
        </View>
      </Modal>
    </Screen>
  )
}
