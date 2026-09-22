import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '../../../i18n'
import type { TraceBodySnapshot, TraceCallRecord } from '../../../types/trace'
import type { TraceSpan } from '../../../lib/traceViewModel'
import { formatTraceJson } from '../../../lib/traceViewModel'
import { fetchTraceCallDetail } from '../../../lib/trace/callCache'
import { parseTraceRequestBody, parseTraceResponseBody } from '../../../lib/trace/requestParse'
import { splitRequestMessages, type LocatedInjection } from '../../../lib/trace/semanticTimeline'
import type { NormalizedMessage } from '../../../lib/trace/types'
import { formatBytes } from '../../../lib/formatBytes'
import { CodeViewer } from '../../chat/CodeViewer'
import { Badge } from '@/components/ui/Badge'
import { CopyButton } from '@/components/ui/CopyButton'
import { EmptyState } from '@/components/ui/EmptyState'
import { Spinner } from '@/components/ui/Spinner'
import { Section } from './Section'
import { MessageBlocks } from './MessageBlocks'

const MESSAGE_FOLD_THRESHOLD = 20
const MESSAGE_HEAD_COUNT = 2
const MESSAGE_TAIL_COUNT = 6

export function LlmCallDetail({
  sessionId,
  span,
  revisionKey,
}: {
  sessionId: string
  span: TraceSpan
  revisionKey?: string
}) {
  const t = useTranslation()
  const call = span.call
  const callId = call?.id ?? null
  const isTerminal = span.status !== 'pending'
  const [detail, setDetail] = useState<TraceCallRecord | null>(null)
  const [fetchFailed, setFetchFailed] = useState(false)
  const fetchKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!callId || !isTerminal) return
    const key = `${sessionId}:${callId}:${revisionKey ?? 'legacy'}`
    // Ref guard keeps React StrictMode's double effect run from issuing a
    // second request; staleness is checked against the ref at resolve time.
    if (fetchKeyRef.current === key) return
    fetchKeyRef.current = key
    // Keep the record on screen while a newer copy loads. Clearing it first
    // drops the reader back to the truncated snapshot and resets their scroll.
    void fetchTraceCallDetail(sessionId, callId, revisionKey).then((full) => {
      if (fetchKeyRef.current !== key) return
      if (full) {
        setDetail(full)
        setFetchFailed(false)
      } else {
        setFetchFailed(true)
      }
    })
  }, [sessionId, callId, isTerminal, revisionKey])

  const effectiveCall = detail && detail.id === callId ? detail : call
  const parsed = useMemo(() => {
    if (!effectiveCall) return { request: null, response: null }
    const semantic = effectiveCall.request.semantic
    const requestBody = semantic
      ? JSON.stringify(semantic.request)
      : effectiveCall.request.body.preview
    return {
      request: requestBody
        ? parseTraceRequestBody(requestBody, semantic ? 'anthropic' : effectiveCall.source)
        : null,
      response: effectiveCall.response?.body.preview
        ? parseTraceResponseBody(effectiveCall.response.body.preview, effectiveCall.source)
        : null,
    }
  }, [effectiveCall])

  // The harness sends its assembled context as user-role text. Reading it
  // beside the real exchange is what makes a request legible, so the two are
  // split apart rather than rendered as one message list.
  const split = useMemo(
    () => splitRequestMessages(parsed.request?.messages ?? []),
    [parsed.request],
  )

  if (!call || !effectiveCall) return null

  const loadingDetail = isTerminal && (!detail || detail.id !== callId) && !fetchFailed
  const requestParseFailed = Boolean(effectiveCall.request.body.preview) && parsed.request === null
  const responseParseFailed = Boolean(effectiveCall.response?.body.preview) &&
    (parsed.response === null || parsed.response.message === null)
  const legacyFallback = !loadingDetail && (requestParseFailed || (isTerminal && !call.error && responseParseFailed))
  const params = parsed.request?.params ?? {}
  const paramEntries = Object.entries(params)

  return (
    <div data-testid="trace-llm-detail">
      {loadingDetail ? (
        <div className="progress-indeterminate-track h-0.5 bg-[var(--color-surface-container)]" data-testid="trace-detail-loading" />
      ) : null}
      {fetchFailed ? (
        <NoticeBar text={t('trace.detail.fetchFailed')} />
      ) : null}
      {legacyFallback ? (
        <NoticeBar text={t('trace.detail.legacyTruncated')} />
      ) : null}

      <Section sectionKey="llm.response" title={t('trace.section.response')} defaultOpen>
        <ResponseContent
          call={effectiveCall}
          pending={!isTerminal}
          parsedMessage={parsed.response?.message ?? null}
          stopReason={parsed.response?.stopReason}
        />
      </Section>

      {split.injections.length > 0 ? (
        <Section
          sectionKey="llm.context"
          title={t('trace.section.context')}
          badge={split.injections.length}
          defaultOpen
        >
          <ContextInjectionList injections={split.injections} />
        </Section>
      ) : null}

      {split.conversation.length > 0 ? (
        <Section
          sectionKey="llm.messages"
          title={t('trace.section.messages')}
          badge={split.conversation.length}
          defaultOpen
        >
          <MessageList messages={split.conversation} />
        </Section>
      ) : null}

      {parsed.request?.system ? (
        <Section
          sectionKey="llm.systemPrompt"
          title={t('trace.section.systemPrompt')}
          badge={t('trace.detail.chars', { count: parsed.request.system.length })}
          actions={
            <CopyButton
              text={parsed.request.system}
              copiedLabel={t('common.copied')}
              className="rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)]"
            />
          }
        >
          <pre className="max-h-[400px] overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-[1.7] text-[var(--color-text-secondary)]">
            {parsed.request.system}
          </pre>
        </Section>
      ) : null}

      {parsed.request && parsed.request.tools.length > 0 ? (
        <Section sectionKey="llm.tools" title={t('trace.section.tools')} badge={parsed.request.tools.length}>
          <ToolDefinitions tools={parsed.request.tools} />
        </Section>
      ) : null}

      {paramEntries.length > 0 ? (
        <Section sectionKey="llm.parameters" title={t('trace.section.parameters')} badge={paramEntries.length}>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[12.5px]">
            {paramEntries.map(([key, value]) => (
              <ParamRow key={key} name={key} value={value} />
            ))}
          </dl>
        </Section>
      ) : null}

      <Section sectionKey="llm.raw" title={t('trace.section.raw')} defaultOpen={legacyFallback}>
        <RawBodies call={effectiveCall} />
      </Section>
    </div>
  )
}

export function isAbortedTraceCall(call: TraceCallRecord): boolean {
  if (call.metadata?.aborted === true) return true
  const name = call.error?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

function ResponseContent({
  call,
  pending,
  parsedMessage,
  stopReason,
}: {
  call: TraceCallRecord
  pending: boolean
  parsedMessage: NormalizedMessage | null
  stopReason?: string
}) {
  const t = useTranslation()
  if (call.error) {
    const aborted = isAbortedTraceCall(call)
    return (
      <div
        className="rounded-[var(--radius-lg)] border border-l-4 border-[var(--color-error)] bg-[var(--color-error-container)] px-4 py-3"
        data-testid="trace-call-error"
      >
        <div className="flex min-w-0 items-center gap-2">
          <div className="text-[13px] font-bold text-[var(--color-error)]">{call.error.name}</div>
          {aborted ? (
            <Badge tone="danger" size="xs" pill={false} bordered data-testid="trace-call-aborted-badge">
              {t('trace.status.aborted')}
            </Badge>
          ) : null}
        </div>
        <div className="mt-1.5 text-[13px] leading-[1.6] text-[var(--color-on-error-container)]">{call.error.message}</div>
        {aborted ? (
          <div className="mt-1.5 text-[12px] leading-[1.6] text-[var(--color-on-error-container)]">
            {t('trace.detail.aborted')}
          </div>
        ) : null}
        {call.error.stack ? (
          <details className="mt-2">
            <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              stack
            </summary>
            <pre className="mt-1.5 max-h-[240px] overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.6] text-[var(--color-text-tertiary)]">
              {call.error.stack}
            </pre>
          </details>
        ) : null}
      </div>
    )
  }
  if (pending) {
    return (
      <div className="flex items-center gap-2 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] px-4 py-3.5 text-[13px] text-[var(--color-text-tertiary)]">
        <Spinner size={14} />
        {t('trace.detail.streaming')}
      </div>
    )
  }
  if (!parsedMessage) {
    return (
      <EmptyState
        description={call.response ? t('trace.detail.legacyTruncated') : t('trace.noResponse')}
        variant="dashed"
        size="sm"
      />
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <MessageBlocks message={parsedMessage} />
      {stopReason ? (
        <div className="flex items-center gap-2 text-[13px] text-[var(--color-text-secondary)]">
          <span>{t('trace.detail.stopReason')}</span>
          <Badge tone="neutral" size="sm" pill={false} mono>{stopReason}</Badge>
        </div>
      ) : null}
    </div>
  )
}

function MessageList({ messages }: { messages: NormalizedMessage[] }) {
  const t = useTranslation()
  const [showAll, setShowAll] = useState(false)
  if (showAll || messages.length <= MESSAGE_FOLD_THRESHOLD) {
    return (
      <div className="flex flex-col gap-2.5">
        {messages.map((message, index) => <MessageBlocks key={index} message={message} />)}
      </div>
    )
  }
  const head = messages.slice(0, MESSAGE_HEAD_COUNT)
  const tail = messages.slice(messages.length - MESSAGE_TAIL_COUNT)
  const hiddenCount = messages.length - head.length - tail.length
  return (
    <div className="flex flex-col gap-2.5">
      {head.map((message, index) => <MessageBlocks key={`head-${index}`} message={message} />)}
      <button
        type="button"
        onClick={() => setShowAll(true)}
        className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] px-3 py-2 text-[12.5px] text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)] active:scale-[0.98]"
      >
        {t('trace.detail.earlierMessages', { count: hiddenCount })}
      </button>
      {tail.map((message, index) => <MessageBlocks key={`tail-${index}`} message={message} />)}
    </div>
  )
}

const CONTEXT_KIND_LABEL = {
  'system-reminder': 'trace.context.systemReminder',
  'deferred-tools': 'trace.context.deferredTools',
  other: 'trace.context.other',
} as const satisfies Record<LocatedInjection['kind'], string>

/**
 * The context the harness assembled for this request, one row per injection.
 * Collapsed rows carry the kind and size so a scan shows what was added
 * without opening anything.
 */
function ContextInjectionList({ injections }: { injections: LocatedInjection[] }) {
  const t = useTranslation()
  // Keyed by content, not position: a live session re-renders on every poll and
  // an index would then point at whichever injection landed in that slot.
  const [expanded, setExpanded] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-1.5">
      {injections.map((injection) => {
        const key = `${injection.messageIndex}:${injection.kind}:${injection.label}`
        const open = expanded === key
        return (
          <div key={key} className="rounded-[var(--radius-md)] border border-[var(--color-border)]">
            <button
              type="button"
              onClick={() => setExpanded((current) => (current === key ? null : key))}
              aria-expanded={open}
              className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--color-surface-container)]"
            >
              <span className="shrink-0 rounded-full bg-[var(--color-surface-container)] px-2 py-0.5 text-[11px] text-[var(--color-text-tertiary)]">
                {t(CONTEXT_KIND_LABEL[injection.kind])}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-text-primary)]">
                {injection.label}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-[var(--color-text-tertiary)]">
                {t('trace.detail.chars', { count: injection.text.length })}
              </span>
            </button>
            {open ? (
              <pre className="max-h-[320px] overflow-y-auto whitespace-pre-wrap break-words border-t border-[var(--color-border)] px-2.5 py-2 text-[12.5px] leading-[1.7] text-[var(--color-text-secondary)]">
                {injection.text}
              </pre>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function ToolDefinitions({ tools }: { tools: Array<{ name: string; description?: string; schema?: unknown }> }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const active = tools.find((tool) => tool.name === expanded)
  return (
    <div>
      <div className="flex flex-wrap gap-1">
        {tools.map((tool) => (
          <button
            key={tool.name}
            type="button"
            onClick={() => setExpanded((current) => current === tool.name ? null : tool.name)}
            aria-pressed={expanded === tool.name}
            {...(tool.description ? { title: tool.description } : {})}
            className={`rounded-full border px-2.5 py-0.5 font-mono text-[11.5px] transition-colors ${
              expanded === tool.name
                ? 'border-[var(--color-primary-fixed-dim)] bg-[var(--color-brand-soft)] text-[var(--color-on-brand-soft)]'
                : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-outline)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            {tool.name}
          </button>
        ))}
      </div>
      {active ? (
        <div className="mt-2.5">
          {active.description ? (
            <p className="mb-2 text-[12.5px] leading-[1.6] text-[var(--color-text-secondary)]">{active.description}</p>
          ) : null}
          <CodeViewer code={formatTraceJson(active.schema ?? null)} language="json" maxLines={24} showLineNumbers />
        </div>
      ) : null}
    </div>
  )
}

function ParamRow({ name, value }: { name: string; value: unknown }) {
  return (
    <>
      <dt className="font-mono text-[var(--color-text-tertiary)]">{name}</dt>
      <dd className="min-w-0 truncate font-mono text-[var(--color-text-secondary)]" title={stringifyParam(value)}>
        {stringifyParam(value)}
      </dd>
    </>
  )
}

function stringifyParam(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return String(value)
  }
}

function RawBodies({ call }: { call: TraceCallRecord }) {
  const t = useTranslation()
  return (
    <div className="flex flex-col gap-3">
      <RawBody title={t('trace.requestBody')} body={call.request.body} maxLines={80} />
      <RawHeaders title={t('trace.requestHeaders')} headers={call.request.headers} />
      {call.response ? (
        <>
          <RawBody title={t('trace.responseBody')} body={call.response.body} maxLines={80} />
          <RawHeaders title={t('trace.responseHeaders')} headers={call.response.headers} />
        </>
      ) : null}
    </div>
  )
}

function RawBody({ title, body, maxLines }: { title: string; body: TraceBodySnapshot; maxLines: number }) {
  const t = useTranslation()
  const code = body.contentType === 'json' ? formatTraceJson(body.preview) : body.preview
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">{title}</span>
        <span className="font-mono text-[11px] text-[var(--color-text-tertiary)]">
          {formatBytes(body.bytes)}{body.truncated ? ` · ${t('trace.truncatedShort')}` : ''}
        </span>
      </div>
      {code ? (
        <CodeViewer code={code} language={body.contentType === 'json' ? 'json' : 'text'} maxLines={maxLines} showLineNumbers={body.contentType === 'json'} />
      ) : (
        <EmptyState description={t('trace.noData')} variant="dashed" size="sm" />
      )}
    </div>
  )
}

function RawHeaders({ title, headers }: { title: string; headers: Record<string, string> }) {
  return (
    <div>
      <div className="mb-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">{title}</div>
      <CodeViewer code={formatTraceJson(headers)} language="json" maxLines={20} showLineNumbers />
    </div>
  )
}

function NoticeBar({ text }: { text: string }) {
  return (
    <div className="mx-6 mt-4 rounded-[var(--radius-md)] border border-[var(--color-warning)] bg-[var(--color-warning-container)] px-3.5 py-2 text-[12.5px] text-[var(--color-on-warning-container)]">
      {text}
    </div>
  )
}
