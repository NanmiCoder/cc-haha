import { memo, useCallback, useMemo, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { OpenWithMenu } from '@/components/composite/OpenWithMenu'
import { buildOpenWithMenuItemsForHref } from '../../lib/openWithMenuItems'
import { fileRefFromElement } from '../../lib/markdownAutolink'
import type { OpenWithItem } from '../../lib/openWithItems'
import { MessageActionBar, type MessageBranchAction } from './MessageActionBar'
import { TurnCompletionStamp } from './TurnCompletionStamp'
import type { TurnCompletion } from '../../lib/turnCompletion'
import { InlineImageGallery } from './InlineImageGallery'
import { InlineVideoGallery } from './InlineVideoGallery'
import { AssistantOutputTargetCard } from './AssistantOutputTargetCard'
import { openPreviewLink } from '../../lib/openPreviewLink'
import { extractAssistantOutputTargets } from '../../lib/assistantOutputTargets'
import { createAssistantMarkdownImageResolver } from '../../lib/markdownImages'
import { getServerBaseUrl } from '../../lib/desktopRuntime'
import { isManagedGeneratedImagePath } from '../../lib/attachmentImages'
import { useWorkspaceContentStore } from '../../stores/workspaceContentStore'
import { useTranslation, type TranslationKey } from '../../i18n'

type Props = {
  content: string
  isStreaming?: boolean
  branchAction?: MessageBranchAction
  sessionId?: string
  /** This turn's real changed files (absolute), used to anchor output chips onto
   *  files that were actually written instead of guessing from the prose. */
  turnChangedFiles?: string[]
  /** Only one assistant message per turn owns fallback cards for unmentioned changed files. */
  isTurnOutputOwner?: boolean
  /** Set only on the last reply of a finished turn: when it ended and how long it took. */
  turnCompletion?: TurnCompletion
}

const MAX_CARDS = 3

export const AssistantMessage = memo(function AssistantMessage({
  content,
  isStreaming,
  branchAction,
  sessionId,
  turnChangedFiles,
  isTurnOutputOwner = true,
  turnCompletion,
}: Props) {
  const t = useTranslation()
  const workDir = useWorkspaceContentStore((s) => (sessionId ? s.statusBySession[sessionId]?.workDir : undefined))

  const [openWith, setOpenWith] = useState<{ items: OpenWithItem[]; anchor: DOMRect } | null>(null)

  const handleLinkClick = useCallback(
    (href: string, event: ReactMouseEvent<HTMLDivElement>): boolean => {
      if (!sessionId) return false
      const handled = openPreviewLink(href, sessionId)
      if (handled) event.preventDefault()
      return handled
    },
    [sessionId],
  )

  // Right-clicking a reference in the prose opens the same menu the output cards
  // and the file tree use, so "open in VS Code" / "reveal in Finder" / "copy
  // path" are reachable from the place the model actually names the file.
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!sessionId) return
      const target = event.target as HTMLElement | null
      const link = target?.closest<HTMLAnchorElement>('a[data-file-path], a[href]')
      const href = fileRefFromElement(link) ?? link?.getAttribute('href')
      if (!href) return

      event.preventDefault()
      const anchor = link!.getBoundingClientRect()
      void (async () => {
        const items = await buildOpenWithMenuItemsForHref(href, {
          sessionId,
          workDir,
          // Cast t: useTranslation takes TranslationKey, the builder takes string.
          // Every key it looks up is a valid TranslationKey, so this is safe.
          t: (key, vars) => t(key as TranslationKey, vars),
        })
        if (items.length > 0) setOpenWith({ items, anchor })
      })()
    },
    [sessionId, t, workDir],
  )

  const outputTargets = useMemo(
    () =>
      isStreaming || !sessionId
        ? []
        : // Image/video targets render inline (InlineImageGallery/InlineVideoGallery); never also as a card.
          extractAssistantOutputTargets(content, {
            workDir,
            changedFiles: turnChangedFiles,
            includeChangedFileFallback: isTurnOutputOwner,
          }).filter(
            (target) => target.kind !== 'image' && target.kind !== 'video',
          ),
    [content, isStreaming, isTurnOutputOwner, sessionId, workDir, turnChangedFiles],
  )
  const resolveAssistantImageSrc = useMemo(
    () => {
      if (isStreaming || !sessionId) return undefined
      const resolveLocalImage = createAssistantMarkdownImageResolver({
        baseUrl: getServerBaseUrl(),
        sessionId,
      })
      return (src: string) => isManagedGeneratedImagePath(src)
        ? null
        : resolveLocalImage(src)
    },
    [isStreaming, sessionId],
  )

  if (!content.trim()) return null

  const documentLayout = shouldUseDocumentLayout(content)
  const showTurnCompletion = !isStreaming && Boolean(turnCompletion)

  return (
    <div className="flex justify-start">
      <div
        data-message-shell="assistant"
        data-layout={documentLayout ? 'document' : 'bubble'}
        // Always the full column. A reply that hugs its text turns every short
        // answer into a differently-shaped block, so a scrolled transcript reads
        // as a ragged pile; one width makes the replies a single column the eye
        // can run down. The user bubble stays hugged — that asymmetry is what
        // says which side is speaking, so it does not need width to say it too.
        className="group flex w-full min-w-0 max-w-full flex-col items-start"
      >
        <div
          onContextMenu={sessionId ? handleContextMenu : undefined}
          // No card. Left-aligned, full-column prose against the page is already
          // unmistakably the reply — the hugged, tinted bubble on the right is
          // what says who is speaking (see the note above), so a border here
          // repeats that at the cost of ~50px per reply and makes prose look
          // like the tool rows it sits between. The turn rail groups it now.
          className="w-full text-[14.5px] text-[var(--color-text-primary)]"
        >
          <MarkdownRenderer
            content={content}
            variant={documentLayout ? 'document' : 'default'}
            streaming={isStreaming}
            onLinkClick={sessionId ? handleLinkClick : undefined}
            resolveImageSrc={resolveAssistantImageSrc}
          />
          {!isStreaming && (
            <InlineImageGallery
              text={content}
              sessionId={sessionId}
              workDir={workDir}
              changedFiles={turnChangedFiles}
              suppressManagedGeneratedImages
            />
          )}
          {!isStreaming && (
            <InlineVideoGallery
              text={content}
              sessionId={sessionId}
              workDir={workDir}
              changedFiles={turnChangedFiles}
            />
          )}
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

        {openWith && (
          <OpenWithMenu
            items={openWith.items}
            anchor={openWith.anchor}
            onClose={() => setOpenWith(null)}
          />
        )}

        {/*
          Only the reply that closes a turn gets this footer. A turn emits many
          intermediate replies ("checking the lint spread now") and nobody copies
          or forks from those — yet the bar reserved 36px on each one whether or
          not it was hovered, which on a one-line reply outweighed the text.
          The action buttons and completion metadata share one compact row so a
          finished answer has one visual close instead of two stacked footers.
          Being rare now, it stays visible instead of waiting for a hover.
          Mid-turn text is still copyable by selecting it (SelectableChatMessage).
        */}
        {showTurnCompletion && (
          <MessageActionBar
            copyText={content}
            copyLabel={t('chat.copyReply')}
            branchAction={branchAction}
            align="start"
            alwaysVisible
            metadata={<TurnCompletionStamp completion={turnCompletion!} />}
          />
        )}
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
