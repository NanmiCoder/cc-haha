import type { OpenTarget } from '../stores/openTargetStore'

// ─── File-type description ────────────────────────────────────────────────────

export type FileTypeInfo = { icon: string; categoryKey: string; ext: string }

const FILE_TYPE_RULES: Array<{ re: RegExp; key: string; icon: string }> = [
  { re: /\.pdf$/i, key: 'document', icon: 'picture_as_pdf' },
  { re: /\.(doc|docx|docm|odt|rtf|pages)$/i, key: 'document', icon: 'docs' },
  { re: /\.(md|mdx|markdown)$/i, key: 'document', icon: 'markdown' },
  { re: /\.(txt|log|rst)$/i, key: 'document', icon: 'text_snippet' },
  { re: /\.(xls|xlsx|xlsm|csv|ods|numbers)$/i, key: 'spreadsheet', icon: 'table_chart' },
  { re: /\.(ppt|pptx|pptm|odp|key)$/i, key: 'presentation', icon: 'slideshow' },
  { re: /\.(zip|7z|rar|tar|gz|tgz|bz2|xz)$/i, key: 'archive', icon: 'folder_zip' },
  { re: /\.(mp3|wav|m4a|flac|aac|ogg|opus)$/i, key: 'audio', icon: 'audio_file' },
  { re: /\.(mp4|mov|m4v|webm|mkv|avi)$/i, key: 'video', icon: 'video_file' },
  { re: /\.(html?|xhtml)$/i, key: 'web', icon: 'html' },
  { re: /\.(png|jpe?g|gif|svg|webp|avif|bmp|ico)$/i, key: 'image', icon: 'image' },
  { re: /\.(ts|tsx|js|jsx|mjs|cjs|json|css|scss|less|py|rs|go|java|rb|php|c|cc|cpp|h|hpp|sh|ya?ml|toml|xml|sql)$/i, key: 'code', icon: 'code' },
]

export function describeFileType(path: string): FileTypeInfo {
  const fileName = path.split(/[\\/]/).pop() ?? path
  const dotIndex = fileName.lastIndexOf('.')
  const ext = dotIndex > 0 && dotIndex < fileName.length - 1
    ? fileName.slice(dotIndex + 1).toUpperCase()
    : ''
  for (const rule of FILE_TYPE_RULES) {
    if (rule.re.test(path)) return { icon: rule.icon, categoryKey: `openWith.fileType.${rule.key}`, ext }
  }
  return { icon: 'insert_drive_file', categoryKey: 'openWith.fileType.file', ext }
}

const PREVIEWABLE_CHANGED_FILE_RE = /\.(md|markdown|html?|png|jpe?g|gif|webp|svg)$/i

/**
 * True only for changed-file types with a meaningful *rendered* preview
 * (markdown / html / image). Source files (.ts/.json/.css …) return false.
 * Used only to sort rich-preview files ahead of generic source/document rows.
 */
export function isPreviewableChangedFile(path: string): boolean {
  return PREVIEWABLE_CHANGED_FILE_RE.test(path)
}

// ─── Open-with items ──────────────────────────────────────────────────────────

export type OpenWithIcon = 'in-app-browser' | 'system' | 'application' | 'ide' | 'file-manager' | 'preview' | 'copy'

export type OpenWithItem = {
  id: string
  label: string
  icon: OpenWithIcon
  target?: OpenTarget          // present for native app / IDE / file-manager items
  onSelect: () => void
}

export type OpenWithDeps = {
  openInAppBrowser: (url: string) => void
  openSystem: (urlOrPath: string) => void
  openWorkspacePreview: (relPath: string) => void
  openTarget: (targetId: string, absolutePath: string) => void
  /** Omit to leave the copy entries out (a URL context has nothing to copy). */
  copyPath?: (absolutePath: string) => void
  copyFileContent?: (path: string) => void
  t: (key: string, vars?: Record<string, string>) => string
}

export type OpenWithContext =
  | { kind: 'url'; url: string }
  | { kind: 'file'; absolutePath: string; relPath?: string; previewable?: boolean; inAppBrowserUrl?: string }

export function buildOpenWithItems(ctx: OpenWithContext, targets: OpenTarget[], deps: OpenWithDeps): OpenWithItem[] {
  const items: OpenWithItem[] = []
  if (ctx.kind === 'url') {
    items.push({ id: 'in-app', label: deps.t('openWith.inAppBrowser'), icon: 'in-app-browser', onSelect: () => deps.openInAppBrowser(ctx.url) })
    items.push({ id: 'system', label: deps.t('openWith.systemBrowser'), icon: 'system', onSelect: () => deps.openSystem(ctx.url) })
    return items
  }
  if (ctx.previewable && ctx.relPath != null) {
    const relPath = ctx.relPath
    items.push({ id: 'preview', label: deps.t('openWith.workspacePreview'), icon: 'preview', onSelect: () => deps.openWorkspacePreview(relPath) })
  }
  if (ctx.inAppBrowserUrl) {
    const url = ctx.inAppBrowserUrl
    items.push({ id: 'in-app', label: deps.t('openWith.inAppBrowser'), icon: 'in-app-browser', onSelect: () => deps.openInAppBrowser(url) })
  }
  for (const target of targets.filter((x) => x.kind === 'application')) {
    items.push({ id: `app:${target.id}`, label: deps.t('openWith.openInTarget', { target: target.label }), icon: 'application', target, onSelect: () => deps.openTarget(target.id, ctx.absolutePath) })
  }
  const systemTarget = targets.find((target) => target.kind === 'system_default')
  items.push(systemTarget
    ? { id: 'system', label: deps.t('openWith.systemDefault'), icon: 'system', target: systemTarget, onSelect: () => deps.openTarget(systemTarget.id, ctx.absolutePath) }
    : { id: 'system', label: deps.t('openWith.systemDefault'), icon: 'system', onSelect: () => deps.openSystem(ctx.absolutePath) })
  for (const target of targets.filter((x) => x.kind === 'ide')) {
    items.push({ id: `ide:${target.id}`, label: deps.t('openWith.openInTarget', { target: target.label }), icon: 'ide', target, onSelect: () => deps.openTarget(target.id, ctx.absolutePath) })
  }
  // Copy entries sit between "open in…" and "reveal in…", matching the order the
  // platform file managers use.
  if (deps.copyPath) {
    const copyPath = deps.copyPath
    items.push({ id: 'copy-path', label: deps.t('openWith.copyPath'), icon: 'copy', onSelect: () => copyPath(ctx.absolutePath) })
  }
  if (deps.copyFileContent) {
    const copyFileContent = deps.copyFileContent
    const readPath = ctx.relPath ?? ctx.absolutePath
    items.push({ id: 'copy-content', label: deps.t('openWith.copyFileContent'), icon: 'copy', onSelect: () => copyFileContent(readPath) })
  }
  for (const target of targets.filter((x) => x.kind === 'file_manager')) {
    items.push({ id: `fm:${target.id}`, label: deps.t('openWith.revealInTarget', { target: target.label }), icon: 'file-manager', target, onSelect: () => deps.openTarget(target.id, ctx.absolutePath) })
  }
  return items
}
