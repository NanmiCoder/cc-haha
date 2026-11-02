import { Pressable, View } from 'react-native'
import { Text } from './Text'
import type { ApiClient } from '../core/client'
import type { Checkpoint } from '../core/operations'
import { changesCardLabel } from '../core/changesView'
import { DiffStat, Icon, useColors } from './kit'

/**
 * 一轮结束后的「变更卡」：一行 `3 个文件 +18 −4 ›`，点开进文件页的「已修改」。
 * 传了 onUndo 时右侧多一个「撤销」文字按钮，走调用方现有的回退入口。
 * 总数来自这一轮检查点，没有可恢复的文件检查点时不显示。
 */
export function SessionChangesCard({
  checkpoint,
  onOpen,
  onUndo,
}: {
  /** 旧版逐文件读差异用，一行卡不再需要；保留是为了不破坏现有调用。 */
  client?: ApiClient | null
  /** 同上。 */
  sessionId?: string
  checkpoint?: Checkpoint
  onOpen(): void
  onUndo?(): void
}) {
  const colors = useColors()
  const files = checkpoint?.code.available ? checkpoint.code.filesChanged.length : 0
  if (!checkpoint || !files) return null
  const { insertions, deletions } = checkpoint.code
  return (
    <View
      style={{
        minHeight: 52,
        borderRadius: 16,
        backgroundColor: colors.card,
        boxShadow: `0 0 0 1px ${colors.hair}`,
        flexDirection: 'row',
        alignItems: 'center',
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={changesCardLabel(files, insertions, deletions)}
        accessibilityHint="查看更改的文件"
        onPress={onOpen}
        style={({ pressed }) => ({
          flex: 1,
          minWidth: 0,
          minHeight: 52,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingLeft: 14,
          paddingRight: onUndo ? 4 : 14,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Icon name="file" size={20} color={colors.ink2} />
        <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ink }}>{files} 个文件</Text>
        <DiffStat added={insertions} removed={deletions} />
        <View style={{ marginLeft: 'auto' }}>
          <Icon name="chevron-right" size={16} color={colors.ink3} strokeWidth={2.2} />
        </View>
      </Pressable>
      {onUndo ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="撤销这一轮的更改"
          onPress={onUndo}
          style={({ pressed }) => ({
            minWidth: 56,
            height: 52,
            paddingRight: 14,
            paddingLeft: 8,
            alignItems: 'flex-end',
            justifyContent: 'center',
            opacity: pressed ? 0.5 : 1,
          })}
        >
          <Text style={{ fontSize: 15, fontWeight: '500', color: colors.ink2 }}>撤销</Text>
        </Pressable>
      ) : null}
    </View>
  )
}
