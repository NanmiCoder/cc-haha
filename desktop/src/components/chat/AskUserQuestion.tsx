import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent } from 'react'
import {
  listPendingPermissions,
  useChatStore,
  type AskUserQuestionDraft,
} from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'
import { useTeamStore } from '../../stores/teamStore'
import { useUIStore } from '../../stores/uiStore'
import { useTranslation } from '../../i18n'
import { ArrowRight, Check, CircleCheck, ImagePlus, Info, MessageCircleQuestion, MessagesSquare, Send } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { detectPlatform } from '@/lib/workspace/shortcuts'
import { isInlineImagePath } from '../../lib/attachmentImages'
import {
  filesToComposerAttachments,
  getDataTransferFiles,
  isSupportedImageFile,
  selectNativeImageAttachments,
  type ComposerAttachment,
} from '../../lib/composerAttachments'
import { isDesktopRuntime } from '../../lib/desktopRuntime'
import { formatBytes } from '../../lib/formatBytes'
import { checkUserMessageBudget } from '../../lib/userMessageBudget'
import type { AttachmentRef, ClientMessage } from '../../types/chat'
import { AttachmentGallery, type AttachmentPreview } from './AttachmentGallery'
import { PendingDecisionMarker } from './PendingDecisionMarker'
import { useComposerFileDrop } from './useComposerFileDrop'
import {
  ASK_USER_QUESTION_CLARIFY_WITH_QUESTIONS_PREFIX,
  ASK_USER_QUESTION_EXPIRED_ANSWER_PREFIX,
} from '../../../../src/constants/messages'

type QuestionOption = {
  label: string
  description?: string
}

type Question = {
  question: string
  header?: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

type Props = {
  sessionId?: string | null
  toolUseId: string
  input: unknown
  result?: unknown
  /**
   * A user message exists after this question in the transcript — the user has
   * already moved past it, so no live permission request can still be on its way.
   * Computed by buildRenderModel, the only place that sees the whole list.
   */
  supersededByUserMessage?: boolean
  /**
   * While the question waits on a live request, draw one marker line instead
   * of the card: the phone answers it from the approval bar, and two live
   * copies of the card would each hold half an answer.
   */
  markerWhenPending?: boolean
}

const IMAGE_ATTACHED_LABEL = '(Image attached)'
const ATTACHED_IMAGES_NOTE_PREFIX = 'Attached images: '
const ACCEPTED_IMAGE_INPUT = 'image/png,image/jpeg,image/gif,image/webp'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The input is whatever the model emitted, and the transcript keeps it even when the
// server rejected the call as invalid — so a card is rebuilt from it on every replay
// (issue #1400: an option description that came back as an object threw React #31 and
// took the whole app down, again on every launch). Only string fields are trusted,
// because a non-string child throws while rendering; anything else is left out rather
// than shown. That cleanup is display-only: the answer still travels with the
// original input (see handleSubmit).

function toOption(value: unknown): QuestionOption | null {
  if (!isRecord(value) || typeof value.label !== 'string') return null
  return typeof value.description === 'string'
    ? { label: value.label, description: value.description }
    : { label: value.label }
}

function toQuestion(value: unknown): Question | null {
  if (!isRecord(value) || typeof value.question !== 'string') return null
  return {
    question: value.question,
    header: typeof value.header === 'string' ? value.header : undefined,
    options: Array.isArray(value.options)
      ? value.options.flatMap((option) => toOption(option) ?? [])
      : undefined,
    multiSelect: value.multiSelect === true,
  }
}

/**
 * Parse the AskUserQuestion input which may come in different shapes.
 */
function parseInput(input: unknown): Question[] {
  if (!isRecord(input)) return []

  // Shape 1: { questions: [...] }
  if (Array.isArray(input.questions)) {
    return input.questions.flatMap((question) => toQuestion(question) ?? [])
  }

  // Shape 2: { question: "...", options: [...] }
  const single = toQuestion(input)
  return single ? [single] : []
}

type QuestionSelections = Record<number, string[]>
type QuestionFreeTexts = Record<number, string>
type QuestionImages = Record<number, ComposerAttachment[]>
const EMPTY_FREE_TEXTS: QuestionFreeTexts = {}
const EMPTY_QUESTION_IMAGES: QuestionImages = {}

function getSelectedAnswer(question: Question, selected: string[] | undefined) {
  if (!selected || selected.length === 0) return ''
  return question.multiSelect ? selected.join(', ') : selected[0] ?? ''
}

function formatQuestionSummary(
  selected: string,
  note: string,
  imageCount: number,
  imageAttachedText: string,
): string {
  if (selected && note) return `${selected} (${note})`
  if (selected) return selected
  if (note) return note
  if (imageCount > 0) return imageAttachedText
  return ''
}

function stripAttachedImagesMetadata(notes: string): string {
  return notes
    .split('\n')
    .filter((line) => !line.trim().startsWith(ATTACHED_IMAGES_NOTE_PREFIX))
    .join('\n')
    .trim()
}

function isSupportedImageAttachment(attachment: ComposerAttachment): boolean {
  if (attachment.type !== 'image') return false
  if (attachment.mimeType) {
    return isSupportedImageFile({ type: attachment.mimeType, name: attachment.name })
  }
  if (attachment.path) {
    return isInlineImagePath(attachment.path)
  }
  return true
}

function toAttachmentRef(attachment: ComposerAttachment): AttachmentRef {
  return {
    type: 'image',
    name: attachment.name,
    ...(attachment.path ? { path: attachment.path } : {}),
    ...(attachment.data ? { data: attachment.data } : {}),
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
  }
}

function parseResultAttachments(value: unknown): AttachmentPreview[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry, index): AttachmentPreview[] => {
    if (!isRecord(entry) || entry.type !== 'image') return []
    const name = typeof entry.name === 'string' && entry.name.trim()
      ? entry.name
      : `image-${index + 1}`
    const path = typeof entry.path === 'string' ? entry.path : undefined
    const data = typeof entry.data === 'string' ? entry.data : undefined
    const previewUrl = typeof entry.previewUrl === 'string' ? entry.previewUrl : undefined
    const mimeType = typeof entry.mimeType === 'string' ? entry.mimeType : undefined
    if (!path && !data && !previewUrl) return []
    return [{
      id: typeof entry.id === 'string' ? entry.id : `result-img-${index}`,
      type: 'image',
      name,
      ...(path ? { path } : {}),
      ...(data ? { data } : {}),
      ...(previewUrl ? { previewUrl } : {}),
      ...(mimeType ? { mimeType } : {}),
    }]
  })
}

export function AskUserQuestion({
  sessionId,
  toolUseId,
  input,
  result,
  supersededByUserMessage,
  markerWhenPending = false,
}: Props) {
  const respondToPermission = useChatStore((s) => s.respondToPermission)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const targetSessionId = sessionId ?? activeTabId
  // A team member's page shows the member's transcript under its own tab id,
  // which nothing connects to the member's CLI. The server forwards the
  // member's requests to the lead session, named after the member, and hands
  // an answer sent there to the member that asked — so that is where its
  // question waits and gets answered.
  const memberLeadSessionId = useTabStore((s) => {
    const tab = targetSessionId ? s.tabs.find((candidate) => candidate.sessionId === targetSessionId) : undefined
    return tab?.type === 'team-member' ? tab.teamLeadSessionId ?? null : null
  })
  const memberName = useTeamStore((s) => memberLeadSessionId && targetSessionId
    ? s.getMemberBySessionId(targetSessionId)?.name ?? null
    : null)
  const requestSessionId = memberLeadSessionId ?? targetSessionId
  const pendingRequest = useChatStore((s) => requestSessionId
    ? listPendingPermissions(s.sessions[requestSessionId])
      .find((permission) => permission.toolUseId === toolUseId &&
        // The lead session also holds its own requests and other members'.
        (!memberLeadSessionId || (memberName !== null && permission.displayName === memberName))) ?? null
    : null)
  // The card is rendered from the transcript, but answering it needs the live
  // permission request. Both facts below come from the session, never from the
  // transcript, and they are what tells a live question from an expired one.
  const sessionChatState = useChatStore((s) =>
    targetSessionId ? s.sessions[targetSessionId]?.chatState : undefined)
  const sessionConnectionState = useChatStore((s) =>
    targetSessionId ? s.sessions[targetSessionId]?.connectionState : undefined)
  const t = useTranslation()
  const textareaId = useId()
  const questions = useMemo(() => parseInput(input), [input])
  const inputObject = isRecord(input) ? input : {}
  const allowFreeText = inputObject.allowFreeText !== false
  // Read once instead of subscribing: this card writes the draft on every
  // change, and a subscription would feed its own writes back as re-renders.
  const storedDraft = targetSessionId
    ? useChatStore.getState().askUserQuestionDrafts[targetSessionId]?.[toolUseId]
    : undefined
  const [activeTab, setActiveTab] = useState(storedDraft?.activeTab ?? 0)
  const [selections, setSelections] = useState<QuestionSelections>(storedDraft?.selections ?? {})
  const [draftFreeTexts, setFreeTexts] = useState(storedDraft?.freeTexts ?? EMPTY_FREE_TEXTS)
  const [draftImages, setImagesByQuestion] = useState(storedDraft?.images ?? EMPTY_QUESTION_IMAGES)
  const [hasSubmitted, setHasSubmitted] = useState(allowFreeText && storedDraft?.submitted === true)
  const [handedOff, setHasRequestedChat] = useState(storedDraft?.handedOff === true)
  const [sentAsMessage, setHasSentAsMessage] = useState(storedDraft?.sentAsMessage === true)
  // 固定选项不能从旧草稿恢复文字、图片或转交状态。
  const freeTexts = allowFreeText ? draftFreeTexts : EMPTY_FREE_TEXTS
  const imagesByQuestion = allowFreeText ? draftImages : EMPTY_QUESTION_IMAGES
  const hasRequestedChat = allowFreeText && handedOff
  const hasSentAsMessage = allowFreeText && sentAsMessage
  const composingRef = useRef(false)
  const activitySentForRequest = useRef<string | null>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const dropZoneRef = useRef<HTMLDivElement>(null)
  const imageLoadGenRef = useRef(0)
  const mountedRef = useRef(true)
  const prevPendingRequestIdRef = useRef<string | null>(pendingRequest?.requestId ?? null)

  const clampedActiveTab = questions.length > 0 ? Math.min(activeTab, questions.length - 1) : 0
  const activeTabRef = useRef(clampedActiveTab)
  activeTabRef.current = clampedActiveTab

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      imageLoadGenRef.current += 1
    }
  }, [])

  // If the server rejects attachment materialization and restores the pending
  // permission, reopen the card with the user's draft intact so they can retry.
  useEffect(() => {
    const prevId = prevPendingRequestIdRef.current
    const currentId = pendingRequest?.requestId ?? null
    prevPendingRequestIdRef.current = currentId
    if (!prevId && currentId && (hasSubmitted || hasRequestedChat)) {
      setHasSubmitted(false)
      setHasRequestedChat(false)
    }
  }, [hasRequestedChat, hasSubmitted, pendingRequest?.requestId])

  // A choice can be made before the SDK permission request reaches the UI.
  // Protect that draft as soon as the matching request arrives.
  useEffect(() => {
    if (!requestSessionId || !pendingRequest || hasSubmitted ||
      activitySentForRequest.current === pendingRequest.requestId) return
    if (!Object.values(selections).some((labels) => labels.length > 0) &&
      !Object.values(freeTexts).some((value) => value.trim()) &&
      !Object.values(imagesByQuestion).some((items) => items.length > 0)) return
    activitySentForRequest.current = pendingRequest.requestId
    useChatStore.getState().recordAskUserQuestionActivity(requestSessionId, pendingRequest.requestId)
  }, [freeTexts, hasSubmitted, imagesByQuestion, pendingRequest, requestSessionId, selections])

  const resultAnswers = useMemo(() => {
    if (!result || typeof result !== 'object') return {}
    const answers = (result as { answers?: unknown }).answers
    return answers && typeof answers === 'object'
      ? answers as Record<string, string>
      : {}
  }, [result])
  const resultAnnotations = useMemo(() => {
    if (!result || typeof result !== 'object') return {}
    const annotations = (result as { annotations?: unknown }).annotations
    if (!isRecord(annotations)) return {}
    const parsed: Record<string, { notes?: string }> = {}
    for (const [questionText, entry] of Object.entries(annotations)) {
      if (!isRecord(entry)) continue
      if (typeof entry.notes === 'string' && entry.notes.trim()) {
        parsed[questionText] = { notes: entry.notes.trim() }
      }
    }
    return parsed
  }, [result])
  const resultAttachments = useMemo(() => {
    if (!result || typeof result !== 'object') return []
    return parseResultAttachments((result as { attachments?: unknown }).attachments)
  }, [result])
  const resultHandedOff = Boolean(isRecord(result) && result.handedOff === true)
  const resultText = typeof result === 'string' && result.trim().length > 0 ? result.trim() : ''
  const automaticallyAnswered = Boolean(result && typeof result === 'object' &&
    (result as { selectionSource?: unknown }).selectionSource === 'automatic')
  const hasStructuredAnswers = Object.keys(resultAnswers).length > 0
  const hasTerminalResult = hasStructuredAnswers || resultHandedOff || resultText.length > 0
  const isHandedOff = hasRequestedChat || resultHandedOff
  const submitted = hasTerminalResult || hasSubmitted || isHandedOff || hasSentAsMessage

  // Mid-turn states. Here "no request yet" means "not yet", not "never": the card
  // renders as soon as the tool_use block is complete (`tool_use_complete` clears
  // isPending), while the can_use_tool request only lands afterwards. Judging that
  // window as expired would flash a bogus notice on every live question.
  const sessionBusy =
    sessionChatState === 'thinking' ||
    sessionChatState === 'streaming' ||
    sessionChatState === 'tool_executing' ||
    sessionChatState === 'compacting' ||
    sessionChatState === 'permission_pending'
  // While reconnecting, the permission snapshot may not have arrived yet,
  // so stay neutral rather than declaring the question dead.
  const connected = Boolean(targetSessionId) && sessionConnectionState === 'connected'
  /**
   * The question outlived its live permission request: whoever was waiting for it
   * is gone (renderer was away, CLI reclaimed, turn interrupted) or the user has
   * already replied in the composer. `respondToPermission` has nothing left to
   * answer, so the card must say so instead of pretending to be a live prompt.
   *
   * `!pendingRequest` comes first and is absolute: while a request exists the
   * answer MUST travel as a permission response — routing it to a message would
   * drop the real prompt and can cancel the turn waiting on it.
   */
  const expired = !submitted && !pendingRequest && connected &&
    (supersededByUserMessage === true || !sessionBusy)
  const readOnly = expired && !allowFreeText
  // Direct team-member messages (`sendMessageToMember`) are text-only; live
  // member questions still support images because they route through the lead
  // session's `permission_response`.
  const canAttachImages = allowFreeText && !(memberLeadSessionId && expired)

  const allLocalImages = useMemo(
    () => questions.flatMap((_, index) => imagesByQuestion[index] ?? []),
    [imagesByQuestion, questions],
  )
  const imageAttachedDisplayText = t('question.imageAttached')
  const localSummary = useMemo(
    () => questions
      .map((question, index) => formatQuestionSummary(
        getSelectedAnswer(question, selections[index]),
        freeTexts[index]?.trim() ?? '',
        canAttachImages ? (imagesByQuestion[index]?.length ?? 0) : 0,
        imageAttachedDisplayText,
      ))
      .filter(Boolean)
      .join('; '),
    [canAttachImages, freeTexts, imageAttachedDisplayText, imagesByQuestion, questions, selections],
  )

  const answeredText = useMemo(() => {
    if (hasStructuredAnswers) {
      return questions
        .map((question) => {
          const rawAnswer = resultAnswers[question.question]
          if (typeof rawAnswer !== 'string' || !rawAnswer.trim()) return ''
          const answer = rawAnswer.trim() === IMAGE_ATTACHED_LABEL
            ? imageAttachedDisplayText
            : rawAnswer
          const rawNotes = resultAnnotations[question.question]?.notes ?? ''
          const displayNotes = stripAttachedImagesMetadata(rawNotes)
          if (displayNotes && displayNotes !== IMAGE_ATTACHED_LABEL && displayNotes !== rawAnswer.trim()) {
            return `${answer} (${displayNotes})`
          }
          return answer
        })
        .filter(Boolean)
        .join(', ')
    }
    if (resultText) return resultText
    return localSummary
  }, [hasStructuredAnswers, imageAttachedDisplayText, localSummary, questions, resultAnnotations, resultAnswers, resultText])

  const markUserActivity = useCallback(() => {
    if (!requestSessionId || !pendingRequest || submitted ||
      activitySentForRequest.current === pendingRequest.requestId) return
    activitySentForRequest.current = pendingRequest.requestId
    useChatStore.getState().recordAskUserQuestionActivity(requestSessionId, pendingRequest.requestId)
  }, [pendingRequest, requestSessionId, submitted])

  const appendImageAttachments = useCallback((qIndex: number, nextAttachments: ComposerAttachment[]) => {
    if (submitted || !canAttachImages) return
    const onlyImages = nextAttachments.filter(isSupportedImageAttachment)
    if (onlyImages.length === 0) return
    markUserActivity()
    setImagesByQuestion((prev) => ({
      ...prev,
      [qIndex]: [...(prev[qIndex] ?? []), ...onlyImages],
    }))
  }, [canAttachImages, markUserActivity, submitted])

  const handleDroppedAttachments = useCallback((nextAttachments: ComposerAttachment[]) => {
    appendImageAttachments(activeTabRef.current, nextAttachments)
  }, [appendImageAttachments])

  const { isDragActive, dragHandlers } = useComposerFileDrop({
    disabled: submitted || !canAttachImages,
    panelRef: dropZoneRef,
    onAttachments: handleDroppedAttachments,
    onError: (error) => {
      console.warn('[AskUserQuestion] Failed to read dropped images', error)
    },
  })

  // Hand the card's state to the store so it survives the unmounts that tab
  // switches and the virtualized window cause — the answers are the user's work.
  // Terminal states it can prove locally win over the ones the server records:
  // `sentAsMessage` and the handoff leave no trace on the server, and dropping
  // them would resurrect an answerable form that could deliver twice.
  useEffect(() => {
    if (!targetSessionId) return
    const store = useChatStore.getState()
    const hasImages = Object.values(imagesByQuestion).some((items) => items.length > 0)
    const draft: AskUserQuestionDraft = {
      activeTab,
      selections,
      freeTexts,
      ...(hasImages ? { images: imagesByQuestion } : {}),
    }
    if (hasTerminalResult) {
      store.clearAskUserQuestionDraft(targetSessionId, toolUseId)
      return
    }
    if (hasSentAsMessage) {
      store.setAskUserQuestionDraft(targetSessionId, toolUseId, { ...draft, sentAsMessage: true })
      return
    }
    if (hasRequestedChat) {
      store.setAskUserQuestionDraft(targetSessionId, toolUseId, { ...draft, handedOff: true })
      return
    }
    if (hasSubmitted) {
      if (hasImages) {
        // Keep the draft while async server-side image processing is in flight
        // so unmounting before `tool_result` neither resurrects an empty form
        // nor drops the user's images if materialization fails and retries.
        store.setAskUserQuestionDraft(targetSessionId, toolUseId, { ...draft, submitted: true })
      } else {
        store.clearAskUserQuestionDraft(targetSessionId, toolUseId)
      }
      return
    }
    store.setAskUserQuestionDraft(targetSessionId, toolUseId, draft)
  }, [
    activeTab,
    freeTexts,
    hasRequestedChat,
    hasSentAsMessage,
    hasSubmitted,
    hasTerminalResult,
    imagesByQuestion,
    selections,
    targetSessionId,
    toolUseId,
  ])

  // Every hook above this line runs unconditionally, and it has to stay that way.
  // `input` is not fixed for the lifetime of the instance: chatStore rebuilds tool_use
  // messages from the transcript under a stable id (`${messageId}-block-${index}`), so
  // the same mounted component can see its question count cross zero in either
  // direction. With the early return above the useMemo calls, that transition threw
  // "Rendered fewer/more hooks than expected" and took the whole message list down.
  if (questions.length === 0) return null
  if (markerWhenPending && pendingRequest) {
    return <PendingDecisionMarker title={t('mobile.approval.questionTitle')} />
  }
  const safeActiveTab = clampedActiveTab
  const activeQuestion = questions[safeActiveTab]

  const terminalWithoutAnswers = submitted && !hasStructuredAnswers && !isHandedOff && resultText.length > 0

  /** The `- "question"\n  Answer: …` block every AskUserQuestion handoff uses. */
  const describeAnswers = () => questions
    .map((question, index) => {
      const selected = getSelectedAnswer(question, selections[index])
      const note = freeTexts[index]?.trim() ?? ''
      const images = canAttachImages ? (imagesByQuestion[index] ?? []) : []
      const lines = [`- "${question.question}"`]
      if (selected && note) {
        lines.push(`  Answer: ${selected}`)
        lines.push(`  Notes: ${note}`)
      } else if (selected) {
        lines.push(`  Answer: ${selected}`)
      } else if (note) {
        lines.push(`  Answer: ${note}`)
      } else if (images.length > 0) {
        lines.push(`  Answer: ${IMAGE_ATTACHED_LABEL}`)
      } else {
        lines.push('  (No answer provided)')
      }
      if (images.length > 0 && (selected || note)) {
        lines.push(`  ${ATTACHED_IMAGES_NOTE_PREFIX}${images.map((image) => image.name).join(', ')}`)
      }
      return lines.join('\n')
    })
    .join('\n')

  const enforcePayloadBudget = (message: ClientMessage): boolean => {
    const budget = checkUserMessageBudget(message)
    if (budget.ok) return true
    // Surface via toast (z-index above mobile sheets and visible on team-member
    // tabs where `requestSessionId` points at the lead session).
    useUIStore.getState().addToast({
      type: 'error',
      message: t('chat.messageTooLarge', {
        size: formatBytes(budget.bytes),
        limit: formatBytes(budget.limit),
      }),
    })
    return false
  }

  /**
   * Delivers text to the model as an ordinary user message — only ever reached
   * when no permission request is left to answer. Mirrors ChatInput's
   * send-or-queue decision so a session that started a new turn between render
   * and click is not interrupted mid-turn.
   */
  const sendAsMessage = (
    content: string,
    displayContent: string,
    attachments?: AttachmentRef[],
  ) => {
    const sessionId = targetSessionId
    if (!allowFreeText || !sessionId) return false
    const effectiveAttachments = canAttachImages && attachments?.length ? attachments : undefined
    if (effectiveAttachments && !enforcePayloadBudget({
      type: 'user_message',
      content,
      attachments: effectiveAttachments,
    })) {
      return false
    }
    const store = useChatStore.getState()
    const liveChatState = store.sessions[sessionId]?.chatState ?? 'idle'
    // Direct team-member sessions transmit `userFacingContent` (`displayContent`),
    // so keep the full structured content there instead of dropping the prefix.
    const visibleText = memberLeadSessionId ? content : displayContent
    if (liveChatState !== 'idle') {
      store.queueUserMessage(sessionId, {
        content,
        displayContent: visibleText,
        ...(effectiveAttachments ? { attachments: effectiveAttachments } : {}),
      })
      return true
    }
    return store.sendMessage(
      sessionId,
      content,
      effectiveAttachments,
      { displayContent: visibleText },
    )
  }

  const appendImageFiles = (qIndex: number, files: FileList | File[]) => {
    if (submitted || !canAttachImages) return
    const imageFiles = Array.from(files).filter(isSupportedImageFile)
    if (imageFiles.length === 0) return
    const generation = imageLoadGenRef.current
    void filesToComposerAttachments(imageFiles)
      .then((nextAttachments) => {
        if (!mountedRef.current || generation !== imageLoadGenRef.current) return
        appendImageAttachments(qIndex, nextAttachments)
      })
      .catch((error) => {
        console.warn('[AskUserQuestion] Failed to read attached images', error)
      })
  }

  const handleRemoveImage = (qIndex: number, imageId: string) => {
    if (submitted) return
    setImagesByQuestion((prev) => {
      const current = prev[qIndex] ?? []
      const remaining = current.filter((image) => image.id !== imageId)
      const next = { ...prev }
      if (remaining.length > 0) {
        next[qIndex] = remaining
      } else {
        delete next[qIndex]
      }
      return next
    })
  }

  const handlePaste = (qIndex: number, event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (submitted || !canAttachImages || !event.clipboardData) return
    const imageFiles = getDataTransferFiles(event.clipboardData).filter(isSupportedImageFile)
    if (imageFiles.length === 0) return
    event.preventDefault()
    appendImageFiles(qIndex, imageFiles)
  }

  const openImagePicker = () => {
    if (submitted || !canAttachImages) return
    const targetTab = safeActiveTab
    if (!isDesktopRuntime()) {
      imageInputRef.current?.click()
      return
    }
    const generation = imageLoadGenRef.current
    void selectNativeImageAttachments()
      .then((nativeAttachments) => {
        if (!mountedRef.current || generation !== imageLoadGenRef.current) return
        if (nativeAttachments) {
          appendImageAttachments(targetTab, nativeAttachments)
          return
        }
        imageInputRef.current?.click()
      })
  }

  const handleImageFileSelect = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (files && files.length > 0) {
      appendImageFiles(safeActiveTab, files)
    }
    event.target.value = ''
  }

  const handleSelect = (qIndex: number, label: string) => {
    if (submitted || readOnly) return
    markUserActivity()
    // Computed from the render snapshot rather than inside the updater: React
    // may run a state updater twice, and advancing the tab is a side effect.
    // Clicking an already-selected option deselects it — that is not a step
    // forward. Multi-select or a question that already has notes/images keeps
    // the user on the current question so they can finish composing.
    const hasDraftDetail =
      Boolean(freeTexts[qIndex]?.trim()) || (canAttachImages && (imagesByQuestion[qIndex]?.length ?? 0) > 0)
    const shouldAdvance =
      questions[qIndex]?.multiSelect !== true &&
      !(selections[qIndex]?.includes(label) ?? false) &&
      !hasDraftDetail &&
      qIndex === safeActiveTab &&
      qIndex < questions.length - 1
    setSelections((prev) => {
      const question = questions[qIndex]
      const selected = prev[qIndex] ?? []
      if (question?.multiSelect) {
        const nextSelected = selected.includes(label)
          ? selected.filter((value) => value !== label)
          : [...selected, label]
        const next = { ...prev }
        if (nextSelected.length > 0) {
          next[qIndex] = nextSelected
        } else {
          delete next[qIndex]
        }
        return next
      }
      if (selected[0] === label) {
        const next = { ...prev }
        delete next[qIndex]
        return next
      }
      return { ...prev, [qIndex]: [label] }
    })
    if (shouldAdvance) setActiveTab(qIndex + 1)
  }

  const handleFreeTextChange = (qIndex: number, value: string) => {
    if (!allowFreeText || submitted) return
    markUserActivity()
    setFreeTexts((prev) => {
      const next = { ...prev }
      if (value) {
        next[qIndex] = value
      } else {
        delete next[qIndex]
      }
      return next
    })
  }

  const collectAttachmentRefs = (): AttachmentRef[] =>
    canAttachImages ? allLocalImages.map(toAttachmentRef) : []

  const handleSubmit = () => {
    if (submitted) return

    const parts: string[] = []
    for (let i = 0; i < questions.length; i++) {
      const summary = formatQuestionSummary(
        getSelectedAnswer(questions[i]!, selections[i]),
        freeTexts[i]?.trim() ?? '',
        canAttachImages ? (imagesByQuestion[i]?.length ?? 0) : 0,
        imageAttachedDisplayText,
      )
      if (summary) parts.push(summary)
    }
    const response = parts.join('; ')
    if (!response) return

    const attachments = collectAttachmentRefs()

    if (expired) {
      const sent = sendAsMessage(
        `${ASK_USER_QUESTION_EXPIRED_ANSWER_PREFIX}\n\n${describeAnswers()}`,
        response,
        attachments,
      )
      if (sent) {
        imageLoadGenRef.current += 1
        setHasSentAsMessage(true)
      }
      return
    }

    if (!requestSessionId || !pendingRequest) return

    const answers: Record<string, string> = {}
    const annotations: Record<string, { notes: string }> = {}
    questions.forEach((question, index) => {
      const selected = getSelectedAnswer(question, selections[index])
      const note = freeTexts[index]?.trim() ?? ''
      const images = imagesByQuestion[index] ?? []
      const hasImages = images.length > 0
      const imageNote = hasImages
        ? `${ATTACHED_IMAGES_NOTE_PREFIX}${images.map((image) => image.name).join(', ')}`
        : ''
      if (selected) {
        answers[question.question] = selected
        if (note && hasImages) {
          annotations[question.question] = { notes: `${note}\n${imageNote}` }
        } else if (note) {
          annotations[question.question] = { notes: note }
        } else if (hasImages) {
          annotations[question.question] = { notes: imageNote }
        }
      } else if (note) {
        answers[question.question] = note
        if (hasImages) {
          annotations[question.question] = { notes: imageNote }
        }
      } else if (hasImages) {
        answers[question.question] = IMAGE_ATTACHED_LABEL
        if (questions.length > 1) {
          annotations[question.question] = { notes: imageNote }
        }
      }
    })

    const metadata = inputObject.metadata
    const updatedInput: Record<string, unknown> = {
      ...inputObject,
      answers,
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
      ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? { metadata: Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'autoAnswered')) }
        : {}),
    }
    if (attachments.length > 0 && !enforcePayloadBudget({
      type: 'permission_response',
      requestId: pendingRequest.requestId,
      allowed: true,
      updatedInput,
      attachments,
    })) {
      return
    }
    const sent = respondToPermission(requestSessionId, pendingRequest.requestId, true, {
      updatedInput,
      ...(attachments.length > 0 ? { attachments } : {}),
    })
    if (sent) {
      imageLoadGenRef.current += 1
      setHasSubmitted(true)
    }
  }

  /**
   * Hands the questions back to the model as a conversation instead of an
   * answer — the user doesn't think any option fits and wants to talk first.
   *
   * Travels as a denial because that's the only channel that carries free text
   * back to the model, but the server rewrites it (buildDenyMessage) into
   * "ask them what they'd like to clarify" rather than the usual "STOP and
   * wait". Deliberately not gated on `allAnswered`: not recognising your own
   * question in any of the options is exactly when nothing is filled in.
   *
   * With no request left to deny (see `expired`), the same wording is sent as
   * an ordinary message instead — the model still gets asked to follow up.
   */
  const handleChatAboutThis = () => {
    if (!allowFreeText || submitted) return

    const attachments = collectAttachmentRefs()

    if (expired) {
      const questionsWithAnswers = describeAnswers()
      // No request left to deny, so this goes out as an ordinary message and
      // carries the same wording the server would have written for the denial.
      const sent = sendAsMessage(
        `${ASK_USER_QUESTION_CLARIFY_WITH_QUESTIONS_PREFIX}${questionsWithAnswers}`,
        questionsWithAnswers,
        attachments,
      )
      if (sent) {
        imageLoadGenRef.current += 1
        setHasRequestedChat(true)
      }
      return
    }

    if (!requestSessionId || !pendingRequest) return

    const denyMessage = describeAnswers()
    if (attachments.length > 0 && !enforcePayloadBudget({
      type: 'permission_response',
      requestId: pendingRequest.requestId,
      allowed: false,
      denyMessage,
      attachments,
    })) {
      return
    }
    const sent = respondToPermission(requestSessionId, pendingRequest.requestId, false, {
      // Carry whatever was already picked, typed, or attached, so switching to
      // a conversation isn't punished by losing the partial answers.
      denyMessage,
      ...(attachments.length > 0 ? { attachments } : {}),
    })
    if (sent) {
      imageLoadGenRef.current += 1
      setHasRequestedChat(true)
    }
  }

  const isQuestionAnswered = (index: number) =>
    Boolean(freeTexts[index]?.trim()) ||
    (selections[index]?.length ?? 0) > 0 ||
    (canAttachImages && (imagesByQuestion[index]?.length ?? 0) > 0)

  // All questions must be answered (via selection, free text, or image) to enable submit
  const allAnswered = questions.every((_, i) => isQuestionAnswered(i))

  if (!activeQuestion) return null

  // Gates the Next button: ChatGPT's `canAdvance`, so a step forward cannot
  // silently drop a question the user never answered.
  const activeAnswered = isQuestionAnswered(safeActiveTab)
  const hasActiveSelection = (selections[safeActiveTab]?.length ?? 0) > 0
  const activeImages = canAttachImages ? (imagesByQuestion[safeActiveTab] ?? []) : []
  const submittedImages: AttachmentPreview[] = resultAttachments.length > 0
    ? resultAttachments
    : (canAttachImages ? allLocalImages : [])

  const statusBadgeKey = automaticallyAnswered
    ? 'question.autoAnswered'
    : hasSentAsMessage || expired
      ? 'question.expiredBadge'
      : isHandedOff
        ? 'question.chatBadge'
        : terminalWithoutAnswers ? 'question.completed' : 'question.answered'

  return (
    <div className={`overflow-hidden rounded-[var(--radius-lg)] border ${
      submitted
        ? 'border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]'
        : 'border-[var(--color-outline)] border-l-2 border-l-[var(--color-info)] bg-[var(--color-surface-container)] shadow-[var(--shadow-card)]'
    }`}>
      {/* Header: 42px, the shared card head of the ask / plan cards. */}
      <div className={`flex h-[42px] items-center gap-2 px-3.5 ${submitted ? '' : 'border-b border-[var(--color-border)]'}`}>
        <MessageCircleQuestion aria-hidden="true" size={15} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" />
        <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--color-text-primary)]">
          {t('question.needsInput')}
        </span>
        {(submitted || expired) && (
          // handing the question back is not an answer — saying "answered"
          // there misreports what the user did; and an expired question was
          // never answered at all, whatever happened to the answers
          <Badge className="shrink-0">{t(statusBadgeKey)}</Badge>
        )}
        {!submitted && questions.length > 1 && (
          <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-[var(--color-text-tertiary)]">
            <span className="font-medium text-[var(--color-text-primary)]">{safeActiveTab + 1}</span> / {questions.length}
          </span>
        )}
      </div>

      {/* Question tabs (only when there are several questions) */}
      {!submitted && questions.length > 1 && (
        <div className="flex gap-0.5 overflow-x-auto px-2.5 pt-2">
          {questions.map((q, i) => {
            const isActive = safeActiveTab === i
            const isAnswered = isQuestionAnswered(i)
            const tabLabel = q.header || `Q${i + 1}`
            return (
              <button
                key={i}
                type="button"
                onClick={() => setActiveTab(i)}
                aria-current={isActive || undefined}
                className={`flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
                  isActive
                    ? 'bg-[var(--color-surface-container)] font-medium text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                {isAnswered && (
                  <CircleCheck aria-hidden="true" size={12} strokeWidth={2} className="text-[var(--color-success)]" />
                )}
                {tabLabel}
              </button>
            )
          })}
        </div>
      )}

      {/* Active question content */}
      {!submitted && (
        <div className="px-2.5 pt-3">
          {/* Only free-form questions can send their answers using a new message. */}
          {expired && allowFreeText && (
            <div
              role="status"
              aria-live="polite"
              className="mx-1 mb-3 flex items-start gap-2 rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2 text-xs text-[var(--color-text-secondary)]"
            >
              <Info aria-hidden="true" size={14} strokeWidth={1.75} className="mt-px shrink-0 text-[var(--color-text-tertiary)]" />
              <span>{t('question.expiredNotice')}</span>
            </div>
          )}
          <p className="mb-2 px-1 text-sm font-medium text-[var(--color-text-primary)]">
            {activeQuestion.question}
          </p>

          {/* Option cards: hairline at rest, a 1.5px terracotta edge on the
              faint brand wash when picked. */}
          {activeQuestion.options && activeQuestion.options.length > 0 && (
            <div className="grid gap-1.5">
              {activeQuestion.options.map((opt, optIndex) => {
                const isSelected = selections[safeActiveTab]?.includes(opt.label) ?? false
                const isMultiSelect = activeQuestion.multiSelect === true
                return (
                  <button
                    key={optIndex}
                    type="button"
                    onClick={() => handleSelect(safeActiveTab, opt.label)}
                    disabled={readOnly}
                    aria-pressed={isSelected}
                    className={`flex w-full cursor-pointer items-start gap-2.5 rounded-[var(--radius-md)] px-3 py-2.5 text-left transition-[background-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-default ${
                      isSelected
                        ? 'bg-[var(--color-brand-soft)] shadow-[inset_0_0_0_1.5px_var(--color-brand)]'
                        : 'shadow-[inset_0_0_0_1px_var(--color-border)] hover:shadow-[inset_0_0_0_1px_var(--color-outline)]'
                    }`}
                  >
                    {/* Selection indicator: a ring that fills in for single
                        choice, a checkbox for multi-select. */}
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center transition-[background-color,box-shadow] ${
                        isMultiSelect ? 'rounded-[var(--radius-xs)]' : 'rounded-full'
                      } ${
                        isSelected
                          ? isMultiSelect
                            ? 'bg-[var(--color-brand)] text-[var(--color-on-primary)]'
                            : 'shadow-[inset_0_0_0_5px_var(--color-brand)]'
                          : 'shadow-[inset_0_0_0_1.5px_var(--color-border-strong)]'
                      }`}
                    >
                      {isSelected && isMultiSelect ? <Check size={12} strokeWidth={2.5} /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-[var(--color-text-primary)]">
                        {opt.label}
                      </span>
                      {opt.description && (
                        <span className="mt-0.5 block text-xs text-[var(--color-text-tertiary)]">
                          {opt.description}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {allowFreeText && (
            <div
              ref={dropZoneRef}
              className="mt-2.5"
              {...dragHandlers}
            >
              <div className="mb-1 flex items-center justify-between gap-2 px-1">
                <label htmlFor={textareaId} className="text-xs text-[var(--color-text-tertiary)]">
                  {t(hasActiveSelection ? 'question.additionalResponse' : 'question.customResponse')}
                </label>
                {canAttachImages && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={openImagePicker}
                      icon={<ImagePlus aria-hidden="true" size={14} strokeWidth={1.75} />}
                    >
                      {t('question.attachImage')}
                    </Button>
                    <input
                      ref={imageInputRef}
                      type="file"
                      accept={ACCEPTED_IMAGE_INPUT}
                      multiple
                      className="hidden"
                      onChange={handleImageFileSelect}
                    />
                  </>
                )}
              </div>
              <div
                className={`rounded-[var(--radius-md)] border bg-[var(--color-surface-container-low)] transition-colors focus-within:border-[var(--color-outline)] focus-within:bg-[var(--color-surface-container-lowest)] focus-within:ring-2 focus-within:ring-[var(--color-border-focus)] ${
                  isDragActive ? 'border-[var(--color-brand)]' : 'border-[var(--color-border)]'
                }`}
              >
                {activeImages.length > 0 && (
                  <div className="px-3 pt-2.5">
                    <AttachmentGallery
                      attachments={activeImages}
                      variant="composer"
                      onRemove={(id) => handleRemoveImage(safeActiveTab, id)}
                    />
                  </div>
                )}
                <textarea
                  id={textareaId}
                  value={freeTexts[safeActiveTab] ?? ''}
                  onChange={(e) => handleFreeTextChange(safeActiveTab, e.target.value)}
                  onPaste={(e) => handlePaste(safeActiveTab, e)}
                  onCompositionStart={() => { composingRef.current = true }}
                  onCompositionEnd={() => { composingRef.current = false }}
                  onKeyDown={(e) => {
                    if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && allAnswered) {
                      e.preventDefault()
                      handleSubmit()
                    }
                  }}
                  placeholder={t('question.typePlaceholder')}
                  rows={3}
                  wrap="soft"
                  className="scrollbar-autohide max-h-48 min-h-[72px] w-full resize-y bg-transparent px-3 py-2.5 text-[13px] leading-relaxed text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none"
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Submitted answer display — the chat handoff wins over any terminal
          result, whose text is the deny payload and not worth showing. */}
      {submitted && (
        <div className="border-t border-[var(--color-border)] px-3.5 py-2.5">
          <p className="mb-1 truncate text-xs text-[var(--color-text-tertiary)]">{activeQuestion.question}</p>
          {hasSentAsMessage ? (
            <div className="flex items-center gap-2 text-[13px] text-[var(--color-text-secondary)]">
              <Send aria-hidden="true" size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" />
              <span>
                {t('question.sentAsMessagePrefix')}<strong className="font-medium text-[var(--color-text-primary)]">{answeredText}</strong>
              </span>
            </div>
          ) : isHandedOff ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-[13px] text-[var(--color-text-secondary)]">
                <MessagesSquare aria-hidden="true" size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" />
                <span>{t('question.chatRequested')}</span>
              </div>
              {localSummary && (
                <p className="pl-5 text-xs text-[var(--color-text-tertiary)]">
                  {localSummary}
                </p>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-[13px] text-[var(--color-text-secondary)]">
              <CircleCheck aria-hidden="true" size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-success)]" />
              <span>
                {t(terminalWithoutAnswers ? 'question.resultPrefix' : 'question.answeredPrefix')}<strong className="font-medium text-[var(--color-text-primary)]">{answeredText}</strong>
              </span>
            </div>
          )}
          {submittedImages.length > 0 && (
            <div className="mt-2">
              <AttachmentGallery attachments={submittedImages} variant="composer" />
            </div>
          )}
        </div>
      )}

      {/* Action bar. Wraps rather than overflows: the buttons plus a translated
          label (kr/jp run long) can outgrow a narrow side-by-side pane. Next is
          pushed to the end of the row and wraps alone onto a second line when
          it runs out of room. */}
      {!submitted && !readOnly && (
        <div className="flex flex-wrap items-center gap-2 px-3.5 pb-3.5 pt-3">
          <Button
            variant="primary"
            size="base"
            // Only a free-form question can fall back to a chat message once expired.
            disabled={!allAnswered || (!expired && !pendingRequest)}
            onClick={handleSubmit}
          >
            <span>{t(expired ? 'question.sendAsMessage' : 'question.submit')}</span>
            <Kbd size="xs" appearance="inverse" aria-hidden="true" className="ml-0.5 opacity-85">{detectPlatform() === 'mac' ? '⌘↵' : 'Ctrl+↵'}</Kbd>
          </Button>
          {allowFreeText && (
            <Button
              variant="ghost"
              size="base"
              disabled={!expired && !pendingRequest}
              onClick={handleChatAboutThis}
              title={t('question.chatAboutThisHint')}
              icon={<MessagesSquare aria-hidden="true" size={14} strokeWidth={1.75} />}
            >
              {t('question.chatAboutThis')}
            </Button>
          )}
          {/* Only on multi-question input, and never on the last one. Pushed to
              the end of the row so it stays out of the way of Submit, which is
              the action that actually ends the exchange. */}
          {questions.length > 1 && safeActiveTab < questions.length - 1 && (
            <Button
              variant="secondary"
              size="base"
              className="ml-auto"
              disabled={!activeAnswered}
              onClick={() => setActiveTab(safeActiveTab + 1)}
              icon={<ArrowRight aria-hidden="true" size={14} strokeWidth={1.75} />}
              iconPosition="end"
            >
              {t('question.next')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
