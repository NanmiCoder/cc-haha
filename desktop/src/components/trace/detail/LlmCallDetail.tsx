import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import type { TraceBodySnapshot, TraceCallRecord } from '../../../types/trace'
import type { TraceSpan } from '../../../lib/traceViewModel'
import { formatTraceJson } from '../../../lib/traceViewModel'
import { fetchTraceCallDetail } from '../../../lib/trace/callCache'
import { parseTraceRequestBody, parseTraceResponseBody } from '../../../lib/trace/requestParse'
import type { NormalizedMessage } from '../../../lib/trace/types'
import { formatBytes } from '../../../lib/formatBytes'
import { CodeViewer } from '../../chat/CodeViewer'
import { CopyButton } from '../../shared/CopyButton'
import { MetaChip } from '../TraceBadges'
import { Section } from './Section'
import { MessageBlocks } from './MessageBlocks'

const MESSAGE_FOLD_THRESHOLD = 20
const MESSAGE_HEAD_COUNT = 2
const MESSAGE_TAIL_COUNT = 6

export function LlmCallDetail({ sessionId, span }: { sessionId: string; span: TraceSpan }) {
  const t = useTranslation()
  const call = span.call
  const callId = call?.id ?? null
  const isTerminal = span.status !== 'pending'
  const [detail, setDetail] = useState<TraceCallRecord | null>(null)
  const [fetchFailed, setFetchFailed] = useState(false)
  const fetchKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!callId || !isTerminal) return
    const key = `${sessionId}:${callId}`
    // Ref guard keeps React StrictMode's double effect run from issuing a
    // second request; staleness is checked against the ref at resolve time.
    if (fetchKeyRef.current === key) return
    fetchKeyRef.current = key
    void fetchTraceCallDetail(sessionId, callId).then((full) => {
      if (fetchKeyRef.current !== key) return
      if (full) {
        setDetail(full)
        setFetchFailed(false)
      } else {
        setFetchFailed(true)
      }
    })
  }, [sessionId, callId, isTerminal])

  const effectiveCall = detail && detail.id === callId ? detail : call
  const parsed = useMemo(() => {
    if (!effectiveCall) return { request: null, response: null }
    return {
      request: effectiveCall.request.body.preview
        ? parseTraceRequestBody(effectiveCall.request.body.preview, effectiveCall.source)
        : null,
      response: effectiveCall.response?.body.preview
        ? parseTraceResponseBody(effectiveCall.response.body.preview, effectiveCall.source)
        : null,
    }
  }, [effectiveCall])

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

      {parsed.request && parsed.request.messages.length > 0 ? (
        <Section
          sectionKey="llm.messages"
          title={t('trace.section.messages')}
          badge={parsed.request.messages.length}
          defaultOpen
        >
          <MessageList messages={parsed.request.messages} />
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
              className="rounded-[var(--radius-sm)] border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)]"
            />
          }
        >
          <pre className="max-h-[400px] overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-[var(--color-text-secondary)]">
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
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[11px]">
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
        className="rounded-[var(--radius-md)] border border-[var(--color-error)]/25 bg-[var(--color-error-container)]/40 px-3 py-2"
        data-testid="trace-call-error"
      >
        <div className="flex min-w-0 items-center gap-2">
          <div className="text-xs font-semibold text-[var(--color-error)]">{call.error.name}</div>
          {aborted ? (
            <span
              className="inline-flex shrink-0 items-center rounded-[var(--radius-sm)] bg-[var(--color-error)]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-error)]"
              data-testid="trace-call-aborted-badge"
            >
              {t('trace.status.aborted')}
            </span>
          ) : null}
        </div>
        <div className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)]">{call.error.message}</div>
        {aborted ? (
          <div className="mt-1 text-[11px] leading-4 text-[var(--color-text-tertiary)]">
            {t('trace.detail.aborted')}
          </div>
        ) : null}
        {call.error.stack ? (
          <details className="mt-1.5">
            <summary className="cursor-pointer text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
              stack
            </summary>
            <pre className="mt-1 max-h-[240px] overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-[var(--color-text-tertiary)]">
              {call.error.stack}
            </pre>
          </details>
        ) : null}
      </div>
    )
  }
  if (pending) {
    return (
      <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] px-3 py-3 text-xs text-[var(--color-text-tertiary)]">
        <Loader2 size={13} strokeWidth={2} className="animate-spin" />
        {t('trace.detail.streaming')}
      </div>
    )
  }
  if (!parsedMessage) {
    return (
      <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] px-3 py-3 text-xs text-[var(--color-text-tertiary)]">
        {call.response ? t('trace.detail.legacyTruncated') : t('trace.noResponse')}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <MessageBlocks message={parsedMessage} />
      {stopReason ? (
        <div>
          <MetaChip label={t('trace.detail.stopReason')} value={stopReason} />
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
      <div className="flex flex-col gap-2">
        {messages.map((message, index) => <MessageBlocks key={index} message={message} />)}
      </div>
    )
  }
  const head = messages.slice(0, MESSAGE_HEAD_COUNT)
  const tail = messages.slice(messages.length - MESSAGE_TAIL_COUNT)
  const hiddenCount = messages.length - head.length - tail.length
  return (
    <div className="flex flex-col gap-2">
      {head.map((message, index) => <MessageBlocks key={`head-${index}`} message={message} />)}
      <button
        type="button"
        onClick={() => setShowAll(true)}
        className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] px-3 py-1.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)] active:scale-[0.98]"
      >
        {t('trace.detail.earlierMessages', { count: hiddenCount })}
      </button>
      {tail.map((message, index) => <MessageBlocks key={`tail-${index}`} message={message} />)}
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
            className={`rounded-[var(--radius-sm)] border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
              expanded === tool.name
                ? 'border-[var(--color-border-focus)] text-[var(--color-text-primary)]'
                : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            {tool.name}
          </button>
        ))}
      </div>
      {active ? (
        <div className="mt-2">
          {active.description ? (
            <p className="mb-1.5 text-[11px] leading-5 text-[var(--color-text-secondary)]">{active.description}</p>
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
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">{title}</span>
        <span className="font-mono text-[10px] text-[var(--color-text-tertiary)]">
          {formatBytes(body.bytes)}{body.truncated ? ` · ${t('trace.truncatedShort')}` : ''}
        </span>
      </div>
      {code ? (
        <CodeViewer code={code} language={body.contentType === 'json' ? 'json' : 'text'} maxLines={maxLines} showLineNumbers={body.contentType === 'json'} />
      ) : (
        <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-text-tertiary)]">
          {t('trace.noData')}
        </div>
      )}
    </div>
  )
}

function RawHeaders({ title, headers }: { title: string; headers: Record<string, string> }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">{title}</div>
      <CodeViewer code={formatTraceJson(headers)} language="json" maxLines={20} showLineNumbers />
    </div>
  )
}

function NoticeBar({ text }: { text: string }) {
  return (
    <div className="mx-4 mt-3 rounded-[var(--radius-md)] border border-[var(--color-warning)]/30 bg-[var(--color-warning-container)]/30 px-3 py-1.5 text-[11px] text-[var(--color-text-secondary)]">
      {text}
    </div>
  )
}
