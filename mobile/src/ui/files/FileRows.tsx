import { Pressable, TextInput, View } from 'react-native'
import { Text } from '../Text'
import { Icon, Mono, useColors } from '../kit'
import { isImagePath, type BadgeStatus } from '../../core/changesView'
import {
  changedRowLabel,
  type ChangedRow,
  type FilesTab,
  type SearchRow,
  type TreeItem,
} from './filesModel'

export const floatShadow = (hair: string) =>
  `0 1px 2px rgba(28,25,23,0.06), 0 4px 14px rgba(28,25,23,0.09), 0 0 0 1px ${hair}`

/* ───────────── Segments ───────────── */

/** "Modified | All files": rounded capsule segments, with the selected one a white raised segment. */
export function FilesTabs({ value, onChange }: { value: FilesTab; onChange(value: FilesTab): void }) {
  const colors = useColors()
  const options: { value: FilesTab; label: string }[] = [
    { value: 'changed', label: 'Modified' },
    { value: 'all', label: 'All files' },
  ]
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel="File scope"
      style={{
        height: 44,
        marginHorizontal: 16,
        borderRadius: 22,
        backgroundColor: colors.fill,
        padding: 3,
        flexDirection: 'row',
      }}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={{
              flex: 1,
              borderRadius: 19,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: selected ? colors.card : 'transparent',
              boxShadow: selected ? `0 1px 3px rgba(28,25,23,0.12), 0 0 0 1px ${colors.hair}` : undefined,
            }}
          >
            <Text
              style={{
                fontSize: 15,
                fontWeight: selected ? '600' : '400',
                color: selected ? colors.ink : colors.ink2,
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/* ───────────── Modified ───────────── */

/** M grey background, A green background, D red background, R / ? same colors as M and A; blank slot while the diff is not loaded yet. */
function ChangeBadge({ status }: { status?: BadgeStatus }) {
  const colors = useColors()
  if (!status) return <View style={{ width: 22, height: 22, marginLeft: 4 }} />
  const scheme =
    status === 'A' || status === '?'
      ? { bg: colors.okSoft, fg: colors.ok }
      : status === 'D'
        ? { bg: colors.errSoft, fg: colors.err }
        : { bg: colors.fill, fg: colors.ink2 }
  return (
    <View
      style={{
        width: 22,
        height: 22,
        marginLeft: 4,
        borderRadius: 6,
        backgroundColor: scheme.bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Mono style={{ fontSize: 12, fontWeight: '600', color: scheme.fg }}>{status}</Mono>
    </View>
  )
}

export function FileGlyph({ path, color }: { path: string; color: string }) {
  return (
    <View style={{ width: 28, alignItems: 'center' }}>
      <Icon name={isImagePath(path) ? 'image' : 'file'} size={20} color={color} strokeWidth={1.6} />
    </View>
  )
}

/** A modified row: file name (monospace) + small directory text · +N −N · status badge. */
export function ChangedFileRow({ row, onPress }: { row: ChangedRow; onPress(): void }) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={changedRowLabel(row)}
      accessibilityHint="View diff"
      onPress={onPress}
      style={({ pressed }) => ({
        height: 60,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        backgroundColor: pressed ? colors.fill : 'transparent',
      })}
    >
      <FileGlyph path={row.path} color={colors.ink2} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Mono numberOfLines={1} style={{ fontSize: 14, lineHeight: 20, fontWeight: '500', color: colors.ink }}>
          {row.name}
        </Mono>
        {row.dir ? (
          <Mono numberOfLines={1} ellipsizeMode="head" style={{ fontSize: 12, lineHeight: 16, color: colors.ink3 }}>
            {row.dir}
          </Mono>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {row.added ? <Mono style={{ fontSize: 12, color: colors.add }}>+{row.added}</Mono> : null}
        {row.removed ? <Mono style={{ fontSize: 12, color: colors.del }}>−{row.removed}</Mono> : null}
        <ChangeBadge status={row.badge} />
      </View>
      <Hairline />
    </Pressable>
  )
}

/** Hairline at the row bottom, starting after the file icon. */
export function Hairline({ inset = 56 }: { inset?: number }) {
  const colors = useColors()
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', left: inset, right: 0, bottom: 0, height: 1, backgroundColor: colors.hair }}
    />
  )
}

/** Text entry at the top of the list, like "View all changes and rewind ›". */
export function LinkRow({ title, onPress }: { title: string; onPress(): void }) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 16,
        backgroundColor: pressed ? colors.fill : 'transparent',
      })}
    >
      <Text style={{ fontSize: 15, color: colors.ink2 }}>{title}</Text>
      <Icon name="chevron-right" size={15} color={colors.ink3} strokeWidth={2.2} />
    </Pressable>
  )
}

/* ───────────── All files ───────────── */

const indent = 20

/** A directory tree row: expand chevron · folder / file icon · name; note rows (loading, error, empty folder) indent to the name. */
export function TreeFileRow({
  item,
  onToggle,
  onOpenFile,
  onRetry,
}: {
  item: TreeItem
  onToggle(path: string): void
  onOpenFile(path: string): void
  onRetry(path: string): void
}) {
  const colors = useColors()
  const pad = 16 + item.depth * indent
  if (item.kind === 'note') {
    const row = (
      <View style={{ minHeight: 40, justifyContent: 'center', paddingLeft: pad + 20 + 28 + 10, paddingRight: 16 }}>
        <Text style={{ fontSize: 14, color: item.tone === 'err' ? colors.err : colors.ink3 }}>{item.text}</Text>
      </View>
    )
    return item.retry === undefined ? (
      row
    ) : (
      <Pressable accessibilityRole="button" accessibilityLabel={item.text} onPress={() => onRetry(item.retry!)}>
        {row}
      </Pressable>
    )
  }
  const { entry } = item
  const directory = entry.isDirectory
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${entry.name}, ${directory ? 'Folder' : isImagePath(entry.name) ? 'Image' : 'File'}`}
      accessibilityState={directory ? { expanded: item.open } : undefined}
      onPress={() => (directory ? onToggle(entry.path) : onOpenFile(entry.path))}
      style={({ pressed }) => ({
        height: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingLeft: pad,
        paddingRight: 16,
        backgroundColor: pressed ? colors.fill : 'transparent',
      })}
    >
      <View style={{ width: 20, alignItems: 'center' }}>
        {directory ? (
          <Icon name={item.open ? 'chevron-down' : 'chevron-right'} size={16} color={colors.ink3} strokeWidth={2.2} />
        ) : null}
      </View>
      {directory ? (
        <View style={{ width: 28, alignItems: 'center' }}>
          <Icon name="folder" size={22} color={colors.ink2} strokeWidth={1.6} />
        </View>
      ) : (
        <FileGlyph path={entry.name} color={colors.ink2} />
      )}
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 16, color: colors.ink }}>
        {entry.name}
      </Text>
      <Hairline inset={pad + 20 + 10} />
    </Pressable>
  )
}

/** Search results: file name + containing directory. */
export function SearchResultRow({ row, onPress }: { row: SearchRow; onPress(): void }) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.path}, file`}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        backgroundColor: pressed ? colors.fill : 'transparent',
      })}
    >
      <FileGlyph path={row.path} color={colors.ink2} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text numberOfLines={1} style={{ fontSize: 16, lineHeight: 21, color: colors.ink }}>
          {row.name}
        </Text>
        {row.dir ? (
          <Mono numberOfLines={1} ellipsizeMode="head" style={{ fontSize: 12, lineHeight: 16, color: colors.ink3 }}>
            {row.dir}
          </Mono>
        ) : null}
      </View>
      <Hairline />
    </Pressable>
  )
}

/* ───────────── Bottom search box ───────────── */

export function FilesSearchBar({
  value,
  onChangeText,
  bottom,
}: {
  value: string
  onChangeText(value: string): void
  bottom: number
}) {
  const colors = useColors()
  return (
    <View
      style={{
        position: 'absolute',
        left: 16,
        right: 16,
        bottom,
        height: 52,
        borderRadius: 26,
        backgroundColor: colors.card,
        boxShadow: `0 1px 2px rgba(28,25,23,0.05), 0 6px 20px rgba(28,25,23,0.10), 0 0 0 1px ${colors.hair}`,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingLeft: 18,
        paddingRight: 8,
      }}
    >
      <Icon name="search" size={20} color={colors.ink3} strokeWidth={2} />
      <TextInput
        accessibilityLabel="Search files"
        value={value}
        onChangeText={onChangeText}
        placeholder="Search files"
        placeholderTextColor={colors.ink3}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={{ flex: 1, minWidth: 0, fontSize: 16, color: colors.ink, paddingVertical: 10 }}
      />
      {value ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          hitSlop={8}
          onPress={() => onChangeText('')}
          style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}
        >
          <View
            style={{
              width: 20,
              height: 20,
              borderRadius: 10,
              backgroundColor: colors.chevron,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="x" size={11} color="#FFFFFF" strokeWidth={3.5} />
          </View>
        </Pressable>
      ) : null}
    </View>
  )
}
