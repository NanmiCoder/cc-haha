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

/**
 * AI 代答倒计时。只在服务端宣布过代答（autoAnswerDeadline 为数字或 null）时才有值；
 * 本机发出过“我在回答”信号后变成“你已接手”。入口行和分步页共用同一份。
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
    /** 本机已发出接手信号。 */
    interact: () => setInteracted(true),
  }
}

/** 输入框位置的一行入口：“有 N 个问题等你回答 ›”，点按打开分步页。 */
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
      accessibilityLabel={sent ? `${label}，已提交` : label}
      accessibilityHint="打开回答页"
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
        {sent ? '已提交，正在等待电脑确认。' : label}
      </Text>
      {!sent && clock?.state === 'counting' ? (
        <Text style={{ fontSize: 13, color: colors.attn }}>{clock.label} 后 AI 代答</Text>
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
}: {
  option: Question['options'][number]
  selected: boolean
  multiple: boolean
  disabled: boolean
  onPress(): void
}) {
  const colors = useColors()
  const display = questionOptionPresentation(option.label)
  return (
    <Pressable
      accessibilityRole={multiple ? 'checkbox' : 'radio'}
      accessibilityLabel={option.description ? `${display.label}，${option.description}` : display.label}
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
        backgroundColor: selected ? colors.sel : colors.card,
        boxShadow: selected ? `inset 0 0 0 1.5px ${colors.run}` : `inset 0 0 0 1px ${colors.hair}`,
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
              推荐
            </Text>
          ) : null}
        </View>
        {option.description ? (
          <Text numberOfLines={2} style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>
            {option.description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  )
}

export type QuestionPageProps = {
  visible: boolean
  /** 收起分步页（作答进度保留，再点入口行接着答）。 */
  onClose(): void
  request: PermissionRequest
  input: Record<string, unknown>
  ready: boolean
  sent: boolean
  /** 发出 ask_user_question_activity；返回是否已发出。 */
  signalActivity(): boolean
  submit(answers: Record<string, string>): boolean
  discuss(note: string): boolean
  /** AI 代答倒计时；不传就不显示。 */
  clock?: QuestionClock | null
  /** 本机已发出接手信号（配合 useQuestionClock 的 interact）。 */
  onInteract?(): void
}

/**
 * AskUserQuestion 的全高分步页：一题一屏，大行选项，底部固定“上一题 / 下一题（最后一题是提交）”，
 * 左下“先讨论一下”按现有协议拒绝并附说明。作答状态留在组件里，请让它一直挂着、只切 visible。
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
        style={[{ flex: 1, backgroundColor: colors.bg }, Platform.OS === 'web' && { paddingTop: 54 }]}
      >
        <KeyboardViewport style={{ flex: 1 }}>
          <View accessibilityViewIsModal role="dialog" aria-label="回答提问" style={{ flex: 1 }}>
            <View style={{ height: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="收起"
                accessibilityHint="稍后再答，进度保留"
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
                回答提问
                {model.position ? (
                  <Text style={{ color: colors.ink3, fontWeight: '500' }}> · {model.position}</Text>
                ) : null}
              </Text>
              <View style={{ width: 44 }} />
            </View>
            <View
              accessibilityRole="progressbar"
              accessibilityLabel="回答进度"
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
                    aria-label="选项"
                    style={{ gap: 10, paddingTop: 20 }}
                  >
                    {current.options.map((option) => (
                      <OptionRow
                        key={option.label}
                        option={option}
                        multiple={model.multiple}
                        disabled={locked}
                        selected={!model.customActive && Boolean(flow.answers[current.question]?.includes(option.label))}
                        onPress={() => choose(option.label)}
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
                          accessibilityLabel={`自己写的回答 ${model.index + 1}`}
                          autoFocus
                          multiline
                          placeholder="写下你的回答"
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
                        accessibilityLabel="其他，我自己说"
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
                        <Text style={{ fontSize: 16, color: colors.ink3 }}>其他，我自己说…</Text>
                      </Pressable>
                    )}
                  </View>
                </>
              ) : (
                <Text style={{ fontSize: 16, lineHeight: 24, color: colors.ink2 }}>
                  电脑没有提供可以回答的问题，请在电脑上处理。
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
                      accessibilityLabel="上一题"
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
                      <Text style={{ fontSize: 16, fontWeight: '600', color: colors.ink }}>上一题</Text>
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
                  accessibilityLabel="先讨论一下"
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
                  <Text style={{ fontSize: 15, color: colors.ink2 }}>先讨论一下</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </KeyboardViewport>
        <Sheet
          visible={discussOpen}
          onClose={() => setDiscussOpen(false)}
          title="先讨论一下"
          left={<TextButton title="取消" onPress={() => setDiscussOpen(false)} />}
          footer={
            <Button
              title="发送说明"
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
            说明会发给电脑上的任务，这一轮提问先不作答。
          </Text>
          <NoteInput
            accessibilityLabel="告诉它还需要澄清什么"
            placeholder="告诉它还需要澄清什么"
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
 * 入口行 + 分步页的现成组合（Approval 里直接用）。需要把入口放进输入框位置时，
 * 单独用 {@link QuestionPrompt} 和 {@link QuestionPage}，时钟用 {@link useQuestionClock}。
 */
export function QuestionDecision(props: Omit<QuestionPageProps, 'visible' | 'onClose' | 'clock' | 'onInteract'>) {
  const [open, setOpen] = useState(false)
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const bottom = Platform.OS === 'web' ? 34 : Math.max(insets.bottom, 12)
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
