export function readingProgress({ top, height, viewportHeight, headerHeight }) {
  const distance = height - (viewportHeight - headerHeight)
  if (distance <= 0) return top <= headerHeight ? 100 : 0
  return Math.round(Math.max(0, Math.min(1, (headerHeight - top) / distance)) * 100)
}

export async function copyCode(text, clipboard) {
  if (!clipboard?.writeText) return false
  try {
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
