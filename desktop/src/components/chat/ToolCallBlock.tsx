import { SessionToolLinks, SESSION_TOOL_NAMES } from '@/components/chat/SessionToolLinks'
import { memo, useMemo, useState, type ReactNode } from 'react'
import { getDisclosure, setDisclosure } from '../../lib/disclosureMemory'
import {
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  CirclePause,
  CircleStop,
  CircleX,
  ClipboardList,
  Copy,
  LoaderCircle,
} from 'lucide-react'
import { activitySegmentIcon } from './activityGroupModel'
import { CodeViewer } from './CodeViewer'
import { DiffViewer } from './DiffViewer'
import { TerminalChrome } from './TerminalChrome'
import {
  countDiffLines,
  countReadLines,
  formatCountLabel,
  hasToolVerb,
  parseSearchResult,
  parseShellExitCode,
  parseTodos,
  toolVerb,
  type GrepResult,
  type TodoItem,
} from './toolCallPresentation'
import { Badge } from '@/components/ui/Badge'
import { CopyButton } from '@/components/ui/CopyButton'
import { toolResultImagesFor } from '@/lib/toolResultContent'
import { useTranslation } from '../../i18n'
import type { TranslationKey } from '../../i18n'
import { InlineImageGallery } from './InlineImageGallery'
import { ToolResultImages } from './ToolResultImages'
import { ImageGenerationBlock } from './ImageGenerationBlock'
import { isImageGenerationToolName } from './imageGenerationTools'
import { ViewInTrajectoryButton } from '../trajectory/TrajectoryLinkContext'
import type { AgentTaskNotification } from '../../types/chat'
import {
  PlanPreviewCard,
  extractPlanPreview,
  isEnterPlanModeTool,
  isExitPlanModeTool,
} from './PlanModePreview'

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string

/**
 * `card` is the standalone bordered block. `row` is one node of an activity
 * run's timeline: a 22px ringed icon on the run's rail, the verb, its target and
 * a right-aligned result. Expanded row details hang under the text column rather
 * than rebuilding the card stack the activity-group treatment removed (#1177).
 */
export type ToolCallChrome = 'card' | 'row'

/**
 * Where a call stands, as the timeline colours it: running is info blue,
 * waiting on the user is amber, failed is red. Done and idle stay neutral —
 * a finished step should not compete with the one still in flight.
 */
export type ToolRowStatus = 'idle' | 'running' | 'waiting' | 'done' | 'error' | 'stopped'

type Props = {
  toolName: string
  input: unknown
  result?: { content: unknown; isError: boolean } | null
  agentTaskNotification?: AgentTaskNotification
  compact?: boolean
  chrome?: ToolCallChrome
  isPending?: boolean
  status?: 'stopped'
  partialInput?: string
  defaultExpanded?: boolean
  durationMs?: number
  /** Stable key that survives virtualized row unmount/remount. */
  disclosureKey?: string
  /** Enables "view in trajectory" when rendered inside the main session's message list. */
  toolUseId?: string
  /** Briefly marks this call as the one a "locate in chat" jump landed on. */
  navigationHighlighted?: boolean
  /** A permission prompt for this call is waiting on the user. */
  awaitingApproval?: boolean
  /**
   * The call is executing right now. Owners that know whether the turn is live
   * pass it; without them only a call whose input is still streaming counts,
   * so a transcript replayed after a crash never spins forever.
   */
  running?: boolean
}

const WRITER_PREVIEW_MAX_LINES = 120
const WRITER_PREVIEW_MAX_CHARS = 30000
const SEARCH_RESULT_MAX_ROWS = 200

/**
 * Shell-style tools whose stdout is echoed back into the terminal block (#1149).
 * `PowerShell` mirrors `Bash` on Windows — both carry a `command` input and
 * produce plain-text output, so they share one rendering path.
 */
const SHELL_TOOL_NAMES = new Set(['Bash', 'PowerShell'])

/**
 * Shell input keys already echoed by the terminal block itself: `command` shows
 * as the `$` line and `description` names the row. When those are the only keys
 * present the Tool Input JSON block is pure duplication (#1149).
 */
const SHELL_ECHOED_INPUT_KEYS = new Set(['command', 'description'])

const SHELL_OUTPUT_COLLAPSED_LINES = 12

const SEARCH_TOOL_NAMES = new Set(['Grep', 'Glob'])

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

export const ToolCallBlock = memo(function ToolCallBlock({ toolName, input, result, compact = false, chrome = 'card', isPending = false, status, partialInput, defaultExpanded = false, durationMs, disclosureKey, toolUseId, navigationHighlighted = false, awaitingApproval = false, running }: Props) {
  const isRow = chrome === 'row'
  const isExitPlanTool = isExitPlanModeTool(toolName)
  const isEnterPlanTool = isEnterPlanModeTool(toolName)
  const [localExpanded, setLocalExpanded] = useState(defaultExpanded || isExitPlanTool)
  const expanded = disclosureKey ? (getDisclosure(disclosureKey) ?? localExpanded) : localExpanded
  const setExpanded = (next: boolean | ((value: boolean) => boolean)) => {
    const resolved = typeof next === 'function' ? next(expanded) : next
    setLocalExpanded(resolved)
    if (disclosureKey) setDisclosure(disclosureKey, resolved)
  }
  const t = useTranslation()
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const target = getToolTarget(toolName, obj)
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
  const pendingTitle = pendingSummary
    ? (liveStatsSummary ? `${pendingSummary} · ${liveStatsSummary}` : pendingSummary)
    : undefined
  const rowStatus: ToolRowStatus = result?.isError
    ? 'error'
    : result
      ? 'done'
      : stoppedSummary
        ? 'stopped'
        : awaitingApproval
          ? 'waiting'
          // Input still streaming is live by definition; past that, only an
          // owner that knows the turn is live may call a resultless step running.
          : (running || Boolean(pendingSummary))
            ? 'running'
            : 'idle'
  // The text extractors below skip image blocks; this is what gives them a thumbnail.
  const toolImages = useMemo(
    () => toolResultImagesFor({ toolName, input, content: result?.content }),
    [input, result?.content, toolName],
  )
  const durationSummary = typeof durationMs === 'number' && durationMs >= 0 && result
    ? formatDuration(durationMs)
    : ''

  const preview = useMemo(
    () => renderPreview(toolName, obj, result, t, durationSummary),
    [durationSummary, obj, result, toolName, t],
  )
  const details = useMemo(
    () => renderDetails(toolName, obj, t, isPending ? partialInput : undefined),
    [isPending, obj, partialInput, toolName, t],
  )
  const hasResultDetails = Boolean(result && extractTextContent(result.content))
  const hasEditPreview = toolName === 'Edit' && typeof obj.old_string === 'string' && typeof obj.new_string === 'string'
  const hasWritePreview = toolName === 'Write' && typeof obj.content === 'string'
  // A shell command is itself expandable content: the terminal block echoes the
  // command plus its output — including the "no output" case, where the result
  // text is empty and hasResultDetails alone would keep the row sealed shut.
  const hasShellCommand = isShellTool(toolName) && typeof obj.command === 'string'
  const hasTodoList = toolName === 'TodoWrite' && (parseTodos(obj)?.length ?? 0) > 0
  const hasAgentInputDetails = toolName === 'Agent' && (
    typeof obj.description === 'string' ||
    typeof obj.prompt === 'string' ||
    typeof obj.subagent_type === 'string'
  )
  const expandable = hasEditPreview || hasWritePreview || hasShellCommand || hasTodoList || hasResultDetails || hasAgentInputDetails || Boolean(isPending && partialInput)
  // A shell call the model described names itself by that description: it
  // already leads with the action ("运行 validators 单测"), so a verb in front of
  // it only stutters, and the pipeline it stands for truncates into noise. The
  // command moves to the tooltip and the terminal block's `$` line.
  const shellDescription = isShellTool(toolName) && typeof obj.description === 'string' ? obj.description.trim() : ''
  const verb = shellDescription || toolVerb(toolName, t)
  const labelKind: 'verb' | 'toolName' | 'description' = shellDescription
    ? 'description'
    : hasToolVerb(toolName) ? 'verb' : 'toolName'
  // The raw tool name stays one hover away: the row speaks in verbs, but
  // someone matching a row to a log or a trajectory entry needs the real name.
  // The overlay covers the running summary too, so its full text rides along.
  const headTitle = [toolName, target.title, pendingTitle].filter(Boolean).join(' · ')

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

  const meta = (
    <ToolRowMeta
      toolName={toolName}
      input={obj}
      result={result ?? null}
      rowStatus={rowStatus}
      outputSummary={outputSummary}
      pendingSummary={pendingSummary}
      stoppedSummary={stoppedSummary}
      liveStatsSummary={liveStatsSummary}
    />
  )

  // The head is a row of siblings, not one big button, so a second action
  // ("view in trajectory") can sit in it without nesting interactive elements
  // or being laid over the duration and chevron. The disclosure button stretches
  // its hit area across the whole head with an `::after` overlay: clicking the
  // duration or chevron still toggles, and the action — positioned, later in
  // tree order — paints and hit-tests above it.
  const head = (
    <>
      <button
        type="button"
        data-chat-disclosure="true"
        aria-expanded={expandable ? expanded : undefined}
        onClick={() => {
          if (expandable) {
            setExpanded((value) => !value)
          }
        }}
        title={headTitle}
        className="flex min-w-0 flex-1 items-center gap-2 self-stretch text-left after:absolute after:inset-0 after:rounded-[var(--radius-sm)] after:content-[''] focus:outline-none focus-visible:after:shadow-[var(--shadow-focus-ring)]"
      >
        {isRow ? null : <CardToolIcon toolName={toolName} status={rowStatus} />}
        <span
          className={
            labelKind === 'toolName'
              ? `${target.text ? 'max-w-[40%] shrink-0' : 'min-w-0'} truncate font-mono text-[12px] font-medium text-[var(--color-text-primary)]`
              : labelKind === 'description'
                ? 'min-w-0 truncate text-[13px] font-medium text-[var(--color-text-primary)]'
                : 'shrink-0 text-[13px] font-medium text-[var(--color-text-primary)]'
          }
        >
          {verb}
        </span>
        {target.text ? (
          <span
            className={`min-w-0 truncate ${
              target.mono
                ? 'font-mono text-[12px] text-[var(--color-text-secondary)]'
                : 'text-[13px] text-[var(--color-text-secondary)]'
            }`}
          >
            {target.text}
          </span>
        ) : null}
        <span className="min-w-3 flex-1" />
        {meta}
      </button>
      {toolUseId ? (
        // Its own slot left of the duration: the space is always held (no
        // jump on hover) and nothing is drawn over the duration or chevron.
        // `relative` lifts it above the disclosure's stretched overlay.
        <ViewInTrajectoryButton
          toolUseId={toolUseId}
          className="relative -my-1 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/toolhead:opacity-100"
        />
      ) : null}
      <span className="w-[38px] shrink-0 text-right font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
        {durationSummary}
      </span>
      {expandable ? (
        <ChevronRight
          size={14}
          strokeWidth={1.75}
          aria-hidden="true"
          className={`shrink-0 text-[var(--color-text-tertiary)] transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />
      ) : (
        <span aria-hidden="true" className="w-3.5 shrink-0" />
      )}
    </>
  )

  const imageStrip = toolImages.images.length > 0 || toolImages.dropped > 0 ? (
    <ToolResultImages
      images={toolImages.images}
      omitted={toolImages.dropped}
      originalPath={toolImages.originalPath}
      toolName={toolName}
      // Row: under the text column, where the expanded details also start.
      className={isRow ? 'pb-1.5 pl-[30px] pt-0.5' : 'px-3 pb-3'}
    />
  ) : null

  if (isRow) {
    return (
      <div
        data-tool-call-chrome="row"
        data-tool-use-id={toolUseId}
        data-tool-status={rowStatus}
        className={`rounded-[var(--radius-sm)]${navigationHighlighted ? ' chat-tool-navigation-target' : ''}`}
      >
        <div className="flex min-h-[30px] items-center gap-1">
          <ToolNode toolName={toolName} status={rowStatus} />
          <div
            className={`group/toolhead relative flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-[var(--radius-sm)] pl-1 pr-1 transition-colors ${
              expandable ? 'hover:bg-[var(--color-surface-hover)]' : ''
            }`}
          >
            {head}
          </div>
        </div>

        {SESSION_TOOL_NAMES.has(toolName) ? (
          <div className="pl-[30px]"><SessionToolLinks input={input} result={result?.content} /></div>
        ) : null}

        {/* Outside the disclosure on purpose: a picture the tool returned is the
            answer, not a detail to open a panel for. */}
        {imageStrip}

        {expandable && expanded && (
          <div
            data-tool-call-details="inline"
            data-tool-output-error={result?.isError ? 'true' : undefined}
            className="space-y-2 pb-2.5 pl-[30px] pt-1"
          >
            {preview}
            {details}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      data-tool-call-chrome="card"
      data-tool-use-id={toolUseId}
      data-tool-status={rowStatus}
      className={`overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] ${
        compact ? 'mb-0' : 'mb-2'
      }${navigationHighlighted ? ' chat-tool-navigation-target' : ''}`}
    >
      <div
        className={`group/toolhead relative flex w-full items-center gap-2 px-3 transition-colors ${
          compact ? 'min-h-9' : 'min-h-10'
        } ${expandable ? 'hover:bg-[var(--color-surface-hover)]' : ''}`}
      >
        {head}
      </div>

      {SESSION_TOOL_NAMES.has(toolName) ? <SessionToolLinks input={input} result={result?.content} /> : null}

      {imageStrip}

      {expandable && expanded && (
        <div
          data-tool-call-details="panel"
          data-tool-output-error={result?.isError ? 'true' : undefined}
          className="space-y-2.5 border-t border-[var(--color-border)] px-3 py-3"
        >
          {preview}
          {details}
        </div>
      )}
    </div>
  )
})

/** The row's node on the run's rail. */
function ToolNode({ toolName, status }: { toolName: string; status: ToolRowStatus }) {
  const Icon = status === 'running' ? LoaderCircle : activitySegmentIcon(toolName)
  return (
    <span
      aria-hidden="true"
      data-tool-node={status}
      className={`relative flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border ${NODE_TONE[status]}`}
    >
      <Icon size={12} strokeWidth={2} className={status === 'running' ? 'animate-spin' : undefined} />
    </span>
  )
}

const NODE_TONE: Record<ToolRowStatus, string> = {
  idle: 'border-[var(--color-outline)] bg-[var(--color-surface)] text-[var(--color-text-tertiary)]',
  done: 'border-[var(--color-outline)] bg-[var(--color-surface)] text-[var(--color-text-tertiary)]',
  stopped: 'border-[var(--color-outline)] bg-[var(--color-surface)] text-[var(--color-text-tertiary)]',
  running: 'border-[var(--color-info)] bg-[var(--color-info-container)] text-[var(--color-on-info-container)]',
  waiting: 'border-[var(--color-warning)] bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)]',
  error: 'border-[var(--color-error-soft-hover)] bg-[var(--color-error-container)] text-[var(--color-on-error-container)]',
}

/** A standalone card leads with a plain glyph; the node belongs to the rail. */
function CardToolIcon({ toolName, status }: { toolName: string; status: ToolRowStatus }) {
  const Icon = status === 'running' ? LoaderCircle : activitySegmentIcon(toolName)
  const tone = status === 'error'
    ? 'text-[var(--color-error)]'
    : status === 'running'
      ? 'text-[var(--color-info)]'
      : status === 'waiting'
        ? 'text-[var(--color-warning)]'
        : 'text-[var(--color-text-tertiary)]'
  return (
    <Icon
      size={14}
      strokeWidth={1.75}
      aria-hidden="true"
      className={`shrink-0 ${tone} ${status === 'running' ? 'animate-spin' : ''}`}
    />
  )
}

/**
 * The right-hand result of a row: what the call produced, in the fewest words
 * that still say it — `+18 −5`, `26 lines`, `3 files · 6 matches`. Failures
 * lead with their first line instead, in red, because that line is usually the
 * whole story.
 */
function ToolRowMeta({
  toolName,
  input,
  result,
  rowStatus,
  outputSummary,
  pendingSummary,
  stoppedSummary,
  liveStatsSummary,
}: {
  toolName: string
  input: Record<string, unknown>
  result: { content: unknown; isError: boolean } | null
  rowStatus: ToolRowStatus
  outputSummary: string
  pendingSummary: string
  stoppedSummary: string
  liveStatsSummary: string
}) {
  const t = useTranslation()

  if (pendingSummary) {
    return (
      <span className="inline-flex min-w-0 max-w-[58%] shrink-0 items-center gap-1 text-[12px] text-[var(--color-info)]">
        <span className="truncate">{pendingSummary}</span>
        {liveStatsSummary ? (
          <>
            <span className="shrink-0">·</span>
            <span className="shrink-0 font-mono tabular-nums">{liveStatsSummary}</span>
          </>
        ) : null}
      </span>
    )
  }

  if (stoppedSummary) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-[var(--color-text-tertiary)]">
        <CircleStop size={12} strokeWidth={2} aria-hidden="true" />
        {stoppedSummary}
      </span>
    )
  }

  if (rowStatus === 'waiting') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-[var(--color-on-warning-container)]">
        <CirclePause size={12} strokeWidth={2} aria-hidden="true" />
        {t('permission.awaitingApproval')}
      </span>
    )
  }

  if (!result) {
    return liveStatsSummary ? (
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
        {liveStatsSummary}
      </span>
    ) : null
  }

  if (result.isError) {
    return outputSummary ? (
      <span className="inline-flex min-w-0 shrink items-center gap-1 text-[12px] text-[var(--color-error)]">
        <CircleX size={12} strokeWidth={2} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{outputSummary}</span>
      </span>
    ) : null
  }

  const resultMeta = getResultMeta(toolName, input, result.content, t)
  if (resultMeta) return resultMeta
  return outputSummary ? (
    <span className="min-w-0 shrink truncate text-[12px] text-[var(--color-text-tertiary)]">
      {outputSummary}
    </span>
  ) : null
}

/** Tool-specific result digests; null falls back to the generic one-liner. */
function getResultMeta(
  toolName: string,
  input: Record<string, unknown>,
  content: unknown,
  t: Translate,
): ReactNode | null {
  if ((toolName === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') ||
    (toolName === 'Write' && typeof input.content === 'string')) {
    const counts = toolName === 'Edit'
      ? countDiffLines(input.old_string as string, input.new_string as string)
      : countDiffLines('', input.content as string)
    return <DiffCounts additions={counts.additions} deletions={toolName === 'Edit' ? counts.deletions : null} />
  }

  const text = extractTextContent(content) ?? ''

  if (toolName === 'Read' && text) {
    // A one-line file says more as itself than as "1 line", so it keeps the
    // generic one-liner that shows the result without expanding.
    const lines = countReadLines(text)
    return lines > 1 ? <MetaText>{formatLineCount(lines, t)}</MetaText> : null
  }

  if (SEARCH_TOOL_NAMES.has(toolName) && text) {
    const parsed = parseSearchResult(text)
    if (!parsed) return null
    return <MetaText>{formatSearchSummary(parsed, t)}</MetaText>
  }

  if (toolName === 'TodoWrite') {
    const todos = parseTodos(input)
    if (!todos || todos.length === 0) return null
    return <MetaText>{formatCountLabel(todos.length, 'tool.itemCountSingular', 'tool.itemCountPlural', t)}</MetaText>
  }

  return null
}

function MetaText({ children }: { children: ReactNode }) {
  return (
    <span className="min-w-0 shrink truncate text-[12px] tabular-nums text-[var(--color-text-tertiary)]">
      {children}
    </span>
  )
}

export function DiffCounts({ additions, deletions }: { additions: number; deletions: number | null }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[12px] tabular-nums">
      <span className="text-[var(--color-diff-added-text)]">+{additions}</span>
      {deletions === null ? null : <span className="text-[var(--color-diff-removed-text)]">−{deletions}</span>}
    </span>
  )
}

function formatSearchSummary(parsed: GrepResult, t: Translate): string {
  const files = formatCountLabel(parsed.fileCount, 'tool.fileCountSingular', 'tool.fileCountPlural', t)
  if (parsed.matchCount === undefined) return files
  const matches = formatCountLabel(parsed.matchCount, 'tool.matchCountSingular', 'tool.matchCountPlural', t)
  return `${files} · ${matches}`
}

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
    <div className={`overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] ${
      compact ? 'mb-0' : 'mb-2'
    }`}>
      <div className="flex min-h-9 w-full items-center gap-2 px-3 text-left">
        <ClipboardList size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--color-text-primary)]">
          {t('settings.permissions.plan')}
        </span>
        {isPending ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-[var(--color-info)]">
            <LoaderCircle size={12} strokeWidth={2} className="animate-spin" aria-hidden="true" />
            {t('tool.preparingTool')}
          </span>
        ) : null}
        {result?.isError ? (
          <CircleX size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-error)]" />
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
    <div className={`overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] ${
      compact ? 'mb-0' : 'mb-2'
    }`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex min-h-10 w-full items-center gap-2 px-3 text-left transition-colors hover:bg-[var(--color-surface-hover)] focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
      >
        <ClipboardList size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--color-text-primary)]">
          {title}
        </span>
        {preview.filePath ? (
          <span className="hidden max-w-[40%] truncate font-mono text-[11px] text-[var(--color-text-tertiary)] sm:inline">
            {preview.filePath}
          </span>
        ) : null}
        {isPending ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-[var(--color-info)]">
            <LoaderCircle size={12} strokeWidth={2} className="animate-spin" aria-hidden="true" />
            {t('tool.preparingTool')}
          </span>
        ) : null}
        <ChevronRight
          size={14}
          strokeWidth={1.75}
          aria-hidden="true"
          className={`shrink-0 text-[var(--color-text-tertiary)] transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />
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

/** The small "copy" action every detail block carries in its head. */
function DetailCopyButton({ text, t }: { text: string; t?: Translate }) {
  const label = t?.('common.copy') ?? 'Copy'
  return (
    <CopyButton
      text={text}
      label={label}
      copiedLabel={t?.('common.copied') ?? 'Copied'}
      displayLabel={<><Copy size={12} strokeWidth={2} aria-hidden="true" />{label}</>}
      displayCopiedLabel={<><CircleCheck size={12} strokeWidth={2} aria-hidden="true" />{t?.('common.copied') ?? 'Copied'}</>}
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[var(--radius-sm)] px-1.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
    />
  )
}

/** Shared 30px head for the inline output / input / writer blocks. */
function DetailHead({ label, children, tone = 'neutral' }: { label: ReactNode; children?: ReactNode; tone?: 'neutral' | 'error' }) {
  return (
    <div
      className={`flex h-[30px] items-center justify-between gap-2 border-b pl-3 pr-1.5 text-[12px] ${
        tone === 'error'
          ? 'border-[var(--color-error-soft-hover)] text-[var(--color-on-error-container)]'
          : 'border-[var(--color-border)] text-[var(--color-text-tertiary)]'
      }`}
    >
      <span className="min-w-0 truncate">{label}</span>
      {children}
    </div>
  )
}

function renderPreview(
  toolName: string,
  obj: Record<string, unknown>,
  result?: { content: unknown; isError: boolean } | null,
  t?: Translate,
  durationSummary = '',
) {
  const filePath = typeof obj.file_path === 'string' ? obj.file_path : 'file'
  // Must match the terminal-block condition below exactly. When they diverged, a
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
    // #1149: echo the command's output back into the terminal block. Both the
    // success and error bodies render here, so getVisibleResultText suppresses
    // the generic result box for shell tools to avoid a second copy.
    return (
      <ShellTerminal
        toolName={toolName}
        command={shellCommand}
        result={result ?? null}
        durationSummary={durationSummary}
      />
    )
  }

  if (toolName === 'TodoWrite') {
    const todos = parseTodos(obj)
    if (todos && todos.length > 0) {
      // The list is the call; its "todos updated" acknowledgement says nothing.
      return (
        <>
          <TodoListView todos={todos} />
          {result?.isError ? resultOutput : null}
        </>
      )
    }
  }

  if (SEARCH_TOOL_NAMES.has(toolName) && result && !result.isError) {
    const parsed = parseSearchResult(extractTextContent(result.content) ?? '')
    if (parsed && parsed.rows.length > 0) {
      return (
        <SearchResultView
          result={parsed}
          pattern={toolName === 'Grep' && typeof obj.pattern === 'string' ? obj.pattern : ''}
          caseInsensitive={obj['-i'] === true}
        />
      )
    }
  }

  return resultOutput
}

function getVisibleResultText(
  toolName: string,
  result?: { content: unknown; isError: boolean } | null,
  echoesInTerminal = false,
): string | null {
  if (!result) return null
  const text = extractTextContent(result.content)
  if (!text) return null

  // Shell output owns its own renderer inside the terminal block (both success
  // and error), so the generic result box must stay out of the way — but only
  // when that renderer will actually run.
  if (echoesInTerminal) return null
  if (result.isError) return text
  // Read/Edit/Write stay suppressed: Edit/Write results are a single
  // "file updated" line with no information, and Read is file content the user
  // can already open, and by far the bulkiest tool output.
  if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') return null
  return text
}

/**
 * A shell call as a terminal block: the command on a `$` line and its output
 * under it, in one plain `<pre>`.
 *
 * Shell output has no language to highlight, so it does not go through
 * CodeViewer. Note this is NOT a saving relative to the old behaviour —
 * CodeViewer never ran for shell tools (successes rendered nothing at all, and
 * the error branch already used a plain `<pre>`). It is simply the right target:
 * don't move shell text onto a syntax-highlighting path later on the assumption
 * that it used to be there. For reference, CodeViewer does mount both Prism and
 * Shiki over the same text, so that move would cost two tokenizer passes.
 */
function ShellTerminal({
  toolName,
  command,
  result,
  durationSummary,
}: {
  toolName: string
  command: string
  result: { content: unknown; isError: boolean } | null
  durationSummary: string
}) {
  const [expanded, setExpanded] = useState(false)
  const t = useTranslation()
  const isError = Boolean(result?.isError)
  const resolved = useMemo(
    () => (result ? resolveShellOutputKind(result.content, toolName) : null),
    [result, toolName],
  )
  // Errors are never windowed. #625 deliberately made full tool error output
  // visible; putting failures behind a 12-line window would quietly undo that.
  // Successes get the window because they are the bulk of the transcript.
  const output = useMemo(
    () => prepareShellOutput(resolved?.kind === 'text' ? resolved.text : '', expanded || isError),
    [resolved, expanded, isError],
  )
  const showToggle = output.collapsible && !isError
  const exitCode = result ? parseShellExitCode(extractTextContent(result.content) ?? '', isError) : null

  return (
    <TerminalChrome
      label={toolName === 'PowerShell' ? 'powershell' : 'bash'}
      meta={(
        <>
          {result ? (
            <Badge
              tone={isError ? 'danger' : 'success'}
              data-shell-exit={exitCode ?? 'error'}
            >
              {exitCode === null ? t('agentStatus.failed') : t('tool.exitCode', { code: exitCode })}
            </Badge>
          ) : null}
          {durationSummary ? (
            <span className="font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">{durationSummary}</span>
          ) : null}
          <DetailCopyButton text={output.full || command} t={t} />
        </>
      )}
    >
      <div className="px-3.5 pb-3 pt-2.5 font-mono text-[12px] leading-[1.65]">
        <div className="whitespace-pre-wrap break-words text-[var(--color-code-fg)]">
          <span aria-hidden="true" className="mr-2 select-none text-[var(--color-brand)]">$</span>
          {command}
        </div>
        {/* Content we cannot render as terminal text: say nothing rather than
            assert something false about the command. */}
        {!resolved || resolved.kind === 'opaque' ? null : output.visible ? (
          <>
            {/* Commands that emit image paths (screenshots, plots) still get a
                gallery, as the generic result box used to provide. */}
            <InlineImageGallery text={output.full} />
            <pre
              data-shell-output=""
              tabIndex={0}
              className={`mt-1.5 max-h-[420px] overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.65] focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] ${
                isError ? 'text-[var(--color-error)]' : 'text-[var(--color-code-fg)]'
              }`}
            >
              {output.visible}
            </pre>
          </>
        ) : (
          <div className="mt-1.5 font-sans text-[12px] text-[var(--color-text-tertiary)]">
            {t('tool.noOutput')}
          </div>
        )}
      </div>
      {showToggle ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex h-7 w-full items-center justify-center border-t border-[var(--color-border)] text-[12px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
        >
          {expanded
            ? t('tool.showLess')
            : t('tool.showMoreLines', { count: output.hiddenLines })}
        </button>
      ) : null}
    </TerminalChrome>
  )
}

/** Grep / Glob hits as `file:line  code`, the matched text marked. */
function SearchResultView({
  result,
  pattern,
  caseInsensitive,
}: {
  result: GrepResult
  pattern: string
  caseInsensitive: boolean
}) {
  const matcher = useMemo(() => buildSearchMatcher(pattern, caseInsensitive), [caseInsensitive, pattern])
  const rows = result.rows.slice(0, SEARCH_RESULT_MAX_ROWS)
  const hidden = result.rows.length - rows.length

  return (
    <div
      data-search-result=""
      className="max-h-[340px] divide-y divide-[var(--color-border)] overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] font-mono text-[12px] leading-[1.6]"
    >
      {rows.map((row, index) => (
        <div key={`${row.file}:${row.line ?? ''}:${index}`} className="flex gap-3.5 px-2.5 py-1">
          {row.code === undefined ? (
            <span className="min-w-0 truncate text-[var(--color-text-secondary)]" title={row.file}>{row.file}</span>
          ) : (
            <>
              <span className="w-[236px] max-w-[42%] shrink-0 truncate text-[var(--color-text-tertiary)]" title={`${row.file}:${row.line}`}>
                {row.file}:{row.line}
              </span>
              <span className="min-w-0 truncate whitespace-pre text-[var(--color-text-primary)]">
                {highlightMatches(row.code, matcher)}
              </span>
            </>
          )}
        </div>
      ))}
      {hidden > 0 ? (
        <div className="px-2.5 py-1 text-[var(--color-text-tertiary)]">+{hidden}</div>
      ) : null}
    </div>
  )
}

function buildSearchMatcher(pattern: string, caseInsensitive: boolean): RegExp | null {
  if (!pattern) return null
  try {
    return new RegExp(pattern, caseInsensitive ? 'gi' : 'g')
  } catch {
    // ripgrep syntax JavaScript cannot parse: show the rows unmarked.
    return null
  }
}

function highlightMatches(code: string, matcher: RegExp | null): ReactNode {
  if (!matcher) return code
  const parts: ReactNode[] = []
  let last = 0
  for (const match of code.matchAll(matcher)) {
    const start = match.index ?? 0
    if (!match[0]) continue
    if (start > last) parts.push(code.slice(last, start))
    parts.push(
      <mark
        key={start}
        className="rounded-[var(--radius-xs)] bg-[var(--color-search-highlight)] text-[var(--color-on-search-highlight)]"
      >
        {match[0]}
      </mark>,
    )
    last = start + match[0].length
  }
  if (parts.length === 0) return code
  if (last < code.length) parts.push(code.slice(last))
  return parts
}

/** A TodoWrite call drawn as the checklist it wrote. */
function TodoListView({ todos }: { todos: TodoItem[] }) {
  return (
    <ul data-todo-list="" className="grid gap-0.5 py-0.5">
      {todos.map((todo, index) => {
        const Icon = todo.status === 'completed' ? CircleCheck : todo.status === 'in_progress' ? CircleDot : Circle
        return (
          <li
            key={`${index}:${todo.content}`}
            data-todo-status={todo.status}
            className="flex min-h-[26px] items-center gap-2 text-[13px]"
          >
            <Icon
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              className={`shrink-0 ${
                todo.status === 'completed'
                  ? 'text-[var(--color-success)]'
                  : todo.status === 'in_progress'
                    ? 'text-[var(--color-info)]'
                    : 'text-[var(--color-text-tertiary)]'
              }`}
            />
            <span
              className={
                todo.status === 'completed'
                  ? 'text-[var(--color-text-tertiary)] line-through decoration-[var(--color-text-tertiary)]'
                  : todo.status === 'in_progress'
                    ? 'font-medium text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-secondary)]'
              }
            >
              {todo.content}
            </span>
          </li>
        )
      })}
    </ul>
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

/**
 * Input and output blocks share one shape in both chromes — a bordered,
 * `--radius-md` code block — so a row and a card show the same detail the same
 * way. The block wraps CodeViewer's borderless `embedded` chrome rather than its
 * card chrome: one edge, one head, one copy action per block (#1177).
 */
function DetailBlock({ children }: { children: ReactNode }) {
  return (
    <div
      data-tool-detail-surface="block"
      className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]"
    >
      {children}
    </div>
  )
}

function renderResultOutput(
  result: { content: unknown; isError: boolean },
  text: string,
  t?: Translate,
) {
  const label = result.isError
    ? t?.('tool.errorOutput') ?? 'Error Output'
    : t?.('tool.toolOutput') ?? 'Tool Output'

  return (
    <>
      <InlineImageGallery text={text} />
      {result.isError ? (
        <div
          data-tool-detail-surface="error"
          className="overflow-hidden rounded-[var(--radius-md)] bg-[var(--color-error-container)]"
        >
          <DetailHead label={label} tone="error">
            <DetailCopyButton text={text} t={t} />
          </DetailHead>
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] leading-[1.6] text-[var(--color-on-error-container)]">
            {text}
          </pre>
        </div>
      ) : (
        <DetailBlock>
          <CodeViewer code={text} language="plaintext" maxLines={18} chrome="embedded" label={label} />
        </DetailBlock>
      )}
    </>
  )
}

function renderDetails(
  toolName: string,
  obj: Record<string, unknown>,
  t?: Translate,
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

  // The checklist above already is the input.
  if (toolName === 'TodoWrite' && (parseTodos(obj)?.length ?? 0) > 0) {
    return null
  }

  // #1149: the terminal block already shows `command` as the `$` line and the
  // row carries `description`, so this block must never repeat them. Showing
  // the *remaining* keys keeps timeout / run_in_background visible without
  // re-printing the command — an all-or-nothing suppression put the command
  // back on screen for the ~20% of real calls that carry a `timeout`.
  const displayed = isShellTool(toolName) ? omitKeys(obj, SHELL_ECHOED_INPUT_KEYS) : obj
  if (Object.keys(displayed).length === 0) {
    return null
  }

  const text = JSON.stringify(displayed, null, 2)
  const label = t?.('tool.toolInput') ?? 'Tool Input'
  return (
    <DetailBlock>
      <CodeViewer code={text} language="json" maxLines={18} chrome="embedded" label={label} />
    </DetailBlock>
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
  t?: Translate,
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
    <div
      data-tool-detail-surface="block"
      className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-code-bg)]"
    >
      <div className="bg-[var(--color-surface-container)]">
        <DetailHead label={t?.('tool.writerPreview') ?? 'Writer'}>
          <span className="shrink-0 pr-1.5 font-mono text-[11px] tabular-nums">{statsSummary}</span>
        </DetailHead>
      </div>
      <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] leading-[1.6] text-[var(--color-code-fg)]">
        {visibleContent}
      </pre>
    </div>
  )
}

function renderPartialInput(
  partialInput: string,
  t?: Translate,
) {
  const formattedInput = formatPartialJsonInput(partialInput)
  const label = t?.('tool.partialInput') ?? 'Partial input'

  return (
    <DetailBlock>
      <CodeViewer
        code={formattedInput}
        language="json"
        maxLines={8}
        wrapLongLines
        chrome="embedded"
        label={label}
      />
    </DetailBlock>
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

type ToolTarget = {
  text: string
  /** Code-shaped (a path, command, pattern, URL) rather than a sentence. */
  mono: boolean
  /** The untruncated form for the row's tooltip. */
  title?: string
}

/**
 * What the row's verb acts on. Monospace is for the things that are literally
 * code — a command, a glob, a path — not for a sentence describing one, and
 * never for Chinese, where it opens typewriter gaps between characters.
 */
function getToolTarget(toolName: string, obj: Record<string, unknown>): ToolTarget {
  const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  const prose = (text: string): ToolTarget => ({ text, mono: false, title: text || undefined })
  const code = (text: string, title = text): ToolTarget => ({ text, mono: true, title: title || undefined })

  const filePath = str(obj.file_path) || (toolName === 'NotebookEdit' ? str(obj.notebook_path) : '')
  if (filePath) return code(filePath.split(/[/\\]/).pop() || filePath, filePath)

  switch (toolName) {
    case 'ListSessions': return prose(str(obj.query))
    case 'CreateSession': return prose(String(obj.title ?? obj.prompt ?? ''))
    case 'ReadSession': return code(String(obj.sessionId ?? ''))
    case 'SendSessionMessage': return prose(String(obj.content ?? ''))
    case 'WaitSessions': return code(Array.isArray(obj.sessionIds) ? obj.sessionIds.join(', ') : '')
    case 'Bash':
    case 'PowerShell': {
      // With a description the row is named by it (see ToolCallBlock), so the
      // command only rides in the tooltip; without one, the command is the target.
      const command = str(obj.command)
      return str(obj.description) ? { text: '', mono: true, title: command || undefined } : code(command)
    }
    case 'Grep':
    case 'Glob':
      return code(str(obj.pattern))
    case 'WebSearch':
    case 'ToolSearch':
      return prose(str(obj.query))
    case 'WebFetch':
      return code(str(obj.url))
    case 'Agent':
      return prose(str(obj.description))
    case 'Skill':
      return code(str(obj.skill))
    case 'TaskCreate':
      return prose(str(obj.subject))
    case 'TaskUpdate':
    case 'TaskGet': {
      const subject = str(obj.subject)
      return subject ? prose(subject) : code(str(obj.taskId) ? `#${str(obj.taskId)}` : '')
    }
    default:
      return { text: '', mono: false }
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
