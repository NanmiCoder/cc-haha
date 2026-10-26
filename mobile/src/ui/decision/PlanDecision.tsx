import { KeyboardViewport } from '../KeyboardViewport'
import { useState } from 'react'
import {
  Pressable,
  ScrollView,
  View,
} from 'react-native'
import type { ApiClient } from '../../core/client'
import type { ChatState, RuntimeConfig } from '../../core/types'
import {
  Button,
  Callout,
  Icon,
  InlineError,
  Mono,
  PageSheet,
  Segmented,
  TextButton,
  useColors,
} from '../kit'
import { planExecutionModes } from '../modes'
import { RuntimeSheet } from '../RuntimePicker'
import { EffortControl } from '../EffortControl'
import { Text } from '../Text'
import type { PlanExecutionMode } from '../approvalData'
import {
  DecisionHeader,
  DecisionSurface,
  NoteInput,
  SubmittedRow,
  useBottomInset,
} from './parts'
import { PlanDocument } from './PlanDocument'
import {
  MISSING_PLAN_TEXT,
  planExcerpt,
  planFilePath,
  planSource,
} from './planText'

const NOT_SENT = '操作尚未发出。请等待会话同步完成，或核对当前任务状态。'

/** ExitPlanMode：底部紧凑卡 + 挂载即弹出的全屏计划页。 */
export function PlanDecision({
  input,
  ready,
  sent,
  serverError,
  client,
  runtime,
  position,
  approve,
  revise,
}: {
  input: Record<string, unknown>
  ready: boolean
  sent: boolean
  serverError?: ChatState['error']
  client?: ApiClient | null
  runtime?: RuntimeConfig
  position?: { index: number; total: number }
  approve(plan: { mode: PlanExecutionMode; runtime?: RuntimeConfig }): boolean
  revise(feedback: string): boolean
}) {
  const colors = useColors()
  const bottom = useBottomInset()
  const [sheetOpen, setSheetOpen] = useState(true)
  const [mode, setMode] = useState<PlanExecutionMode>('acceptEdits')
  const [executionRuntime, setExecutionRuntime] = useState<RuntimeConfig>()
  // RuntimeSheet 回传所选模型时用它的显示名；沿用当前模型时只有 modelId。
  const [executionModelName, setExecutionModelName] = useState<string>()
  const [runtimeOpen, setRuntimeOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [notSent, setNotSent] = useState(false)
  // 打开前就存在的错误属于别的操作，计划页里只显示之后出现的错误。
  const [initialError] = useState(serverError)
  const text = planSource(input)
  const path = planFilePath(input)
  const locked = !ready || sent
  const execution = executionRuntime ?? runtime
  const executionLabel = execution
    ? (executionRuntime && executionModelName) || execution.modelId
    : '沿用当前模型'
  const sheetError = notSent
    ? NOT_SENT
    : serverError && serverError !== initialError
      ? serverError.message
      : undefined

  const attempt = (accepted: boolean) => {
    setNotSent(!accepted)
    return accepted
  }

  return (
    <DecisionSurface label="批准计划">
      <DecisionHeader title="计划写好了，等你确认" position={position} />
      <Text numberOfLines={2} style={{ fontSize: 14, lineHeight: 21, color: colors.ink2 }}>
        {text ? planExcerpt(text) : MISSING_PLAN_TEXT}
      </Text>
      {sent ? (
        <SubmittedRow />
      ) : (
        <Button title="看完整计划" size="lg" onPress={() => setSheetOpen(true)} />
      )}
      <PageSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="计划"
        background={colors.card}
        left={<TextButton title="稍后" onPress={() => setSheetOpen(false)} />}
      >
        <KeyboardViewport style={{ flex: 1 }}>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingTop: 4, paddingHorizontal: 22, paddingBottom: 24, gap: 12 }}
          >
            {text ? (
              <PlanDocument text={text} />
            ) : (
              <Text style={{ fontSize: 16, lineHeight: 25, color: colors.ink2 }}>
                {MISSING_PLAN_TEXT}
              </Text>
            )}
            {path ? (
              <Mono selectable style={{ fontSize: 12, lineHeight: 17, color: colors.ink3, paddingTop: 4 }}>
                {path}
              </Mono>
            ) : null}
          </ScrollView>
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: colors.hair,
              paddingTop: 14,
              paddingHorizontal: 16,
              paddingBottom: bottom,
              gap: 12,
              backgroundColor: colors.card,
            }}
          >
            <Text style={{ fontSize: 13, lineHeight: 18, fontWeight: '600', color: colors.ink3 }}>
              批准后怎么执行
            </Text>
            <Segmented<PlanExecutionMode>
              label="执行权限"
              options={planExecutionModes.map((option) => ({
                label: option.title,
                value: option.id as PlanExecutionMode,
              }))}
              value={mode}
              onChange={setMode}
              disabled={locked}
            />
            {mode === 'bypassPermissions' ? (
              <Callout>执行时跳过所有工具审批，只在你信任的项目里用。</Callout>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`执行模型：${executionLabel}，点按更换`}
              accessibilityState={{ disabled: locked || !client }}
              disabled={locked || !client}
              onPress={() => setRuntimeOpen(true)}
              style={({ pressed }) => ({
                height: 44,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                opacity: locked || !client ? 0.45 : pressed ? 0.6 : 1,
              })}
            >
              <Text style={{ flex: 1, fontSize: 15, color: colors.ink2 }}>执行模型</Text>
              <Text numberOfLines={1} style={{ flexShrink: 1, maxWidth: '70%', fontSize: 15, color: colors.ink }}>
                {executionLabel}
              </Text>
              <Icon name="chevron-right" size={15} color={colors.chevron} strokeWidth={2.2} />
            </Pressable>
            <View style={{ alignItems: 'flex-start' }}>
              <EffortControl client={client ?? null} runtime={execution} disabled={locked} onApply={setExecutionRuntime} />
            </View>
            {feedbackOpen ? (
              <View style={{ gap: 6 }}>
                <Text style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>需要调整的地方</Text>
                <NoteInput
                  accessibilityLabel="需要调整的地方"
                  placeholder="把修改意见告诉它"
                  autoFocus
                  minHeight={80}
                  value={feedback}
                  onChangeText={setFeedback}
                  editable={!sent}
                />
              </View>
            ) : null}
            <InlineError text={sheetError} />
            {sent ? (
              <SubmittedRow />
            ) : (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button
                  title={feedbackOpen ? '继续规划' : '提意见'}
                  variant="secondary"
                  size="lg"
                  style={{ flex: 1 }}
                  disabled={!ready}
                  onPress={() => {
                    if (!feedbackOpen) setFeedbackOpen(true)
                    else attempt(revise(feedback))
                  }}
                />
                <Button
                  title="批准并执行"
                  size="lg"
                  style={{ flex: 1.4 }}
                  disabled={!ready}
                  onPress={() =>
                    attempt(
                      approve({
                        mode,
                        ...(executionRuntime ? { runtime: executionRuntime } : {}),
                      })
                    )
                  }
                />
              </View>
            )}
          </View>
        </KeyboardViewport>
        <RuntimeSheet
          visible={runtimeOpen}
          onClose={() => setRuntimeOpen(false)}
          title="执行模型"
          client={client}
          initial={execution}
          onApply={(value, model) => {
            setExecutionRuntime(value)
            setExecutionModelName(model?.id === value.modelId ? model.name : undefined)
            setRuntimeOpen(false)
          }}
        />
      </PageSheet>
    </DecisionSurface>
  )
}
