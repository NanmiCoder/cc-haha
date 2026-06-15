import { memo, useCallback, useEffect, useMemo } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { MessageActionBar, type MessageBranchAction } from './MessageActionBar'
import { InlineImageGallery } from './InlineImageGallery'
import { InlineVideoGallery } from './InlineVideoGallery'
import { AssistantOutputTargetCard } from './AssistantOutputTargetCard'
import { FakeToolUseNotice } from './FakeToolUseNotice'
import { handlePreviewLink } from '../../lib/handlePreviewLink'
import { getServerBaseUrl } from '../../lib/desktopRuntime'
import { getDesktopHost } from '../../lib/desktopHost'
import { extractAssistantOutputTargets } from '../../lib/assistantOutputTargets'
import { extractFakeToolUseBlocks } from '../../lib/fakeToolUseDetection'
import { useBrowserPanelStore } from '../../stores/browserPanelStore'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { useProviderStore } from '../../stores/providerStore'
import { useProviderCompatStore } from '../../stores/providerCompatStore'
import { useTranslation } from '../../i18n'

type Props = {
  content: string
  isStreaming?: boolean
  branchAction?: MessageBranchAction
  sessionId?: string
  timestamp?: number
  /** This turn's real changed files (absolute), used to anchor output chips onto
   *  files that were actually written instead of guessing from the prose. */
  turnChangedFiles?: string[]
}

const MAX_CARDS = 3

export const AssistantMessage = memo(function AssistantMessage({ content, isStreaming, branchAction, sessionId, timestamp, turnChangedFiles }: Props) {
  const t = useTranslation()
  const workDir = useWorkspacePanelStore((s) => (sessionId ? s.statusBySession[sessionId]?.workDir : undefined))
  const activeProviderId = useProviderStore((s) => s.activeId)

  // Some providers/gateways relay model output as raw text instead of
  // structured tool_use blocks. The model then emits XML-style fake
  // <tool_use ...> markers that read as garbage in the chat (e.g.
  // `<tool_useid="..."` after HTML whitespace collapsing). Strip those
  // before MarkdownRenderer sees the content, and surface a notice card
  // so the user knows the model attempted a tool call that didn't run.
  const { cleanContent, fakeBlocks } = useMemo(() => {
    const extraction = extractFakeToolUseBlocks(content)
    return { cleanContent: extraction.cleanText, fakeBlocks: extraction.blocks }
  }, [content])

  // Each detected block is a leak attributable to the active provider.
  // Record them on completion so we don't double-count mid-stream while
  // the same opener gets re-extracted on every token. Keyed on the
  // resolved content + isStreaming so identical replays only fire once.
  useEffect(() => {
    if (isStreaming) return
    if (fakeBlocks.length === 0) return
    const recorder = useProviderCompatStore.getState().recordFakeToolUse
    for (const block of fakeBlocks) {
      recorder(activeProviderId, block.name)
    }
    // We intentionally depend on the message's identity (content) rather
    // than the array — a finalized message replays at most once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, isStreaming, activeProviderId])

  const handleLinkClick = useCallback(
    (href: string, event: ReactMouseEvent<HTMLDivElement>): boolean => {
      if (!sessionId) return false
      const handled = handlePreviewLink(href, {
        sessionId,
        serverBaseUrl: getServerBaseUrl(),
        openBrowser: (id, url) => useBrowserPanelStore.getState().open(id, url),
        openFilePreview: (id, path) => {
          void useWorkspacePanelStore.getState().openPreview(id, path, 'file')
        },
        openExternal: (url) => {
          void getDesktopHost().shell.open(url)
            .catch(() => window.open(url, '_blank'))
        },
      })
      if (handled) event.preventDefault()
      return handled
    },
    [sessionId],
  )

  const outputTargets = useMemo(
    () =>
      isStreaming || !sessionId
        ? []
        : // Image/video targets render inline (InlineImageGallery/InlineVideoGallery); never also as a card.
          extractAssistantOutputTargets(cleanContent, { workDir, changedFiles: turnChangedFiles }).filter(
            (target) => target.kind !== 'image' && target.kind !== 'video',
          ),
    [cleanContent, isStreaming, sessionId, workDir, turnChangedFiles],
  )

  if (!cleanContent.trim() && fakeBlocks.length === 0) return null

  const documentLayout = shouldUseDocumentLayout(cleanContent)

  return (
    <div className="mb-5 flex justify-start">
      <div
        data-message-shell="assistant"
        data-layout={documentLayout ? 'document' : 'bubble'}
        className={`group flex min-w-0 flex-col items-start ${
          documentLayout
            ? 'w-full max-w-full'
            : 'max-w-[88%] sm:max-w-[80%] lg:max-w-[72%]'
        }`}
      >
        <div className={`rounded-[20px] rounded-tl-[8px] border border-[var(--color-border)]/60 bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-text-primary)] shadow-sm ${
          documentLayout ? 'w-full' : 'max-w-full'
        }`}>
          <FakeToolUseNotice blocks={fakeBlocks} />
          <MarkdownRenderer
            content={cleanContent}
            variant={documentLayout ? 'document' : 'default'}
            streaming={isStreaming}
            onLinkClick={sessionId ? handleLinkClick : undefined}
          />
          {!isStreaming && <InlineImageGallery text={cleanContent} sessionId={sessionId} workDir={workDir} />}
          {!isStreaming && <InlineVideoGallery text={cleanContent} sessionId={sessionId} workDir={workDir} />}
          {isStreaming && (
            <span className="ml-0.5 inline-block h-4 w-0.5 animate-shimmer bg-[var(--color-brand)] align-text-bottom" />
          )}
        </div>

        {!isStreaming && sessionId && outputTargets.length > 0 && (
          <div className="mt-1 flex w-full flex-col gap-2">
            {outputTargets.slice(0, MAX_CARDS).map((target) => (
              <AssistantOutputTargetCard key={target.id} target={target} sessionId={sessionId} workDir={workDir} />
            ))}
            {outputTargets.length > MAX_CARDS && (
              <div className="px-1 text-xs text-[var(--color-text-tertiary)]">
                {t('assistantOutputs.moreOutputs', { count: String(outputTargets.length - MAX_CARDS) })}
              </div>
            )}
          </div>
        )}

        <MessageActionBar
          copyText={isStreaming ? undefined : cleanContent}
          copyLabel="Copy reply"
          branchAction={branchAction}
          align="start"
          timestamp={timestamp}
        />
      </div>
    </div>
  )
})

function shouldUseDocumentLayout(content: string) {
  const normalized = content.trim()
  if (!normalized) return false

  if (/```/.test(normalized)) return true
  if (/^\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\|.+\|)/m.test(normalized)) return true

  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)

  return paragraphs.length >= 2 || normalized.split('\n').filter((line) => line.trim()).length >= 8
}
