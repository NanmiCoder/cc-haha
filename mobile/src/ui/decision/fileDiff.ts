import type { DiffLine } from '../../core/operations'
import { plural } from '../../core/plural'

/**
 * Preview changes for file approvals. The tool input only has old/new text without line numbers, so DiffLine does not carry
 * before/after; the view shows a single column with empty line numbers.
 */
export type FileChange = {
  path: string
  lines: DiffLine[]
  added: number
  removed: number
}

/** Write The preview shows at most this many lines; the rest fold into "N more lines". */
export const WRITE_PREVIEW_LINES = 120
/** Edit/MultiEdit Total line cap for the preview, to avoid rendering thousands of lines at once. */
export const EDIT_PREVIEW_LINES = 400
/** Beyond this size skip line-by-line LCS and show as "delete all + add all". */
const LCS_CELL_LIMIT = 250_000

const str = (value: unknown) => (typeof value === 'string' ? value : undefined)

export function splitLines(value: string) {
  if (!value) return []
  const lines = value.replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Line-by-line comparison: common prefix and suffix as context, LCS on the middle, falling back to delete all + add all when too large. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const context = (text: string): DiffLine => ({ text, kind: 'context' })
  const head = a.slice(0, start).map(context)
  const tail = a.slice(endA).map(context)
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  let middle: DiffLine[]
  if (midA.length * midB.length > LCS_CELL_LIMIT) {
    middle = [
      ...midA.map((text): DiffLine => ({ text, kind: 'remove' })),
      ...midB.map((text): DiffLine => ({ text, kind: 'add' })),
    ]
  } else {
    const rows = midA.length
    const cols = midB.length
    const table = Array.from({ length: rows + 1 }, () =>
      new Array<number>(cols + 1).fill(0)
    )
    for (let i = rows - 1; i >= 0; i--)
      for (let j = cols - 1; j >= 0; j--)
        table[i][j] =
          midA[i] === midB[j]
            ? table[i + 1][j + 1] + 1
            : Math.max(table[i + 1][j], table[i][j + 1])
    middle = []
    let i = 0
    let j = 0
    while (i < rows && j < cols) {
      if (midA[i] === midB[j]) {
        middle.push(context(midA[i]))
        i++
        j++
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        // On ties delete before add, matching unified diff convention.
        middle.push({ text: midA[i], kind: 'remove' })
        i++
      } else {
        middle.push({ text: midB[j], kind: 'add' })
        j++
      }
    }
    for (; i < rows; i++) middle.push({ text: midA[i], kind: 'remove' })
    for (; j < cols; j++) middle.push({ text: midB[j], kind: 'add' })
  }
  return [...head, ...middle, ...tail]
}

const count = (lines: DiffLine[], kind: DiffLine['kind']) =>
  lines.filter((line) => line.kind === kind).length

function limit(lines: DiffLine[], max: number): DiffLine[] {
  if (lines.length <= max) return lines
  return [
    ...lines.slice(0, max),
    { text: plural(lines.length - max, 'more line'), kind: 'meta' },
  ]
}

/** Edit / MultiEdit / NotebookEdit / Write change preview; returns null when the input is incomplete. */
export function fileChange(
  toolName: string,
  input: Record<string, unknown>
): FileChange | null {
  const path = str(input.file_path) ?? str(input.notebook_path) ?? ''
  if (toolName === 'Edit') {
    const before = str(input.old_string)
    const after = str(input.new_string)
    if (before === undefined || after === undefined) return null
    const lines = lineDiff(before, after)
    return {
      path,
      lines: limit(
        input.replace_all === true
          ? [{ text: '@@ Replace all occurrences in the file @@', kind: 'hunk' }, ...lines]
          : lines,
        EDIT_PREVIEW_LINES
      ),
      added: count(lines, 'add'),
      removed: count(lines, 'remove'),
    }
  }
  if (toolName === 'MultiEdit') {
    if (!Array.isArray(input.edits)) return null
    const edits = input.edits.flatMap((edit: unknown) => {
      if (!edit || typeof edit !== 'object') return []
      const value = edit as Record<string, unknown>
      const before = str(value.old_string)
      const after = str(value.new_string)
      return before === undefined || after === undefined
        ? []
        : [{ lines: lineDiff(before, after), all: value.replace_all === true }]
    })
    if (!edits.length) return null
    const all = edits.flatMap((edit) => edit.lines)
    return {
      path,
      lines: limit(
        edits.flatMap((edit, index): DiffLine[] => [
          {
            text: `@@ Change ${index + 1}${edit.all ? ' (replace all occurrences)' : ''} @@`,
            kind: 'hunk',
          },
          ...edit.lines,
        ]),
        EDIT_PREVIEW_LINES
      ),
      added: count(all, 'add'),
      removed: count(all, 'remove'),
    }
  }
  if (toolName === 'Write') {
    const content = str(input.content)
    if (content === undefined) return null
    const lines = splitLines(content).map(
      (text): DiffLine => ({ text, kind: 'add' })
    )
    return {
      path,
      lines: limit(lines, WRITE_PREVIEW_LINES),
      added: lines.length,
      removed: 0,
    }
  }
  if (toolName === 'NotebookEdit') {
    const mode = str(input.edit_mode) ?? 'replace'
    if (mode === 'delete')
      return {
        path,
        lines: [{ text: '@@ Delete this cell @@', kind: 'hunk' }],
        added: 0,
        removed: 0,
      }
    const source = str(input.new_source)
    if (source === undefined) return null
    // The original cell content is not in the input; only the new content is shown.
    const lines = splitLines(source).map(
      (text): DiffLine => ({ text, kind: 'add' })
    )
    return {
      path,
      lines: limit(
        [
          {
            text: mode === 'insert' ? '@@ New cell @@' : '@@ Replace cell content @@',
            kind: 'hunk',
          },
          ...lines,
        ],
        WRITE_PREVIEW_LINES
      ),
      added: lines.length,
      removed: 0,
    }
  }
  return null
}
