import { isEditorOpenableFile, isWorkspaceDocumentFile } from './fileCapabilities'
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
  { re: /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonl|css|scss|less|py|rs|go|java|rb|php|c|cc|cpp|h|hpp|sh|ya?ml|toml|xml|sql)$/i, key: 'code', icon: 'code' },
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
 * (markdown / html / image / a document the workspace renders). Source files
 * (.ts/.json/.css …) return false. Used only to sort rich-preview files ahead of
 * generic source rows. Documents come from the same set the preview gate uses, so
 * the ordering cannot disagree with what actually opens.
 */
export function isPreviewableChangedFile(path: string): boolean {
  return PREVIEWABLE_CHANGED_FILE_RE.test(path) || isWorkspaceDocumentFile(path)
}

// ─── Open-with items ──────────────────────────────────────────────────────────

export type OpenWithIcon = 'in-app-browser' | 'system' | 'application' | 'ide' | 'file-manager' | 'preview' | 'copy'

export type OpenWithItem = {
  id: string
  label: string
  icon: OpenWithIcon
  target?: OpenTarget          // present for native app / IDE / file-manager items
  /** Start a new group here. Set by the builder, which is what knows the sections. */
  separatorBefore?: boolean
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
  /**
   * Which editor gets the single top-level slot. Falls back to the first one
   * detected — the point is that the slot is predictable, so it must not be
   * derived from whatever the user happened to open last.
   */
  preferredEditorTargetId?: string
  t: (key: string, vars?: Record<string, string>) => string
}

export type OpenWithContext =
  | { kind: 'url'; url: string }
  | { kind: 'file'; absolutePath: string; relPath?: string; previewable?: boolean; inAppBrowserUrl?: string }

/**
 * How many rows the "open in…" group may hold — the default application, the
 * preferred editor, the associated applications, and whatever editors still fit.
 * Six keeps the whole menu inside a short window without a scrollbar.
 */
export const MAX_OPEN_WITH_ROWS = 6

/**
 * The file manager is named, not interpolated.
 *
 * The server's label is a plain identifier ("Finder", "Explorer", "File Manager")
 * with no locale behind it, so `Reveal in {target}` produced "在 Explorer 中显示"
 * — an English name inside a Chinese sentence, and not even the name Windows uses
 * for it. Same platform-keyed shape the sidebar settled on in #1236.
 */
function revealKeyForPlatform(platform: string): string {
  switch (platform) {
    case 'darwin': return 'openWith.revealIn.darwin'
    case 'win32': return 'openWith.revealIn.win32'
    case 'linux': return 'openWith.revealIn.linux'
    default: return 'openWith.revealIn.default'
  }
}

/** Mark the first entry of a group, so the menu can rule a line above it. */
function pushGroup(items: OpenWithItem[], group: OpenWithItem[]): void {
  const [first, ...rest] = group
  if (!first) return
  items.push(items.length > 0 ? { ...first, separatorBefore: true } : first)
  items.push(...rest)
}

export function buildOpenWithItems(ctx: OpenWithContext, targets: OpenTarget[], deps: OpenWithDeps): OpenWithItem[] {
  const items: OpenWithItem[] = []
  if (ctx.kind === 'url') {
    items.push({ id: 'in-app', label: deps.t('openWith.inAppBrowser'), icon: 'in-app-browser', onSelect: () => deps.openInAppBrowser(ctx.url) })
    items.push({ id: 'system', label: deps.t('openWith.systemBrowser'), icon: 'system', onSelect: () => deps.openSystem(ctx.url) })
    return items
  }

  const inApp: OpenWithItem[] = []
  if (ctx.previewable && ctx.relPath != null) {
    const relPath = ctx.relPath
    inApp.push({ id: 'preview', label: deps.t('openWith.workspacePreview'), icon: 'preview', onSelect: () => deps.openWorkspacePreview(relPath) })
  }
  if (ctx.inAppBrowserUrl) {
    const url = ctx.inAppBrowserUrl
    inApp.push({ id: 'in-app', label: deps.t('openWith.inAppBrowser'), icon: 'in-app-browser', onSelect: () => deps.openInAppBrowser(url) })
  }
  pushGroup(items, inApp)

  const applications = targets.filter((target) => target.kind === 'application')
  const defaultApplication = applications.find((target) => target.isDefault)
  const systemTarget = targets.find((target) => target.kind === 'system_default')

  // "System default" named after the application it will actually open. The row
  // still launches through the system-default target, not through that
  // application: only that path carries the guard that refuses to hand an
  // executable to the shell. So this is a label and an icon, nothing more.
  const systemItem: OpenWithItem = {
    id: 'system',
    label: defaultApplication
      ? deps.t('openWith.openInDefaultTarget', { target: defaultApplication.label })
      : deps.t('openWith.systemDefault'),
    icon: 'system',
    ...(defaultApplication ? { target: defaultApplication } : systemTarget ? { target: systemTarget } : {}),
    onSelect: systemTarget
      ? () => deps.openTarget(systemTarget.id, ctx.absolutePath)
      : () => deps.openSystem(ctx.absolutePath),
  }

  const editors = isEditorOpenableFile(ctx.absolutePath)
    ? targets.filter((target) => target.kind === 'ide')
    : []
  const preferredEditor = editors.find((target) => target.id === deps.preferredEditorTargetId) ?? editors[0]

  const openInItem = (target: OpenTarget, icon: 'ide' | 'application'): OpenWithItem => ({
    id: `${icon === 'ide' ? 'ide' : 'app'}:${target.id}`,
    label: deps.t('openWith.openInTarget', { target: target.label }),
    icon,
    target,
    onSelect: () => deps.openTarget(target.id, ctx.absolutePath),
  })

  const openWith: OpenWithItem[] = [systemItem]
  if (preferredEditor) openWith.push(openInItem(preferredEditor, 'ide'))
  for (const target of applications) {
    // The named row above already covers the default application.
    if (target !== defaultApplication) openWith.push(openInItem(target, 'application'))
  }
  // Only one editor gets a guaranteed slot, because on macOS the rest of this
  // group is a list of associated applications competing for the same space.
  // Where that list does not exist — Windows and Linux have no LaunchServices
  // equivalent, so the server returns none — the space is free, and dropping the
  // other installed editors would cost the user something and buy nothing.
  for (const target of editors) {
    if (openWith.length >= MAX_OPEN_WITH_ROWS) break
    if (target === preferredEditor) continue
    openWith.push(openInItem(target, 'ide'))
  }
  pushGroup(items, openWith)

  // Copy entries sit between "open in…" and "reveal in…", matching the order the
  // platform file managers use.
  const clipboard: OpenWithItem[] = []
  if (deps.copyPath) {
    const copyPath = deps.copyPath
    clipboard.push({ id: 'copy-path', label: deps.t('openWith.copyPath'), icon: 'copy', onSelect: () => copyPath(ctx.absolutePath) })
  }
  if (deps.copyFileContent) {
    const copyFileContent = deps.copyFileContent
    const readPath = ctx.relPath ?? ctx.absolutePath
    clipboard.push({ id: 'copy-content', label: deps.t('openWith.copyFileContent'), icon: 'copy', onSelect: () => copyFileContent(readPath) })
  }
  pushGroup(items, clipboard)

  pushGroup(items, targets
    .filter((target) => target.kind === 'file_manager')
    .map((target) => ({
      id: `fm:${target.id}`,
      label: deps.t(revealKeyForPlatform(target.platform)),
      icon: 'file-manager' as const,
      target,
      onSelect: () => deps.openTarget(target.id, ctx.absolutePath),
    })))

  return items
}
