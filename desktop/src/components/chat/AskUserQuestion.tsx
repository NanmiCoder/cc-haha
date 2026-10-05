import { useEffect, useMemo, useRef, useState } from 'react'
import {
  listPendingPermissions,
  useChatStore,
  type AskUserQuestionDraft,
} from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'
import { useTranslation } from '../../i18n'
import { ArrowRight, Check, CircleCheck, Info, MessageCircleQuestion, MessagesSquare, Send } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
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
}

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

function getSelectedAnswer(question: Question, selected: string[] | undefined) {
  if (!selected || selected.length === 0) return ''
  return question.multiSelect ? selected.join(', ') : selected[0] ?? ''
}

export function AskUserQuestion({
  sessionId,
  toolUseId,
  input,
  result,
  supersededByUserMessage,
}: Props) {
  const { respondToPermission } = useChatStore()
  const activeTabId = useTabStore((s) => s.activeTabId)
  const targetSessionId = sessionId ?? activeTabId
  const pendingRequest = useChatStore((s) => targetSessionId
    ? listPendingPermissions(s.sessions[targetSessionId])
      .find((permission) => permission.toolUseId === toolUseId) ?? null
    : null)
  // The card is rendered from the transcript, but answering it needs the live
  // permission request. Both facts below come from the session, never from the
  // transcript, and they are what tells a live question from an expired one.
  const sessionChatState = useChatStore((s) =>
    targetSessionId ? s.sessions[targetSessionId]?.chatState : undefined)
  const sessionConnectionState = useChatStore((s) =>
    targetSessionId ? s.sessions[targetSessionId]?.connectionState : undefined)
  const t = useTranslation()
  const questions = useMemo(() => parseInput(input), [input])
  const inputObject = (input && typeof input === 'object') ? input as Record<string, unknown> : {}
  // Read once instead of subscribing: this card writes the draft on every
  // change, and a subscription would feed its own writes back as re-renders.
  const storedDraft = targetSessionId
    ? useChatStore.getState().askUserQuestionDrafts[targetSessionId]?.[toolUseId]
    : undefined
  const [activeTab, setActiveTab] = useState(storedDraft?.activeTab ?? 0)
  const [selections, setSelections] = useState<QuestionSelections>(storedDraft?.selections ?? {})
  const [freeTexts, setFreeTexts] = useState<QuestionFreeTexts>(storedDraft?.freeTexts ?? {})
  const [hasSubmitted, setHasSubmitted] = useState(false)
  const [hasRequestedChat, setHasRequestedChat] = useState(storedDraft?.handedOff === true)
  // The question had no live request left, so the answers went out as a message.
  const [hasSentAsMessage, setHasSentAsMessage] = useState(storedDraft?.sentAsMessage === true)
  const composingRef = useRef(false)
  const activitySentForRequest = useRef<string | null>(null)

  // A choice can be made before the SDK permission request reaches the UI.
  // Protect that draft as soon as the matching request arrives.
  useEffect(() => {
    if (!targetSessionId || !pendingRequest || hasSubmitted ||
      activitySentForRequest.current === pendingRequest.requestId) return
    if (!Object.values(selections).some((labels) => labels.length > 0) &&
      !Object.values(freeTexts).some((value) => value.trim())) return
    activitySentForRequest.current = pendingRequest.requestId
    useChatStore.getState().recordAskUserQuestionActivity(targetSessionId, pendingRequest.requestId)
  }, [freeTexts, hasSubmitted, pendingRequest, selections, targetSessionId])

  const resultAnswers = useMemo(() => {
    if (!result || typeof result !== 'object') return {}
    const answers = (result as { answers?: unknown }).answers
    return answers && typeof answers === 'object'
      ? answers as Record<string, string>
      : {}
  }, [result])
  const resultText = typeof result === 'string' && result.trim().length > 0 ? result.trim() : ''
  const automaticallyAnswered = Boolean(result && typeof result === 'object' &&
    (result as { selectionSource?: unknown }).selectionSource === 'automatic')
  const hasStructuredAnswers = Object.keys(resultAnswers).length > 0
  const hasTerminalResult = hasStructuredAnswers || resultText.length > 0

  const answeredText = useMemo(() => {
    if (hasStructuredAnswers) {
      return questions
        .map((question) => resultAnswers[question.question])
        .filter((answer): answer is string => typeof answer === 'string' && answer.trim().length > 0)
        .join(', ')
    }
    if (resultText) return resultText
    return questions
      .map((question, index) => freeTexts[index]?.trim() || getSelectedAnswer(question, selections[index]))
      .filter(Boolean)
      .join('; ')
  }, [freeTexts, hasStructuredAnswers, questions, resultAnswers, resultText, selections])

  // Hand the card's state to the store so it survives the unmounts that tab
  // switches and the virtualized window cause — the answers are the user's work.
  // Terminal states it can prove locally win over the ones the server records:
  // `sentAsMessage` and the handoff leave no trace on the server, and dropping
  // them would resurrect an answerable form that could deliver twice.
  useEffect(() => {
    if (!targetSessionId) return
    const store = useChatStore.getState()
    const draft: AskUserQuestionDraft = { activeTab, selections, freeTexts }
    if (hasSentAsMessage) {
      store.setAskUserQuestionDraft(targetSessionId, toolUseId, { ...draft, sentAsMessage: true })
      return
    }
    if (hasRequestedChat) {
      store.setAskUserQuestionDraft(targetSessionId, toolUseId, { ...draft, handedOff: true })
      return
    }
    if (hasSubmitted || hasTerminalResult) {
      store.clearAskUserQuestionDraft(targetSessionId, toolUseId)
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
  const safeActiveTab = Math.min(activeTab, questions.length - 1)
  const activeQuestion = questions[safeActiveTab]

  const submitted = hasTerminalResult || hasSubmitted || hasRequestedChat || hasSentAsMessage
  const terminalWithoutAnswers = submitted && !hasStructuredAnswers && resultText.length > 0

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
  // Delivering an expired answer means sending a message, which needs a connected
  // session. While reconnecting, the permission snapshot may not have arrived yet,
  // so stay neutral rather than declaring the question dead.
  const canSendAsMessage = Boolean(targetSessionId) && sessionConnectionState === 'connected'
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
  const expired = !submitted && !pendingRequest && canSendAsMessage &&
    (supersededByUserMessage === true || !sessionBusy)

  /** The `- "question"\n  Answer: …` block every AskUserQuestion handoff uses. */
  const describeAnswers = () => questions
    .map((question, index) => {
      const answer = freeTexts[index]?.trim() || getSelectedAnswer(question, selections[index])
      return answer
        ? `- "${question.question}"\n  Answer: ${answer}`
        : `- "${question.question}"\n  (No answer provided)`
    })
    .join('\n')

  /**
   * Delivers text to the model as an ordinary user message — only ever reached
   * when no permission request is left to answer. Mirrors ChatInput's
   * send-or-queue decision so a session that started a new turn between render
   * and click is not interrupted mid-turn.
   */
  const sendAsMessage = (content: string, displayContent: string) => {
    const sessionId = targetSessionId
    if (!sessionId) return
    const store = useChatStore.getState()
    const liveChatState = store.sessions[sessionId]?.chatState ?? 'idle'
    if (liveChatState !== 'idle') {
      store.queueUserMessage(sessionId, { content, displayContent })
      return
    }
    store.sendMessage(sessionId, content, undefined, { displayContent })
  }

  const markUserActivity = () => {
    if (!targetSessionId || !pendingRequest || submitted ||
      activitySentForRequest.current === pendingRequest.requestId) return
    activitySentForRequest.current = pendingRequest.requestId
    useChatStore.getState().recordAskUserQuestionActivity(targetSessionId, pendingRequest.requestId)
  }

  const handleSelect = (qIndex: number, label: string) => {
    if (submitted) return
    markUserActivity()
    // Computed from the render snapshot rather than inside the updater: React
    // may run a state updater twice, and advancing the tab is a side effect.
    // Clicking an already-selected option deselects it — that is not a step
    // forward. Multi-select keeps the user on the question until they say so.
    const shouldAdvance =
      questions[qIndex]?.multiSelect !== true &&
      !(selections[qIndex]?.includes(label) ?? false) &&
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
    setFreeTexts((prev) => {
      if (!prev[qIndex]) return prev
      const next = { ...prev }
      delete next[qIndex]
      return next
    })
    if (shouldAdvance) setActiveTab(qIndex + 1)
  }

  const handleFreeTextChange = (qIndex: number, value: string) => {
    if (submitted) return
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
    if (value.trim()) {
      setSelections((prev) => {
        if (!prev[qIndex]) return prev
        const next = { ...prev }
        delete next[qIndex]
        return next
      })
    }
  }

  const handleSubmit = () => {
    if (submitted) return

    const parts: string[] = []
    for (let i = 0; i < questions.length; i++) {
      const answer = freeTexts[i]?.trim() || getSelectedAnswer(questions[i]!, selections[i])
      if (answer) parts.push(answer)
    }
    const response = parts.join('; ')
    if (!response) return

    if (expired) {
      setHasSentAsMessage(true)
      sendAsMessage(
        `${ASK_USER_QUESTION_EXPIRED_ANSWER_PREFIX}\n\n${describeAnswers()}`,
        response,
      )
      return
    }

    if (!targetSessionId || !pendingRequest) return

    const answers = questions.reduce<Record<string, string>>((acc, question, index) => {
      const freeText = freeTexts[index]?.trim()
      if (freeText) {
        acc[question.question] = freeText
      } else {
        const selected = getSelectedAnswer(question, selections[index])
        if (selected) acc[question.question] = selected
      }
      return acc
    }, {})

    setHasSubmitted(true)
    const metadata = inputObject.metadata
    respondToPermission(targetSessionId, pendingRequest.requestId, true, {
      updatedInput: {
        ...inputObject,
        answers,
        ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata)
          ? { metadata: Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'autoAnswered')) }
          : {}),
      },
    })
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
    if (submitted) return

    if (expired) {
      const questionsWithAnswers = describeAnswers()
      setHasRequestedChat(true)
      // No request left to deny, so this goes out as an ordinary message and
      // carries the same wording the server would have written for the denial.
      sendAsMessage(
        `${ASK_USER_QUESTION_CLARIFY_WITH_QUESTIONS_PREFIX}${questionsWithAnswers}`,
        questionsWithAnswers,
      )
      return
    }

    if (!targetSessionId || !pendingRequest) return

    setHasRequestedChat(true)
    respondToPermission(targetSessionId, pendingRequest.requestId, false, {
      // Carry whatever was already picked, so switching to a conversation isn't
      // punished by losing the partial answers.
      denyMessage: describeAnswers(),
    })
  }

  // All questions must be answered (via selection or free text) to enable submit
  const allAnswered = questions.every((_, i) =>
    Boolean(freeTexts[i]?.trim()) || (selections[i]?.length ?? 0) > 0,
  )

  if (!activeQuestion) return null

  // Gates the Next button: ChatGPT's `canAdvance`, so a step forward cannot
  // silently drop a question the user never answered.
  const activeAnswered =
    Boolean(freeTexts[safeActiveTab]?.trim()) || (selections[safeActiveTab]?.length ?? 0) > 0

  const statusBadgeKey = automaticallyAnswered
    ? 'question.autoAnswered'
    : hasSentAsMessage || expired
      ? 'question.expiredBadge'
      : hasRequestedChat
        ? 'question.chatBadge'
        : terminalWithoutAnswers ? 'question.completed' : 'question.answered'

  return (
    <div className={`overflow-hidden rounded-[var(--radius-lg)] border bg-[var(--color-surface-container-lowest)] ${
      submitted ? 'border-[var(--color-border)]' : 'border-[var(--color-outline)]'
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
            const isAnswered = Boolean(freeTexts[i]?.trim()) || (selections[i]?.length ?? 0) > 0
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
          {/* Nothing is waiting on this question any more. The form below stays
              usable on purpose — the answers are still worth sending — but which
              channel they take changes, and that has to be visible. */}
          {expired && (
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
                    disabled={submitted}
                    aria-pressed={isSelected}
                    className={`flex w-full cursor-pointer items-start gap-2.5 rounded-[var(--radius-md)] px-3 py-2.5 text-left transition-[background-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
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

          {/* Free text input: the sunken answer slot. */}
          <div className="mt-2.5">
            <label className="mb-1 block px-1 text-xs text-[var(--color-text-tertiary)]">
              {t('question.customResponse')}
            </label>
            <textarea
              value={freeTexts[safeActiveTab] ?? ''}
              onChange={(e) => handleFreeTextChange(safeActiveTab, e.target.value)}
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
              className="max-h-48 min-h-[72px] w-full resize-y rounded-[var(--radius-md)] border border-transparent bg-[var(--color-surface-container)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--color-text-primary)] transition-colors placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-outline)] focus:bg-[var(--color-surface-container-lowest)] focus:outline-none"
            />
          </div>
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
          ) : hasRequestedChat ? (
            <div className="flex items-center gap-2 text-[13px] text-[var(--color-text-secondary)]">
              <MessagesSquare aria-hidden="true" size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" />
              <span>{t('question.chatRequested')}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-[13px] text-[var(--color-text-secondary)]">
              <CircleCheck aria-hidden="true" size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-success)]" />
              <span>
                {t(terminalWithoutAnswers ? 'question.resultPrefix' : 'question.answeredPrefix')}<strong className="font-medium text-[var(--color-text-primary)]">{answeredText}</strong>
              </span>
            </div>
          )}
        </div>
      )}

      {/* Action bar. Wraps rather than overflows: the buttons plus a translated
          label (kr/jp run long) can outgrow a narrow side-by-side pane. Next is
          pushed to the end of the row and wraps alone onto a second line when
          it runs out of room. */}
      {!submitted && (
        <div className="flex flex-wrap items-center gap-2 px-3.5 pb-3.5 pt-3">
          <Button
            variant="primary"
            size="base"
            // `expired` is the one state where a button may work without a live
            // request: it sends the answers as a message instead of answering.
            disabled={!allAnswered || (!expired && !pendingRequest)}
            onClick={handleSubmit}
          >
            {t(expired ? 'question.sendAsMessage' : 'question.submit')}
          </Button>
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
