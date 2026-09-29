/** File type icon (Material Symbols) + size formatting for the references
 *  download card. */

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i
const CODE_EXT = /\.(ts|tsx|js|jsx|py|go|rs|java|c|cc|cpp|h|hpp|json|sh|bash|yaml|yml|toml|sql)$/i
const ARCHIVE_EXT = /\.(zip|tar|gz|7z|rar|bz2)$/i
const TABLE_EXT = /\.(csv|tsv|xlsx|xls)$/i
const DOC_EXT = /\.(docx?|rtf|odt)$/i
const AUDIO_EXT = /\.(mp3|wav|ogg|flac|m4a|aac)$/i
const VIDEO_EXT = /\.(mp4|mkv|webm|mov|avi)$/i

export function fileTypeIcon(filePath: string): string {
  const lower = filePath.toLowerCase()
  if (/\.pdf$/i.test(lower)) return 'picture_as_pdf'
  if (IMAGE_EXT.test(lower)) return 'image'
  if (ARCHIVE_EXT.test(lower)) return 'folder_zip'
  if (TABLE_EXT.test(lower)) return 'table'
  if (AUDIO_EXT.test(lower)) return 'audio_file'
  if (VIDEO_EXT.test(lower)) return 'movie'
  if (CODE_EXT.test(lower)) return 'code'
  if (DOC_EXT.test(lower)) return 'description'
  if (/\.md$/i.test(lower) || /\.txt$/i.test(lower)) return 'description'
  return 'insert_drive_file'
}

export function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = size / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}
