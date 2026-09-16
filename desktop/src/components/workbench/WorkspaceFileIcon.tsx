import { Braces, FileArchive, FileAudio, FileCode2, FileSpreadsheet, FileText, FileVideo, Image } from 'lucide-react'
import { describeFileType } from '@/lib/openWithItems'

export type WorkspaceFileIconProps = {
  path: string
  size?: number
  className?: string
}

/** Compact, decorative file identity shared by workspace tabs and tree rows. */
export function WorkspaceFileIcon({ path, size = 14, className = '' }: WorkspaceFileIconProps) {
  const { ext, categoryKey } = describeFileType(path)
  const language = /^(TS|TSX)$/.test(ext) ? 'ts' : /^(JS|JSX|MJS|CJS)$/.test(ext) ? 'js' : null
  if (language) {
    const colors = language === 'ts'
      ? { backgroundColor: 'var(--color-file-typescript-container)', color: 'var(--color-on-file-typescript-container)' }
      : { backgroundColor: 'var(--color-file-javascript-container)', color: 'var(--color-on-file-javascript-container)' }
    return (
      <span
        aria-hidden="true"
        data-file-type={language}
        className={`inline-flex shrink-0 items-center justify-center rounded-[var(--radius-xs)] font-semibold leading-none ${className}`}
        style={{
          width: size,
          height: size,
          fontSize: size * 0.57,
          ...colors,
        }}
      >
        {language.toUpperCase()}
      </span>
    )
  }

  const category = categoryKey.slice('openWith.fileType.'.length)
  const type = ext === 'JSON' || ext === 'JSONL' ? 'json'
    : /^(MD|MDX|MARKDOWN)$/.test(ext) ? 'markdown'
      : ext === 'PDF' ? 'pdf' : category
  const Icon = type === 'json' ? Braces
    : type === 'image' ? Image
      : type === 'archive' ? FileArchive
        : type === 'audio' ? FileAudio
          : type === 'video' ? FileVideo
            : type === 'spreadsheet' ? FileSpreadsheet
              : type === 'code' || type === 'web' ? FileCode2 : FileText
  const color = type === 'json' ? 'var(--color-brand)'
    : type === 'image' ? 'var(--color-info)'
      : type === 'pdf' ? 'var(--color-error)'
        : type === 'spreadsheet' ? 'var(--color-success)' : 'var(--color-text-tertiary)'
  return <Icon aria-hidden="true" data-file-type={type} size={size} strokeWidth={1.7} className={`shrink-0 ${className}`} style={{ color }} />
}
