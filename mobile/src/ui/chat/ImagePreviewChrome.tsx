import { Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Text } from '../Text'
import { Icon } from '../icons'
import { dark } from '../palette'
import type { PreviewImage } from './attachmentPreview'

export const imagePreviewColors = dark

export function ImagePreviewHeader({ image, index, count, onClose }: {
  image: PreviewImage
  index: number
  count: number
  onClose(): void
}) {
  const inset = useSafeAreaInsets()
  return (
    <View style={{ paddingTop: inset.top + 8, paddingHorizontal: 16, paddingBottom: 8, backgroundColor: dark.bg, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ fontSize: 14, color: dark.ink }}>{image.name}</Text>
        <Text accessibilityLiveRegion="polite" style={{ fontSize: 12, color: dark.ink2 }}>{index + 1} / {count}</Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="关闭图片预览" onPress={onClose} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="x" size={24} color={dark.ink} />
      </Pressable>
    </View>
  )
}

export function ImagePreviewNavigation({ index, count, onSelect, hint }: {
  index: number
  count: number
  onSelect(index: number): void
  hint: string
}) {
  const inset = useSafeAreaInsets()
  return (
    <View style={{ paddingHorizontal: 16, paddingBottom: inset.bottom + 8, paddingTop: 8, backgroundColor: dark.bg, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {count > 1 ? (
        <Pressable accessibilityRole="button" accessibilityLabel="上一张图片" accessibilityState={{ disabled: index === 0 }} disabled={index === 0} onPress={() => onSelect(index - 1)} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: index === 0 ? 0.3 : 1 }}>
          <Icon name="chevron-left" size={24} color={dark.ink} />
        </Pressable>
      ) : null}
      <Text style={{ flex: 1, textAlign: 'center', fontSize: 12, lineHeight: 18, color: dark.ink2 }}>{hint}</Text>
      {count > 1 ? (
        <Pressable accessibilityRole="button" accessibilityLabel="下一张图片" accessibilityState={{ disabled: index === count - 1 }} disabled={index === count - 1} onPress={() => onSelect(index + 1)} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: index === count - 1 ? 0.3 : 1 }}>
          <Icon name="chevron-right" size={24} color={dark.ink} />
        </Pressable>
      ) : null}
    </View>
  )
}

export function ImagePreviewError({ onRetry }: { onRetry(): void }) {
  return (
    <View accessibilityRole="alert" style={{ padding: 20, alignItems: 'center', gap: 8, backgroundColor: dark.bg }}>
      <Text style={{ color: dark.ink, fontSize: 14, textAlign: 'center' }}>图片无法加载，请重试或关闭预览后重新选择。</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="重新加载图片" onPress={onRetry} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 20 }}>
        <Text style={{ fontSize: 14, fontWeight: '600', color: dark.ink }}>重新加载</Text>
      </Pressable>
    </View>
  )
}
