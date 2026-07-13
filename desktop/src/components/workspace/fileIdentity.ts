import type { WorkspaceFileStatus } from '../../api/sessions'
import type { TranslationKey } from '../../i18n'

export type WorkspaceFileIdentity = {
  shortLabel: string
  languageLabel: string
  icon: 'code' | 'config' | 'document' | 'image' | 'file'
}

type Translate = (key: TranslationKey) => string

const SPECIAL_BASENAMES: Record<string, WorkspaceFileIdentity> = {
  dockerfile: { shortLabel: 'DKR', languageLabel: 'Dockerfile', icon: 'config' },
  makefile: { shortLabel: 'MAKE', languageLabel: 'Makefile', icon: 'config' },
  '.gitignore': { shortLabel: 'GIT', languageLabel: 'Git ignore', icon: 'config' },
  '.gitattributes': { shortLabel: 'GIT', languageLabel: 'Git attributes', icon: 'config' },
  '.editorconfig': { shortLabel: 'CFG', languageLabel: 'EditorConfig', icon: 'config' },
  license: { shortLabel: 'TXT', languageLabel: 'Plain text', icon: 'document' },
  readme: { shortLabel: 'TXT', languageLabel: 'Plain text', icon: 'document' },
}

const EXTENSIONS: Record<string, WorkspaceFileIdentity> = {
  ts: { shortLabel: 'TS', languageLabel: 'TypeScript', icon: 'code' },
  tsx: { shortLabel: 'TSX', languageLabel: 'TypeScript React', icon: 'code' },
  js: { shortLabel: 'JS', languageLabel: 'JavaScript', icon: 'code' },
  jsx: { shortLabel: 'JSX', languageLabel: 'JavaScript React', icon: 'code' },
  py: { shortLabel: 'PY', languageLabel: 'Python', icon: 'code' },
  go: { shortLabel: 'GO', languageLabel: 'Go', icon: 'code' },
  rs: { shortLabel: 'RS', languageLabel: 'Rust', icon: 'code' },
  java: { shortLabel: 'JAVA', languageLabel: 'Java', icon: 'code' },
  kt: { shortLabel: 'KT', languageLabel: 'Kotlin', icon: 'code' },
  swift: { shortLabel: 'SWIFT', languageLabel: 'Swift', icon: 'code' },
  c: { shortLabel: 'C', languageLabel: 'C', icon: 'code' },
  cc: { shortLabel: 'C++', languageLabel: 'C++', icon: 'code' },
  cpp: { shortLabel: 'C++', languageLabel: 'C++', icon: 'code' },
  h: { shortLabel: 'H', languageLabel: 'C header', icon: 'code' },
  css: { shortLabel: 'CSS', languageLabel: 'CSS', icon: 'code' },
  scss: { shortLabel: 'SCSS', languageLabel: 'SCSS', icon: 'code' },
  html: { shortLabel: 'HTML', languageLabel: 'HTML', icon: 'code' },
  sh: { shortLabel: 'SH', languageLabel: 'Shell script', icon: 'code' },
  bash: { shortLabel: 'SH', languageLabel: 'Bash script', icon: 'code' },
  zsh: { shortLabel: 'ZSH', languageLabel: 'Z shell script', icon: 'code' },
  yaml: { shortLabel: 'YAML', languageLabel: 'YAML', icon: 'config' },
  yml: { shortLabel: 'YAML', languageLabel: 'YAML', icon: 'config' },
  json: { shortLabel: 'JSON', languageLabel: 'JSON', icon: 'config' },
  toml: { shortLabel: 'TOML', languageLabel: 'TOML', icon: 'config' },
  ini: { shortLabel: 'INI', languageLabel: 'INI configuration', icon: 'config' },
  env: { shortLabel: 'ENV', languageLabel: 'Environment configuration', icon: 'config' },
  md: { shortLabel: 'MD', languageLabel: 'Markdown', icon: 'document' },
  markdown: { shortLabel: 'MD', languageLabel: 'Markdown', icon: 'document' },
  txt: { shortLabel: 'TXT', languageLabel: 'Plain text', icon: 'document' },
  png: { shortLabel: 'IMG', languageLabel: 'PNG image', icon: 'image' },
  jpg: { shortLabel: 'IMG', languageLabel: 'JPEG image', icon: 'image' },
  jpeg: { shortLabel: 'IMG', languageLabel: 'JPEG image', icon: 'image' },
  gif: { shortLabel: 'IMG', languageLabel: 'GIF image', icon: 'image' },
  webp: { shortLabel: 'IMG', languageLabel: 'WebP image', icon: 'image' },
  svg: { shortLabel: 'SVG', languageLabel: 'SVG image', icon: 'image' },
}

export function getFileIdentity(path: string): WorkspaceFileIdentity {
  const basename = path.replace(/\\/g, '/').split('/').pop() || path
  const normalizedBasename = basename.toLowerCase()
  const special = SPECIAL_BASENAMES[normalizedBasename]
  if (special) return special

  const extensionIndex = normalizedBasename.lastIndexOf('.')
  const extension = extensionIndex >= 0 ? normalizedBasename.slice(extensionIndex + 1) : ''
  const known = EXTENSIONS[extension]
  if (known) return known

  if (!extension) {
    return { shortLabel: 'TXT', languageLabel: 'Plain text', icon: 'document' }
  }

  return {
    shortLabel: extension.slice(0, 4).toUpperCase(),
    languageLabel: `${extension.toUpperCase()} file`,
    icon: 'file',
  }
}

const STATUS_KEYS: Record<WorkspaceFileStatus, TranslationKey> = {
  modified: 'workspace.status.modified',
  added: 'workspace.status.added',
  deleted: 'workspace.status.deleted',
  renamed: 'workspace.status.renamed',
  untracked: 'workspace.status.untracked',
  copied: 'workspace.status.copied',
  type_changed: 'workspace.status.typeChanged',
  unknown: 'workspace.status.unknown',
}

export function getWorkspaceStatusLabel(status: WorkspaceFileStatus, t: Translate) {
  return t(STATUS_KEYS[status])
}
