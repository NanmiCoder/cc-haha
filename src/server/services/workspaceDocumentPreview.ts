import * as path from 'node:path'

/**
 * Document formats the workspace panel renders in the renderer from raw bytes.
 *
 * This table is the single source of truth for what the server will hand to a
 * viewer: `WorkspaceService.readFile` uses it to classify a path without reading
 * it, and the `raw` route uses it as an allowlist. The desktop keeps a mirror in
 * `desktop/src/lib/fileCapabilities.ts` — link routing has to be synchronous, so
 * it cannot ask the server — and a parity test pins the two together.
 */
export type WorkspaceDocumentPreviewType = 'pdf' | 'docx' | 'xlsx'

export type WorkspaceDocumentFormat = {
  previewType: WorkspaceDocumentPreviewType
  mimeType: string
  /**
   * Largest file a viewer is offered. Parsing runs on the renderer's main thread
   * (Office packages) or holds the whole file in memory (PDF), so this is a
   * memory/latency guard, not a transport limit.
   */
  maxBytes: number
}

const MIB = 1024 * 1024

export const WORKSPACE_DOCUMENT_FORMATS: Readonly<Record<string, WorkspaceDocumentFormat>> = {
  pdf: {
    previewType: 'pdf',
    mimeType: 'application/pdf',
    maxBytes: 100 * MIB,
  },
  docx: {
    previewType: 'docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    maxBytes: 30 * MIB,
  },
  xlsx: {
    previewType: 'xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    maxBytes: 30 * MIB,
  },
  xlsm: {
    previewType: 'xlsx',
    mimeType: 'application/vnd.ms-excel.sheet.macroEnabled.12',
    maxBytes: 30 * MIB,
  },
  // The binary workbook of Excel 97-2003. Same viewer as the zipped formats.
  xls: {
    previewType: 'xlsx',
    mimeType: 'application/vnd.ms-excel',
    maxBytes: 30 * MIB,
  },
  // Delimited text is plain text, but it is read as a table. The viewer decodes it
  // whole before it keeps the first rows, so the limit is lower than a workbook's.
  csv: {
    previewType: 'xlsx',
    mimeType: 'text/csv',
    maxBytes: 10 * MIB,
  },
  tsv: {
    previewType: 'xlsx',
    mimeType: 'text/tab-separated-values',
    maxBytes: 10 * MIB,
  },
}

/** Extensions (without the dot) the workspace can preview as documents. */
export function workspaceDocumentExtensions(): string[] {
  return Object.keys(WORKSPACE_DOCUMENT_FORMATS)
}

/**
 * Classify a path by extension alone. Nothing is read: the caller decides
 * whether the file is small enough, and the viewer reports files that are not
 * really that format.
 */
export function documentFormatForPath(filePath: string): WorkspaceDocumentFormat | null {
  const extension = path.extname(filePath).slice(1).toLowerCase()
  return WORKSPACE_DOCUMENT_FORMATS[extension] ?? null
}

/**
 * Changes whenever the file's content may have changed, so a viewer holding an
 * older render knows to fetch again. mtime alone misses a same-instant rewrite
 * and size alone misses an in-place edit; together they are what a watcher
 * event would also have to move.
 */
export function workspaceFileVersion(stat: { mtimeMs: number; size: number }): string {
  return `${stat.mtimeMs}-${stat.size}`
}
