import { parseDiff } from '../../core/operations'

export type FileChange = { status: 'A' | 'M' | 'D'; added: number; removed: number }

/** Read added/modified/deleted and added/removed line counts from a single file's unified diff. */
export function fileChange(diff: string): FileChange {
  const status = /^new file mode/m.test(diff) || /^--- \/dev\/null$/m.test(diff)
    ? 'A'
    : /^deleted file mode/m.test(diff) || /^\+\+\+ \/dev\/null$/m.test(diff)
      ? 'D'
      : 'M'
  let added = 0
  let removed = 0
  for (const line of parseDiff(diff)) {
    if (line.kind === 'add') added++
    else if (line.kind === 'remove') removed++
  }
  return { status, added, removed }
}
