import { useEffect, useState } from 'react'
import { Modal, Platform, Pressable, ScrollView, TextInput, View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import type { PermissionRequest } from '../../core/types'
import { Button, HaloDot, Icon, Sheet, Spinner, TextButton, useColors } from '../kit'
import { Text } from '../Text'
import { KeyboardViewport } from '../KeyboardViewport'
import {
  questionClock,
  questionOptionPresentation,
  readQuestions,
  remainingQuestionTime,
  type Question,
  type QuestionClock,
} from '../approvalData'
import { CountdownPill, NoteInput, SubmittedRow, webNoOutline } from './parts'
import { changeQuestionFlow, initialQuestionFlow } from './questionFlow'
import { backQuestionStep, primaryQuestionStep, questionPageModel, questionPromptLabel } from './questionPage'
import { simulatedPhoneChrome } from '../webChrome'

/**
 * AI Auto-answer countdown. Only has a value when the server has announced auto-answer (autoAnswerDeadline is a number or null); 
 * after this device sends the "I am answering" signal it becomes "You took over". The entry row and step page share the same value.
 */
export function useQuestionClock(request: PermissionRequest) {
  const deadline = request.autoAnswerDeadline
  const [now, setNow] = useState(() => Date.now())
  const [interacted, setInteracted] = useState(false)
  const [baseline] = useState(() => remainingQuestionTime(deadline, Date.now())?.seconds)
  useEffect(() => {
    if (typeof deadline !== 'number') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [deadline])
  return {
    clock: questionClock(deadline, now, interacted, baseline),
    /** This device has sent the take-over signal. */
    interact: () => setInteracted(true),
  }
}

/** One-line entry at the input position: "N questions waiting for your answer ›", tap to open the step page. */
export function QuestionPrompt({
  count,
  onOpen,
  sent,
  clock,
}: {
  count: number
  onOpen(): void
  sent?: boolean
  clock?: QuestionClock | null
}) {
  const colors = useColors()
  const label = questionPromptLabel(count)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={sent ? `${label}, submitted` : label}
      accessibilityHint="Open answer page"
      disabled={sent}
      onPress={onOpen}
      style={({ pressed }) => ({
        minHeight: 52,
        borderRadius: 16,
        backgroundColor: colors.card,
        boxShadow: `0 1px 2px rgba(28,25,23,0.05), 0 6px 20px rgba(28,25,23,0.08), 0 0 0 1px ${colors.hair}`,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      {sent ? <Spinner size={16} /> : <HaloDot size={9} />}
      <Text numberOfLines={1} style={{ flex: 1, fontSize: 15, fontWeight: '600', color: colors.ink }}>
        {sent ? 'Submitted, waiting for the computer to confirm.' : label}
      </Text>
      {!sent && clock?.state === 'counting' ? (
        <Text style={{ fontSize: 13, color: colors.attn }}>{clock.label} until AI answers</Text>
      ) : null}
      {sent ? null : <Icon name="chevron-right" size={16} color={colors.ink3} strokeWidth={2.2} />}
    </Pressable>
  )
}

function Mark({ multiple, selected }: { multiple: boolean; selected: boolean }) {
  const colors = useColors()
  return (
    <View
      style={{
        width: 24,
        height: 24,
        borderRadius: multiple ? 7 : 12,
        backgroundColor: selected ? colors.run : 'transparent',
        boxShadow: selected ? undefined : `inset 0 0 0 1.5px ${colors.chevron}`,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {selected ? (
        multiple ? (
          <Icon name="check" size={15} color="#FFFFFF" strokeWidth={3} />
        ) : (
          <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: '#FFFFFF' }} />
        )
      ) : null}
    </View>
  )
}

function OptionRow({
  option,
  selected,
  multiple,
  disabled,
  onPress,
  onInspect,
}: {
  option: Question['options'][number]
  selected: boolean
  multiple: boolean
  disabled: boolean
  onPress(): void
  onInspect(): void
}) {
  const colors = useColors()
  const display = questionOptionPresentation(option.label)
  const [expanded, setExpanded] = useState(false)
  const [fullHeight, setFullHeight] = useState(0)
  const [previewHeight, setPreviewHeight] = useState(0)
  const truncated = previewHeight > 0 && fullHeight > previewHeight + 1
  const descriptionStyle = { fontSize: 13, lineHeight: 18, color: colors.ink3 }
  return (
    <View
      style={{
        borderRadius: 16,
        backgroundColor: selected ? colors.sel : colors.card,
        boxShadow: selected ? `inset 0 0 0 1.5px ${colors.run}` : `inset 0 0 0 1px ${colors.hair}`,
      }}
    >
      <Pressable
        accessibilityRole={multiple ? 'checkbox' : 'radio'}
        accessibilityLabel={option.description ? `${display.label}, ${option.description}` : display.label}
        accessibilityState={{ checked: selected, disabled }}
        aria-checked={selected}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => ({
          minHeight: 60,
          borderRadius: 16,
          paddingHorizontal: 16,
          paddingVertical: 8,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 14,
          opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
        })}
      >
        <Mark multiple={multiple} selected={selected} />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ flexShrink: 1, fontSize: 17, lineHeight: 22, fontWeight: '500', color: colors.ink }}>
              {display.label}
            </Text>
            {display.recommended ? (
              <Text
                style={{
                  fontSize: 11.5,
                  fontWeight: '600',
                  color: colors.attn,
                  backgroundColor: colors.attnSoft,
                  borderRadius: 6,
                  paddingHorizontal: 6,
                  paddingVertical: 1,
                  overflow: 'hidden',
                }}
              >
                Recommended
              </Text>
            ) : null}
          </View>
          {option.description ? (
            <View style={{ overflow: 'hidden' }}>
              <Text
                numberOfLines={expanded ? undefined : 2}
                onLayout={(event) => {
                  if (!expanded) setPreviewHeight(event.nativeEvent.layout.height)
                }}
                style={descriptionStyle}
              >
                {option.description}
              </Text>
              {/* Measure the same width/font without a line limit on native and RN Web. */}
              <Text
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                aria-hidden
                onLayout={(event) => setFullHeight(event.nativeEvent.layout.height)}
                style={[descriptionStyle, { position: 'absolute', top: 0, left: 0, right: 0, opacity: 0, pointerEvents: 'none' }]}
              >
                {option.description}
              </Text>
            </View>
          ) : null}
        </View>
      </Pressable>
      {truncated || expanded ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} details of “${display.label}”`}
          accessibilityState={{ expanded }}
          aria-expanded={expanded}
          onPress={() => {
            if (!disabled) onInspect()
            setExpanded((value) => !value)
          }}
          style={({ pressed }) => ({
            alignSelf: 'flex-start',
            marginLeft: 54,
            paddingHorizontal: 16,
            minHeight: 44,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ fontSize: 13, fontWeight: '500', color: colors.run }}>
            {expanded ? 'Collapse details' : 'Expand details'}
          </Text>
          <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={colors.run} />
        </Pressable>
      ) : null}
    </View>
  )
}

export type QuestionPageProps = {
  visible: boolean
  /** Collapse the step page (answer progress is kept; tap the entry row again to continue). */
  onClose(): void
  request: PermissionRequest
  input: Record<string, unknown>
  ready: boolean
  sent: boolean
  /** Send ask_user_question_activity; returns whether it was sent. */
  signalActivity(): boolean
  submit(answers: Record<string, string>): boolean
  discuss(note: string): boolean
  /** AI Auto-answer countdown; not shown when omitted. */
  clock?: QuestionClock | null
  /** This device has sent the take-over signal (paired with interact from useQuestionClock). */
  onInteract?(): void
}

/**
 * AskUserQuestion full-height step page: one question per screen, large option rows, with a fixed bottom "Previous / Next (Submit on the last question)", 
 * and "Discuss first" at the bottom left denies with a note per the existing protocol. Answer state lives in the component, so keep it mounted and only toggle visible.
 */
export function QuestionPage({
  visible,
  onClose,
  input,
  ready,
  sent,
  signalActivity,
  submit,
  discuss,
  clock,
  onInteract,
}: QuestionPageProps) {
  const colors = useColors()
  const questions = readQuestions(input)
  const [flow, setFlow] = useState(initialQuestionFlow)
  const change = (action: Parameters<typeof changeQuestionFlow>[2]) =>
    setFlow((current) => changeQuestionFlow(current, questions, action))
  const [customOpen, setCustomOpen] = useState<Record<string, boolean>>({})
  const [discussOpen, setDiscussOpen] = useState(false)
  const [note, setNote] = useState('')
  const model = questionPageModel(flow, questions, { ready, sent })
  const { current } = model
  const locked = !ready || sent
  const activity = () => {
    if (signalActivity()) onInteract?.()
  }
  const choose = (label: string) => {
    if (!current) return
    activity()
    setCustomOpen((value) => ({ ...value, [current.question]: false }))
    change({ type: 'choose', label })
  }
  const back = () => {
    const step = backQuestionStep(flow, questions, { ready, sent })
    if (!step) return
    activity()
    change(step)
  }
  const primary = () => {
    const step = primaryQuestionStep(flow, questions, { ready, sent })
    if (!step) return
    activity()
    if (step.type === 'open') change(step)
    else if (submit(step.answers)) onClose()
  }
  const customText = current ? (flow.custom[current.question] ?? '') : ''
  const showCustom = Boolean(current && customOpen[current.question])

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'fullScreen' : undefined}
      onRequestClose={onClose}
    >
      <SafeAreaView
        edges={['top', 'left', 'right']}
        style={[{ flex: 1, backgroundColor: colors.bg }, simulatedPhoneChrome && { paddingTop: 54 }]}
      >
        <KeyboardViewport style={{ flex: 1 }}>
          <View accessibilityViewIsModal role="dialog" aria-label="Answer questions" style={{ flex: 1 }}>
            <View style={{ height: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Collapse"
                accessibilityHint="Answer later, progress kept"
                onPress={onClose}
                style={({ pressed }) => ({
                  width: 44,
                  height: 44,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: pressed ? 0.5 : 1,
                })}
              >
                <Icon name="chevron-down" size={24} color={colors.ink} strokeWidth={2.2} />
              </Pressable>
              <Text
                accessibilityRole="header"
                numberOfLines={1}
                style={{ flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600', color: colors.ink }}
              >
                Answer questions
                {model.position ? (
                  <Text style={{ color: colors.ink3, fontWeight: '500' }}> · {model.position}</Text>
                ) : null}
              </Text>
              <View style={{ width: 44 }} />
            </View>
            <View
              accessibilityRole="progressbar"
              accessibilityLabel="Answer progress"
              accessibilityValue={{ min: 1, max: Math.max(1, model.total), now: model.index + 1 }}
              style={{
                marginHorizontal: 16,
                marginTop: 2,
                height: 4,
                borderRadius: 2,
                backgroundColor: colors.fill,
                overflow: 'hidden',
              }}
            >
              <View
                style={{
                  width: `${Math.round(model.progress * 1000) / 10}%`,
                  height: '100%',
                  borderRadius: 2,
                  backgroundColor: colors.run,
                }}
              />
            </View>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 22, paddingBottom: 24 }}
            >
              {current ? (
                <>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 }}>
                    <Text style={{ fontSize: 13, color: colors.ink3 }}>{model.kind}</Text>
                    <View style={{ flex: 1 }} />
                    {clock ? (
                      <CountdownPill
                        state={clock.state}
                        label={clock.state === 'counting' ? clock.label : undefined}
                        fraction={clock.state === 'counting' ? clock.fraction : undefined}
                      />
                    ) : null}
                  </View>
                  <Text
                    accessibilityRole="header"
                    style={{ fontSize: 20, lineHeight: 28, fontWeight: '600', color: colors.ink, paddingTop: 10 }}
                  >
                    {current.question}
                  </Text>
                  {model.hint ? (
                    <Text style={{ fontSize: 14, color: colors.ink3, paddingTop: 4 }}>{model.hint}</Text>
                  ) : null}
                  <View
                    role={model.multiple ? 'group' : 'radiogroup'}
                    aria-label="Options"
                    style={{ gap: 10, paddingTop: 20 }}
                  >
                    {current.options.map((option) => (
                      <OptionRow
                        key={`${current.question}:${option.label}`}
                        option={option}
                        multiple={model.multiple}
                        disabled={locked}
                        selected={!model.customActive && Boolean(flow.answers[current.question]?.includes(option.label))}
                        onPress={() => choose(option.label)}
                        onInspect={activity}
                      />
                    ))}
                    {showCustom ? (
                      <View
                        style={{
                          borderRadius: 16,
                          minHeight: 60,
                          paddingHorizontal: 16,
                          paddingVertical: 14,
                          flexDirection: 'row',
                          alignItems: 'flex-start',
                          gap: 14,
                          backgroundColor: model.customActive ? colors.sel : colors.card,
                          boxShadow: `inset 0 0 0 1.5px ${colors.run}`,
                        }}
                      >
                        <Mark multiple={model.multiple} selected={model.customActive} />
                        <TextInput
                          accessibilityLabel={`Your own answer ${model.index + 1}`}
                          autoFocus
                          multiline
                          placeholder="Write your answer"
                          placeholderTextColor={colors.ink3}
                          value={customText}
                          editable={!locked}
                          onFocus={activity}
                          onChangeText={(value) => {
                            activity()
                            change({ type: 'custom', text: value })
                          }}
                          style={[
                            {
                              flex: 1,
                              minHeight: 24,
                              maxHeight: 160,
                              padding: 0,
                              fontSize: 16,
                              lineHeight: 24,
                              color: colors.ink,
                            },
                            webNoOutline,
                          ]}
                        />
                      </View>
                    ) : (
                      <Pressable
                        accessibilityRole={model.multiple ? 'checkbox' : 'radio'}
                        accessibilityLabel="Other, I will say it myself"
                        accessibilityState={{ checked: false, disabled: locked }}
                        disabled={locked}
                        onPress={() => {
                          activity()
                          setCustomOpen((value) => ({ ...value, [current.question]: true }))
                        }}
                        style={({ pressed }) => ({
                          height: 52,
                          borderRadius: 16,
                          paddingHorizontal: 16,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 14,
                          boxShadow: `inset 0 0 0 1px ${colors.hair}`,
                          opacity: locked ? 0.45 : pressed ? 0.75 : 1,
                        })}
                      >
                        <Mark multiple={model.multiple} selected={false} />
                        <Text style={{ fontSize: 16, color: colors.ink3 }}>Other, I will say it myself…</Text>
                      </Pressable>
                    )}
                  </View>
                </>
              ) : (
                <Text style={{ fontSize: 16, lineHeight: 24, color: colors.ink2 }}>
                  The computer did not provide any answerable questions; please handle it on the computer.
                </Text>
              )}
            </ScrollView>
            <View
              style={{
                borderTopWidth: 1,
                borderTopColor: colors.hair,
                backgroundColor: colors.bg,
                paddingHorizontal: 16,
                paddingTop: 12,
              }}
            >
              {sent ? (
                <SubmittedRow />
              ) : (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {model.canBack ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Previous"
                      onPress={back}
                      style={({ pressed }) => ({
                        flex: 1,
                        height: 52,
                        borderRadius: 16,
                        backgroundColor: colors.fill,
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: pressed ? 0.7 : 1,
                      })}
                    >
                      <Text style={{ fontSize: 16, fontWeight: '600', color: colors.ink }}>Previous</Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={model.primaryLabel}
                    accessibilityState={{ disabled: !model.primaryEnabled }}
                    disabled={!model.primaryEnabled}
                    onPress={primary}
                    style={({ pressed }) => ({
                      flex: model.canBack ? 1.6 : 1,
                      height: 52,
                      borderRadius: 16,
                      backgroundColor: model.primaryEnabled ? colors.btn : colors.fill,
                      alignItems: 'center',
                      justifyContent: 'center',
                      opacity: pressed ? 0.8 : 1,
                    })}
                  >
                    <Text
                      style={{
                        fontSize: 16,
                        fontWeight: '600',
                        color: model.primaryEnabled ? colors.btnInk : colors.ink3,
                      }}
                    >
                      {model.primaryLabel}
                    </Text>
                  </Pressable>
                </View>
              )}
              <View style={{ minHeight: 56, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 2 }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Discuss first"
                  accessibilityState={{ disabled: !model.discussEnabled }}
                  disabled={!model.discussEnabled}
                  onPress={() => {
                    activity()
                    setDiscussOpen(true)
                  }}
                  style={({ pressed }) => ({
                    height: 44,
                    paddingHorizontal: 16,
                    justifyContent: 'center',
                    opacity: !model.discussEnabled ? 0.4 : pressed ? 0.6 : 1,
                  })}
                >
                  <Text style={{ fontSize: 15, color: colors.ink2 }}>Discuss first</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </KeyboardViewport>
        <Sheet
          visible={discussOpen}
          onClose={() => setDiscussOpen(false)}
          title="Discuss first"
          left={<TextButton title="Cancel" onPress={() => setDiscussOpen(false)} />}
          footer={
            <Button
              title="Send note"
              size="lg"
              disabled={!ready || sent || !note.trim()}
              onPress={() => {
                if (discuss(note)) {
                  setDiscussOpen(false)
                  onClose()
                }
              }}
            />
          }
        >
          <Text style={{ fontSize: 14, lineHeight: 21, color: colors.ink2 }}>
            The note is sent to the task on the computer, and this round of questions is left unanswered.
          </Text>
          <NoteInput
            accessibilityLabel="Tell it what still needs clarifying"
            placeholder="Tell it what still needs clarifying"
            autoFocus
            value={note}
            onChangeText={setNote}
            editable={!sent}
            style={{ backgroundColor: colors.card }}
          />
        </Sheet>
      </SafeAreaView>
    </Modal>
  )
}

/**
 * Ready-made combo of entry row + step page (used directly in Approval). When the entry needs to go at the input position, 
 * use {@link QuestionPrompt} and {@link QuestionPage} separately, with {@link useQuestionClock} for the clock.
 */
export function QuestionDecision(props: Omit<QuestionPageProps, 'visible' | 'onClose' | 'clock' | 'onInteract'>) {
  const [open, setOpen] = useState(false)
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const bottom = simulatedPhoneChrome ? 34 : Math.max(insets.bottom, 12)
  const { clock, interact } = useQuestionClock(props.request)
  const count = readQuestions(props.input).length
  return (
    <>
      <View style={{ backgroundColor: colors.bg, paddingHorizontal: 12, paddingTop: 8, paddingBottom: bottom }}>
        <QuestionPrompt count={count} sent={props.sent} clock={clock} onOpen={() => setOpen(true)} />
      </View>
      <QuestionPage
        {...props}
        visible={open}
        onClose={() => setOpen(false)}
        clock={clock}
        onInteract={interact}
      />
    </>
  )
}
