import { Pressable, View } from 'react-native'
import { Text } from '../Text'
import { Icon, Mono, useColors } from '../kit'
import { targetAccessibility, targetLine } from './whereModel'

/**
 * 新任务顶部的单行“位置”卡：📁 项目名  ⎇ main · 新工作树 ›。
 * 点按打开位置页；分支和工作树都在那里改。
 */
export function TargetCard({
  name,
  branch,
  status,
  worktree = false,
  onPress,
  disabled,
}: {
  name: string
  branch?: string
  /** 没有分支时代替分支显示（“读取中…”“无 Git 分支”）。 */
  status?: string
  /** 新开工作树时在分支后面写“新工作树”。 */
  worktree?: boolean
  onPress(): void
  disabled?: boolean
}) {
  const colors = useColors()
  const line = targetLine({ name, branch, status }, worktree)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={targetAccessibility(line)}
      accessibilityHint="选择项目目录、分支和工作树"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 56,
        backgroundColor: colors.card,
        borderRadius: 16,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        opacity: disabled ? 0.6 : pressed ? 0.7 : 1,
      })}
    >
      <Icon name="folder" size={20} color={colors.ink2} strokeWidth={1.75} />
      <Text
        numberOfLines={1}
        style={{ flexShrink: 1, maxWidth: '55%', fontSize: 16, lineHeight: 21, fontWeight: '600', color: colors.ink }}
      >
        {line.name}
      </Text>
      <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        {line.branch ? (
          <>
            <Icon name="git-branch" size={13} color={colors.ink3} strokeWidth={2} />
            <Mono numberOfLines={1} style={{ flexShrink: 1, fontSize: 13, color: colors.ink3 }}>
              {line.branch}
            </Mono>
          </>
        ) : line.status ? (
          <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13, color: colors.ink3 }}>
            {line.status}
          </Text>
        ) : null}
        {line.note ? (
          <Text numberOfLines={1} style={{ flexShrink: 0, fontSize: 13, color: colors.ink3 }}>
            · {line.note}
          </Text>
        ) : null}
      </View>
      <Icon name="chevron-right" size={16} color={colors.chevron} strokeWidth={2.2} />
    </Pressable>
  )
}
