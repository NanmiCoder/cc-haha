import { useMemo, useRef, useState } from 'react'
import { listPendingPermissions, useChatStore } from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'
import { useTranslation } from '../../i18n'
import { Button } from '@/components/ui/Button'

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

export function AskUserQuestion({ sessionId, toolUseId, input, result }: Props) {
  const { respondToPermission } = useChatStore()
  const activeTabId = useTabStore((s) => s.activeTabId)
  const targetSessionId = sessionId ?? activeTabId
  const pendingRequest = useChatStore((s) => targetSessionId
    ? listPendingPermissions(s.sessions[targetSessionId])
      .find((permission) => permission.toolUseId === toolUseId) ?? null
    : null)
  const t = useTranslation()
  const questions = parseInput(input)
  const inputObject = (input && typeof input === 'object') ? input as Record<string, unknown> : {}
  const [activeTab, setActiveTab] = useState(0)
  const [selections, setSelections] = useState<QuestionSelections>({})
  const [freeTexts, setFreeTexts] = useState<QuestionFreeTexts>({})
  const [hasSubmitted, setHasSubmitted] = useState(false)
  const [hasRequestedChat, setHasRequestedChat] = useState(false)
  const composingRef = useRef(false)

  const resultAnswers = useMemo(() => {
    if (!result || typeof result !== 'object') return {}
    const answers = (result as { answers?: unknown }).answers
    return answers && typeof answers === 'object'
      ? answers as Record<string, string>
      : {}
  }, [result])
  const resultText = typeof result === 'string' && result.trim().length > 0 ? result.trim() : ''
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

  // Every hook above this line runs unconditionally, and it has to stay that way.
  // `input` is not fixed for the lifetime of the instance: chatStore rebuilds tool_use
  // messages from the transcript under a stable id (`${messageId}-block-${index}`), so
  // the same mounted component can see its question count cross zero in either
  // direction. With the early return above the useMemo calls, that transition threw
  // "Rendered fewer/more hooks than expected" and took the whole message list down.
  if (questions.length === 0) return null
  const safeActiveTab = Math.min(activeTab, questions.length - 1)
  const activeQuestion = questions[safeActiveTab]

  const submitted = hasTerminalResult || hasSubmitted || hasRequestedChat
  const terminalWithoutAnswers = submitted && !hasStructuredAnswers && resultText.length > 0

  const handleSelect = (qIndex: number, label: string) => {
    if (submitted) return
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
  }

  const handleFreeTextChange = (qIndex: number, value: string) => {
    if (submitted) return
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
    respondToPermission(targetSessionId, pendingRequest.requestId, true, {
      updatedInput: {
        ...inputObject,
        answers,
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
   */
  const handleChatAboutThis = () => {
    if (submitted) return
    if (!targetSessionId || !pendingRequest) return

    // Carry whatever was already picked, so switching to a conversation isn't
    // punished by losing the partial answers.
    const questionsWithAnswers = questions
      .map((question, index) => {
        const answer = freeTexts[index]?.trim() || getSelectedAnswer(question, selections[index])
        return answer
          ? `- "${question.question}"\n  Answer: ${answer}`
          : `- "${question.question}"\n  (No answer provided)`
      })
      .join('\n')

    setHasRequestedChat(true)
    respondToPermission(targetSessionId, pendingRequest.requestId, false, {
      denyMessage: questionsWithAnswers,
    })
  }

  // All questions must be answered (via selection or free text) to enable submit
  const allAnswered = questions.every((_, i) =>
    Boolean(freeTexts[i]?.trim()) || (selections[i]?.length ?? 0) > 0,
  )

  if (!activeQuestion) return null

  return (
    <div className={`mb-4 rounded-[var(--radius-lg)] border overflow-hidden ${
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
          {submitted && (
            <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-[var(--color-surface-container-high)] text-[var(--color-text-tertiary)]">
              {/* handing the question back is not an answer — saying "answered"
                  there misreports what the user did */}
              {t(hasRequestedChat
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
        {submitted && (hasRequestedChat ? (
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

      {/* Action bar. Wraps rather than overflows: two buttons plus a translated
          label (kr/jp run long) can outgrow a narrow side-by-side pane. */}
      {!submitted && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
          <Button
            variant="primary"
            size="sm"
            disabled={!allAnswered || !pendingRequest}
            onClick={handleSubmit}
            icon={
              <span className="material-symbols-outlined text-[14px]">send</span>
            }
          >
            {t('question.submit')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!pendingRequest}
            onClick={handleChatAboutThis}
            title={t('question.chatAboutThisHint')}
            icon={
              <span className="material-symbols-outlined text-[14px]">forum</span>
            }
          >
            {t('question.chatAboutThis')}
          </Button>
        </div>
      )}
    </div>
  )
}
