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
  questionAnswerValues,
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

/** AskUserQuestion：一次一题，最后一题提交；“先讨论一下”按现有协议拒绝并附说明。 */
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
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
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
  const values = questionAnswerValues(questions, answers, custom)
  const locked = !ready || sent
  const current = questions[Math.min(index, Math.max(0, questions.length - 1))]
  const last = index >= questions.length - 1
  const currentAnswered = current ? Boolean(values[current.question]) : false
  const complete =
    questions.length > 0 && questions.every((question) => values[question.question])

  const activity = () => {
    if (signalActivity()) setInteracted(true)
  }

  const choose = (label: string) => {
    if (!current) return
    activity()
    const key = current.question
    setCustom((value) => ({ ...value, [key]: '' }))
    setCustomOpen((value) => ({ ...value, [key]: false }))
    setAnswers((value) => {
      const previous = value[key] ?? []
      return {
        ...value,
        [key]: current.multiSelect
          ? previous.includes(label)
            ? previous.filter((item) => item !== label)
            : [...previous, label]
          : [label],
      }
    })
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
                {` · ${index + 1} / ${questions.length}`}
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
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={{ maxHeight: height * 0.56, flexGrow: 0 }}
        contentContainerStyle={{ gap: 12 }}
      >
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
                    setCustom((existing) => ({ ...existing, [current.question]: value }))
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
          {last ? (
            <Button
              title="提交回答"
              size="lg"
              style={{ flex: 1.4 }}
              disabled={!ready || !complete}
              onPress={() => submit(values)}
            />
          ) : (
            <Button
              title="下一题"
              size="lg"
              style={{ flex: 1.4 }}
              disabled={!currentAnswered}
              onPress={() => {
                activity()
                setIndex((value) => Math.min(value + 1, questions.length - 1))
              }}
            />
          )}
        </View>
      )}
      {index > 0 && !sent ? (
        <QuietButton
          title="上一题"
          onPress={() => {
            activity()
            setIndex((value) => Math.max(0, value - 1))
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
