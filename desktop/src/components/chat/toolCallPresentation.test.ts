import { describe, expect, it } from 'vitest'
import { translate } from '../../i18n'
import {
  countDiffLines,
  countReadLines,
  hasToolVerb,
  parseSearchResult,
  parseShellExitCode,
  parseTodos,
  toolVerb,
} from './toolCallPresentation'

const zh = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate('zh', key, params)

describe('toolVerb', () => {
  it('leads a row with a verb, never the raw tool name', () => {
    expect(toolVerb('Grep', zh)).toBe('搜索')
    expect(toolVerb('Read', zh)).toBe('读取')
    expect(toolVerb('Bash', zh)).toBe('运行')
    expect(toolVerb('TodoWrite', zh)).toBe('更新任务清单')
    expect(toolVerb('TodoWrite', zh)).not.toContain('TodoWrite')
  })

  it('keeps an unknown tool its own name, since that is all that says what it is', () => {
    expect(hasToolVerb('mcp__linear__create_issue')).toBe(false)
    expect(toolVerb('mcp__linear__create_issue', zh)).toBe('mcp__linear__create_issue')
  })
})

describe('countDiffLines', () => {
  it('does not count a deletion for a brand-new file', () => {
    // Write diffs against ''. Splitting '' yields [''], which used to report a
    // phantom "−1" on every new file.
    expect(countDiffLines('', 'a\nb\nc')).toEqual({ additions: 3, deletions: 0 })
  })

  it('counts changed lines on both sides', () => {
    expect(countDiffLines('a\nb\nc', 'a\nB\nc\nd')).toEqual({ additions: 2, deletions: 1 })
  })
})

describe('parseSearchResult', () => {
  it('reads content-mode grep lines into file:line rows', () => {
    const parsed = parseSearchResult('src/a.ts:12:const x = 1\nsrc/a.ts:30:x += 1\nsrc/b.ts:4:return x')
    expect(parsed).toEqual({
      fileCount: 2,
      matchCount: 3,
      rows: [
        { file: 'src/a.ts', line: 12, code: 'const x = 1' },
        { file: 'src/a.ts', line: 30, code: 'x += 1' },
        { file: 'src/b.ts', line: 4, code: 'return x' },
      ],
    })
  })

  it('skips the separators between context groups', () => {
    expect(parseSearchResult('a.ts:1:one\n--\nb.ts:9:two')?.matchCount).toBe(2)
  })

  it('reads a files-with-matches list under its banner', () => {
    const parsed = parseSearchResult('Found 2 files\n/repo/src/a.ts\n/repo/src/b.ts')
    expect(parsed?.fileCount).toBe(2)
    expect(parsed?.matchCount).toBeUndefined()
    expect(parsed?.rows.map((row) => row.file)).toEqual(['/repo/src/a.ts', '/repo/src/b.ts'])
  })

  it('reports an empty search as zero files', () => {
    expect(parseSearchResult('No files found')).toEqual({ rows: [], fileCount: 0 })
  })

  it('gives up on text it does not recognise, so the raw output still shows', () => {
    expect(parseSearchResult('error: regex parse error:\n    (unclosed')).toBeNull()
  })
})

describe('parseShellExitCode', () => {
  it('reads the code the CLI reports for a failed command', () => {
    expect(parseShellExitCode('fatal: bad revision\nExit code 128', true)).toBe(128)
  })

  it('treats a successful result as exit 0', () => {
    expect(parseShellExitCode('ok', false)).toBe(0)
  })

  it('does not invent a code for a failure that carries none', () => {
    expect(parseShellExitCode('InputValidationError', true)).toBeNull()
  })
})

describe('parseTodos', () => {
  it('keeps each item and its state, defaulting unknown states to pending', () => {
    expect(parseTodos({
      todos: [
        { content: 'Read the form', status: 'completed' },
        { content: 'Extract validators', status: 'in_progress' },
        { content: 'Add tests', status: 'whatever' },
        { content: '', status: 'pending' },
      ],
    })).toEqual([
      { content: 'Read the form', status: 'completed' },
      { content: 'Extract validators', status: 'in_progress' },
      { content: 'Add tests', status: 'pending' },
    ])
  })

  it('returns null when the input carries no list', () => {
    expect(parseTodos({})).toBeNull()
  })
})

describe('countReadLines', () => {
  it('ignores the reminders appended to a Read result', () => {
    expect(countReadLines('1\tconst a = 1\n2\tconst b = 2\n<system-reminder>\nnote\n</system-reminder>\n')).toBe(2)
  })
})
