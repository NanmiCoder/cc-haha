import { ActivityIndicator, Image, Pressable, View } from 'react-native'
import { Text } from '../Text'
import { Icon, useColors, type IconName } from '../kit'
import type { ComposerAttachment } from '../../core/chatComposer'

/** 运行设置 chip（36 高、圆角 18、发丝描边、尾部下箭头）。长模型名截断而不撑破一行。 */
export function TaskChip({
  label,
  icon,
  onPress,
  disabled,
  accessibilityLabel,
}: {
  label: string
  icon?: IconName
  onPress(): void
  disabled?: boolean
  accessibilityLabel?: string
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 36,
        maxWidth: '100%',
        paddingHorizontal: 12,
        borderRadius: 18,
        backgroundColor: colors.card,
        boxShadow: `inset 0 0 0 1px ${colors.hair}`,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      {icon && <Icon name={icon} size={15} color={colors.ink} strokeWidth={2} />}
      <Text
        numberOfLines={1}
        style={{ flexShrink: 1, fontSize: 14, color: colors.ink }}
      >
        {label}
      </Text>
      <Icon name="chevron-down" size={12} color={colors.ink3} strokeWidth={2.4} />
    </Pressable>
  )
}

/** 44 圆形描边按钮（“+”材料）。 */
export function RoundButton({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: IconName
  label: string
  onPress(): void
  disabled?: boolean
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: colors.card,
        boxShadow: `inset 0 0 0 1px ${colors.hair}`,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      <Icon name={icon} size={20} color={colors.ink} strokeWidth={2} />
    </Pressable>
  )
}

/** “团队”切换胶囊：未选描边，选中蓝底蓝字。 */
export function TeamToggle({
  value,
  onChange,
  disabled,
  hint,
}: {
  value: boolean
  onChange(value: boolean): void
  disabled?: boolean
  hint?: string
}) {
  const colors = useColors()
  const fg = value ? colors.run : colors.ink2
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel="团队"
      accessibilityHint={hint}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={({ pressed }) => ({
        height: 44,
        paddingHorizontal: 14,
        borderRadius: 22,
        backgroundColor: value ? colors.runTint : colors.card,
        boxShadow: value ? undefined : `inset 0 0 0 1px ${colors.hair}`,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      <Icon name="users" size={16} color={fg} strokeWidth={2} />
      <Text
        style={{ fontSize: 14, color: fg, fontWeight: value ? '600' : '400' }}
      >
        团队
      </Text>
    </Pressable>
  )
}

/** 墨色“开始 ↑”胶囊，高 48。 */
export function StartButton({
  onPress,
  disabled,
  busy,
}: {
  onPress(): void
  disabled?: boolean
  busy?: boolean
}) {
  const colors = useColors()
  const inactive = disabled || busy
  const fg = inactive ? colors.ink3 : colors.btnInk
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="开始"
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => ({
        marginLeft: 'auto',
        height: 48,
        paddingHorizontal: 24,
        borderRadius: 24,
        backgroundColor: inactive ? colors.fill : colors.btn,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ fontSize: 16, fontWeight: '600', color: fg }}>开始</Text>
      {busy ? (
        <ActivityIndicator size="small" color={fg} />
      ) : (
        <Icon name="arrow-up" size={17} color={fg} strokeWidth={2.4} />
      )}
    </Pressable>
  )
}

/** 64 缩略图，右上角 × 移除。图片显示预览，文件显示图标和文件名。 */
export function AttachmentThumb({
  item,
  onRemove,
  disabled,
}: {
  item: ComposerAttachment
  onRemove(): void
  disabled?: boolean
}) {
  const colors = useColors()
  const name = item.name ?? (item.type === 'image' ? '图片' : '文件')
  return (
    <View style={{ width: 64, height: 64 }}>
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: 12,
          overflow: 'hidden',
          backgroundColor: colors.fill,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          paddingHorizontal: 6,
        }}
      >
        {item.type === 'image' && item.uri ? (
          <Image
            accessibilityLabel={name}
            source={{ uri: item.uri }}
            style={{ position: 'absolute', width: 64, height: 64 }}
          />
        ) : (
          <>
            <Icon
              name={item.type === 'image' ? 'image' : 'file'}
              size={22}
              color={colors.ink3}
            />
            <Text
              numberOfLines={1}
              ellipsizeMode="middle"
              style={{ fontSize: 10.5, lineHeight: 13, color: colors.ink3 }}
            >
              {name}
            </Text>
          </>
        )}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`移除${name}`}
        disabled={disabled}
        hitSlop={8}
        onPress={onRemove}
        style={{
          position: 'absolute',
          top: -6,
          right: -6,
          width: 22,
          height: 22,
          borderRadius: 11,
          backgroundColor: colors.ink,
          boxShadow: `0 0 0 2px ${colors.card}`,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.45 : 1,
        }}
      >
        <Icon name="x" size={10} color={colors.card} strokeWidth={3.5} />
      </Pressable>
    </View>
  )
}

const materials: { kind: 'photos' | 'camera' | 'file'; label: string; icon: IconName }[] =
  [
    { kind: 'photos', label: '相册', icon: 'image' },
    { kind: 'camera', label: '拍照', icon: 'camera' },
    { kind: 'file', label: '文件', icon: 'file' },
  ]

/** 材料面板：相册 / 拍照 / 文件三个图块。 */
export function MaterialTiles({
  onPick,
  disabled,
}: {
  onPick(kind: 'photos' | 'camera' | 'file'): void
  disabled?: boolean
}) {
  const colors = useColors()
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {materials.map((item) => (
        <Pressable
          key={item.kind}
          accessibilityRole="button"
          accessibilityLabel={item.label}
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={() => onPick(item.kind)}
          style={({ pressed }) => ({
            flex: 1,
            height: 72,
            borderRadius: 14,
            backgroundColor: colors.card,
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
          })}
        >
          <Icon name={item.icon} size={22} color={colors.ink} />
          <Text style={{ fontSize: 13, color: colors.ink }}>{item.label}</Text>
        </Pressable>
      ))}
    </View>
  )
}
