import { LINKABLE_FILE_EXTENSIONS } from './filePathBoundary'

const SYSTEM_OPEN_EXTENSIONS: ReadonlySet<string> = new Set([
  // Office and document packages are binary containers, not source previews.
  'pdf', 'doc', 'docx', 'docm', 'odt', 'rtf', 'pages',
  'xls', 'xlsx', 'xlsm', 'ods', 'numbers',
  'ppt', 'pptx', 'pptm', 'odp', 'key',
  // Archives and media should use the user's associated desktop application.
  'zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz',
  'mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg', 'opus',
  'mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi',
])

// These are user-facing deliverables often created without being repeated in the
// final prose. Source files stay in the changed-file card unless the assistant
// explicitly cites them, so a large code change does not become a wall of cards.
const GENERATED_ARTIFACT_EXTENSIONS: ReadonlySet<string> = new Set([
  'avif', 'csv', 'doc', 'docx', 'docm', 'gif', 'jpeg', 'jpg', 'md', 'mdx',
  'numbers', 'ods', 'odt', 'pages', 'pdf', 'png', 'ppt', 'pptx', 'pptm',
  'rtf', 'tsv', 'webp', 'xls', 'xlsm', 'xlsx',
])

export function fileExtension(path: string): string {
  const withoutPosition = path.replace(/(?::\d+(?::\d+)?|[#:]L\d+(?:-L?\d+)?)$/i, '')
  const basename = withoutPosition.split(/[\\/]/).pop() ?? ''
  const dot = basename.lastIndexOf('.')
  return dot > 0 && dot < basename.length - 1
    ? basename.slice(dot + 1).toLowerCase()
    : ''
}

/** Whether the workspace can render this path as text/source or an image. */
export function isWorkspacePreviewableFile(path: string): boolean {
  const extension = fileExtension(path)
  if (!extension) return true
  return LINKABLE_FILE_EXTENSIONS.has(extension) && !SYSTEM_OPEN_EXTENSIONS.has(extension)
}

/** Whether a changed file should become a deliverable card without a prose citation. */
export function isGeneratedArtifactFile(path: string): boolean {
  return GENERATED_ARTIFACT_EXTENSIONS.has(fileExtension(path))
}

/** Whether a cited path belongs in the final-output resource strip. */
export function isOutputResourceFile(path: string): boolean {
  return isGeneratedArtifactFile(path)
    || (LINKABLE_FILE_EXTENSIONS.has(fileExtension(path)) && !isWorkspacePreviewableFile(path))
}
