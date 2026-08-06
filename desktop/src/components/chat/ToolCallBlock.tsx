import { memo, useMemo, useState } from 'react'
import { CircleStop, LoaderCircle } from 'lucide-react'
import { CodeViewer } from './CodeViewer'
import { DiffViewer } from './DiffViewer'
import { TerminalChrome } from './TerminalChrome'
import { CopyButton } from '@/components/ui/CopyButton'
import { useTranslation } from '../../i18n'
import type { TranslationKey } from '../../i18n'
import { InlineImageGallery } from './InlineImageGallery'
import { ImageGenerationBlock } from './ImageGenerationBlock'
import { isImageGenerationToolName } from './imageGenerationTools'
import type { AgentTaskNotification } from '../../types/chat'
import {
  PlanPreviewCard,
  extractPlanPreview,
  isEnterPlanModeTool,
  isExitPlanModeTool,
} from './PlanModePreview'

type Props = {
  toolName: string
  input: unknown
  result?: { content: unknown; isError: boolean } | null
  agentTaskNotification?: AgentTaskNotification
  compact?: boolean
  isPending?: boolean
  status?: 'stopped'
  partialInput?: string
  defaultExpanded?: boolean
  durationMs?: number
}

const TOOL_ICONS: Record<string, string> = {
  Bash: 'terminal',
  PowerShell: 'terminal',
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

/**
 * Shell-style tools whose stdout is echoed back into the terminal card (#1149).
 * `PowerShell` mirrors `Bash` on Windows — both carry a `command` input and
 * produce plain-text output, so they share one rendering path.
 */
const SHELL_TOOL_NAMES = new Set(['Bash', 'PowerShell'])

/**
 * Shell input keys already echoed by the terminal card itself: `command` shows
 * as the `$` line and `description` as the window title. When those are the only
 * keys present the Tool Input JSON block is pure duplication (#1149).
 */
const SHELL_ECHOED_INPUT_KEYS = new Set(['command', 'description'])

const SHELL_OUTPUT_COLLAPSED_LINES = 12

export function isShellTool(toolName: string): boolean {
  return SHELL_TOOL_NAMES.has(toolName)
}

/**
 * The CLI never sends an empty tool_result: `isToolResultContentEmpty` in
 * src/utils/toolResultStorage.ts substitutes `(<Tool> completed with no output)`
 * because a bare empty result at the prompt tail makes some models emit their
 * stop sequence (inc-4586). So "no output" has to be recognised from that
 * marker, not from an empty string.
 */
export function isNoOutputMarker(text: string, toolName: string): boolean {
  return text.trim() === `(${toolName} completed with no output)`
}

export type ShellOutputKind =
  /** The command ran and reported that it printed nothing. */
  | { kind: 'empty' }
  /** Plain text to echo. */
  | { kind: 'text'; text: string }
  /** Content we cannot render as terminal text (image / structured blocks). */
  | { kind: 'opaque' }

/**
 * Decide what a shell tool_result actually represents.
 *
 * `extractTextContent` flattens both "genuinely nothing" and "blocks that hold
 * no text" to '', which is not the same thing: a Bash command returning an image
 * block must not be labelled "no output".
 */
export function resolveShellOutputKind(content: unknown, toolName: string): ShellOutputKind {
  const text = extractTextContent(content) ?? ''

  if (isNoOutputMarker(text, toolName)) return { kind: 'empty' }
  if (sanitizeShellOutput(text)) return { kind: 'text', text }

  // No usable text left. A string that sanitized down to nothing (a progress
  // line that erased itself) really is nothing to show; non-string payloads that
  // still carry blocks are content we simply cannot render, so stay silent
  // rather than assert something false about the command.
  const hasUnrenderableBlocks = typeof content === 'string'
    ? false
    : Array.isArray(content)
      ? content.length > 0
      : Boolean(content)
  return hasUnrenderableBlocks ? { kind: 'opaque' } : { kind: 'empty' }
}

type ContentStats = {
  lines: number
  chars: number
  visibleLines?: number
  windowed?: boolean
}

export const ToolCallBlock = memo(function ToolCallBlock({ toolName, input, result, compact = false, isPending = false, status, partialInput, defaultExpanded = false, durationMs }: Props) {
  const isExitPlanTool = isExitPlanModeTool(toolName)
  const isEnterPlanTool = isEnterPlanModeTool(toolName)
  const [expanded, setExpanded] = useState(defaultExpanded || isExitPlanTool)
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
  const stoppedSummary = status === 'stopped' && !result
    ? t('tool.stopped')
    : ''
  const liveStats = useMemo(
    () => getToolContentStats(toolName, obj, isPending ? partialInput : undefined),
    [isPending, obj, partialInput, toolName],
  )
  const liveStatsSummary = liveStats ? formatContentStats(liveStats, t) : ''

  const preview = useMemo(() => renderPreview(toolName, obj, result, t), [obj, result, toolName, t])
  const details = useMemo(() => renderDetails(toolName, obj, t, isPending ? partialInput : undefined), [isPending, obj, partialInput, toolName, t])
  const hasResultDetails = Boolean(result && extractTextContent(result.content))
  const hasEditPreview = toolName === 'Edit' && typeof obj.old_string === 'string' && typeof obj.new_string === 'string'
  const hasWritePreview = toolName === 'Write' && typeof obj.content === 'string'
  // A shell command is itself expandable content: the terminal card echoes the
  // command plus its output — including the "no output" case, where the result
  // text is empty and hasResultDetails alone would keep the card sealed shut.
  const hasShellCommand = isShellTool(toolName) && typeof obj.command === 'string'
  const hasAgentInputDetails = toolName === 'Agent' && (
    typeof obj.description === 'string' ||
    typeof obj.prompt === 'string' ||
    typeof obj.subagent_type === 'string'
  )
  const expandable = hasEditPreview || hasWritePreview || hasShellCommand || hasResultDetails || hasAgentInputDetails || Boolean(isPending && partialInput)
  const durationSummary = typeof durationMs === 'number' && durationMs >= 0 && result
    ? formatDuration(durationMs)
    : ''

  if (isEnterPlanTool) {
    return (
      <EnterPlanModeToolCallBlock
        result={result}
        compact={compact}
        isPending={isPending}
      />
    )
  }

  if (isExitPlanTool) {
    return (
      <PlanToolCallBlock
        input={input}
        result={result}
        compact={compact}
        isPending={isPending}
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      />
    )
  }

  if (isImageGenerationToolName(toolName)) {
    return (
      <ImageGenerationBlock
        input={input}
        result={result}
        compact={compact}
        isPending={isPending}
        durationMs={durationMs}
      />
    )
  }

  return (
    <div className={`overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] ${
      compact ? 'mb-0' : 'mb-2'
    }`}>
      <button
        type="button"
        onClick={() => {
          if (expandable) {
            setExpanded((value) => !value)
          }
        }}
        className={`flex w-full items-center text-left transition-colors hover:bg-[var(--color-surface-hover)] ${
          compact ? 'gap-[11px] px-3.5 py-2.5' : 'gap-3 px-4 py-3'
        }`}
      >
        {compact ? (
          <span className="material-symbols-outlined shrink-0 text-[16px] text-[var(--color-text-secondary)]">{icon}</span>
        ) : (
          /* The ink square is the design's tool badge: solid `--t1` with the page
             ground as its glyph color, which is exactly the primary-button pair. */
          <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] bg-[var(--color-btn-primary-bg)] text-[var(--color-btn-primary-fg)]">
            <span className="material-symbols-outlined text-[16px]">{icon}</span>
          </span>
        )}
        <span className={`shrink-0 font-bold text-[var(--color-text-primary)] ${compact ? 'text-[13px]' : 'text-[14px]'}`}>
          {toolName}
        </span>
        {filePath ? (
          <span className={`min-w-0 flex-1 truncate font-mono text-[var(--color-text-secondary)] ${compact ? 'text-[12.5px]' : 'text-[13px]'}`}>
            {filePath.split('/').pop()}
          </span>
        ) : summary ? (
          <span className={`min-w-0 flex-1 truncate font-mono text-[var(--color-text-secondary)] ${compact ? 'text-[12.5px]' : 'text-[13px]'}`}>
            {summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {pendingSummary ? (
          <span
            className="inline-flex min-w-0 max-w-[58%] shrink-0 items-center gap-1 text-[12.5px] text-[var(--color-text-tertiary)]"
            title={liveStatsSummary ? `${pendingSummary} · ${liveStatsSummary}` : pendingSummary}
          >
            <LoaderCircle size={13} strokeWidth={2.4} className="animate-spin" aria-hidden="true" />
            <span className="truncate">{pendingSummary}</span>
            {liveStatsSummary ? (
              <>
                <span className="shrink-0">·</span>
                <span className="shrink-0 font-mono tabular-nums">
                  {liveStatsSummary}
                </span>
              </>
            ) : null}
          </span>
        ) : stoppedSummary ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[12.5px] text-[var(--color-text-tertiary)]">
            <CircleStop size={13} strokeWidth={2.25} aria-hidden="true" />
            {stoppedSummary}
          </span>
        ) : result && outputSummary ? (
          <span
            className={`min-w-0 shrink truncate text-[12.5px] ${
              result.isError
                ? 'text-[var(--color-error)]'
                : 'text-[var(--color-text-tertiary)]'
            }`}
          >
            {outputSummary}
          </span>
        ) : liveStatsSummary ? (
          <span className="shrink-0 font-mono text-[12.5px] tabular-nums text-[var(--color-text-tertiary)]">
            {liveStatsSummary}
          </span>
        ) : null}
        {durationSummary && (
          <span className="shrink-0 font-mono text-[12px] tabular-nums text-[var(--color-text-tertiary)]">
            {durationSummary}
          </span>
        )}
        {result?.isError && (
          <span className="material-symbols-outlined shrink-0 text-[15px] text-[var(--color-error)]">error</span>
        )}
        {expandable && (
          <span className="shrink-0 text-[11px] leading-none text-[var(--color-text-tertiary)]" aria-hidden="true">
            {expanded ? '▴' : '▾'}
          </span>
        )}
      </button>

      {expandable && expanded && (
        <div className="space-y-2.5 border-t border-[var(--color-border)] px-4 py-3.5">
          {preview}
          {details}
        </div>
      )}
    </div>
  )
})

function EnterPlanModeToolCallBlock({
  result,
  compact,
  isPending,
}: {
  result?: { content: unknown; isError: boolean } | null
  compact: boolean
  isPending: boolean
}) {
  const t = useTranslation()
  const errorText = result?.isError ? extractTextContent(result.content) : null

  return (
    <div className={`overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-primary-fixed-dim)] bg-[var(--color-surface-container-lowest)] ${
      compact ? 'mb-0' : 'mb-2'
    }`}>
      <div className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <span className="material-symbols-outlined text-[14px] text-[var(--color-brand)]">architecture</span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--color-text-primary)]">
          {t('settings.permissions.plan')}
        </span>
        {isPending ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-[var(--color-outline)]">
            <LoaderCircle size={12} strokeWidth={2.4} className="animate-spin" aria-hidden="true" />
            {t('tool.preparingTool')}
          </span>
        ) : null}
        {result?.isError ? (
          <span className="material-symbols-outlined shrink-0 text-[14px] text-[var(--color-error)]">error</span>
        ) : null}
      </div>

      {result?.isError && errorText ? (
        <div className="border-t border-[var(--color-border)] px-3 py-3">
          {renderResultOutput(result, errorText, t)}
        </div>
      ) : null}
    </div>
  )
}

function PlanToolCallBlock({
  input,
  result,
  compact,
  isPending,
  expanded,
  onToggle,
}: {
  input: unknown
  result?: { content: unknown; isError: boolean } | null
  compact: boolean
  isPending: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const t = useTranslation()
  const preview = extractPlanPreview(input, result?.content)
  const hasPlanPreview = Boolean(
    preview.plan.trim() ||
    preview.filePath ||
    preview.allowedPrompts.length > 0,
  )
  const showPlanPreview = hasPlanPreview || !result?.isError
  const title = result?.isError
    ? t('permission.planRejected')
    : result
      ? t('permission.planApproved')
      : t('permission.planReadyTitle')
  const hasRawResult = Boolean(result && extractTextContent(result.content))

  return (
    <div className={`overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-primary-fixed-dim)] bg-[var(--color-surface-container-lowest)] ${
      compact ? 'mb-0' : 'mb-2'
    }`}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
      >
        <span className="material-symbols-outlined text-[14px] text-[var(--color-brand)]">architecture</span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--color-text-primary)]">
          {title}
        </span>
        {preview.filePath ? (
          <span className="hidden max-w-[40%] truncate font-mono text-[11px] text-[var(--color-text-tertiary)] sm:inline">
            {preview.filePath}
          </span>
        ) : null}
        {isPending ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-[var(--color-outline)]">
            <LoaderCircle size={12} strokeWidth={2.4} className="animate-spin" aria-hidden="true" />
            {t('tool.preparingTool')}
          </span>
        ) : null}
        <span className="material-symbols-outlined text-[14px] text-[var(--color-outline)]">
          {expanded ? 'expand_less' : 'expand_more'}
        </span>
      </button>

      {expanded ? (
        <div className="space-y-2.5 border-t border-[var(--color-border)] px-3 py-3">
          {showPlanPreview ? (
            <PlanPreviewCard
              title={t('permission.planPreviewTitle')}
              plan={preview.plan}
              filePath={preview.filePath}
              allowedPrompts={preview.allowedPrompts}
              requestedPermissionsTitle={t('permission.planRequestedPermissions')}
              emptyLabel={t('permission.planEmpty')}
            />
          ) : null}
          {result?.isError && hasRawResult ? (
            renderResultOutput(result, extractTextContent(result.content) ?? '', t)
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function renderPreview(
  toolName: string,
  obj: Record<string, unknown>,
  result?: { content: unknown; isError: boolean } | null,
  t?: (key: TranslationKey, params?: Record<string, string | number>) => string,
) {
  const filePath = typeof obj.file_path === 'string' ? obj.file_path : 'file'
  // Must match the terminal-card condition below exactly. When they diverged, a
  // shell call whose input lacked `command` suppressed the generic result box
  // without rendering a replacement, blanking the panel (e.g. an
  // InputValidationError whose error body then vanished).
  const shellCommand = isShellTool(toolName) && typeof obj.command === 'string' ? obj.command : null
  const echoesInTerminal = shellCommand !== null
  const resultText = getVisibleResultText(toolName, result, echoesInTerminal)
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

  if (shellCommand !== null) {
    // #1149: echo the command's output back into the terminal card. Both the
    // success and error bodies render here, so getVisibleResultText suppresses
    // the generic result box for shell tools to avoid a second copy.
    return (
      <TerminalChrome title={typeof obj.description === 'string' ? obj.description : filePath}>
        <div className="px-3 py-2.5 font-mono text-[11px] leading-[1.3] text-[var(--color-terminal-fg)]">
          <span className="text-[var(--color-terminal-accent)]">$</span> {shellCommand}
        </div>
        {result ? (
          <ShellOutput
            content={result.content}
            isError={result.isError}
            toolName={toolName}
          />
        ) : null}
      </TerminalChrome>
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
  echoesInTerminal = false,
): string | null {
  if (!result) return null
  const text = extractTextContent(result.content)
  if (!text) return null

  // Shell output owns its own renderer inside TerminalChrome (both success and
  // error), so the generic result box must stay out of the way — but only when
  // that renderer will actually run.
  if (echoesInTerminal) return null
  if (result.isError) return text
  // Read/Edit/Write stay suppressed: Edit/Write results are a single
  // "file updated" line with no information, and Read is file content the user
  // can already open, and by far the bulkiest tool output.
  if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') return null
  return text
}

/**
 * Terminal-style output body: plain text in one text node, in a `<pre>`.
 *
 * Shell output has no language to highlight, so it does not go through
 * CodeViewer. Note this is NOT a saving relative to the old behaviour —
 * CodeViewer never ran for shell tools (successes rendered nothing at all, and
 * the error branch already used a plain `<pre>`). It is simply the right target:
 * don't move shell text onto a syntax-highlighting path later on the assumption
 * that it used to be there. For reference, CodeViewer does mount both Prism and
 * Shiki over the same text, so that move would cost two tokenizer passes.
 */
function ShellOutput({ content, isError, toolName }: { content: unknown; isError: boolean; toolName: string }) {
  const [expanded, setExpanded] = useState(false)
  const t = useTranslation()
  const resolved = useMemo(() => resolveShellOutputKind(content, toolName), [content, toolName])
  // Errors are never windowed. #625 deliberately made full tool error output
  // visible; putting failures behind a 12-line window would quietly undo that.
  // Successes get the window because they are the bulk of the transcript.
  const output = useMemo(
    () => prepareShellOutput(resolved.kind === 'text' ? resolved.text : '', expanded || isError),
    [resolved, expanded, isError],
  )
  const showToggle = output.collapsible && !isError

  // Content we cannot render as terminal text: say nothing rather than assert
  // something false about the command.
  if (resolved.kind === 'opaque') return null

  if (!output.visible) {
    return (
      <div className="border-t border-[var(--color-terminal-border)] px-3 py-2.5 font-mono text-[11px] italic text-[var(--color-terminal-muted)]">
        {t('tool.noOutput')}
      </div>
    )
  }

  return (
    <div className="border-t border-[var(--color-terminal-border)]">
      {/* Commands that emit image paths (screenshots, plots) still get a gallery,
          as the generic result box used to provide on the error path. */}
      <InlineImageGallery text={output.full} />
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-terminal-muted)]">
          {isError ? t('tool.errorOutput') : t('tool.toolOutput')}
        </span>
        <CopyButton
          text={output.full}
          className="rounded-[var(--radius-sm)] px-2 py-0.5 text-[11px] text-[var(--color-terminal-muted)] transition-colors hover:text-[var(--color-terminal-fg)]"
        />
      </div>
      <pre
        data-shell-output=""
        tabIndex={0}
        className={`max-h-[420px] overflow-auto whitespace-pre-wrap break-words px-3 pb-2.5 font-mono text-[11.5px] leading-[1.45] ${
          isError ? 'text-[var(--color-terminal-danger)]' : 'text-[var(--color-terminal-fg)]'
        }`}
      >
        {output.visible}
      </pre>
      {showToggle ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="w-full border-t border-[var(--color-terminal-border)] py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-terminal-muted)] transition-colors hover:text-[var(--color-terminal-fg)]"
        >
          {expanded
            ? t('tool.showLess')
            : t('tool.showMoreLines', { count: output.hiddenLines })}
        </button>
      ) : null}
    </div>
  )
}

export type PreparedShellOutput = {
  visible: string
  full: string
  /** Lines withheld right now — 0 once expanded. */
  hiddenLines: number
  /**
   * Whether the full text exceeds the collapsed window at all. Kept separate
   * from hiddenLines so the toggle survives expansion: gating the button on
   * hiddenLines alone unmounted the very control that collapses it again.
   */
  collapsible: boolean
}

/**
 * Collapsed shell output keeps the HEAD and reports the remainder, matching the
 * CLI (src/utils/terminal.ts renderTruncatedContent slices from the start and
 * appends a "+N lines" hint).
 */
export function prepareShellOutput(
  rawText: string,
  expanded: boolean,
  collapsedLines: number = SHELL_OUTPUT_COLLAPSED_LINES,
): PreparedShellOutput {
  const text = sanitizeShellOutput(rawText)

  if (!text) return { visible: '', full: '', hiddenLines: 0, collapsible: false }

  const cutoff = nthNewlineIndex(text, collapsedLines)
  const collapsible = cutoff >= 0

  if (!collapsible) {
    return { visible: text, full: text, hiddenLines: 0, collapsible: false }
  }

  if (expanded) {
    return { visible: text, full: text, hiddenLines: 0, collapsible: true }
  }

  return {
    visible: text.slice(0, cutoff),
    full: text,
    hiddenLines: countLines(text) - collapsedLines,
    collapsible: true,
  }
}

/**
 * Turn raw shell bytes into something a `<pre>` can show honestly.
 *
 * The desktop has no terminal emulator, so control sequences that a real
 * terminal would act on must be resolved or removed rather than printed:
 *   - CRLF is normalised, and a carriage return means "rewrite this line", so
 *     only the text after the last CR on a line survives. Without this, every
 *     progress frame from pip/npm stacks up as its own line.
 *   - CSI and OSC escapes are dropped. Stripping only SGR colour codes left
 *     erase/cursor sequences like `\x1B[2K\x1B[1A` to render as literal junk.
 */
export function sanitizeShellOutput(rawText: string): string {
  if (!rawText) return ''
  const withoutEscapes = stripAnsi(rawText)
  if (!withoutEscapes.includes('\r')) return withoutEscapes.trimEnd()

  return withoutEscapes
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const lastReturn = line.lastIndexOf('\r')
      return lastReturn === -1 ? line : line.slice(lastReturn + 1)
    })
    .join('\n')
    .trimEnd()
}

function omitKeys(
  source: Record<string, unknown>,
  keys: ReadonlySet<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (!keys.has(key)) result[key] = value
  }
  return result
}

/** Index of the nth (1-based) newline, or -1 when the string has fewer. */
function nthNewlineIndex(source: string, n: number): number {
  let index = -1
  for (let seen = 0; seen < n; seen += 1) {
    const next = source.indexOf('\n', index + 1)
    if (next === -1) return -1
    index = next
  }
  return index
}

/** Line count without allocating an array of every line. */
function countLines(source: string): number {
  if (!source) return 0
  let count = 1
  for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) {
    count += 1
  }
  return count
}

/**
 * Round to whole seconds ONCE, then derive the parts from that. Rounding each
 * part independently let `Math.floor(min)` disagree with `Math.round(sec % 60)`
 * and print impossible values like "1m60s" for 119.6s.
 */
export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`

  const totalSeconds = Math.round(durationMs / 1000)
  if (totalSeconds < 10) return `${(durationMs / 1000).toFixed(1)}s`
  if (totalSeconds < 60) return `${totalSeconds}s`

  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m${totalSeconds % 60}s`

  return `${Math.floor(totalMinutes / 60)}h${totalMinutes % 60}m`
}

function renderResultOutput(
  result: { content: unknown; isError: boolean },
  text: string,
  t?: (key: TranslationKey, params?: Record<string, string | number>) => string,
) {
  return (
    <>
      <InlineImageGallery text={text} />
      <div className={`overflow-hidden rounded-[var(--radius-lg)] border ${
        result.isError
          ? 'border-[var(--color-error)] bg-[var(--color-error-container)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface)]'
      }`}>
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-[var(--color-outline)]">
          <span>{result.isError ? t?.('tool.errorOutput') ?? 'Error Output' : t?.('tool.toolOutput') ?? 'Tool Output'}</span>
          <CopyButton
            text={text}
            className="rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2 py-1 text-[11px] normal-case tracking-normal text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)]"
          />
        </div>
        {result.isError ? (
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words bg-[var(--color-code-bg)] px-3 py-2 font-mono text-[12px] leading-[1.45] text-[var(--color-error)]">
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
      if (writerContent !== null) {
        return renderWriterPreview(writerContent, t)
      }
    }
    return renderPartialInput(partialInput, t)
  }

  if (toolName === 'Edit' || toolName === 'Write') {
    return null
  }

  // #1149: the terminal card already shows `command` as the `$` line and
  // `description` as its title, so this block must never repeat them. Showing
  // the *remaining* keys keeps timeout / run_in_background visible without
  // re-printing the command — an all-or-nothing suppression put the command
  // back on screen for the ~20% of real calls that carry a `timeout`.
  const displayed = isShellTool(toolName) ? omitKeys(obj, SHELL_ECHOED_INPUT_KEYS) : obj
  if (Object.keys(displayed).length === 0) {
    return null
  }

  const text = JSON.stringify(displayed, null, 2)
  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-[var(--color-outline)]">
        <span>{t?.('tool.toolInput') ?? 'Tool Input'}</span>
        <CopyButton
          text={text}
          className="rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2 py-1 text-[11px] normal-case tracking-normal text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)]"
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

function getToolContentStats(
  toolName: string,
  obj: Record<string, unknown>,
  partialInput?: string,
): ContentStats | null {
  const content = getToolContentForStats(toolName, obj, partialInput)
  return content === null ? null : countContentStats(content)
}

function getToolContentForStats(
  toolName: string,
  obj: Record<string, unknown>,
  partialInput?: string,
): string | null {
  if (toolName === 'Write') {
    if (typeof obj.content === 'string') return obj.content
    return partialInput ? extractPartialJsonStringField(partialInput, 'content') : null
  }

  if (toolName === 'Edit') {
    if (typeof obj.new_string === 'string') return obj.new_string
    return partialInput ? extractPartialJsonStringField(partialInput, 'new_string') : null
  }

  if (toolName === 'MultiEdit' && Array.isArray(obj.edits)) {
    const replacements = obj.edits
      .map((edit) => (
        edit && typeof edit === 'object' && typeof (edit as Record<string, unknown>).new_string === 'string'
          ? (edit as Record<string, string>).new_string
          : ''
      ))
      .filter(Boolean)
    return replacements.length > 0 ? replacements.join('\n') : null
  }

  return null
}

function countContentStats(content: string): ContentStats {
  return {
    lines: content.length === 0 ? 0 : content.split('\n').length,
    chars: content.length,
  }
}

function formatContentStats(
  stats: ContentStats,
  t?: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  const chars = formatCharCount(stats.chars, t)
  if (stats.windowed && typeof stats.visibleLines === 'number' && stats.visibleLines < stats.lines) {
    return t?.('tool.contentStatsLatest', {
      visible: formatCount(stats.visibleLines),
      total: formatCount(stats.lines),
      chars,
    }) ?? `Latest ${formatCount(stats.visibleLines)} / ${formatCount(stats.lines)} lines · ${chars}`
  }

  return t?.('tool.contentStats', {
    lines: formatLineCount(stats.lines, t),
    chars,
  }) ?? `${formatLineCount(stats.lines, t)} · ${chars}`
}

function formatLineCount(
  count: number,
  t?: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  return count === 1
    ? (t?.('tool.lineCountSingular', { count: formatCount(count) }) ?? `${formatCount(count)} line`)
    : (t?.('tool.lineCountPlural', { count: formatCount(count) }) ?? `${formatCount(count)} lines`)
}

function formatCharCount(
  count: number,
  t?: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  return count === 1
    ? (t?.('tool.charCountSingular', { count: formatCount(count) }) ?? `${formatCount(count)} char`)
    : (t?.('tool.charCountPlural', { count: formatCount(count) }) ?? `${formatCount(count)} chars`)
}

function formatCount(count: number): string {
  return new Intl.NumberFormat().format(count)
}

function renderWriterPreview(
  content: string,
  t?: (key: TranslationKey, params?: Record<string, string | number>) => string,
) {
  const contentStats = countContentStats(content)
  const lines = content.length === 0 ? [] : content.split('\n')
  const totalLines = contentStats.lines
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
  const visibleLineCount = visibleContent.length === 0 ? 0 : visibleContent.split('\n').length
  const statsSummary = formatContentStats({
    lines: totalLines,
    chars: contentStats.chars,
    visibleLines: visibleLineCount,
    windowed: isWindowed,
  }, t)

  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-[var(--color-outline)]">
        <span>{t?.('tool.writerPreview') ?? 'Writer'}</span>
        <span className="font-mono normal-case tracking-normal tabular-nums">
          {statsSummary}
        </span>
      </div>
      <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words bg-[var(--color-code-bg)] px-3 py-2 font-mono text-[12px] leading-[1.45] text-[var(--color-code-fg)]">
        {visibleContent}
      </pre>
    </div>
  )
}

function renderPartialInput(
  partialInput: string,
  t?: (key: TranslationKey, params?: Record<string, string | number>) => string,
) {
  const formattedInput = formatPartialJsonInput(partialInput)

  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="border-b border-[var(--color-border)] px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-[var(--color-outline)]">
        {t?.('tool.partialInput') ?? 'Partial input'}
      </div>
      <CodeViewer code={formattedInput} language="json" maxLines={8} wrapLongLines />
    </div>
  )
}

function formatPartialJsonInput(source: string): string {
  const trimmed = source.trim()
  if (!trimmed) return source

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return formatJsonLikeInput(trimmed)
  }
}

function formatJsonLikeInput(source: string): string {
  let output = ''
  let indent = 0
  let inString = false
  let escaping = false
  let skipWhitespace = false

  const newline = () => {
    output = output.trimEnd()
    output += `\n${'  '.repeat(indent)}`
    skipWhitespace = true
  }

  for (const char of source) {
    if (inString) {
      output += char
      if (escaping) {
        escaping = false
      } else if (char === '\\') {
        escaping = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (skipWhitespace && /\s/.test(char)) continue
    skipWhitespace = false

    if (char === '"') {
      inString = true
      output += char
      continue
    }

    if (char === '{' || char === '[') {
      output += char
      indent += 1
      newline()
      continue
    }

    if (char === '}' || char === ']') {
      indent = Math.max(0, indent - 1)
      if (!output.endsWith('\n')) newline()
      output += char
      continue
    }

    if (char === ',') {
      output += char
      newline()
      continue
    }

    if (char === ':') {
      output += ': '
      skipWhitespace = true
      continue
    }

    output += char
  }

  return output.trimEnd()
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

  // Shell commands that printed nothing still deserve a verdict in the collapsed
  // header, otherwise the row reads as "never ran". The CLI reports this as a
  // marker string rather than empty content — see isNoOutputMarker.
  if (isShellTool(toolName) && isNoOutputMarker(text, toolName)) {
    return t?.('tool.noOutput') ?? 'No output'
  }

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

  const lineCount = countLines(text)
  if (lineCount > 1) {
    return t?.('tool.linesOutput', { count: lineCount }) ?? `${lineCount} lines output`
  }

  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  if (compact.length <= 36) return compact
  return `${compact.slice(0, 36)}…`
}

/**
 * Drop ANSI escapes. Covers the whole CSI family (final byte @-~), not just the
 * SGR `m` colour codes — erase/cursor sequences such as `\x1B[2K` and `\x1B[1A`
 * are common in progress output and used to survive as literal text — plus OSC
 * strings (window titles), which terminate with BEL or ST.
 */
function stripAnsi(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '')
}

function getToolSummary(toolName: string, obj: Record<string, unknown>, t?: (key: TranslationKey, params?: Record<string, string | number>) => string): string {
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
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
