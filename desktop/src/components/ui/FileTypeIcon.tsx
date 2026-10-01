import { FileIcon, defaultStyles, type FileIconProps } from 'react-file-icon'
import { describeFileType } from '@/lib/openWithItems'
import { FILE_GROUP_COLORS, shadeHex } from '@/lib/fileTypePalette'

type IconStyle = Partial<FileIconProps>

const EXTENSION_ALIASES: Record<string, string> = {
  docm: 'docx',
  pages: 'docx',
  xlsm: 'xlsx',
  numbers: 'xlsx',
  pptm: 'pptx',
  key: 'pptx',
  markdown: 'md',
  mdx: 'md',
  log: 'txt',
  rst: 'txt',
  yaml: 'yml',
  tsx: 'ts',
  mjs: 'js',
  cjs: 'js',
  jsonl: 'json',
  xhtml: 'html',
  tgz: 'gz',
  bz2: 'gz',
  xz: 'gz',
  '7z': '7zip',
  opus: 'ogg',
  avif: 'png',
  webp: 'png',
  ico: 'png',
}

/** Glyph used when the library has no style for the extension. */
const GROUP_GLYPHS: Record<string, IconStyle['type']> = {
  picture_as_pdf: 'acrobat',
  docs: 'document',
  markdown: 'document',
  text_snippet: 'document',
  table_chart: 'spreadsheet',
  slideshow: 'presentation',
  folder_zip: 'compressed',
  audio_file: 'audio',
  video_file: 'video',
  html: 'code',
  image: 'image',
  code: 'code',
}

function resolveIconStyle(path: string): { label: string; style: IconStyle; kind: string } {
  const { ext, icon } = describeFileType(path)
  const label = ext.toLowerCase()
  const key = EXTENSION_ALIASES[label] ?? label
  const known = (defaultStyles as Record<string, IconStyle>)[key]
  const color = FILE_GROUP_COLORS[icon] ?? FILE_GROUP_COLORS.insert_drive_file!
  const style: IconStyle = {
    type: known?.type ?? GROUP_GLYPHS[icon] ?? 'document',
    color,
    labelColor: color,
    foldColor: shadeHex(color, 0.18),
    glyphColor: 'rgba(255,255,255,0.4)',
    labelUppercase: true,
  }
  const kind = key === 'md' ? 'markdown' : known ? key : icon === 'insert_drive_file' ? 'file' : icon === 'code' || icon === 'html' ? 'code' : icon
  return { label, style, kind }
}

export type FileTypeIconProps = {
  path: string
  /** Rendered width in px; the glyph keeps the library's document aspect ratio. */
  size?: number
  className?: string
}

/** Folded-corner document glyph with a colored extension label, from react-file-icon. */
export function FileTypeIcon({ path, size = 28, className = '' }: FileTypeIconProps) {
  const { label, style, kind } = resolveIconStyle(path)
  return (
    <span
      aria-hidden="true"
      data-file-type={kind}
      className={`inline-flex shrink-0 ${className}`}
      style={{ width: size }}
    >
      <FileIcon {...style} extension={label || undefined} />
    </span>
  )
}
