import type { WorkspaceDiffFile, WorkspaceDiffRow } from './workspaceDiffModel'

export type WorkspaceDiffMode = 'unified' | 'split'
export type WorkspaceDiffDisplayRow = WorkspaceDiffRow & { displayRow?: number; displayColumn?: 1 | 2 | 'both' }
export type WorkspaceDiffDisplayFile = Omit<WorkspaceDiffFile, 'rows'> & { rows: WorkspaceDiffDisplayRow[] }

/** Pair each change block while retaining the parser's source coordinates. */
export function layoutWorkspaceDiff(files: WorkspaceDiffFile[], mode: WorkspaceDiffMode): WorkspaceDiffDisplayFile[] {
  if (mode === 'unified') return files
  return files.map(file => {
    const rows: WorkspaceDiffDisplayRow[] = []
    let displayRow = 1
    let index = 0
    while (index < file.rows.length) {
      const row = file.rows[index]!
      if (row.kind === 'deletion' || row.kind === 'addition') {
        const oldRows: WorkspaceDiffRow[] = []
        const newRows: WorkspaceDiffRow[] = []
        while (index < file.rows.length && ['deletion', 'addition'].includes(file.rows[index]!.kind)) {
          const change = file.rows[index++]!
          if (change.kind === 'deletion') oldRows.push(change)
          else newRows.push(change)
        }
        for (let pair = 0; pair < Math.max(oldRows.length, newRows.length); pair++) {
          if (oldRows[pair]) rows.push({ ...oldRows[pair]!, displayColumn: 1, displayRow })
          if (newRows[pair]) rows.push({ ...newRows[pair]!, displayColumn: 2, displayRow })
          displayRow++
        }
        continue
      }
      if (row.kind === 'context') {
        rows.push({ ...row, id: `${row.id}-old`, side: 'old', displayColumn: 1, displayRow })
        rows.push({ ...row, displayColumn: 2, displayRow })
      } else rows.push({ ...row, displayColumn: 'both', displayRow })
      displayRow++
      index++
    }
    return { ...file, rows }
  })
}
