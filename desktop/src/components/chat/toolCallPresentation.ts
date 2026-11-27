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
  BrowserTabs: 'toolVerb.browserTabs',
  BrowserNavigate: 'toolVerb.browserNavigate',
  BrowserSnapshot: 'toolVerb.browserSnapshot',
  BrowserAct: 'toolVerb.browserAct',
  BrowserInspect: 'toolVerb.browserInspect',
  BrowserTakeover: 'toolVerb.browserTakeover',
}

export const BROWSER_USE_TOOL_NAMES = new Set([
  'BrowserTabs',
  'BrowserNavigate',
  'BrowserSnapshot',
  'BrowserAct',
  'BrowserInspect',
  'BrowserTakeover',
])

export function isBrowserUseToolName(toolName: string): boolean {
  return BROWSER_USE_TOOL_NAMES.has(toolName)
}

const SENSITIVE_FIELD_RE = /pass(?:word|code)?|secret|token|pin|otp|cvv|cvc|credit.?card|密码|口令|验证码|密钥/i
const RAW_REF_RE = /^@?e\d+$/i

export function maskSensitiveBrowserValue(
  value: string,
  sensitive?: boolean,
  label?: string,
): string {
  if (sensitive || (label && SENSITIVE_FIELD_RE.test(label))) {
    return '••••••'
  }
  return value
}

function cleanHumanTarget(label?: unknown, fallback?: string): string {
  if (typeof label === 'string') {
    const trimmed = label.trim()
    if (trimmed && !RAW_REF_RE.test(trimmed)) return trimmed
  }
  return fallback ?? ''
}

const TAKEOVER_REASON_KEYS: Record<string, TranslationKey> = {
  user_requested: 'browserUse.takeoverReason.userRequested',
  login: 'browserUse.takeoverReason.login',
  '2fa': 'browserUse.takeoverReason.twoFactor',
  two_factor: 'browserUse.takeoverReason.twoFactor',
  captcha: 'browserUse.takeoverReason.captcha',
  payment: 'browserUse.takeoverReason.payment',
  destructive: 'browserUse.takeoverReason.sensitiveConfirm',
  sensitive_confirm: 'browserUse.takeoverReason.sensitiveConfirm',
  permission: 'browserUse.takeoverReason.permission',
  manual: 'browserUse.takeoverReason.manual',
  manual_help: 'browserUse.takeoverReason.manual',
}

/**
 * Formats a browser takeover reason/message into localized copy, ensuring raw
 * internal codes such as `'user_requested'` or `'sensitive_confirm'` never
 * leak verbatim into the bottom pill or chat takeover card.
 */
export function formatTakeoverReason(
  reason: string | undefined,
  message: string | undefined,
  t: Translate,
): string {
  const trimmedMessage = message?.trim()
  if (trimmedMessage) {
    const codeKey = TAKEOVER_REASON_KEYS[trimmedMessage.toLowerCase()]
    return codeKey ? t(codeKey) : trimmedMessage
  }
  const trimmedReason = reason?.trim()
  if (trimmedReason) {
    const codeKey = TAKEOVER_REASON_KEYS[trimmedReason.toLowerCase()]
    if (codeKey) return t(codeKey)
  }
  return t('browserUse.overlay.takeoverDefaultReason')
}

export type BrowserStepDescription = {
  id: string
  label: string
  detail?: string
}

/**
 * Turns a Browser Use tool invocation into concise, human-readable activity
 * descriptions (never exposing raw `@e14` ref tokens and always masking
 * passwords/secrets to `••••••`).
 */
export function describeBrowserToolCall(
  toolName: string,
  input: unknown,
  t: Translate,
): BrowserStepDescription[] {
  const obj = input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {}

  switch (toolName) {
    case 'BrowserNavigate': {
      const action = typeof obj.action === 'string' ? obj.action : 'goto'
      const url = typeof obj.url === 'string' ? obj.url.trim() : ''
      if (action === 'back') return [{ id: 'nav-back', label: t('browserUse.action.back') }]
      if (action === 'forward') return [{ id: 'nav-fwd', label: t('browserUse.action.forward') }]
      if (action === 'reload') return [{ id: 'nav-reload', label: t('browserUse.action.reload') }]
      return [{
        id: 'nav-goto',
        label: url ? t('browserUse.action.navigateUrl', { url }) : t('browserUse.action.navigate'),
      }]
    }
    case 'BrowserSnapshot':
      return [{
        id: 'snapshot',
        label: obj.screenshot ? t('browserUse.action.snapshotScreenshot') : t('browserUse.action.snapshot'),
      }]
    case 'BrowserTabs': {
      const action = typeof obj.action === 'string' ? obj.action : 'list'
      const url = typeof obj.url === 'string' ? obj.url.trim() : ''
      if (action === 'open' || action === 'new') {
        return [{
          id: 'tabs-new',
          label: url ? t('browserUse.action.tabNewUrl', { url }) : t('browserUse.action.tabNew'),
        }]
      }
      if (action === 'close') return [{ id: 'tabs-close', label: t('browserUse.action.tabClose') }]
      if (action === 'switch' || action === 'focus') return [{ id: 'tabs-switch', label: t('browserUse.action.tabSwitch') }]
      return [{ id: 'tabs-list', label: t('browserUse.action.tabList') }]
    }
    case 'BrowserInspect': {
      const kind = typeof obj.kind === 'string' ? obj.kind : 'text'
      if (kind === 'console') return [{ id: 'inspect-console', label: t('browserUse.action.inspectConsole') }]
      if (kind === 'network') return [{ id: 'inspect-network', label: t('browserUse.action.inspectNetwork') }]
      if (kind === 'eval') return [{ id: 'inspect-eval', label: t('browserUse.action.inspectEval') }]
      return [{ id: 'inspect-page', label: t('browserUse.action.inspectPage') }]
    }
    case 'BrowserTakeover': {
      const reason = typeof obj.reason === 'string' ? obj.reason : undefined
      const message = typeof obj.message === 'string' ? obj.message : undefined
      return [{
        id: 'takeover',
        label: t('browserUse.overlay.takeoverPrompt', {
          reason: formatTakeoverReason(reason, message, t),
        }),
      }]
    }
    case 'BrowserAct': {
      const steps = Array.isArray(obj.steps) ? obj.steps : []
      if (steps.length === 0) {
        return [{ id: 'act-empty', label: t('browserUse.action.generic') }]
      }
      return steps.map((raw, idx) => {
        const step = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
        const action = typeof step.action === 'string' ? step.action : 'click'
        const target = cleanHumanTarget(step.label)
        const sensitive = step.sensitive === true
        const rawText = typeof step.text === 'string'
          ? step.text
          : typeof step.value === 'string'
            ? step.value
            : ''
        const safeText = rawText ? maskSensitiveBrowserValue(rawText, sensitive, target) : ''

        switch (action) {
          case 'click':
            return {
              id: `step-${idx}`,
              label: target ? t('browserUse.action.clickTarget', { target }) : t('browserUse.action.click'),
            }
          case 'dblclick':
            return {
              id: `step-${idx}`,
              label: target ? t('browserUse.action.dblclickTarget', { target }) : t('browserUse.action.dblclick'),
            }
          case 'fill':
          case 'type':
            return {
              id: `step-${idx}`,
              label: target
                ? t('browserUse.action.fillTarget', { target, value: safeText })
                : t('browserUse.action.fill', { value: safeText }),
            }
          case 'press':
            return {
              id: `step-${idx}`,
              label: t('browserUse.action.pressKey', { key: typeof step.key === 'string' ? step.key : '' }),
            }
          case 'select':
            return {
              id: `step-${idx}`,
              label: target
                ? t('browserUse.action.selectTarget', { target, value: safeText })
                : t('browserUse.action.select', { value: safeText }),
            }
          case 'hover':
            return {
              id: `step-${idx}`,
              label: target ? t('browserUse.action.hoverTarget', { target }) : t('browserUse.action.hover'),
            }
          case 'scroll':
            return {
              id: `step-${idx}`,
              label: t('browserUse.action.scroll'),
            }
          case 'wait':
            return {
              id: `step-${idx}`,
              label: t('browserUse.action.wait'),
            }
          case 'dialog':
            return {
              id: `step-${idx}`,
              label: step.accept === false ? t('browserUse.action.dialogDismiss') : t('browserUse.action.dialogAccept'),
            }
          default:
            return { id: `step-${idx}`, label: t('browserUse.action.generic') }
        }
      })
    }
    default:
      return [{ id: 'unknown', label: toolVerb(toolName, t) }]
  }
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
