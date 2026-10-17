import { fetchServerImageBlobUrl } from '../../../lib/authedImage'
import { publicAssetPath } from '../../../lib/publicAsset'
import {
  SHARE_SIZES,
  buildShareLayout,
  type ShareImageData,
  type ShareLayout,
  type ShareOptions,
  type ShareTheme,
} from './layout'
import { canvasToPngBlob, createTextMeasurer, ensureShareFonts, paintShareLayout, type PaintAssets } from './paint'

/** The default avatar is the app icon, drawn with its own padding; the page crops it in 1.28×. */
const DEFAULT_AVATAR_ZOOM = 1.28

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Could not load ${src}`))
    image.src = src
  })
}

export type ShareAssets = PaintAssets & { dispose: () => void }

/**
 * The two pictures the image needs. A custom avatar comes through the
 * authenticated image fetch (a bare cross-origin `<img>` would taint the canvas
 * and make export fail); if it cannot be read the app icon stands in, as it does on the page.
 */
export async function loadShareAssets(avatarUrl: string | null): Promise<ShareAssets> {
  const objectUrls: string[] = []
  const icon = await loadImage(publicAssetPath('app-icon.png')).catch(() => null)

  let avatar: PaintAssets['avatar'] = icon ? { image: icon, zoom: DEFAULT_AVATAR_ZOOM } : null
  if (avatarUrl) {
    try {
      const blobUrl = await fetchServerImageBlobUrl(avatarUrl)
      objectUrls.push(blobUrl)
      avatar = { image: await loadImage(blobUrl), zoom: 1 }
    } catch {
      // Keep the app icon.
    }
  }

  return {
    avatar,
    icon,
    dispose: () => objectUrls.forEach((url) => URL.revokeObjectURL(url)),
  }
}

export type RenderShareImageInput = {
  data: ShareImageData
  theme: ShareTheme
  options: ShareOptions
  assets: PaintAssets
}

export async function renderShareImage(
  input: RenderShareImageInput,
  canvas: HTMLCanvasElement = document.createElement('canvas'),
): Promise<{ canvas: HTMLCanvasElement; layout: ShareLayout }> {
  await ensureShareFonts()
  const { width, height } = SHARE_SIZES[input.options.size]
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D is not available')

  const layout = buildShareLayout(input.data, input.theme, input.options, createTextMeasurer(ctx))
  paintShareLayout(ctx, layout, input.assets)
  return { canvas, layout }
}

export async function renderShareImageBlob(input: RenderShareImageInput): Promise<Blob> {
  const { canvas } = await renderShareImage(input)
  return canvasToPngBlob(canvas)
}
