export type WorkspaceDiffSide = 'old' | 'new'

export type WorkspaceDiffRowKind = 'metadata' | 'hunk' | 'context' | 'deletion' | 'addition'

export interface WorkspaceDiffRow {
  id: string
  kind: WorkspaceDiffRowKind
  text: string
  prefix: string
  hunkId: string | null
  oldLine: number | null
  newLine: number | null
  side: WorkspaceDiffSide | null
  selectable: boolean
}

export interface WorkspaceDiffFile {
  id: string
  oldPath: string | null
  newPath: string | null
  rows: WorkspaceDiffRow[]
}

export interface WorkspaceDiffSelection {
  hunkId: string
  side: WorkspaceDiffSide
  startId: string
  endId: string
  rowIds: string[]
  lineStart: number
  lineEnd: number
  quote: string
}

const hunkHeaderPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

function pathFromHeader(line: string, prefix: '--- ' | '+++ '): string | null {
  const path = line.slice(prefix.length).split('\t', 1)[0] ?? ''
  if (path === '/dev/null') return null
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2)
  return path
}

export function parseWorkspaceDiff(value: string): WorkspaceDiffFile[] {
  if (!value) return []

  const files: WorkspaceDiffFile[] = []
  let file: WorkspaceDiffFile | null = null
  let hunkId: string | null = null
  let hunkIndex = 0
  let oldLine = 0
  let newLine = 0

  const startFile = (oldPath: string | null = null, newPath: string | null = null) => {
    file = {
      id: `file-${files.length}`,
      oldPath,
      newPath,
      rows: [],
    }
    files.push(file)
    hunkId = null
    hunkIndex = 0
  }

  const addRow = (
    kind: WorkspaceDiffRowKind,
    text: string,
    prefix = '',
    coordinates: Pick<WorkspaceDiffRow, 'oldLine' | 'newLine' | 'side' | 'selectable'> = {
      oldLine: null,
      newLine: null,
      side: null,
      selectable: false,
    },
  ) => {
    if (!file) startFile()
    const currentFile = file as WorkspaceDiffFile
    currentFile.rows.push({
      id: `${currentFile.id}-row-${currentFile.rows.length}`,
      kind,
      text,
      prefix,
      hunkId,
      ...coordinates,
    })
  }

  for (const line of value.split('\n')) {
    const fileHeader = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (fileHeader) {
      startFile(fileHeader[1], fileHeader[2])
      continue
    }

    if (!file) startFile()
    const currentFile = file!

    if (!hunkId && line.startsWith('--- ')) {
      currentFile.oldPath = pathFromHeader(line, '--- ')
      addRow('metadata', line)
      continue
    }
    if (!hunkId && line.startsWith('+++ ')) {
      currentFile.newPath = pathFromHeader(line, '+++ ')
      addRow('metadata', line)
      continue
    }

    const hunkHeader = hunkHeaderPattern.exec(line)
    if (hunkHeader) {
      hunkId = `${currentFile.id}-hunk-${hunkIndex}`
      hunkIndex += 1
      oldLine = Number(hunkHeader[1])
      newLine = Number(hunkHeader[3])
      addRow('hunk', line)
      continue
    }

    if (line === '\\ No newline at end of file') {
      addRow('metadata', line)
      continue
    }

    if (line.startsWith('@@') || line.startsWith('Binary ')) {
      hunkId = null
      addRow('metadata', line)
      continue
    }

    if (hunkId && line.startsWith('+')) {
      addRow('addition', line.slice(1), '+', {
        oldLine: null,
        newLine,
        side: 'new',
        selectable: true,
      })
      newLine += 1
      continue
    }
    if (hunkId && line.startsWith('-')) {
      addRow('deletion', line.slice(1), '-', {
        oldLine,
        newLine: null,
        side: 'old',
        selectable: true,
      })
      oldLine += 1
      continue
    }
    if (hunkId && line.startsWith(' ')) {
      addRow('context', line.slice(1), ' ', {
        oldLine,
        newLine,
        side: 'new',
        selectable: true,
      })
      oldLine += 1
      newLine += 1
      continue
    }

    addRow('metadata', line)
  }

  return files
}

export function getCompatibleDiffRange(
  rows: WorkspaceDiffRow[],
  anchorId: string,
  targetId: string,
): WorkspaceDiffSelection | null {
  const anchorIndex = rows.findIndex((row) => row.id === anchorId)
  const targetIndex = rows.findIndex((row) => row.id === targetId)
  if (anchorIndex < 0 || targetIndex < 0) return null

  const anchor = rows[anchorIndex]
  const target = rows[targetIndex]
  if (!anchor || !target) return null
  if (
    !anchor.selectable
    || !target.selectable
    || !anchor.hunkId
    || anchor.hunkId !== target.hunkId
    || !anchor.side
    || anchor.side !== target.side
  ) return null

  const startIndex = Math.min(anchorIndex, targetIndex)
  const endIndex = Math.max(anchorIndex, targetIndex)
  const selectedRows = rows.slice(startIndex, endIndex + 1).filter((row) => (
    row.selectable && row.hunkId === anchor.hunkId && row.side === anchor.side
  ))
  const lineNumbers = selectedRows.map((row) => (
    anchor.side === 'old' ? row.oldLine : row.newLine
  )).filter((line): line is number => line !== null)

  if (selectedRows.length === 0 || lineNumbers.length !== selectedRows.length) return null
  const firstRow = selectedRows[0]!
  const lastRow = selectedRows[selectedRows.length - 1]!

  return {
    hunkId: anchor.hunkId,
    side: anchor.side,
    startId: firstRow.id,
    endId: lastRow.id,
    rowIds: selectedRows.map((row) => row.id),
    lineStart: lineNumbers[0]!,
    lineEnd: lineNumbers[lineNumbers.length - 1]!,
    quote: selectedRows.map((row) => row.text).join('\n'),
  }
}
