import type { DiffLine } from '../../core/operations'

/**
 * 文件审批的预览改动。工具输入里只有旧/新文本，没有行号，所以 DiffLine 不带
 * before/after；视图用单栏空行号显示。
 */
export type FileChange = {
  path: string
  lines: DiffLine[]
  added: number
  removed: number
}

/** Write 预览最多展示这么多行，其余折成“还有 N 行”。 */
export const WRITE_PREVIEW_LINES = 120
/** Edit/MultiEdit 预览的总行数上限，避免一次渲染上千行。 */
export const EDIT_PREVIEW_LINES = 400
/** 超过这个规模就不做逐行 LCS，直接按“全删 + 全加”展示。 */
const LCS_CELL_LIMIT = 250_000

const str = (value: unknown) => (typeof value === 'string' ? value : undefined)

export function splitLines(value: string) {
  if (!value) return []
  const lines = value.replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** 逐行比较：公共前后缀作上下文，中间部分做 LCS，规模太大时退回全删全加。 */
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
        // 平手时先删后加，和统一 diff 的习惯一致。
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
    { text: `还有 ${lines.length - max} 行`, kind: 'meta' },
  ]
}

/** Edit / MultiEdit / NotebookEdit / Write 的改动预览；输入不完整时返回 null。 */
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
          ? [{ text: '@@ 替换文件里所有相同内容 @@', kind: 'hunk' }, ...lines]
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
            text: `@@ 第 ${index + 1} 处${edit.all ? '（替换所有相同内容）' : ''} @@`,
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
        lines: [{ text: '@@ 删除这个单元格 @@', kind: 'hunk' }],
        added: 0,
        removed: 0,
      }
    const source = str(input.new_source)
    if (source === undefined) return null
    // 单元格原内容不在输入里，只展示新内容。
    const lines = splitLines(source).map(
      (text): DiffLine => ({ text, kind: 'add' })
    )
    return {
      path,
      lines: limit(
        [
          {
            text: mode === 'insert' ? '@@ 新增单元格 @@' : '@@ 替换单元格内容 @@',
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
