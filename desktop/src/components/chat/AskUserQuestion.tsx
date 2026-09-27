import { useEffect, useMemo, useRef, useState } from 'react'
import {
  listPendingPermissions,
  useChatStore,
  type AskUserQuestionDraft,
} from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'
import { useTranslation } from '../../i18n'
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

type AskUserInput = {
  questions?: Question[]
  question?: string
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

/**
 * Parse the AskUserQuestion input which may come in different shapes.
 */
function parseInput(input: unknown): Question[] {
  if (!input || typeof input !== 'object') return []
  const obj = input as AskUserInput

  // Shape 1: { questions: [...] }
  if (Array.isArray(obj.questions)) {
    return obj.questions
  }

  // Shape 2: { question: "...", options: [...] }
  if (typeof obj.question === 'string') {
    return [{
      question: obj.question,
      header: obj.header,
      options: obj.options,
      multiSelect: obj.multiSelect,
    }]
  }

  return []
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
  const questions = parseInput(input)
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

  return (
    <div className={`rounded-[var(--radius-lg)] border overflow-hidden ${
      submitted
        ? 'border-[var(--color-border)] bg-[var(--color-surface-container-low)] opacity-70'
        : 'border-[var(--color-secondary)] bg-[var(--color-surface-container-lowest)]'
    }`}>
      {/* Header */}
      <div className={`flex items-center gap-3 px-4 py-3 ${
        submitted
          ? 'bg-[var(--color-surface-container-low)]'
          : 'bg-[var(--color-surface-container)]'
      }`}>
        <div className="flex items-center justify-center w-8 h-8 rounded-[var(--radius-md)] bg-[var(--color-secondary-container)]">
          <span className="material-symbols-outlined text-[18px] text-[var(--color-secondary)]">
            help
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">
            {t('question.needsInput')}
          </span>
          {(submitted || expired) && (
            <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-[var(--color-surface-container-high)] text-[var(--color-text-tertiary)]">
              {/* handing the question back is not an answer — saying "answered"
                  there misreports what the user did; and an expired question was
                  never answered at all, whatever happened to the answers */}
              {t(automaticallyAnswered
                ? 'question.autoAnswered'
                : hasSentAsMessage || expired
                ? 'question.expiredBadge'
                : hasRequestedChat
                  ? 'question.chatBadge'
                  : terminalWithoutAnswers ? 'question.completed' : 'question.answered')}
            </span>
          )}
        </div>
      </div>

      {/* Question tabs — horizontal tab bar (only show when multiple questions) */}
      {questions.length > 1 && (
        <div className="flex px-4 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)] overflow-x-auto">
          {questions.map((q, i) => {
            const isActive = safeActiveTab === i
            const isAnswered = Boolean(freeTexts[i]?.trim()) || (selections[i]?.length ?? 0) > 0
            const tabLabel = q.header || `Q${i + 1}`
            return (
              <button
                key={i}
                onClick={() => setActiveTab(i)}
                className={`relative flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium whitespace-nowrap transition-colors ${
                  isActive
                    ? 'text-[var(--color-secondary)]'
                    : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
                }`}
              >
                {isAnswered && (
                  <span className="material-symbols-outlined text-[14px] text-[var(--color-success)]">check_circle</span>
                )}
                {tabLabel}
                {isActive && (
                  <div className="absolute bottom-0 left-2 right-2 h-[2px] bg-[var(--color-secondary)] rounded-t" />
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* Active question content */}
      <div className="px-4 py-3">
        {/* Nothing is waiting on this question any more. The form below stays
            usable on purpose — the answers are still worth sending — but which
            channel they take changes, and that has to be visible. */}
        {expired && (
          <div
            role="status"
            aria-live="polite"
            className="mb-3 flex items-start gap-2 text-xs text-[var(--color-text-secondary)]"
          >
            <span className="material-symbols-outlined text-[14px] text-[var(--color-text-tertiary)]" aria-hidden="true">
              info
            </span>
            <span>{t('question.expiredNotice')}</span>
          </div>
        )}
        <p className="text-sm font-medium text-[var(--color-text-primary)] mb-3">
          {activeQuestion.question}
        </p>

        {/* Option cards */}
        {activeQuestion.options && activeQuestion.options.length > 0 && (
          <div className="space-y-2 mb-3">
            {activeQuestion.options.map((opt, optIndex) => {
              const isSelected = selections[safeActiveTab]?.includes(opt.label) ?? false
              const isMultiSelect = activeQuestion.multiSelect === true
              return (
                <button
                  key={optIndex}
                  onClick={() => handleSelect(safeActiveTab, opt.label)}
                  disabled={submitted}
                  className={`w-full text-left px-4 py-3 rounded-[var(--radius-md)] border transition-all duration-150 cursor-pointer ${
                    isSelected
                      ? 'border-[var(--color-secondary)] bg-[var(--color-secondary-container)]'
                      : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-outline)] hover:bg-[var(--color-surface-container-low)]'
                  } ${submitted ? 'cursor-default' : ''}`}
                >
                  <div className="flex items-start gap-3">
                    {/* Selection indicator */}
                    <div className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors ${
                      isSelected
                        ? 'border-[var(--color-secondary)] bg-[var(--color-secondary)]'
                        : 'border-[var(--color-outline)]'
                    } ${isMultiSelect ? 'rounded-[var(--radius-xs)]' : 'rounded-full'}`}>
                      {isSelected && (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className={`text-sm font-medium ${
                        isSelected
                          ? 'text-[var(--color-secondary)]'
                          : 'text-[var(--color-text-primary)]'
                      }`}>
                        {opt.label}
                      </span>
                      {opt.description && (
                        <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                          {opt.description}
                        </p>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {/* Free text input */}
        {!submitted && (
          <div>
            <label className="text-xs text-[var(--color-text-tertiary)] mb-1.5 block">
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
              className="max-h-48 min-h-[84px] w-full resize-y rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm leading-relaxed text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)] focus:outline-none focus:shadow-[var(--shadow-focus-ring)]"
            />
          </div>
        )}

        {/* Submitted answer display — the chat handoff wins over any terminal
            result, whose text is the deny payload and not worth showing. */}
        {submitted && (hasSentAsMessage ? (
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
            <span className="material-symbols-outlined text-[14px] text-[var(--color-secondary)]">send</span>
            <span>
              {t('question.sentAsMessagePrefix')}<strong>{answeredText}</strong>
            </span>
          </div>
        ) : hasRequestedChat ? (
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
            <span className="material-symbols-outlined text-[14px] text-[var(--color-secondary)]">forum</span>
            <span>{t('question.chatRequested')}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
            <span className="material-symbols-outlined text-[14px] text-[var(--color-success)]">check_circle</span>
            <span>
              {t(terminalWithoutAnswers ? 'question.resultPrefix' : 'question.answeredPrefix')}<strong>{answeredText}</strong>
            </span>
          </div>
        ))}
      </div>

      {/* Action bar. Wraps rather than overflows: the buttons plus a translated
          label (kr/jp run long) can outgrow a narrow side-by-side pane. Next is
          pushed to the end of the row and wraps alone onto a second line when
          it runs out of room. */}
      {!submitted && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
          <Button
            variant="primary"
            size="sm"
            // `expired` is the one state where a button may work without a live
            // request: it sends the answers as a message instead of answering.
            disabled={!allAnswered || (!expired && !pendingRequest)}
            onClick={handleSubmit}
            icon={
              <span className="material-symbols-outlined text-[14px]">send</span>
            }
          >
            {t(expired ? 'question.sendAsMessage' : 'question.submit')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!expired && !pendingRequest}
            onClick={handleChatAboutThis}
            title={t('question.chatAboutThisHint')}
            icon={
              <span className="material-symbols-outlined text-[14px]">forum</span>
            }
          >
            {t('question.chatAboutThis')}
          </Button>
          {/* Only on multi-question input, and never on the last one. Pushed to
              the end of the row so it stays out of the way of Submit, which is
              the action that actually ends the exchange. */}
          {questions.length > 1 && safeActiveTab < questions.length - 1 && (
            <Button
              variant="tonal"
              size="sm"
              className="ml-auto"
              disabled={!activeAnswered}
              onClick={() => setActiveTab(safeActiveTab + 1)}
              icon={
                <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
              }
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
