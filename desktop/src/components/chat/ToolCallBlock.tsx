import { memo, useMemo, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { CodeViewer } from './CodeViewer'
import { DiffViewer } from './DiffViewer'
import { TerminalChrome } from './TerminalChrome'
import { CopyButton } from '../shared/CopyButton'
import { useTranslation } from '../../i18n'
import type { TranslationKey } from '../../i18n'
import { InlineImageGallery } from './InlineImageGallery'
import type { AgentTaskNotification } from '../../types/chat'

type Props = {
  toolName: string
  input: unknown
  result?: { content: unknown; isError: boolean } | null
  agentTaskNotification?: AgentTaskNotification
  compact?: boolean
  isPending?: boolean
  partialInput?: string
}

const TOOL_ICONS: Record<string, string> = {
  Bash: 'terminal',
  Read: 'description',
  Write: 'edit_document',
  Edit: 'edit_note',
  Glob: 'search',
  Grep: 'find_in_page',
  Agent: 'smart_toy',
  WebSearch: 'travel_explore',
  WebFetch: 'cloud_download',
  NotebookEdit: 'note',
  Skill: 'auto_awesome',
}

const WRITER_PREVIEW_MAX_LINES = 120
const WRITER_PREVIEW_MAX_CHARS = 30000

export const ToolCallBlock = memo(function ToolCallBlock({ toolName, input, result, compact = false, isPending = false, partialInput }: Props) {
  const [expanded, setExpanded] = useState(false)
  const t = useTranslation()
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const icon = TOOL_ICONS[toolName] || 'build'
  const filePath = typeof obj.file_path === 'string' ? obj.file_path : ''
  const summary = getToolSummary(toolName, obj, t)
  const outputSummary = getToolResultSummary(
    toolName,
    result?.content,
    result?.isError ?? false,
    t,
  )
  const pendingSummary = isPending && !result
    ? getPendingSummary(toolName, t)
    : ''

  const preview = useMemo(() => renderPreview(toolName, obj, result, t), [obj, result, toolName, t])
  const details = useMemo(() => renderDetails(toolName, obj, t, isPending ? partialInput : undefined), [isPending, obj, partialInput, toolName, t])
  const hasResultDetails = Boolean(result && extractTextContent(result.content))
  const hasEditPreview = toolName === 'Edit' && typeof obj.old_string === 'string' && typeof obj.new_string === 'string'
  const hasWritePreview = toolName === 'Write' && typeof obj.content === 'string'
  const expandable = hasEditPreview || hasWritePreview || hasResultDetails || Boolean(isPending && partialInput)

  return (
    <div className={`overflow-hidden rounded-lg border border-[var(--color-border)]/50 bg-[var(--color-surface-container-lowest)] ${
      compact ? 'mb-0' : 'mb-2'
    }`}>
      <button
        type="button"
        onClick={() => {
          if (expandable) {
            setExpanded((value) => !value)
          }
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]/50"
      >
        <span className="material-symbols-outlined text-[14px] text-[var(--color-outline)]">{icon}</span>
        <span className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
          {toolName}
        </span>
        {filePath ? (
          <span className="min-w-0 flex-1 truncate font-[var(--font-mono)] text-[11px] text-[var(--color-text-tertiary)]">
            {filePath.split('/').pop()}
          </span>
        ) : summary ? (
          <span className="min-w-0 flex-1 truncate font-[var(--font-mono)] text-[11px] text-[var(--color-text-tertiary)]">
            {summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {pendingSummary ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-[var(--color-outline)]">
            <LoaderCircle size={12} strokeWidth={2.4} className="animate-spin" aria-hidden="true" />
            {pendingSummary}
          </span>
        ) : result && outputSummary ? (
          <span
            className={`shrink-0 text-[10px] ${
              result.isError
                ? 'text-[var(--color-error)]'
                : 'text-[var(--color-outline)]'
            }`}
          >
            {outputSummary}
          </span>
        ) : null}
        {result?.isError && (
          <span className="material-symbols-outlined shrink-0 text-[14px] text-[var(--color-error)]">error</span>
        )}
        {expandable && (
          <span className="material-symbols-outlined text-[14px] text-[var(--color-outline)]">
            {expanded ? 'expand_less' : 'expand_more'}
          </span>
        )}
      </button>

      {expandable && expanded && (
        <div className="fade-in space-y-2.5 border-t border-[var(--color-border)]/60 px-3 py-3">
          {preview}
          {details}
        </div>
      )}
    </div>
  )
})

function renderPreview(
  toolName: string,
  obj: Record<string, unknown>,
  result?: { content: unknown; isError: boolean } | null,
  t?: (key: TranslationKey, params?: Record<string, string | number>) => string,
) {
  const filePath = typeof obj.file_path === 'string' ? obj.file_path : 'file'
  const resultText = getVisibleResultText(toolName, result)
  const resultOutput = result && resultText ? renderResultOutput(result, resultText, t) : null

  if (toolName === 'Edit' && typeof obj.old_string === 'string' && typeof obj.new_string === 'string') {
    return (
      <>
        <DiffViewer filePath={filePath} oldString={obj.old_string} newString={obj.new_string} />
        {resultOutput}
      </>
    )
  }

  if (toolName === 'Write' && typeof obj.content === 'string') {
    return (
      <>
        <DiffViewer filePath={filePath} oldString="" newString={obj.content} />
        {resultOutput}
      </>
    )
  }

  if (toolName === 'Bash' && typeof obj.command === 'string') {
    return (
      <>
        <TerminalChrome title={typeof obj.description === 'string' ? obj.description : filePath}>
          <div className="px-3 py-2.5 font-[var(--font-mono)] text-[11px] leading-[1.3] text-[var(--color-terminal-fg)]">
            <span className="text-[var(--color-terminal-accent)]">$</span> {obj.command}
          </div>
        </TerminalChrome>
        {resultOutput}
      </>
    )
  }

  if (toolName === 'Read') {
    return resultOutput
  }

  if (resultOutput) return resultOutput

  return null
}

function getVisibleResultText(
  toolName: string,
  result?: { content: unknown; isError: boolean } | null,
): string | null {
  if (!result) return null
  const text = extractTextContent(result.content)
  if (!text) return null

  if (result.isError) return text
  if (toolName === 'Bash' || toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') return null
  return text
}

function renderResultOutput(
  result: { content: unknown; isError: boolean },
  text: string,
  t?: (key: TranslationKey, params?: Record<string, string | number>) => string,
) {
  return (
    <>
      <InlineImageGallery text={text} />
      <div className={`overflow-hidden rounded-lg border ${
        result.isError
          ? 'border-[var(--color-error)]/20 bg-[var(--color-error-container)]/60'
          : 'border-[var(--color-border)] bg-[var(--color-surface)]'
      }`}>
        <div className="flex items-center justify-between border-b border-[var(--color-border)]/60 px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-[var(--color-outline)]">
          <span>{result.isError ? t?.('tool.errorOutput') ?? 'Error Output' : t?.('tool.toolOutput') ?? 'Tool Output'}</span>
          <CopyButton
            text={text}
            className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[10px] normal-case tracking-normal text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)]"
          />
        </div>
        {result.isError ? (
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words bg-[var(--color-code-bg)] px-3 py-2 font-[var(--font-mono)] text-[12px] leading-[1.45] text-[var(--color-error)]">
            {text}
          </pre>
        ) : (
          <CodeViewer code={text} language="plaintext" maxLines={18} />
        )}
      </div>
    </>
  )
}

function renderDetails(
  toolName: string,
  obj: Record<string, unknown>,
  t?: (key: TranslationKey, params?: Record<string, string | number>) => string,
  partialInput?: string,
) {
  if (partialInput) {
    if (toolName === 'Write') {
      const writerContent = extractPartialJsonStringField(partialInput, 'content')
      if (writerContent) {
        return renderWriterPreview(writerContent, t)
      }
    }
    return renderPartialInput(partialInput, t)
  }

  if (toolName === 'Edit' || toolName === 'Write') {
    return null
  }

  const text = JSON.stringify(obj, null, 2)
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-[var(--color-outline)]">
        <span>{t?.('tool.toolInput') ?? 'Tool Input'}</span>
        <CopyButton
          text={text}
          className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[10px] normal-case tracking-normal text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)]"
        />
      </div>
      <CodeViewer code={text} language="json" maxLines={18} />
    </div>
  )
}

function extractPartialJsonStringField(source: string, field: string): string | null {
  const key = `"${field}"`
  const keyIndex = source.indexOf(key)
  if (keyIndex < 0) return null
  const colonIndex = source.indexOf(':', keyIndex + key.length)
  if (colonIndex < 0) return null

  let index = colonIndex + 1
  while (index < source.length && /\s/.test(source[index] ?? '')) index += 1
  if (source[index] !== '"') return null
  index += 1

  let value = ''
  while (index < source.length) {
    const char = source[index]
    if (char === '"') return value
    if (char !== '\\') {
      value += char
      index += 1
      continue
    }

    const escaped = source[index + 1]
    if (escaped === undefined) break
    switch (escaped) {
      case 'n':
        value += '\n'
        index += 2
        break
      case 'r':
        value += '\r'
        index += 2
        break
      case 't':
        value += '\t'
        index += 2
        break
      case 'b':
        value += '\b'
        index += 2
        break
      case 'f':
        value += '\f'
        index += 2
        break
      case '"':
      case '\\':
      case '/':
        value += escaped
        index += 2
        break
      case 'u': {
        const hex = source.slice(index + 2, index + 6)
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          value += String.fromCharCode(Number.parseInt(hex, 16))
          index += 6
        } else {
          index = source.length
        }
        break
      }
      default:
        value += escaped
        index += 2
        break
    }
  }
  return value
}

function renderWriterPreview(
  content: string,
  t?: (key: TranslationKey, params?: Record<string, string | number>) => string,
) {
  const lines = content.split('\n')
  const totalLines = lines.length
  const visibleLines = lines.length > WRITER_PREVIEW_MAX_LINES
    ? lines.slice(-WRITER_PREVIEW_MAX_LINES)
    : lines
  let visibleContent = visibleLines.join('\n')
  const charTruncated = visibleContent.length > WRITER_PREVIEW_MAX_CHARS
  if (charTruncated) {
    visibleContent = visibleContent.slice(-WRITER_PREVIEW_MAX_CHARS)
  }
  const lineWindowed = totalLines > visibleLines.length
  const isWindowed = lineWindowed || charTruncated

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-[var(--color-outline)]">
        <span>{t?.('tool.writerPreview') ?? 'Writer'}</span>
        {isWindowed ? (
          <span className="normal-case tracking-normal">
            {t?.('tool.writerPreviewLatest', { visible: visibleLines.length, total: totalLines }) ?? `Showing latest ${visibleLines.length} of ${totalLines} lines`}
          </span>
        ) : null}
      </div>
      <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words bg-[var(--color-code-bg)] px-3 py-2 font-[var(--font-mono)] text-[12px] leading-[1.45] text-[var(--color-code-fg)]">
        {visibleContent}
      </pre>
    </div>
  )
}

function renderPartialInput(
  partialInput: string,
  t?: (key: TranslationKey, params?: Record<string, string | number>) => string,
) {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="border-b border-[var(--color-border)] px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-[var(--color-outline)]">
        {t?.('tool.partialInput') ?? 'Partial input'}
      </div>
      <CodeViewer code={partialInput} language="json" maxLines={8} />
    </div>
  )
}

function getPendingSummary(
  toolName: string,
  t?: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  if (toolName === 'Write') return t?.('tool.generatingContent') ?? 'Generating content'
  if (toolName === 'Edit' || toolName === 'MultiEdit') return t?.('tool.preparingEdit') ?? 'Preparing edit'
  return t?.('tool.preparingTool') ?? 'Preparing tool'
}

function getToolResultSummary(
  toolName: string,
  content: unknown,
  isError: boolean,
  t?: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  const text = extractTextContent(content)
  if (!text) return ''

  if (isError) {
    const firstLine = text
      .split('\n')
      .map((line) => stripAnsi(line).replace(/\s+/g, ' ').trim())
      .find(Boolean)

    if (!firstLine) {
      return t?.('tool.error') ?? 'Error'
    }

    return firstLine.length <= 72 ? firstLine : `${firstLine.slice(0, 72)}…`
  }

  if (toolName === 'Bash') return ''

  const lineCount = text.split('\n').length
  if (lineCount > 1) {
    return t?.('tool.linesOutput', { count: lineCount }) ?? `${lineCount} lines output`
  }

  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  if (compact.length <= 36) return compact
  return `${compact.slice(0, 36)}…`
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-9;]*m/g, '')
}

function getToolSummary(toolName: string, obj: Record<string, unknown>, t?: (key: TranslationKey, params?: Record<string, string | number>) => string): string {
  switch (toolName) {
    case 'Bash':
      return typeof obj.command === 'string' ? obj.command : ''
    case 'Read':
      return t?.('tool.readFileContents') ?? 'Read file contents'
    case 'Write':
      return typeof obj.content === 'string'
        ? (t?.('tool.linesCreated', { count: obj.content.split('\n').length }) ?? `${obj.content.split('\n').length} lines created`)
        : (t?.('tool.createFile') ?? 'Create file')
    case 'Edit':
      return typeof obj.old_string === 'string' && typeof obj.new_string === 'string'
        ? changedLineSummary(obj.old_string, obj.new_string, t)
        : (t?.('tool.updateFileContents') ?? 'Update file contents')
    case 'Glob':
      return typeof obj.pattern === 'string' ? obj.pattern : ''
    case 'Grep':
      return typeof obj.pattern === 'string' ? obj.pattern : ''
    case 'Agent':
      return typeof obj.description === 'string' ? obj.description : ''
    default:
      return ''
  }
}

function extractTextContent(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((chunk: any) => (typeof chunk === 'string' ? chunk : chunk?.text || ''))
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content === 'object') {
    return JSON.stringify(content, null, 2)
  }
  return null
}

function changedLineSummary(oldString: string, newString: string, t?: (key: TranslationKey, params?: Record<string, string | number>) => string): string {
  const oldLines = oldString.split('\n')
  const newLines = newString.split('\n')
  let changed = 0
  const max = Math.max(oldLines.length, newLines.length)

  for (let index = 0; index < max; index += 1) {
    if ((oldLines[index] ?? '') !== (newLines[index] ?? '')) {
      changed += 1
    }
  }

  return t?.('tool.linesChanged', { count: changed }) ?? `${changed} lines changed`
}
