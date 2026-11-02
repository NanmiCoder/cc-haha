import { useCallback, useMemo, useState } from 'react'
import { View } from 'react-native'
import ImageView from 'react-native-image-viewing'
import { ImagePreviewError, ImagePreviewHeader, ImagePreviewNavigation, imagePreviewColors as colors } from './ImagePreviewChrome'
import { useImagePreviewStatus } from './imagePreviewStatus'
import type { ImagePreviewProps } from './attachmentPreview'

/** Native Modal, native iOS zooming and the library's Android pinch/pan gestures. */
export function ImagePreview({ images, initialIndex, onClose }: ImagePreviewProps) {
  const [selectedIndex, setSelectedIndex] = useState(initialIndex)
  // Swipes live inside the gallery. Changing its imageIndex prop remounts it;
  // reserve that for explicit navigation/retry so swiping doesn't reset zoom.
  const [opening, setOpening] = useState({ index: initialIndex, revision: 0 })
  const sources = useMemo(() => images.map((image) => ({ uri: image.uri })), [images])
  const { failed, attempt, retry } = useImagePreviewStatus(images[selectedIndex]?.uri || '')
  const select = useCallback((index: number) => {
    if (index < 0 || index >= images.length) return
    setSelectedIndex(index)
    setOpening((previous) => ({ index, revision: previous.revision + 1 }))
  }, [images.length])
  const Header = useCallback(({ imageIndex }: { imageIndex: number }) => (
    <ImagePreviewHeader image={images[imageIndex]} index={imageIndex} count={images.length} onClose={onClose} />
  ), [images, onClose])
  const Footer = useCallback(({ imageIndex }: { imageIndex: number }) => (
    <View>
      {failed && imageIndex === selectedIndex ? <ImagePreviewError onRetry={() => { setOpening((previous) => ({ ...previous, index: selectedIndex })); retry() }} /> : null}
      <ImagePreviewNavigation index={imageIndex} count={images.length} onSelect={select} hint={images.length > 1 ? '双指缩放 · 双击放大 · 左右滑动切图' : '双指缩放 · 双击放大'} />
    </View>
  ), [failed, images.length, retry, select, selectedIndex])
  if (!images.length) return null
  return (
    <ImageView
      key={`${opening.revision}:${attempt}`}
      images={sources}
      imageIndex={opening.index}
      keyExtractor={(_, index) => images[index].id}
      visible
      onRequestClose={onClose}
      onImageIndexChange={setSelectedIndex}
      presentationStyle="fullScreen"
      backgroundColor={colors.bg}
      swipeToCloseEnabled
      doubleTapToZoomEnabled
      HeaderComponent={Header}
      FooterComponent={Footer}
    />
  )
}
