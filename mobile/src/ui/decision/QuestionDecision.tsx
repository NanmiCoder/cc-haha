import { useEffect, useState } from 'react'
import { Pressable, ScrollView, TextInput, View, useWindowDimensions } from 'react-native'
import type { PermissionRequest } from '../../core/types'
import {
  Button,
  CheckMark,
  OptionCard,
  RadioMark,
  Sheet,
  TextButton,
  useColors,
} from '../kit'
import { monoFont } from '../palette'
import { Text } from '../Text'
import {
  questionClock,
  questionOptionPresentation,
  readQuestions,
  remainingQuestionTime,
} from '../approvalData'
import {
  CountdownPill,
  DecisionHeader,
  DecisionSurface,
  NoteInput,
  QuietButton,
  SubmittedRow,
  webNoOutline,
} from './parts'

import { initialQuestionFlow, changeQuestionFlow, questionFlowValues, canSubmitQuestions } from './questionFlow'

/** AskUserQuestion：一次一题，汇总确认后提交；“先讨论一下”按现有协议拒绝并附说明。 */
export function QuestionDecision({
  request,
  input,
  ready,
  sent,
  signalActivity,
  submit,
  discuss,
}: {
  request: PermissionRequest
  input: Record<string, unknown>
  ready: boolean
  sent: boolean
  /** 发出 ask_user_question_activity；返回是否已发出。 */
  signalActivity(): boolean
  submit(answers: Record<string, string>): boolean
  discuss(note: string): boolean
}) {
  const colors = useColors()
  const { height } = useWindowDimensions()
  const questions = readQuestions(input)
  const [flow, setFlow] = useState(initialQuestionFlow)
  const { index, answers, custom, review } = flow
  const change = (action: Parameters<typeof changeQuestionFlow>[2]) =>
    setFlow((current) => changeQuestionFlow(current, questions, action))
  const [customOpen, setCustomOpen] = useState<Record<string, boolean>>({})
  const [discussOpen, setDiscussOpen] = useState(false)
  const [note, setNote] = useState('')
  const [interacted, setInteracted] = useState(false)
  const deadline = request.autoAnswerDeadline
  const [now, setNow] = useState(() => Date.now())
  const [baseline] = useState(
    () => remainingQuestionTime(deadline, Date.now())?.seconds
  )
  useEffect(() => {
    if (typeof deadline !== 'number') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [deadline])
  const clock = questionClock(deadline, now, interacted, baseline)
  const values = questionFlowValues(flow, questions)
  const locked = !ready || sent
  const current = questions[Math.min(index, Math.max(0, questions.length - 1))]
  const last = index >= questions.length - 1
  const currentAnswered = current ? Boolean(values[current.question]) : false
  const complete = canSubmitQuestions(flow, questions, ready)

  const activity = () => {
    if (signalActivity()) setInteracted(true)
  }

  const choose = (label: string) => {
    if (!current) return
    activity()
    const key = current.question
    setCustomOpen((value) => ({ ...value, [key]: false }))
    change({ type: 'choose', label })
  }

  const customText = current ? (custom[current.question] ?? '') : ''
  const customActive = Boolean(customText.trim())
  const Mark = current?.multiSelect ? CheckMark : RadioMark

  return (
    <DecisionSurface label="回答提问">
      <DecisionHeader
        titleStyle="quiet"
        title={
          <Text numberOfLines={1} style={{ fontSize: 14, lineHeight: 20, color: colors.ink2 }}>
            在问你
            {questions.length > 1 ? (
              <Text style={{ fontFamily: monoFont, fontVariant: ['tabular-nums'], color: colors.ink3 }}>
                {review ? ' · 确认回答' : ` · ${index + 1} / ${questions.length}`}
              </Text>
            ) : null}
          </Text>
        }
        right={
          clock ? (
            <CountdownPill
              state={clock.state}
              label={clock.state === 'counting' ? clock.label : undefined}
              fraction={clock.state === 'counting' ? clock.fraction : undefined}
            />
          ) : null
        }
      />
      {questions.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {questions.map((question, position) => (
            <Pressable
              key={question.question}
              accessibilityRole="tab"
              accessibilityLabel={`${question.header || String.fromCharCode(65 + position)}，${values[question.question] ? '已回答' : '未回答'}`}
              accessibilityState={{ selected: !review && index === position, disabled: sent }}
              disabled={sent}
              onPress={() => { activity(); change({ type: 'open', index: position }) }}
              style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 12, backgroundColor: !review && index === position ? colors.sel : colors.fill }}
            >
              <Text style={{ color: colors.ink, fontSize: 14 }}>
                {question.header || String.fromCharCode(65 + position)}{values[question.question] ? ' ✓' : ''}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={{ maxHeight: height * 0.56, flexGrow: 0 }}
        contentContainerStyle={{ gap: 12 }}
      >
        {review ? (
          <View style={{ gap: 10 }}>
            <Text accessibilityRole="header" style={{ fontSize: 19, fontWeight: '600', color: colors.ink }}>确认回答</Text>
            {questions.map((question, position) => (
              <Pressable key={question.question} accessibilityRole="button" accessibilityLabel={`修改回答：${question.question}`} disabled={sent}
                onPress={() => { activity(); change({ type: 'open', index: position }) }}
                style={{ padding: 14, gap: 6, borderRadius: 12, backgroundColor: colors.fill }}>
                <Text style={{ fontSize: 14, lineHeight: 20, color: colors.ink2 }}>{question.header || String.fromCharCode(65 + position)} · {question.question}</Text>
                <Text style={{ fontSize: 16, lineHeight: 23, color: colors.ink }}>{values[question.question] || '尚未回答'}</Text>
                <Text style={{ fontSize: 12, color: colors.run }}>点此修改</Text>
              </Pressable>
            ))}
          </View>
        ) : <>
        <Text
          accessibilityRole="header"
          style={{ fontSize: 19, lineHeight: 26, fontWeight: '600', color: colors.ink }}
        >
          {current?.question ?? '电脑没有提供可以回答的问题，请在电脑上处理。'}
        </Text>
        {current ? (
          <View
            role={current.multiSelect ? 'group' : 'radiogroup'}
            aria-label="选项"
            style={{ gap: 8 }}
          >
            {current.options.map((option) => {
              const display = questionOptionPresentation(option.label)
              const selected =
                !customActive &&
                Boolean(answers[current.question]?.includes(option.label))
              return (
                <OptionCard
                  key={option.label}
                  selected={selected}
                  title={display.label}
                  description={option.description}
                  badge={display.recommended ? '推荐' : undefined}
                  multiple={current.multiSelect}
                  disabled={locked}
                  onPress={() => choose(option.label)}
                />
              )
            })}
            {customOpen[current.question] ? (
              <View
                style={{
                  borderRadius: 14,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  flexDirection: 'row',
                  gap: 12,
                  backgroundColor: customActive ? colors.sel : 'transparent',
                  boxShadow: `inset 0 0 0 1.5px ${colors.run}`,
                }}
              >
                <View style={{ marginTop: 1 }}>
                  <Mark selected={customActive} />
                </View>
                <TextInput
                  accessibilityLabel={`自己写的回答 ${index + 1}`}
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
                      minHeight: 22,
                      maxHeight: 140,
                      padding: 0,
                      fontSize: 16,
                      lineHeight: 22,
                      color: colors.ink,
                    },
                    webNoOutline,
                  ]}
                />
              </View>
            ) : (
              <Pressable
                accessibilityRole={current.multiSelect ? 'checkbox' : 'radio'}
                accessibilityLabel="都不对，我自己说"
                accessibilityState={{ checked: false, disabled: locked }}
                disabled={locked}
                onPress={() => {
                  activity()
                  setCustomOpen((value) => ({ ...value, [current.question]: true }))
                }}
                style={({ pressed }) => ({
                  minHeight: 48,
                  borderRadius: 14,
                  paddingHorizontal: 14,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  boxShadow: `inset 0 0 0 1px ${colors.hair}`,
                  opacity: locked ? 0.45 : pressed ? 0.75 : 1,
                })}
              >
                <Mark selected={false} />
                <Text style={{ fontSize: 16, color: colors.ink3 }}>都不对，我自己说…</Text>
              </Pressable>
            )}
          </View>
        ) : null}
        </>}
      </ScrollView>
      {sent ? (
        <SubmittedRow />
      ) : (
        <View style={{ flexDirection: 'row', gap: 8, paddingTop: 2 }}>
          <Button
            title="先讨论一下"
            variant="secondary"
            size="lg"
            style={{ flex: 1 }}
            disabled={!ready}
            onPress={() => {
              activity()
              setDiscussOpen(true)
            }}
          />
          {review ? (
            <Button
              title="提交回答"
              size="lg"
              style={{ flex: 1.4 }}
              disabled={!ready || !complete}
              onPress={() => { if (canSubmitQuestions(flow, questions, ready)) submit(values) }}
            />
          ) : (
            <Button
              title={last ? '确认全部回答' : '下一题'}
              size="lg"
              style={{ flex: 1.4 }}
              disabled={!currentAnswered || (last && !complete)}
              onPress={() => {
                activity()
                change(last ? { type: 'review' } : { type: 'open', index: index + 1 })
              }}
            />
          )}
        </View>
      )}
      {(index > 0 || review) && !sent ? (
        <QuietButton
          title="上一题"
          onPress={() => {
            activity()
            change({ type: 'open', index: review ? questions.length - 1 : Math.max(0, index - 1) })
          }}
        />
      ) : null}
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
              if (discuss(note)) setDiscussOpen(false)
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
    </DecisionSurface>
  )
}
