import { useEffect, useState } from 'react'
import { Image, Modal, Pressable, ScrollView, View } from 'react-native'
import { Text } from '../Text'
import { ImagePreviewError, ImagePreviewHeader, ImagePreviewNavigation, imagePreviewColors as colors } from './ImagePreviewChrome'
import type { ImagePreviewProps } from './attachmentPreview'

/** Browser preview. Native builds select ImagePreview.native.tsx instead. */
export function ImagePreview({ images, initialIndex, onClose }: ImagePreviewProps) {
  const [index, setIndex] = useState(initialIndex)
  const [zoom, setZoom] = useState(1)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [stage, setStage] = useState({ width: 1, height: 1 })
  const image = images[index]
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', keyDown)
    return () => document.removeEventListener('keydown', keyDown)
  }, [onClose])
  if (!image) return null
  function select(next: number) {
    if (next < 0 || next >= images.length) return
    setIndex(next)
    setZoom(1)
    setFailed(false)
    setAttempt(0)
  }
  return (
    <Modal visible animationType="fade" onRequestClose={onClose}>
      <View accessibilityViewIsModal style={{ flex: 1, backgroundColor: colors.bg }}>
        <ImagePreviewHeader image={image} index={index} count={images.length} onClose={onClose} />
        <View style={{ flex: 1, minHeight: 0 }} onLayout={(event) => setStage(event.nativeEvent.layout)}>
          {failed ? <ImagePreviewError onRetry={() => { setFailed(false); setAttempt((value) => value + 1) }} /> : (
            <ScrollView horizontal key={`${index}:${attempt}`} contentContainerStyle={{ minWidth: '100%' }} showsHorizontalScrollIndicator={zoom > 1}>
              <ScrollView style={{ width: stage.width * zoom, height: stage.height }} contentContainerStyle={{ minHeight: '100%' }} showsVerticalScrollIndicator={zoom > 1}>
                <Image accessibilityLabel={image.name} source={{ uri: image.uri }} resizeMode="contain" onError={() => setFailed(true)} style={{ width: stage.width * zoom, height: stage.height * zoom }} />
              </ScrollView>
            </ScrollView>
          )}
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 16 }}>
          <Pressable accessibilityRole="button" accessibilityLabel={zoom === 1 ? '放大图片' : '适应屏幕'} onPress={() => setZoom((value) => value === 1 ? 2 : 1)} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 16 }}>
            <Text style={{ fontSize: 14, color: colors.ink }}>{zoom === 1 ? '放大' : '适应屏幕'}</Text>
          </Pressable>
        </View>
        <ImagePreviewNavigation index={index} count={images.length} onSelect={select} hint="放大后可滚动查看细节" />
      </View>
    </Modal>
  )
}
