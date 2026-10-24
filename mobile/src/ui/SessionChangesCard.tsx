import { useEffect, useState } from 'react'
import { Pressable, View } from 'react-native'
import { Text } from './Text'
import type { ApiClient } from '../core/client'
import { listCheckpoints, type Checkpoint } from '../core/operations'
import { Icon, Raised, mono, useTheme } from './theme'

/** The summary is the actual latest turn checkpoint, not the entire working tree diff. */
export function SessionChangesCard({
  client,
  sessionId,
  revision,
  onOpen,
}: {
  client: ApiClient | null
  sessionId: string
  revision: string
  onOpen(): void
}) {
  const { colors: c, styles: s } = useTheme()
  const [result, setResult] = useState<{
    checkpoint?: Checkpoint
    error?: boolean
  } | null>(null)
  useEffect(() => {
    if (!client) return
    const controller = new AbortController()
    listCheckpoints(client, sessionId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted)
          setResult({
            checkpoint: value.checkpoints.reduce<Checkpoint | undefined>(
              (previous, current) =>
                !previous ||
                current.target.userMessageIndex >
                  previous.target.userMessageIndex
                  ? current
                  : previous,
              undefined
            ),
          })
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ error: true })
      })
    return () => controller.abort()
  }, [client, sessionId, revision])
  if (!result) return null
  const checkpoint = result.checkpoint
  const total =
    (checkpoint?.code.insertions ?? 0) + (checkpoint?.code.deletions ?? 0)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="查看本轮改动"
      onPress={onOpen}
    >
      <Raised style={{ paddingHorizontal: 16, paddingVertical: 14, gap: 10 }}>
        <View style={s.between}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: c.ink }}>
            {checkpoint?.code.available
              ? `改动 ${checkpoint.code.filesChanged.length} 个文件`
              : '本轮改动'}
          </Text>
          {checkpoint?.code.available ? (
            <Text style={{ fontFamily: mono, fontSize: 12, color: c.red }}>
              <Text style={{ color: c.green }}>
                +{checkpoint.code.insertions}
              </Text>{' '}
              −{checkpoint.code.deletions}
            </Text>
          ) : (
            <Icon name="chevron-right" size={14} />
          )}
        </View>
        {total > 0 && (
          <View
            style={{
              height: 6,
              borderRadius: 3,
              backgroundColor: c.inset,
              flexDirection: 'row',
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                flex: checkpoint!.code.insertions / total,
                backgroundColor: c.green,
              }}
            />
            <View
              style={{
                flex: checkpoint!.code.deletions / total,
                backgroundColor: c.accent,
              }}
            />
          </View>
        )}
        {checkpoint?.code.filesChanged.slice(0, 3).map((path) => (
          <Text
            key={path}
            numberOfLines={1}
            style={{ fontFamily: mono, fontSize: 11, color: c.secondary }}
          >
            {path}
          </Text>
        ))}
        <View style={s.between}>
          <Text style={[s.small, { fontSize: 10 }]}>
            {result.error
              ? '暂时无法读取，打开后重试'
              : !checkpoint
                ? '查看文件检查点与可用的回退'
                : checkpoint.code.filesChanged.length > 3
                  ? `还有 ${checkpoint.code.filesChanged.length - 3} 个文件`
                  : '查看差异与回退选项'}
          </Text>
          <Icon name="arrow-right" size={14} color={c.muted} />
        </View>
      </Raised>
    </Pressable>
  )
}
