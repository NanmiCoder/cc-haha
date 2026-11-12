export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const maximumFractionDigits = value >= 10 || unitIndex === 0 ? 0 : 1

  return `${new Intl.NumberFormat('en-US', {
    maximumFractionDigits,
  }).format(value)} ${units[unitIndex]}`
}
