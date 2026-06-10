import { useMemo } from 'react'
import { useTranslation } from '../../../i18n'
import type { MessageEntry } from '../../../types/session'
import type { TraceSpan } from '../../../lib/traceViewModel'
import { formatTraceJson } from '../../../lib/traceViewModel'
import type { NormalizedBlock, NormalizedMessage } from '../../../lib/trace/types'
import { normalizeContentBlock } from '../../../lib/trace/sse'
import { CodeViewer } from '../../chat/CodeViewer'
import { Section } from './Section'
import { MessageBlocks } from './MessageBlocks'

export function MessageDetail({ span }: { span: TraceSpan }) {
  const t = useTranslation()
  const message = span.message
  const normalized = useMemo(
    () => message ? normalizeMessageEntry(message) : null,
    [message],
  )

  if (!message || !normalized) return null

  return (
    <div data-testid="trace-message-detail">
      <Section sectionKey="message.content" title={t('trace.section.content')} defaultOpen>
        {normalized.content.length > 0 ? (
          <MessageBlocks message={normalized} />
        ) : (
          <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] px-3 py-3 text-xs text-[var(--color-text-tertiary)]">
            {t('trace.noData')}
          </div>
        )}
      </Section>
      <Section sectionKey="message.raw" title={t('trace.section.raw')}>
        <CodeViewer code={formatTraceJson(message.content)} language="json" maxLines={48} showLineNumbers />
      </Section>
    </div>
  )
}

function normalizeMessageEntry(message: MessageEntry): NormalizedMessage {
  const role: NormalizedMessage['role'] =
    message.type === 'assistant' || message.type === 'tool_use'
      ? 'assistant'
      : message.type === 'system'
        ? 'system'
        : message.type === 'tool_result'
          ? 'tool'
          : 'user'
  const content = message.content
  if (typeof content === 'string') {
    return { role, content: [{ type: 'text', text: content }] }
  }
  if (Array.isArray(content)) {
    const blocks = content
      .map((block) => normalizeContentBlock(block))
      .filter((block): block is NormalizedBlock => block !== null)
    return { role, content: blocks }
  }
  return { role, content: [] }
}
