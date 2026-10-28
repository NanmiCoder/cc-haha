import type React from 'react'
import { Pressable, View } from 'react-native'
import { Text } from '../Text'
import { Icon, Mono, useColors } from '../kit'

/**
 * 分组列表里的单选行：标题（可等宽）+ 副行，右侧可带说明文字和蓝色勾。
 * 项目、分支、模型、权限模式共用，尺寸按设计稿：有副行时最小高 56，否则 48。
 */
export function ChoiceRow({
  title,
  titleMono,
  titleColor,
  titleWeight = '500',
  detail,
  detailMono,
  detailSize = 13,
  detailColor,
  trailingText,
  selected,
  leading,
  gap = 12,
  onPress,
  disabled,
  accessibilityLabel,
}: {
  title: string
  titleMono?: boolean
  titleColor?: string
  titleWeight?: '400' | '500' | '600'
  detail?: string
  detailMono?: boolean
  detailSize?: number
  detailColor?: string
  trailingText?: string
  selected?: boolean
  leading?: React.ReactNode
  gap?: number
  onPress?(): void
  disabled?: boolean
  accessibilityLabel?: string
}) {
  const colors = useColors()
  const Title = titleMono ? Mono : Text
  const Detail = detailMono ? Mono : Text
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        accessibilityLabel ??
        [title, detail, trailingText].filter(Boolean).join('，')
      }
      accessibilityState={{ selected: Boolean(selected), disabled }}
      disabled={disabled || !onPress}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: detail ? 56 : 48,
        paddingHorizontal: 14,
        paddingVertical: detail ? 8 : 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap,
        backgroundColor: pressed ? colors.fill : 'transparent',
        opacity: disabled ? 0.45 : 1,
      })}
    >
      {leading}
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Title
          numberOfLines={1}
          style={{
            fontSize: titleMono ? 14.5 : 16,
            lineHeight: titleMono ? 20 : 21,
            fontWeight: titleMono ? '400' : titleWeight,
            color: titleColor ?? colors.ink,
          }}
        >
          {title}
        </Title>
        {detail ? (
          <Detail
            numberOfLines={1}
            ellipsizeMode={detailMono ? 'middle' : 'tail'}
            style={{
              fontSize: detailSize,
              lineHeight: 18,
              color: detailColor ?? colors.ink3,
            }}
          >
            {detail}
          </Detail>
        ) : null}
      </View>
      {trailingText ? (
        <Text style={{ fontSize: 13, color: colors.ink3 }}>{trailingText}</Text>
      ) : null}
      {selected ? (
        <Icon name="check" size={18} color={colors.run} strokeWidth={2.4} />
      ) : null}
    </Pressable>
  )
}
