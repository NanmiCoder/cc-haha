import { memo, useMemo, useState } from 'react'
import { CircleStop, LoaderCircle } from 'lucide-react'
import { CodeViewer } from './CodeViewer'
import { DiffViewer } from './DiffViewer'
import { TerminalChrome } from './TerminalChrome'
import { CopyButton } from '../shared/CopyButton'
import { useTranslation } from '../../i18n'
import type { TranslationKey } from '../../i18n'
import { InlineImageGallery } from './InlineImageGallery'
import { ImageGalleryModal } from './ImageGalleryModal'
import type { AgentTaskNotification } from '../../types/chat'
import { PlanPreviewCard, extractPlanPreview, isExitPlanModeTool } from './PlanModePreview'

type Props = {
  toolName: string
  input: unknown
  result?: { content: unknown; isError: boolean } | null
  agentTaskNotification?: AgentTaskNotification
  compact?: boolean
  isPending?: boolean
  status?: 'stopped'
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

type ContentStats = {
  lines: number
  chars: number
  visibleLines?: number
  windowed?: boolean
}

export const ToolCallBlock = memo(function ToolCallBlock({ toolName, input, result, compact = false, isPending = false, status, partialInput }: Props) {
  const isPlanTool = isExitPlanModeTool(toolName)
  const [expanded, setExpanded] = useState(isPlanTool)
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
  const hasResultDetails = Boolean(result && (extractTextContent(result.content) || extractImageBlocks(result.content).length > 0))
  const hasEditPreview = toolName === 'Edit' && typeof obj.old_string === 'string' && typeof obj.new_string === 'string'
  const hasWritePreview = toolName === 'Write' && typeof obj.content === 'string'
  const expandable = hasEditPreview || hasWritePreview || hasResultDetails || Boolean(isPending && partialInput)

  if (isPlanTool) {
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
          <span
            className="inline-flex min-w-0 max-w-[58%] shrink-0 items-center gap-1 text-[10px] text-[var(--color-outline)]"
            title={liveStatsSummary ? `${pendingSummary} · ${liveStatsSummary}` : pendingSummary}
          >
            <LoaderCircle size={12} strokeWidth={2.4} className="animate-spin" aria-hidden="true" />
            <span className="truncate">{pendingSummary}</span>
            {liveStatsSummary ? (
              <>
                <span className="shrink-0 text-[var(--color-text-tertiary)]">·</span>
                <span className="shrink-0 font-[var(--font-mono)] tabular-nums text-[var(--color-text-tertiary)]">
                  {liveStatsSummary}
                </span>
              </>
            ) : null}
          </span>
        ) : stoppedSummary ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-[var(--color-outline)]">
            <CircleStop size={12} strokeWidth={2.25} aria-hidden="true" />
            {stoppedSummary}
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
        ) : liveStatsSummary ? (
          <span className="shrink-0 font-[var(--font-mono)] text-[10px] tabular-nums text-[var(--color-outline)]">
            {liveStatsSummary}
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
  const title = result?.isError
    ? t('permission.planRejected')
    : result
      ? t('permission.planApproved')
      : t('permission.planReadyTitle')
  const hasRawResult = Boolean(result && extractTextContent(result.content))

  return (
    <div className={`overflow-hidden rounded-lg border border-[var(--color-brand)]/35 bg-[var(--color-surface-container-lowest)] ${
      compact ? 'mb-0' : 'mb-2'
    }`}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]/50"
      >
        <span className="material-symbols-outlined text-[14px] text-[var(--color-brand)]">architecture</span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--color-text-primary)]">
          {title}
        </span>
        {preview.filePath ? (
          <span className="hidden max-w-[40%] truncate font-[var(--font-mono)] text-[11px] text-[var(--color-text-tertiary)] sm:inline">
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
        <div className="space-y-2.5 border-t border-[var(--color-border)]/60 px-3 py-3">
          <PlanPreviewCard
            title={t('permission.planPreviewTitle')}
            plan={preview.plan}
            filePath={preview.filePath}
            allowedPrompts={preview.allowedPrompts}
            requestedPermissionsTitle={t('permission.planRequestedPermissions')}
            emptyLabel={t('permission.planEmpty')}
          />
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

/** Renders extracted image blocks in a grid with click-to-fullscreen gallery. */
export function ImageBlockGallery({ imageBlocks }: { imageBlocks: ImageBlock[] }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const galleryImages = useMemo(
    () => imageBlocks.map((img, i) => ({ src: img.src, name: `Image ${i + 1}` })),
    [imageBlocks],
  )

  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-outline)]">
        <span className="material-symbols-outlined text-[12px]">image</span>
        {imageBlocks.length === 1 ? '1 image' : `${imageBlocks.length} images`}
      </div>
      <div className={`grid gap-2 ${imageBlocks.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
        {imageBlocks.map((img, i) => (
          <button
            key={img.src}
            type="button"
            onClick={() => setActiveIndex(i)}
            className="group/image relative overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] text-left shadow-sm transition-all hover:shadow-md hover:border-[var(--color-brand)]/40"
          >
            <img
              src={img.src}
              alt={`Generated image ${i + 1}`}
              loading="lazy"
              className="w-full object-contain"
              style={{ maxHeight: imageBlocks.length === 1 ? 400 : 240 }}
            />
            <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover/image:bg-black/20 group-hover/image:opacity-100">
              <span className="material-symbols-outlined rounded-full bg-white/90 p-2 text-[20px] text-[var(--color-text-primary)] shadow-lg">
                fullscreen
              </span>
            </div>
          </button>
        ))}
      </div>

      {activeIndex !== null && activeIndex >= 0 && (
        <ImageGalleryModal
          open={activeIndex !== null}
          images={galleryImages}
          activeIndex={activeIndex}
          onClose={() => setActiveIndex(null)}
          onSelect={setActiveIndex}
        />
      )}
    </div>
  )
}

function renderResultOutput(
  result: { content: unknown; isError: boolean },
  text: string,
  t?: (key: TranslationKey, params?: Record<string, string | number>) => string,
) {
  const imageBlocks = extractImageBlocks(result.content)
  return (
    <>
      {imageBlocks.length > 0 && (
        <ImageBlockGallery imageBlocks={imageBlocks} />
      )}
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
      if (writerContent !== null) {
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
    <div className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-[var(--color-outline)]">
        <span>{t?.('tool.writerPreview') ?? 'Writer'}</span>
        <span className="font-[var(--font-mono)] normal-case tracking-normal tabular-nums">
          {statsSummary}
        </span>
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
  const formattedInput = formatPartialJsonInput(partialInput)

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
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

export type ImageBlock = { src: string; mimeType: string }

function extractImageBlocks(content: unknown): ImageBlock[] {
  if (!Array.isArray(content)) return []
  const images: ImageBlock[] = []
  const seen = new Set<string>()
  for (const block of content) {
    if (!block || typeof block !== 'object' || !('type' in block)) continue
    const typed = block as Record<string, unknown>
    if (typed.type === 'image' && typeof typed.data === 'string') {
      const mime = typeof typed.mimeType === 'string' ? typed.mimeType : 'image/png'
      images.push({ src: `data:${mime};base64,${typed.data}`, mimeType: mime })
    }
    // Handle OpenAI-style image_url blocks (from MCP proxy transforms)
    if (typed.type === 'image_url' && typed.image_url && typeof typed.image_url === 'object') {
      const url = (typed.image_url as Record<string, unknown>).url
      if (typeof url === 'string' && /^(https?:|data:)/i.test(url)) {
        if (!seen.has(url)) { seen.add(url); images.push({ src: url, mimeType: 'image/png' }) }
      }
    }
    // Extract markdown image syntax ![...](url) from text blocks
    if (typed.type === 'text' && typeof typed.text === 'string') {
      const mdImageRe = /!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g
      let match: RegExpExecArray | null
      while ((match = mdImageRe.exec(typed.text)) !== null) {
        const url = match[1]!
        if (!seen.has(url)) { seen.add(url); images.push({ src: url, mimeType: 'image/png' }) }
      }
    }
  }
  return images
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
