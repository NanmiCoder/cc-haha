import { describe, expect, it } from 'vitest'
import { translate } from '../../i18n'
import {
  countDiffLines,
  countReadLines,
  describeBrowserToolCall,
  formatTakeoverReason,
  hasToolVerb,
  isBrowserUseToolName,
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

describe('Browser Use presentation helpers', () => {
  const en = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate('en', key, params)

  it('formats BrowserTabs action="open" with URL just like "new"', () => {
    expect(describeBrowserToolCall('BrowserTabs', { action: 'open', url: 'https://example.com' }, en)).toEqual([
      { id: 'tabs-new', label: 'Open new tab: https://example.com' },
    ])
    expect(describeBrowserToolCall('BrowserTabs', { action: 'open' }, en)).toEqual([
      { id: 'tabs-new', label: 'Open new browser tab' },
    ])
  })

  it('maps raw takeover reason codes to localized copy instead of showing raw codes', () => {
    expect(formatTakeoverReason('user_requested', 'user_requested', en)).toBe('You took over browser control')
    expect(formatTakeoverReason('login', undefined, en)).toBe('Sign in to continue')
    expect(formatTakeoverReason('2fa', undefined, en)).toBe('Complete two-factor verification')
    expect(formatTakeoverReason('two_factor', undefined, en)).toBe('Complete two-factor verification')
    expect(formatTakeoverReason('captcha', undefined, en)).toBe('Complete the verification challenge (CAPTCHA)')
    expect(formatTakeoverReason('payment', undefined, en)).toBe('Review and confirm payment details')
    expect(formatTakeoverReason('destructive', undefined, en)).toBe('Confirm this sensitive action in the browser')
    expect(formatTakeoverReason('sensitive_confirm', 'sensitive_confirm', en)).toBe('Confirm this sensitive action in the browser')
    expect(formatTakeoverReason('permission', undefined, en)).toBe('Review and grant the browser permission prompt')
    expect(formatTakeoverReason('manual_help', undefined, en)).toBe('Complete this manual step in the browser')
    expect(formatTakeoverReason('unknown_code', undefined, en)).toBe('Please complete this step in the browser')
    expect(formatTakeoverReason('manual', 'Finish checkout form', en)).toBe('Finish checkout form')
  })

  it('describes all Browser Use tools and BrowserAct action variants cleanly', () => {
    expect(isBrowserUseToolName('BrowserAct')).toBe(true)
    expect(isBrowserUseToolName('Bash')).toBe(false)

    expect(describeBrowserToolCall('BrowserNavigate', { action: 'back' }, en)[0]?.label).toBe('Go back')
    expect(describeBrowserToolCall('BrowserNavigate', { action: 'forward' }, en)[0]?.label).toBe('Go forward')
    expect(describeBrowserToolCall('BrowserNavigate', { action: 'reload' }, en)[0]?.label).toBe('Reload page')
    expect(describeBrowserToolCall('BrowserNavigate', { url: 'https://a.test' }, en)[0]?.label).toBe('Open https://a.test')
    expect(describeBrowserToolCall('BrowserNavigate', {}, en)[0]?.label).toBe('Navigate to page')

    expect(describeBrowserToolCall('BrowserSnapshot', { screenshot: true }, en)[0]?.label).toBe('Read page structure and screenshot')
    expect(describeBrowserToolCall('BrowserSnapshot', {}, en)[0]?.label).toBe('Read page structure')

    expect(describeBrowserToolCall('BrowserTabs', { action: 'close' }, en)[0]?.label).toBe('Close browser tab')
    expect(describeBrowserToolCall('BrowserTabs', { action: 'focus' }, en)[0]?.label).toBe('Switch browser tab')
    expect(describeBrowserToolCall('BrowserTabs', { action: 'list' }, en)[0]?.label).toBe('List browser tabs')

    expect(describeBrowserToolCall('BrowserInspect', { kind: 'console' }, en)[0]?.label).toBe('Inspect console logs')
    expect(describeBrowserToolCall('BrowserInspect', { kind: 'network' }, en)[0]?.label).toBe('Inspect network requests')
    expect(describeBrowserToolCall('BrowserInspect', { kind: 'eval' }, en)[0]?.label).toBe('Inspect page state')
    expect(describeBrowserToolCall('BrowserInspect', { kind: 'text' }, en)[0]?.label).toBe('Read page content')

    expect(describeBrowserToolCall('BrowserTakeover', { reason: 'captcha' }, en)[0]?.label).toContain('CAPTCHA')
    expect(describeBrowserToolCall('UnknownTool', {}, en)[0]?.label).toBe('UnknownTool')

    expect(describeBrowserToolCall('BrowserAct', { steps: [] }, en)[0]?.label).toBe('Interact with page')
    const steps = describeBrowserToolCall('BrowserAct', {
      steps: [
        { action: 'click', label: '@e12' },
        { action: 'dblclick', label: 'Row 1' },
        { action: 'dblclick' },
        { action: 'fill', label: 'Password', text: 's3cr3t', sensitive: true },
        { action: 'type', text: 'plain' },
        { action: 'press', key: 'Enter' },
        { action: 'select', label: 'Country', value: 'US' },
        { action: 'select', value: 'UK' },
        { action: 'hover', label: 'Menu' },
        { action: 'hover' },
        { action: 'scroll' },
        { action: 'wait' },
        { action: 'dialog', accept: true },
        { action: 'dialog', accept: false },
        { action: 'other' },
      ],
    }, en)
    expect(steps.map((s) => s.label)).toEqual([
      'Click element',
      'Double-click "Row 1"',
      'Double-click element',
      'Enter "••••••" in "Password"',
      'Type "plain"',
      'Press Enter',
      'Select "US" in "Country"',
      'Select "UK"',
      'Hover over "Menu"',
      'Hover over element',
      'Scroll page',
      'Wait for page update',
      'Accept browser dialog',
      'Dismiss browser dialog',
      'Interact with page',
    ])
  })
})
