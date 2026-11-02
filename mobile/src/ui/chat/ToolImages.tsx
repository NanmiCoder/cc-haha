import { useContext, useEffect, useMemo, useState } from 'react'
import { Image, Keyboard, Pressable, View } from 'react-native'
import type { ToolImageVariant } from '../../core/client'
import type { ToolImage } from '../../core/types'
import { Text } from '../Text'
import { Icon, Spinner, useColors } from '../kit'
import { ImagePreview } from './ImagePreview'
import type { PreviewImage } from './attachmentPreview'
import { ToolImageLoaderContext } from './toolImageContext'
import type { NamedToolImage } from './steps'

const TILE_HEIGHT = 112
const STRIP_LIMIT = 6

function tileWidth(image: ToolImage) {
  if (!image.width || !image.height) return 150
  return Math.round(Math.min(220, Math.max(72, (TILE_HEIGHT * image.width) / image.height)))
}

function useToolImageUri(image: ToolImage, variant: ToolImageVariant) {
  const loader = useContext(ToolImageLoaderContext)
  const ready = loader?.peek(image, variant)
  const [loaded, setLoaded] = useState<{ key: string; uri?: string; failed: boolean }>()
  const [attempt, setAttempt] = useState(0)
  const key = `${variant}\n${image.url ?? image.data?.length ?? ''}\n${attempt}`
  useEffect(() => {
    if (ready || !loader) return
    let live = true
    loader.load(image, variant).then(
      (uri) => live && setLoaded({ key, uri, failed: false }),
      () => live && setLoaded({ key, failed: true })
    )
    return () => {
      live = false
    }
    // `key` covers the image identity, the variant and retries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready, loader])
  const current = loaded?.key === key ? loaded : undefined
  return {
    uri: ready ?? current?.uri,
    // Without a connected computer there is nothing to download from.
    failed: !ready && (!loader || current?.failed === true),
    retry: () => setAttempt((value) => value + 1),
  }
}

function Tile({ image, label, onOpen }: { image: ToolImage; label: string; onOpen(): void }) {
  const colors = useColors()
  const { uri, failed, retry } = useToolImageUri(image, 'thumb')
  const width = tileWidth(image)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={failed ? `${label}，加载失败，点按重试` : `查看${label}`}
      disabled={!uri && !failed}
      onPress={() => {
        if (failed) return retry()
        Keyboard.dismiss()
        onOpen()
      }}
      style={({ pressed }) => ({
        width,
        height: TILE_HEIGHT,
        borderRadius: 10,
        overflow: 'hidden',
        backgroundColor: colors.fill,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {uri ? (
        <Image source={{ uri }} resizeMode="cover" style={{ width, height: TILE_HEIGHT }} />
      ) : failed ? (
        <View style={{ alignItems: 'center', gap: 4, paddingHorizontal: 6 }}>
          <Icon name="image" size={18} color={colors.ink3} />
          <Text style={{ fontSize: 11.5, color: colors.ink3 }}>点按重试</Text>
        </View>
      ) : (
        <Spinner size={14} thickness={2} />
      )}
    </Pressable>
  )
}

/** Thumbnails of tool-produced images (a Read of a screenshot), tap to view full screen. */
export function ToolImageStrip({ images }: { images: NamedToolImage[] }) {
  const colors = useColors()
  const [preview, setPreview] = useState<number | null>(null)
  if (!images.length) return null
  const shown = images.slice(0, STRIP_LIMIT)
  const rest = images.length - shown.length
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4, marginBottom: 6 }}>
      {shown.map(({ image, name }, index) => (
        <Tile key={`${image.url ?? 'inline'}:${index}`} image={image} label={name} onOpen={() => setPreview(index)} />
      ))}
      {rest > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`查看其余 ${rest} 张图片`}
          onPress={() => setPreview(STRIP_LIMIT)}
          style={{ height: TILE_HEIGHT, minWidth: 64, borderRadius: 10, backgroundColor: colors.fill, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ fontSize: 14, color: colors.ink2 }}>+{rest}</Text>
        </Pressable>
      ) : null}
      {preview !== null ? (
        <ToolImagePreview images={images} initialIndex={preview} onClose={() => setPreview(null)} />
      ) : null}
    </View>
  )
}

/**
 * Opens on the thumbnail that is already on screen and swaps in each original
 * as it arrives, starting with the one that was tapped.
 */
function ToolImagePreview({ images, initialIndex, onClose }: { images: NamedToolImage[]; initialIndex: number; onClose(): void }) {
  const loader = useContext(ToolImageLoaderContext)
  const [originals, setOriginals] = useState<Record<number, string>>({})
  useEffect(() => {
    if (!loader) return
    let live = true
    const order = [initialIndex, ...images.map((_, index) => index).filter((index) => index !== initialIndex)]
    void (async () => {
      for (const index of order) {
        try {
          const uri = await loader.load(images[index]!.image, 'full')
          if (!live) return
          setOriginals((previous) => ({ ...previous, [index]: uri }))
        } catch {
          // The thumbnail stays; the viewer offers its own retry.
        }
      }
    })()
    return () => {
      live = false
    }
  }, [images, initialIndex, loader])
  const preview = useMemo(
    () =>
      images.flatMap(({ image, name }, index): PreviewImage[] => {
        const uri = originals[index] ?? loader?.peek(image, 'full') ?? loader?.peek(image, 'thumb')
        return uri ? [{ id: `${image.url ?? 'inline'}:${index}`, name, uri, attachmentIndex: index }] : []
      }),
    [images, loader, originals]
  )
  const start = Math.max(0, preview.findIndex((image) => image.attachmentIndex === initialIndex))
  if (!preview.length) return null
  return <ImagePreview images={preview} initialIndex={start} onClose={onClose} />
}
