export function planResize(w: number, h: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(w, h)
  if (longest <= maxEdge) return { width: w, height: h }
  const scale = maxEdge / longest
  return { width: Math.round(w * scale), height: Math.round(h * scale) }
}

/** In the browser: scale a dataUrl to fit maxEdge and re-encode it at quality. */
export async function compressDataUrl(dataUrl: string, maxEdge = 1600, quality = 0.85): Promise<string> {
  const img = new Image()
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('load')); img.src = dataUrl })
  const { width, height } = planResize(img.naturalWidth, img.naturalHeight, maxEdge)
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  canvas.getContext('2d')!.drawImage(img, 0, 0, width, height)
  return canvas.toDataURL('image/png', quality)
}
