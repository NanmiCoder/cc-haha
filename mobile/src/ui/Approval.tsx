import { useEffect, useState } from 'react'
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native'
import { Text } from './Text'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { LinearGradient } from 'expo-linear-gradient'
import type { ApiClient } from '../core/client'
import type {
  ChatState,
  ClientMessage,
  PermissionRequest,
  RuntimeConfig,
} from '../core/types'
import {
  CircleButton,
  Field,
  Icon,
  Inset,
  Notice,
  PageHeader,
  Raised,
  Toggle,
  mono,
  useTheme,
} from './theme'
import { Markdown } from './Message'
import { RuntimePicker } from './RuntimePicker'
import {
  planPermissionUpdates,
  questionAnswerInput,
  questionOptionPresentation,
  readQuestions,
  remainingQuestionTime,
  type PlanExecutionMode,
} from './approvalData'

/** Approval buttons have deliberately different heights from the general app CTA. */
function DecisionButton({
  title,
  onPress,
  secondary,
  disabled,
  height = 54,
}: {
  title: string
  onPress(): void
  secondary?: boolean
  disabled?: boolean
  height?: number
}) {
  const { colors: c, dark } = useTheme()
  const radius = height === 52 ? 16 : 17
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        borderRadius: radius,
        opacity: disabled ? 0.45 : 1,
        transform: [{ translateY: pressed ? 2 : 0 }],
        boxShadow: secondary
          ? `0 ${pressed ? 1 : 3}px 0 ${dark ? '#10100E' : '#C8C5BE'}, 0 8px 14px rgba(60,45,30,.12)`
          : `0 ${pressed ? 1 : 3}px 0 #7E3824, 0 8px 14px rgba(126,56,36,.25)`,
      })}
    >
      <LinearGradient
        colors={
          secondary
            ? dark
              ? ['#38352F', '#292724']
              : ['#F7F6F3', '#E9E8E4']
            : ['#C1603F', '#A64D33']
        }
        style={{
          minHeight: height,
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: radius,
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: `inset 0 1px 0 ${secondary ? c.highlight : 'rgba(255,255,255,.28)'}`,
        }}
      >
        <Text
          style={{
            fontSize: 15,
            lineHeight: 21,
            fontWeight: '600',
            color: secondary ? c.ink : '#FFFFFF',
          }}
        >
          {title}
        </Text>
      </LinearGradient>
    </Pressable>
  )
}

const requestInput = (request: PermissionRequest) =>
  (request.input && typeof request.input === 'object'
    ? request.input
    : {}) as Record<string, unknown>
export function PlanPreview({ request }: { request: PermissionRequest }) {
  const { colors: c, styles: s, dark } = useTheme()
  const input = requestInput(request)
  return (
    <Raised
      style={{
        padding: 18,
        gap: 14,
        borderRadius: 20,
        backgroundColor: dark ? c.surface : '#FBFAF8',
      }}
    >
      <Text
        style={{
          fontFamily: mono,
          fontSize: 11,
          color: dark ? c.amber : '#8A5A17',
        }}
      >
        计划 · 等你批准
      </Text>
      <Markdown
        text={String(
          input.plan ??
            input.planContent ??
            '电脑未提供计划正文，请在电脑上核对后再批准。'
        )}
      />
      {input.planFilePath || input.filePath ? (
        <Text selectable style={[s.small, { fontFamily: mono, fontSize: 10 }]}>
          {String(input.planFilePath ?? input.filePath)}
        </Text>
      ) : null}
    </Raised>
  )
}

export function Approval({
  request,
  send,
  ready,
  serverError,
  client,
  runtime,
}: {
  request: PermissionRequest
  send(message: ClientMessage): boolean
  ready: boolean
  serverError?: ChatState['error']
  client?: ApiClient | null
  runtime?: RuntimeConfig
}) {
  const { colors: c, styles: s, dark } = useTheme()
  const insets = useSafeAreaInsets()
  const { height } = useWindowDimensions()
  const input = requestInput(request)
  const questions = readQuestions(input)
  const isQuestion = request.toolName === 'AskUserQuestion'
  const isPlan = request.toolName === 'ExitPlanMode'
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [feedback, setFeedback] = useState('')
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [questionActionsOpen, setQuestionActionsOpen] = useState(false)
  const [allowSession, setAllowSession] = useState(false)
  const [mode, setMode] = useState<PlanExecutionMode>('acceptEdits')
  const [executionRuntime, setExecutionRuntime] = useState<
    RuntimeConfig | undefined
  >()
  const [runtimeOpen, setRuntimeOpen] = useState(false)
  const [submission, setSubmission] = useState({
    ready,
    serverError,
    sent: false,
  })
  const sent =
    submission.ready === ready &&
    submission.serverError === serverError &&
    submission.sent
  if (submission.ready !== ready || submission.serverError !== serverError)
    setSubmission({ ready, serverError, sent: false })
  const [interacted, setInteracted] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const countdown = remainingQuestionTime(request.autoAnswerDeadline, now)
  const answerValues = Object.fromEntries(
    questions.map((question) => [
      question.question,
      custom[question.question]?.trim() ||
        answers[question.question]?.join(', ') ||
        '',
    ])
  )
  const activity = () => {
    if (
      send({ type: 'ask_user_question_activity', requestId: request.requestId })
    )
      setInteracted(true)
  }
  function respond(allowed: boolean) {
    const accepted = send({
      type: 'permission_response',
      requestId: request.requestId,
      allowed,
      ...(isQuestion && allowed
        ? { updatedInput: questionAnswerInput(input, answerValues) }
        : {}),
      ...(isPlan && allowed
        ? {
            permissionUpdates: planPermissionUpdates(mode, input),
            ...(executionRuntime ? { runtimeOverride: executionRuntime } : {}),
          }
        : {}),
      ...(!isQuestion && !isPlan && allowSession && allowed
        ? { rule: 'always' as const }
        : {}),
      ...(!allowed && feedback.trim() ? { denyMessage: feedback.trim() } : {}),
    })
    if (accepted) setSubmission({ ready, serverError, sent: true })
    return accepted
  }
  const command =
    typeof input.command === 'string'
      ? input.command
      : typeof input.file_path === 'string'
        ? input.file_path
        : JSON.stringify(input, null, 2)
  const execution = executionRuntime ?? runtime
  const effort = execution?.effortLevel
    ? ({ low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' }[
        execution.effortLevel
      ] ?? execution.effortLevel)
    : null
  const questionHint = countdown
    ? countdown.seconds
      ? '开始选择或输入后，自动代答会暂停。'
      : '自动代答已到时，你仍可以手动回答。'
    : request.autoAnswerDeadline === null && interacted
      ? '你已接手，自动代答已暂停。'
      : '回答将同步到正在等待的电脑。'
  return (
    <View
      accessibilityLabel={
        isQuestion ? '回答提问' : isPlan ? '批准计划' : '审批'
      }
      style={{
        backgroundColor: c.surface,
        borderTopLeftRadius: 26,
        borderTopRightRadius: 26,
        paddingHorizontal: 18,
        paddingTop: isQuestion ? 10 : isPlan ? 18 : 16,
        paddingBottom: Math.max(insets.bottom, 18),
        gap: isQuestion || isPlan ? 14 : 12,
        boxShadow: `inset 0 1px 0 ${c.highlight}, 0 -10px 30px rgba(60,45,30,.14)`,
      }}
    >
      {isQuestion && (
        <View
          style={{
            width: 36,
            height: 4,
            borderRadius: 2,
            backgroundColor: c.line,
            alignSelf: 'center',
            boxShadow: 'inset 0 1px 1px rgba(40,30,20,.2)',
          }}
        />
      )}
      {isPlan ? (
        <Text style={s.small}>批准后怎么执行</Text>
      ) : (
        <View style={[s.between, { gap: 8 }]}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              flex: 1,
            }}
          >
            <LinearGradient
              colors={['#FFD9A0', '#E39A3B', '#A86A1C']}
              style={{ width: 9, height: 9, borderRadius: 5 }}
            />
            <Text
              style={{
                fontSize: 13,
                lineHeight: 18,
                fontWeight: '600',
                color: dark ? '#E9B675' : '#8A5A17',
              }}
            >
              {isQuestion ? '在问你' : '需要你批准'}
            </Text>
          </View>
          {isQuestion ? (
            <>
              {countdown && (
                <View
                  accessibilityLabel={`AI 代答 ${countdown.label}`}
                  style={{
                    backgroundColor: c.well,
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                    borderRadius: 6,
                    boxShadow: 'inset 0 1px 2px rgba(0,0,0,.5)',
                  }}
                >
                  <Text
                    style={{
                      fontFamily: mono,
                      fontSize: 11,
                      lineHeight: 15,
                      color: '#D8D4CA',
                    }}
                  >
                    AI 代答{' '}
                    <Text style={{ color: '#F2C38A' }}>
                      {countdown.label.padStart(5, '0')}
                    </Text>
                  </Text>
                </View>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="更多提问操作"
                disabled={!ready || sent}
                hitSlop={10}
                onPress={() => {
                  activity()
                  setQuestionActionsOpen(true)
                }}
                style={{
                  width: 24,
                  height: 24,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: !ready || sent ? 0.4 : 1,
                }}
              >
                <Icon name="more-horizontal" size={18} color={c.muted} />
              </Pressable>
            </>
          ) : (
            <Inset
              style={{
                paddingHorizontal: 8,
                paddingVertical: 3,
                borderRadius: 6,
              }}
            >
              <Text
                style={{
                  fontFamily: mono,
                  fontSize: 11,
                  lineHeight: 16,
                  color: c.secondary,
                }}
              >
                {request.toolName}
              </Text>
            </Inset>
          )}
        </View>
      )}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={{ maxHeight: height * (isQuestion ? 0.53 : 0.31) }}
        contentContainerStyle={{
          gap: isQuestion || isPlan ? 14 : 12,
          paddingBottom: 2,
        }}
      >
        {isQuestion ? (
          questions.map((question, index) => (
            <View key={question.question} style={{ gap: 14 }}>
              <Text
                style={{
                  color: c.ink,
                  fontSize: 18,
                  lineHeight: 25,
                  fontWeight: '600',
                }}
              >
                {question.question}
                {questions.length > 1
                  ? ` (${index + 1}/${questions.length})`
                  : ''}
              </Text>
              <View style={{ gap: 8 }}>
                {question.options.map((option) => {
                  const selected =
                    !custom[question.question]?.trim() &&
                    answers[question.question]?.includes(option.label)
                  const display = questionOptionPresentation(option.label)
                  return (
                    <Pressable
                      key={option.label}
                      accessibilityLabel={option.label}
                      accessibilityRole={
                        question.multiSelect ? 'checkbox' : 'radio'
                      }
                      accessibilityState={{
                        checked: !!selected,
                        disabled: sent || !ready,
                      }}
                      disabled={sent || !ready}
                      onPress={() => {
                        activity()
                        setCustom((value) => ({
                          ...value,
                          [question.question]: '',
                        }))
                        setAnswers((value) => {
                          const previous = value[question.question] ?? []
                          return {
                            ...value,
                            [question.question]: question.multiSelect
                              ? previous.includes(option.label)
                                ? previous.filter(
                                    (item) => item !== option.label
                                  )
                                : [...previous, option.label]
                              : [option.label],
                          }
                        })
                      }}
                    >
                      <View
                        style={{
                          paddingVertical: 13,
                          paddingHorizontal: 14,
                          borderRadius: 16,
                          backgroundColor: selected
                            ? dark
                              ? c.inset
                              : '#E4E2DC'
                            : dark
                              ? c.surface
                              : '#FBFAF8',
                          flexDirection: 'row',
                          gap: 12,
                          alignItems: 'flex-start',
                          boxShadow: selected
                            ? `inset 0 1px 3px rgba(40,30,20,.18), 0 1px 0 ${c.highlight}`
                            : `inset 0 1px 0 ${c.highlight}, 0 1px 2px rgba(60,45,30,.12), 0 4px 10px rgba(60,45,30,.06)`,
                        }}
                      >
                        <View
                          style={{
                            width: 20,
                            height: 20,
                            marginTop: 1,
                            borderRadius: question.multiSelect ? 5 : 10,
                            backgroundColor: selected ? c.line : c.inset,
                            alignItems: 'center',
                            justifyContent: 'center',
                            boxShadow: 'inset 0 1px 2px rgba(40,30,20,.25)',
                          }}
                        >
                          {selected &&
                            (question.multiSelect ? (
                              <Icon name="check" size={13} color={c.accent} />
                            ) : (
                              <LinearGradient
                                colors={['#E58A68', '#B4553A', '#8F3F2A']}
                                style={{
                                  width: 10,
                                  height: 10,
                                  borderRadius: 5,
                                }}
                              />
                            ))}
                        </View>
                        <View style={{ flex: 1, gap: 3 }}>
                          <View
                            style={{
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: 8,
                              flexWrap: 'wrap',
                            }}
                          >
                            <Text
                              style={{
                                fontSize: 15,
                                lineHeight: 21,
                                fontWeight: '600',
                                color: c.ink,
                              }}
                            >
                              {display.label}
                            </Text>
                            {display.recommended && (
                              <Text
                                style={{
                                  fontSize: 11,
                                  lineHeight: 15,
                                  color: dark ? '#E5A78C' : '#9C4630',
                                  paddingVertical: 1,
                                  paddingHorizontal: 6,
                                  borderRadius: 5,
                                  borderWidth: 1,
                                  borderColor: dark ? '#785344' : '#E2B7A6',
                                }}
                              >
                                推荐
                              </Text>
                            )}
                          </View>
                          {option.description && (
                            <Text
                              style={{
                                fontSize: 12,
                                lineHeight: 18,
                                color: c.muted,
                              }}
                            >
                              {option.description}
                            </Text>
                          )}
                        </View>
                      </View>
                    </Pressable>
                  )
                })}
              </View>
              <View style={{ gap: 6 }}>
                <Text style={s.small}>都不合适？直接告诉它</Text>
                <TextInput
                  accessibilityLabel={`自定义回答 ${index + 1}`}
                  placeholder="写下你的想法…"
                  placeholderTextColor={c.muted}
                  value={custom[question.question] ?? ''}
                  onFocus={activity}
                  onChangeText={(value) => {
                    activity()
                    setCustom((current) => ({
                      ...current,
                      [question.question]: value,
                    }))
                  }}
                  editable={!sent && ready}
                  style={[
                    s.input,
                    {
                      height: 46,
                      minHeight: 46,
                      borderRadius: 14,
                      paddingVertical: 0,
                    },
                  ]}
                />
              </View>
            </View>
          ))
        ) : isPlan ? (
          <>
            <Inset style={{ padding: 4, borderRadius: 16 }}>
              <View
                accessibilityRole="radiogroup"
                accessibilityLabel="执行权限"
                style={{ flexDirection: 'row', gap: 4 }}
              >
                {(
                  [
                    { label: '逐项确认', value: 'default' },
                    { label: '自动改文件', value: 'acceptEdits' },
                    { label: '全部放行', value: 'bypassPermissions' },
                  ] as const
                ).map((option) => (
                  <Pressable
                    key={option.value}
                    accessibilityRole="radio"
                    accessibilityLabel={option.label}
                    accessibilityState={{
                      checked: mode === option.value,
                      disabled: sent || !ready,
                    }}
                    disabled={sent || !ready}
                    onPress={() => setMode(option.value)}
                    style={{
                      flex: 1,
                      minHeight: 42,
                      borderRadius: 12,
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexDirection: 'row',
                      gap: 6,
                      backgroundColor:
                        mode === option.value ? c.surface : 'transparent',
                      boxShadow:
                        mode === option.value
                          ? `inset 0 1px 0 ${c.highlight}, 0 1px 2px rgba(60,45,30,.2), 0 3px 6px rgba(60,45,30,.1)`
                          : undefined,
                    }}
                  >
                    {mode === option.value && (
                      <View
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 3,
                          backgroundColor: c.accent,
                        }}
                      />
                    )}
                    <Text
                      style={{
                        fontSize: 13,
                        lineHeight: 18,
                        color: c.secondary,
                        fontWeight: mode === option.value ? '600' : '400',
                      }}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </Inset>
            {mode === 'bypassPermissions' && (
              <Text style={s.small}>
                执行时跳过工具审批，仅用于你信任的工作区。
              </Text>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="选择计划执行模型"
              disabled={sent || !ready || !client}
              onPress={() => setRuntimeOpen(true)}
              style={{
                minHeight: 46,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                borderRadius: 14,
                paddingLeft: 14,
                paddingRight: 12,
                backgroundColor: c.well,
                boxShadow: `inset 0 1px 3px rgba(0,0,0,.5), 0 1px 0 ${c.highlight}`,
              }}
            >
              <Text
                style={{ color: '#8D897F', fontSize: 12, fontFamily: mono }}
              >
                执行模型
              </Text>
              <Text
                style={{
                  flex: 1,
                  color: '#ECE8DE',
                  fontFamily: mono,
                  fontSize: 12,
                }}
                numberOfLines={1}
              >
                {execution?.modelId ?? '沿用当前模型'}
                {effort ? ` · 思考 ${effort}` : ''}
              </Text>
              <Icon name="chevron-down" size={14} color="#8D897F" />
            </Pressable>
          </>
        ) : (
          <>
            {request.description && (
              <Text style={s.small}>{request.description}</Text>
            )}
            <ScrollView
              horizontal
              style={{
                backgroundColor: dark ? c.well : '#1E1D1A',
                borderRadius: 12,
                boxShadow: 'inset 0 2px 6px rgba(0,0,0,.55)',
              }}
              contentContainerStyle={{
                paddingHorizontal: 14,
                paddingVertical: 13,
              }}
            >
              <Text
                selectable
                style={{
                  color: '#ECE8DE',
                  fontFamily: mono,
                  fontSize: 12,
                  lineHeight: 19,
                }}
              >
                {request.toolName === 'Bash' && (
                  <Text style={{ color: '#A9C27A' }}>$ </Text>
                )}
                {command}
              </Text>
            </ScrollView>
            <View style={[s.between, { padding: 2 }]}>
              <Text
                style={{ fontSize: 13, lineHeight: 18, color: c.secondary }}
              >
                本会话内都允许
              </Text>
              <Toggle
                label="本会话内都允许"
                value={allowSession}
                onChange={setAllowSession}
                disabled={sent || !ready}
              />
            </View>
          </>
        )}
        {feedbackOpen && isPlan && (
          <Field
            label="需要调整的地方"
            value={feedback}
            onChangeText={setFeedback}
            placeholder="把修改意见告诉 Agent"
            multiline
          />
        )}
      </ScrollView>
      {sent ? (
        <Notice text="已提交，正在等待电脑确认。" />
      ) : isQuestion ? (
        <DecisionButton
          title="提交回答"
          disabled={
            !ready ||
            !questions.length ||
            Object.values(answerValues).some((value) => !value)
          }
          onPress={() => respond(true)}
        />
      ) : (
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <DecisionButton
              title={isPlan ? (feedbackOpen ? '继续规划' : '提意见') : '拒绝'}
              height={isPlan ? 54 : 52}
              secondary
              disabled={!ready}
              onPress={() => {
                if (isPlan && !feedbackOpen) setFeedbackOpen(true)
                else respond(false)
              }}
            />
          </View>
          <View style={{ flex: isPlan ? 1.6 : 1 }}>
            <DecisionButton
              title={isPlan ? '批准执行' : '允许'}
              height={isPlan ? 54 : 52}
              disabled={!ready}
              onPress={() => respond(true)}
            />
          </View>
        </View>
      )}
      <Modal
        visible={questionActionsOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setQuestionActionsOpen(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{
            flex: 1,
            justifyContent: 'flex-end',
            backgroundColor: '#0005',
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭提问操作"
            onPress={() => setQuestionActionsOpen(false)}
            style={{ flex: 1 }}
          />
          <ScrollView
            keyboardShouldPersistTaps="handled"
            style={{
              flexGrow: 0,
              maxHeight: height * 0.8,
              backgroundColor: c.surface,
              borderTopLeftRadius: 26,
              borderTopRightRadius: 26,
            }}
            contentContainerStyle={{
              paddingHorizontal: 18,
              paddingTop: 18,
              paddingBottom: Math.max(insets.bottom, 18),
              gap: 16,
            }}
          >
            <View style={s.between}>
              <Text style={{ color: c.ink, fontSize: 18, fontWeight: '600' }}>
                先讨论一下
              </Text>
              <CircleButton
                name="x"
                label="关闭更多提问操作"
                onPress={() => setQuestionActionsOpen(false)}
              />
            </View>
            <Text style={s.small}>{questionHint}</Text>
            <Field
              label="补充说明"
              value={feedback}
              onChangeText={setFeedback}
              placeholder="告诉它还需要澄清什么"
              multiline
            />
            <DecisionButton
              title="发送说明，继续讨论"
              disabled={!ready || sent || !feedback.trim()}
              onPress={() => {
                if (respond(false)) setQuestionActionsOpen(false)
              }}
            />
            <DecisionButton
              title="返回选择答案"
              secondary
              onPress={() => setQuestionActionsOpen(false)}
            />
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
      <Modal
        visible={runtimeOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setRuntimeOpen(false)}
      >
        <SafeAreaView style={s.page}>
          <PageHeader
            title="计划执行模型"
            subtitle="批准计划时一并生效"
            back={false}
            right={
              <CircleButton
                name="x"
                label="关闭模型选择"
                onPress={() => setRuntimeOpen(false)}
              />
            }
          />
          <ScrollView contentContainerStyle={s.body}>
            {client && (
              <RuntimePicker
                client={client}
                initial={executionRuntime ?? runtime}
                onApply={(value) => {
                  setExecutionRuntime(value)
                  setRuntimeOpen(false)
                }}
              />
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </View>
  )
}
