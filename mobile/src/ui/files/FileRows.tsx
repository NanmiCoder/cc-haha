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

/* ───────────── 分段 ───────────── */

/** 「已修改 | 所有文件」：圆角胶囊分段，选中项是白色浮起的一段。 */
export function FilesTabs({ value, onChange }: { value: FilesTab; onChange(value: FilesTab): void }) {
  const colors = useColors()
  const options: { value: FilesTab; label: string }[] = [
    { value: 'changed', label: '已修改' },
    { value: 'all', label: '所有文件' },
  ]
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel="文件范围"
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

/* ───────────── 已修改 ───────────── */

/** M 灰底、A 绿底、D 红底，R / ? 与 M、A 同色；差异还没读到时留空位。 */
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

/** 已修改的一行：文件名（等宽）+ 目录小字 · +N −N · 状态角标。 */
export function ChangedFileRow({ row, onPress }: { row: ChangedRow; onPress(): void }) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={changedRowLabel(row)}
      accessibilityHint="查看差异"
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

/** 行底的发丝线，从文件图标之后开始。 */
export function Hairline({ inset = 56 }: { inset?: number }) {
  const colors = useColors()
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', left: inset, right: 0, bottom: 0, height: 1, backgroundColor: colors.hair }}
    />
  )
}

/** 列表顶部的文字入口，如「查看全部改动与回退 ›」。 */
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

/* ───────────── 所有文件 ───────────── */

const indent = 20

/** 目录树的一行：展开箭头 · 文件夹 / 文件图标 · 名字；说明行（读取中、出错、空文件夹）缩进到名字处。 */
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
      accessibilityLabel={`${entry.name}，${directory ? '文件夹' : isImagePath(entry.name) ? '图片' : '文件'}`}
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

/** 搜索结果：文件名 + 所在目录。 */
export function SearchResultRow({ row, onPress }: { row: SearchRow; onPress(): void }) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.path}，文件`}
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

/* ───────────── 底部搜索框 ───────────── */

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
        accessibilityLabel="搜索文件"
        value={value}
        onChangeText={onChangeText}
        placeholder="搜索文件"
        placeholderTextColor={colors.ink3}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={{ flex: 1, minWidth: 0, fontSize: 16, color: colors.ink, paddingVertical: 10 }}
      />
      {value ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="清除搜索"
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
