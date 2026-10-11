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

/**
 * Documents the workspace panel renders itself, from raw bytes.
 *
 * A subset of {@link SYSTEM_OPEN_EXTENSIONS} on purpose. Those extensions stay
 * "not source" for the editor menus (`isEditorOpenableFile`) — a `.pdf` opened in
 * an IDE is still not a thing anyone asked for — and only these are also
 * previewable in the workspace. A format joins this set when its viewer lands,
 * not before, and the server (`workspaceDocumentPreview.ts`) serves exactly
 * these: a parity test pins the two lists together.
 */
export const WORKSPACE_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set<string>([
  'pdf', 'docx', 'xlsx', 'xlsm', 'xls', 'csv', 'tsv',
])

/**
 * Documents that are really plain text, shown as a table. Unlike a workbook they
 * have a line diff, so a changed one is reviewed like source, not just opened.
 */
const DELIMITED_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['csv', 'tsv'])

// These are user-facing deliverables often created without being repeated in the
// final prose. Source files stay in the changed-file card unless the assistant
// explicitly cites them, so a large code change does not become a wall of cards.
const GENERATED_ARTIFACT_EXTENSIONS: ReadonlySet<string> = new Set([
  'avif', 'csv', 'doc', 'docx', 'docm', 'gif', 'jpeg', 'jpg', 'md', 'mdx',
  'numbers', 'ods', 'odt', 'pages', 'pdf', 'png', 'ppt', 'pptx', 'pptm',
  'rtf', 'tsv', 'webp', 'xls', 'xlsm', 'xlsx',
])

/**
 * Formats that only ever arrive as a *product* of a turn — an office document, a
 * PDF, a data export. Nothing in a coding session reads one as source.
 *
 * Deliberately narrower than {@link GENERATED_ARTIFACT_EXTENSIONS}: Markdown and
 * images belong there because they are user-facing deliverables, but this product
 * also reads and edits them constantly ("I'm about to look at `notes.md`"), so
 * they carry no signal about whether the turn produced anything. This set is used
 * where a mention has to be trusted *without* corroboration from the checkpoint,
 * which is exactly where that ambiguity would cost the most.
 */
const SHELL_PRODUCED_DELIVERABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  'pdf', 'doc', 'docx', 'docm', 'odt', 'rtf', 'pages',
  'xls', 'xlsx', 'xlsm', 'ods', 'numbers', 'csv', 'tsv',
  'ppt', 'pptx', 'pptm', 'odp', 'key',
])

export function fileExtension(path: string): string {
  const withoutPosition = path.replace(/(?::\d+(?::\d+)?|[#:]L\d+(?:-L?\d+)?)$/i, '')
  const basename = withoutPosition.split(/[\\/]/).pop() ?? ''
  const dot = basename.lastIndexOf('.')
  return dot > 0 && dot < basename.length - 1
    ? basename.slice(dot + 1).toLowerCase()
    : ''
}

/**
 * Whether offering a code editor for this path makes any sense.
 *
 * Driven by {@link SYSTEM_OPEN_EXTENSIONS} alone, not by what the workspace can
 * preview: an Office package, an archive or a media file is a binary container,
 * and a `.pdf` opened in PyCharm is not a thing anyone asked for — even now that
 * the panel renders it. Deliberately not a separate list of "editable"
 * extensions, which would drift from this one within a release or two.
 */
export function isEditorOpenableFile(path: string): boolean {
  return !SYSTEM_OPEN_EXTENSIONS.has(fileExtension(path))
}

/**
 * Whether this path could only be something the turn produced, so a mention of it
 * can be trusted even when the turn checkpoint has no record of it.
 */
export function isShellProducedDeliverable(path: string): boolean {
  return SHELL_PRODUCED_DELIVERABLE_EXTENSIONS.has(fileExtension(path))
}

/** Whether the workspace renders this path as a document (PDF, Word, Excel…) from raw bytes. */
export function isWorkspaceDocumentFile(path: string): boolean {
  return WORKSPACE_DOCUMENT_EXTENSIONS.has(fileExtension(path))
}

/** Whether this path is delimited text (`.csv`, `.tsv`), which the workspace shows as a table. */
export function isDelimitedTextFile(path: string): boolean {
  return DELIMITED_TEXT_EXTENSIONS.has(fileExtension(path))
}

/** Whether the workspace can render this path as text/source, an image or a document. */
export function isWorkspacePreviewableFile(path: string): boolean {
  const extension = fileExtension(path)
  if (!extension) return true
  if (WORKSPACE_DOCUMENT_EXTENSIONS.has(extension)) return true
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
