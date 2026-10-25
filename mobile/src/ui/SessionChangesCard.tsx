import { useEffect, useEffectEvent, useState } from 'react'
import { Pressable, View } from 'react-native'
import { Text } from './Text'
import type { ApiClient } from '../core/client'
import { checkpointDiff, type Checkpoint } from '../core/operations'
import { DiffStat, Icon, Mono, useColors } from './kit'
import { fileChange, type FileChange } from './chat/changes'

const SHOWN = 3

/**
 * 一轮结束后的「本轮改动」：标题 + 总增删，最多 3 个文件行，再进入改动与回退。
 * 文件的新增/修改和行数来自这一轮检查点的真实差异，读不到的行只显示路径。
 */
export function SessionChangesCard({
  client,
  sessionId,
  checkpoint,
  onOpen,
}: {
  client: ApiClient | null
  sessionId: string
  checkpoint?: Checkpoint
  onOpen(): void
}) {
  const colors = useColors()
  const files = checkpoint?.code.available ? checkpoint.code.filesChanged : []
  const target = checkpoint?.target
  const key = `${target?.targetUserMessageId ?? ''}:${files.slice(0, SHOWN).join('\n')}`
  const [details, setDetails] = useState<{ key: string; files: Record<string, FileChange> }>({
    key: '',
    files: {},
  })
  const load = useEffectEvent((signal: AbortSignal) => {
    if (!client || !target || !files.length) return
    const shown = files.slice(0, SHOWN)
    void Promise.allSettled(
      shown.map((path) => checkpointDiff(client, sessionId, target, path, signal))
    ).then((results) => {
      if (signal.aborted) return
      const next: Record<string, FileChange> = {}
      results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value.state === 'ok' && result.value.diff)
          next[shown[index]] = fileChange(result.value.diff)
      })
      setDetails({ key, files: next })
    })
  })
  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [client, sessionId, key])
  if (!checkpoint || !files.length) return null
  const known = details.key === key ? details.files : {}
  const more = files.length - SHOWN
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`本轮改动 ${files.length} 个文件，新增 ${checkpoint.code.insertions} 行，删除 ${checkpoint.code.deletions} 行，看差异或回退`}
      onPress={onOpen}
      style={({ pressed }) => ({
        backgroundColor: colors.card,
        borderRadius: 16,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 12, paddingHorizontal: 14, paddingBottom: 8 }}>
        <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: colors.ink }}>本轮改动</Text>
        <DiffStat added={checkpoint.code.insertions} removed={checkpoint.code.deletions} />
      </View>
      {files.slice(0, SHOWN).map((path, index, shown) => {
        const change = known[path]
        return (
          <View
            key={path}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingHorizontal: 14,
              paddingTop: 6,
              paddingBottom: index === shown.length - 1 ? 10 : 6,
            }}
          >
            <Text
              style={{
                width: 14,
                fontSize: 11,
                fontWeight: '700',
                color: change?.status === 'A' ? colors.add : change?.status === 'D' ? colors.del : colors.attn,
              }}
            >
              {change?.status ?? ''}
            </Text>
            <Mono numberOfLines={1} ellipsizeMode="head" style={{ flex: 1, minWidth: 0, fontSize: 13, color: colors.ink }}>
              {path}
            </Mono>
            {change && (change.added || change.removed) ? (
              <Mono style={{ fontSize: 12.5, color: colors.ink3 }}>
                {[change.added ? `+${change.added}` : '', change.removed ? `−${change.removed}` : '']
                  .filter(Boolean)
                  .join(' ')}
              </Mono>
            ) : null}
          </View>
        )
      })}
      <View style={{ height: 1, backgroundColor: colors.hair, marginHorizontal: 14 }} />
      <View style={{ height: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14 }}>
        <Text style={{ flex: 1, fontSize: 14, color: colors.ink2 }}>看差异或回退</Text>
        {more > 0 ? (
          <Text style={{ fontSize: 13, color: colors.ink3 }}>另 {more} 个文件</Text>
        ) : null}
        <Icon name="chevron-right" size={14} color={colors.ink2} strokeWidth={2.2} />
      </View>
    </Pressable>
  )
}
