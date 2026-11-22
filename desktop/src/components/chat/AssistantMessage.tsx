import { memo, useCallback, useMemo, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { OpenWithMenu } from '@/components/composite/OpenWithMenu'
import { buildOpenWithMenuItemsForHref } from '../../lib/openWithMenuItems'
import { fileRefFromElement } from '../../lib/markdownAutolink'
import type { OpenWithItem } from '../../lib/openWithItems'
import { MessageActionBar, type MessageBranchAction } from './MessageActionBar'
import { useMessageActionMenu } from './useMessageActionMenu'
import { TurnCompletionStamp } from './TurnCompletionStamp'
import type { TurnCompletion } from '../../lib/turnCompletion'
import { ImageGalleryModal } from './ImageGalleryModal'
import { InlineImageGallery } from './InlineImageGallery'
import { InlineVideoGallery } from './InlineVideoGallery'
import { AssistantOutputTargetCard } from './AssistantOutputTargetCard'
import { openPreviewLink } from '../../lib/openPreviewLink'
import {
  collectAssistantOutputMentions,
  extractMarkdownAudioSources,
  resolveAssistantOutputMentions,
  selectAssistantOutputTargets,
  type TurnOutputEvidence,
} from '@/lib/assistantOutputTargets'
import { resolveAssistantFileHref } from '@/lib/assistantFileContext'
import {
  createAssistantMarkdownAudioResolver,
  createAssistantMarkdownImageResolver,
  localPathFromMarkdownImageUrl,
  normalizeMarkdownImageDestination,
} from '../../lib/markdownImages'
import { isAbsoluteLocalPath } from '../../lib/handlePreviewLink'
import type { MarkdownImageClick } from '../markdown/MarkdownRenderer'
import { getServerBaseUrl } from '../../lib/desktopRuntime'
import { isManagedGeneratedImagePath } from '../../lib/attachmentImages'
import { useWorkspaceContentStore } from '../../stores/workspaceContentStore'
import { useTranslation, type TranslationKey } from '../../i18n'
import { useDiskConfirmedTargets } from '../../hooks/useDiskConfirmedTargets'
import { useWorkspacePathAliases } from '@/hooks/useWorkspacePathAliases'
import { useTurnWrittenTargets } from '../../hooks/useTurnWrittenTargets'
import { createWorkspaceFileLinkVerifier } from '../../lib/workspaceFileStats'
import type { PreviewLinkTarget } from '@/lib/previewLinkRouter'

type Props = {
  content: string
  isStreaming?: boolean
  branchAction?: MessageBranchAction
  sessionId?: string
  /** This turn's real changed files (absolute), used to anchor output chips onto
   *  files that were actually written instead of guessing from the prose. */
  turnChangedFiles?: string[]
  /**
   * What the turn's checkpoint says it could have written. Absent while it is
   * still loading, so no card is shown on a guess that the checkpoint then drops.
   */
  turnOutputEvidence?: TurnOutputEvidence
  /** Only one assistant message per turn owns fallback cards for unmentioned changed files. */
  isTurnOutputOwner?: boolean
  /** Set only on the last reply of a finished turn: when it ended and how long it took. */
  turnCompletion?: TurnCompletion
  /** Latest turn keeps its closing action bar visible; earlier turns reveal on hover. */
  isLatestTurn?: boolean
}

const MAX_CARDS = 3

function audioPathComparisonKey(raw: string, workDir?: string | null): string | null {
  const normalized = normalizeMarkdownImageDestination(raw).trim()
  if (!normalized || /^(?:data:|blob:|https?:)/i.test(normalized)) return null
  const withoutSuffix = normalized.split('#')[0]!.split('?')[0]!
  let decoded = withoutSuffix
  try {
    decoded = decodeURIComponent(withoutSuffix)
  } catch {
    // Keep raw string comparable if percent-escape is malformed.
  }
  const slashed = decoded.replaceAll('\\', '/').replace(/^\.\//, '')
  const unprefixed = /^\/([A-Za-z]:\/)/.test(slashed) ? slashed.slice(1) : slashed
  const absolute = workDir && !isAbsoluteLocalPath(unprefixed) && !unprefixed.startsWith('~/')
    ? `${workDir.replaceAll('\\', '/').replace(/\/+$/, '')}/${unprefixed.replace(/^\/+/, '')}`
    : unprefixed
  const isWindows = /^[A-Za-z]:\//.test(absolute)
  return isWindows ? absolute.toLowerCase() : absolute
}

export const AssistantMessage = memo(function AssistantMessage({
  content,
  isStreaming,
  branchAction,
  sessionId,
  turnChangedFiles,
  turnOutputEvidence,
  isTurnOutputOwner = true,
  turnCompletion,
  isLatestTurn = true,
}: Props) {
  const t = useTranslation()
  const workDir = useWorkspaceContentStore((s) => (sessionId ? s.statusBySession[sessionId]?.workDir : undefined))

  const mentions = useMemo(() => isStreaming || !sessionId ? [] : collectAssistantOutputMentions(content, {
    workDir, includeUnconfirmedNames: true,
  }), [content, isStreaming, sessionId, workDir])
  const mentionedPaths = useMemo(() => mentions.flatMap(({ path }) => path ? [path] : []), [mentions])
  const { aliases, pending } = useWorkspacePathAliases(sessionId, workDir, mentionedPaths)
  const resolvedMentions = useMemo(
    () => resolveAssistantOutputMentions(mentions, aliases, pending, workDir),
    [aliases, mentions, pending, workDir],
  )

  const [openWith, setOpenWith] = useState<{ items: OpenWithItem[]; anchor: DOMRect } | null>(null)
  const [viewer, setViewer] = useState<{ images: Array<{ src: string; name: string; path?: string }>; index: number } | null>(null)

  const handleLinkClick = useCallback(
    (href: PreviewLinkTarget, event: ReactMouseEvent<HTMLDivElement>): boolean => {
      if (!sessionId) return false
      const handled = openPreviewLink(resolveAssistantFileHref(href, content, aliases), sessionId)
      if (handled) event.preventDefault()
      return handled
    },
    [aliases, content, sessionId],
  )

  // A reference guessed from a code span or prose links only once its file is
  // known to exist, judged as the click would resolve it — so a name quoted from
  // a commit message never looks openable.
  const fileLinkVerifier = useMemo(
    () => isStreaming || !sessionId
      ? undefined
      : createWorkspaceFileLinkVerifier(sessionId, (path) => resolveAssistantFileHref(path, content, aliases)),
    [aliases, content, isStreaming, sessionId],
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
        const items = await buildOpenWithMenuItemsForHref(resolveAssistantFileHref(href, content, aliases), {
          sessionId,
          workDir,
          // Cast t: useTranslation takes TranslationKey, the builder takes string.
          // Every key it looks up is a valid TranslationKey, so this is safe.
          t: (key, vars) => t(key as TranslationKey, vars),
        })
        if (items.length > 0) setOpenWith({ items, anchor })
      })()
    },
    [aliases, content, sessionId, t, workDir],
  )

  const inlineAudioKeys = useMemo(() => {
    if (isStreaming || !sessionId) return new Set<string>()
    const keys = new Set<string>()
    for (const raw of extractMarkdownAudioSources(content)) {
      const directKey = audioPathComparisonKey(raw, workDir)
      if (directKey) keys.add(directKey)
      const trimmed = raw.trim().split('#')[0]!.split('?')[0]!
      let decoded = trimmed
      try {
        decoded = decodeURIComponent(trimmed)
      } catch {
        // Keep raw form for alias lookup.
      }
      const aliased = aliases.get(raw) ?? aliases.get(decoded)
      if (aliased) {
        const aliasedKey = audioPathComparisonKey(aliased, workDir)
        if (aliasedKey) keys.add(aliasedKey)
      }
    }
    return keys
  }, [aliases, content, isStreaming, sessionId, workDir])

  const extractedTargets = useMemo(
    () =>
      isStreaming || !sessionId
        ? []
        : // Image/video targets render inline (InlineImageGallery/InlineVideoGallery);
          // inline-embedded audio players (`![...](*.wav)` / `<audio>`) also own their UI.
          selectAssistantOutputTargets(resolvedMentions, {
            workDir,
            changedFiles: turnChangedFiles,
            includeChangedFileFallback: isTurnOutputOwner,
            // Confirmed against the disk by useDiskConfirmedTargets before showing.
            includeUnconfirmedNames: true,
            // A card says the turn produced the file; until the checkpoint says
            // what could have written one, nothing unproven is.
            outputEvidence: { unlistedWrites: turnOutputEvidence?.unlistedWrites ?? false },
          }).filter((target) => {
            if (target.kind === 'image' || target.kind === 'video') return false
            if (inlineAudioKeys.size > 0 && target.kind === 'file') {
              const key = audioPathComparisonKey(target.normalizedPath ?? target.href, workDir)
              if (key && inlineAudioKeys.has(key)) return false
            }
            return true
          }),
    [resolvedMentions, isStreaming, isTurnOutputOwner, sessionId, workDir, turnChangedFiles, turnOutputEvidence?.unlistedWrites, inlineAudioKeys],
  )
  // A bare name the text could not bound is settled against the workspace listing,
  // then a file no changed file accounts for must show it was written this turn.
  const settledTargets = useDiskConfirmedTargets(sessionId, extractedTargets)
  const outputTargets = useTurnWrittenTargets(sessionId, settledTargets, turnOutputEvidence?.startedAt)
  const resolveAssistantImageSrc = useMemo(
    () => {
      if (isStreaming || !sessionId) return undefined
      const resolveLocalImage = createAssistantMarkdownImageResolver({
        baseUrl: getServerBaseUrl(),
        sessionId,
        workDir,
        aliases,
      })
      return (src: string) => isManagedGeneratedImagePath(src)
        ? null
        : resolveLocalImage(src)
    },
    [aliases, isStreaming, sessionId, workDir],
  )
  const resolveAssistantAudioSrc = useMemo(
    () => (isStreaming || !sessionId
      ? undefined
      : createAssistantMarkdownAudioResolver({
          baseUrl: getServerBaseUrl(),
          sessionId,
          workDir,
          aliases,
        })),
    [aliases, isStreaming, sessionId, workDir],
  )

  // A click on a picture in the prose opens it, and its neighbours in the reply, in
  // the viewer. Use the resolved original URL so the viewer owns authenticated
  // fallback loads independently of a row that virtual scrolling may unmount.
  // File paths still have to pass the local-server URL validation.
  const handleImageClick = useCallback(
    ({ images, index }: MarkdownImageClick) => {
      const baseUrl = getServerBaseUrl()
      setViewer({
        index,
        images: images.map((image) => {
          const src = image.originalSrc ?? image.src
          const path = localPathFromMarkdownImageUrl(src, { baseUrl, workDir }) ?? undefined
          const name = image.alt.trim() || path?.split(/[\\/]/).filter(Boolean).pop() || t('assistantOutputs.kind.image')
          return { src, name, ...(path ? { path } : {}) }
        }),
      })
    },
    [t, workDir],
  )

  const showTurnCompletion = !isStreaming && Boolean(turnCompletion)
  // On a phone any finished reply can be held for copy and select; branching
  // stays with the reply that closes a turn, as on the desktop bar.
  const actionMenu = useMessageActionMenu({
    copyText: isStreaming ? undefined : content,
    branchAction: showTurnCompletion ? branchAction : undefined,
  })

  if (!content.trim()) return null

  const documentLayout = shouldUseDocumentLayout(content)

  return (
    <div className="flex justify-start">
      <div
        data-message-shell="assistant"
        data-layout={documentLayout ? 'document' : 'bubble'}
        {...actionMenu.pressProps}
        // Always the full column. A reply that hugs its text turns every short
        // answer into a differently-shaped block, so a scrolled transcript reads
        // as a ragged pile; one width makes the replies a single column the eye
        // can run down. The user bubble stays hugged — that asymmetry is what
        // says which side is speaking, so it does not need width to say it too.
        className={`group flex w-full min-w-0 max-w-full flex-col items-start ${actionMenu.pressClassName}`}
      >
        <div
          onContextMenu={sessionId && !actionMenu.enabled ? handleContextMenu : undefined}
          // No card. Left-aligned, full-column prose against the page is already
          // unmistakably the reply — the hugged, tinted bubble on the right is
          // what says who is speaking (see the note above), so a border here
          // repeats that at the cost of ~50px per reply and makes prose look
          // like the tool rows it sits between. The turn rail groups it now.
          className="w-full text-[var(--color-text-primary)]"
        >
          <MarkdownRenderer
            key={`${sessionId ?? ''}|${workDir ?? ''}`}
            className="chat-reading-markdown"
            content={content}
            variant={documentLayout ? 'document' : 'default'}
            streaming={isStreaming}
            onLinkClick={sessionId ? handleLinkClick : undefined}
            resolveImageSrc={resolveAssistantImageSrc}
            resolveAudioSrc={resolveAssistantAudioSrc}
            onImageClick={resolveAssistantImageSrc ? handleImageClick : undefined}
            fileLinkVerifier={fileLinkVerifier}
          />
          {!isStreaming && (
            <InlineImageGallery
              text={content}
              sessionId={sessionId}
              workDir={workDir}
              mentions={resolvedMentions}
              changedFiles={turnChangedFiles}
              suppressManagedGeneratedImages
            />
          )}
          {!isStreaming && (
            <InlineVideoGallery
              text={content}
              sessionId={sessionId}
              workDir={workDir}
              mentions={resolvedMentions}
              changedFiles={turnChangedFiles}
            />
          )}
          {isStreaming && (
            <span className="ml-0.5 inline-block h-4 w-0.5 animate-stepped-pulse bg-[var(--color-brand)] align-text-bottom" />
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

        {viewer && (
          <ImageGalleryModal
            open
            images={viewer.images}
            activeIndex={viewer.index}
            onClose={() => setViewer(null)}
            onSelect={(index) => setViewer((current) => (current ? { ...current, index } : current))}
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
            copyText={actionMenu.enabled ? undefined : content}
            copyLabel={t('chat.copyReply')}
            branchAction={actionMenu.enabled ? undefined : branchAction}
            align="start"
            alwaysVisible={isLatestTurn}
            metadata={<TurnCompletionStamp completion={turnCompletion!} />}
          />
        )}
        {actionMenu.sheet}
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
