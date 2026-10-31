import type { ApiClient, ToolImageVariant } from './client'
import type { ToolImage } from './types'

/** Thumbnails stay while the conversation is open; originals are large, keep only a few. */
const THUMB_CACHE_CHARS = 16 * 1024 * 1024
const FULL_CACHE_ENTRIES = 3

export type ToolImageLoader = {
  /** A URI that can be drawn right now: an inline image or a finished download. */
  peek(image: ToolImage, variant: ToolImageVariant): string | undefined
  load(image: ToolImage, variant: ToolImageVariant): Promise<string>
}

/** Older computers inline the bytes; draw them directly. */
export function inlineToolImageUri(image: ToolImage): string | undefined {
  return image.data ? `data:${image.mimeType};base64,${image.data}` : undefined
}

/**
 * Downloads referenced tool images through the host's API client, so they use
 * the same credential, origin check, redirect refusal and timeouts as history.
 * Concurrent requests for one image share a download; failures are not cached.
 */
export function createToolImageLoader(client: Pick<ApiClient, 'image'>): ToolImageLoader {
  const thumbs = new Map<string, string>()
  const fulls = new Map<string, string>()
  const pending = new Map<string, Promise<string>>()
  let thumbChars = 0

  const remember = (variant: ToolImageVariant, url: string, uri: string) => {
    const cache = variant === 'thumb' ? thumbs : fulls
    const previous = cache.get(url)
    if (previous !== undefined) {
      cache.delete(url)
      if (variant === 'thumb') thumbChars -= previous.length
    }
    cache.set(url, uri)
    if (variant === 'thumb') {
      thumbChars += uri.length
      for (const [oldest, value] of thumbs) {
        if (thumbChars <= THUMB_CACHE_CHARS || oldest === url) break
        thumbs.delete(oldest)
        thumbChars -= value.length
      }
    } else {
      for (const oldest of fulls.keys()) {
        if (fulls.size <= FULL_CACHE_ENTRIES) break
        fulls.delete(oldest)
      }
    }
  }

  return {
    peek(image, variant) {
      const inline = inlineToolImageUri(image)
      if (inline || !image.url) return inline
      return (variant === 'thumb' ? thumbs : fulls).get(image.url)
    },
    load(image, variant) {
      const ready = this.peek(image, variant)
      if (ready) return Promise.resolve(ready)
      if (!image.url) return Promise.reject(new Error('图片没有可用的地址'))
      const url = image.url
      const key = `${variant}\n${url}`
      const running = pending.get(key)
      if (running) return running
      const request = client.image(url, variant).then(
        (uri) => {
          pending.delete(key)
          remember(variant, url, uri)
          return uri
        },
        (error: unknown) => {
          pending.delete(key)
          throw error
        }
      )
      pending.set(key, request)
      return request
    },
  }
}
