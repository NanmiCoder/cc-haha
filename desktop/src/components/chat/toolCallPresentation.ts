import type { TranslationKey } from '../../i18n'

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string

/**
 * The verb a timeline row leads with. A row reads "读取 MessageList.tsx", not
 * "Read MessageList.tsx": the raw tool name is an implementation detail the
 * reader should not have to decode (`TodoWrite` least of all), so it moves to
 * the row's tooltip and the trajectory view. Tools with no verb here keep their
 * own name — an MCP tool's name is the only thing that says what it is.
 */
const TOOL_VERB_KEYS: Record<string, TranslationKey> = {
  Grep: 'toolVerb.search',
  Glob: 'toolVerb.search',
  ToolSearch: 'toolVerb.search',
  Read: 'toolVerb.read',
  Edit: 'toolVerb.edit',
  MultiEdit: 'toolVerb.edit',
  NotebookEdit: 'toolVerb.edit',
  Write: 'toolVerb.create',
  Bash: 'toolVerb.run',
  PowerShell: 'toolVerb.run',
  TodoWrite: 'toolVerb.updateTodos',
  TaskCreate: 'toolVerb.createTask',
  TaskUpdate: 'toolVerb.updateTask',
  TaskList: 'toolVerb.viewTasks',
  TaskGet: 'toolVerb.viewTasks',
  WebSearch: 'toolVerb.searchWeb',
  WebFetch: 'toolVerb.fetchWeb',
  Agent: 'toolVerb.agent',
  Skill: 'toolVerb.skill',
}

export function toolVerb(toolName: string, t: Translate): string {
  const key = TOOL_VERB_KEYS[toolName]
  return key ? t(key) : toolName
}

/** Whether the row shows a translated verb rather than the tool's own name. */
export function hasToolVerb(toolName: string): boolean {
  return toolName in TOOL_VERB_KEYS
}

export type DiffLineCounts = { additions: number; deletions: number }

/**
 * Line-level change counts for an Edit/Write preview. Deliberately the same
 * positional comparison the diff header has always used, so the `+N −N` on the
 * row and the one on the diff block it opens can never disagree.
 */
export function countDiffLines(oldString: string, newString: string): DiffLineCounts {
  const oldLines = oldString.length === 0 ? [] : oldString.split('\n')
  const newLines = newString.split('\n')
  return {
    additions: newLines.filter((line, index) => line !== (oldLines[index] ?? null)).length,
    deletions: oldLines.filter((line, index) => line !== (newLines[index] ?? null)).length,
  }
}

export type GrepRow = { file: string; line?: number; code?: string }

export type GrepResult = {
  rows: GrepRow[]
  fileCount: number
  matchCount?: number
}

const GREP_CONTENT_LINE = /^(.+?):(\d+)[:-](.*)$/
const FOUND_FILES_LINE = /^Found (\d+) files?\b/i
const NO_MATCHES_LINE = /^No (?:files|matches) found\b/i

/**
 * Read a Grep/Glob result into rows the timeline can lay out as `file:line`
 * plus code. Recognises the three shapes the CLI produces — content lines
 * (`path:12:code`), a file list under a `Found N files` banner, and a bare path
 * list from Glob. Anything else returns null and falls back to the plain output
 * block, so an unexpected format still shows the model's exact text.
 */
export function parseSearchResult(text: string): GrepResult | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((line) => line.trimEnd()).filter(Boolean)
  if (lines.length === 0) return null
  if (lines.length === 1 && NO_MATCHES_LINE.test(lines[0]!)) return { rows: [], fileCount: 0 }

  // `--` separates context groups in `-C` output; it is not a row.
  const contentLines = lines.filter((line) => line !== '--')
  const contentRows: GrepRow[] = []
  for (const line of contentLines) {
    const match = GREP_CONTENT_LINE.exec(line)
    if (!match) break
    contentRows.push({ file: match[1]!, line: Number(match[2]), code: match[3] ?? '' })
  }
  if (contentRows.length > 0 && contentRows.length === contentLines.length) {
    return {
      rows: contentRows,
      fileCount: new Set(contentRows.map((row) => row.file)).size,
      matchCount: contentRows.length,
    }
  }

  const banner = FOUND_FILES_LINE.exec(lines[0]!)
  const pathLines = banner ? lines.slice(1) : lines
  if (pathLines.length > 0 && pathLines.every(looksLikePath)) {
    return {
      rows: pathLines.map((file) => ({ file })),
      fileCount: banner ? Number(banner[1]) : pathLines.length,
    }
  }
  return null
}

function looksLikePath(line: string): boolean {
  return !/\s{2,}/.test(line) && /[/\\.]/.test(line) && !line.startsWith('(')
}

/** `Exit code 2` heads a failed shell result; a success carries no code at all. */
export function parseShellExitCode(text: string, isError: boolean): number | null {
  const match = /(?:^|\n)Exit code (\d+)\b/.exec(text)
  if (match) return Number(match[1])
  return isError ? null : 0
}

export type TodoItem = { content: string; status: 'pending' | 'in_progress' | 'completed' }

export function parseTodos(input: Record<string, unknown>): TodoItem[] | null {
  if (!Array.isArray(input.todos)) return null
  const todos: TodoItem[] = []
  for (const entry of input.todos) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const content = typeof record.content === 'string' ? record.content : ''
    if (!content) continue
    const status = record.status === 'completed' || record.status === 'in_progress' ? record.status : 'pending'
    todos.push({ content, status })
  }
  return todos
}

/** Line count of a Read result, ignoring the reminders the CLI appends. */
export function countReadLines(text: string): number {
  const body = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trimEnd()
  if (!body) return 0
  return body.split('\n').length
}

export function formatCountLabel(
  count: number,
  singular: TranslationKey,
  plural: TranslationKey,
  t: Translate,
): string {
  return t(count === 1 ? singular : plural, { count: new Intl.NumberFormat().format(count) })
}
