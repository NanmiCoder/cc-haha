import { Pressable, View } from 'react-native'
import { Text } from './Text'
import type { ApiClient } from '../core/client'
import type { Checkpoint } from '../core/operations'
import { changesCardLabel } from '../core/changesView'
import { DiffStat, Icon, useColors } from './kit'
import { plural } from '../core/plural'

/**
 * "Changes card" after a turn ends: one row `3 files +18 −4 ›`, tapping opens the Modified tab of the files page.
 * When onUndo is passed an "Undo" text button appears on the right, using the caller's existing rewind entry.
 * The total comes from this turn's checkpoint; hidden when there is no recoverable file checkpoint.
 */
export function SessionChangesCard({
  checkpoint,
  onOpen,
  onUndo,
}: {
  /** Used by the old per-file diff reading; the one-row card no longer needs it, kept to avoid breaking existing calls. */
  client?: ApiClient | null
  /** Same as above. */
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
        accessibilityHint="View changed files"
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
        <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ink }}>{plural(files, 'file')}</Text>
        <DiffStat added={insertions} removed={deletions} />
        <View style={{ marginLeft: 'auto' }}>
          <Icon name="chevron-right" size={16} color={colors.ink3} strokeWidth={2.2} />
        </View>
      </Pressable>
      {onUndo ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Undo this turn’s changes"
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
          <Text style={{ fontSize: 15, fontWeight: '500', color: colors.ink2 }}>Undo</Text>
        </Pressable>
      ) : null}
    </View>
  )
}
