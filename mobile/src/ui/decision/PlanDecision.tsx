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

const NOT_SENT = 'Action not sent yet. Wait for the session to finish syncing, or check the current task state.'

/** ExitPlanMode: a compact card at the bottom + a full-screen plan page that pops up on mount. */
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
  // RuntimeSheet Use the display name when passing back the chosen model; when keeping the current model there is only modelId.
  const [executionModelName, setExecutionModelName] = useState<string>()
  const [runtimeOpen, setRuntimeOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [notSent, setNotSent] = useState(false)
  // Errors existing before opening belong to other actions; the plan page only shows errors that appear afterwards.
  const [initialError] = useState(serverError)
  const text = planSource(input)
  const path = planFilePath(input)
  const locked = !ready || sent
  const execution = executionRuntime ?? runtime
  const executionLabel = execution
    ? (executionRuntime && executionModelName) || execution.modelId
    : 'Keep current model'
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
    <DecisionSurface label="Approve plan">
      <DecisionHeader title="Plan is ready, waiting for your confirmation" position={position} />
      <Text numberOfLines={2} style={{ fontSize: 14, lineHeight: 21, color: colors.ink2 }}>
        {text ? planExcerpt(text) : MISSING_PLAN_TEXT}
      </Text>
      {sent ? (
        <SubmittedRow />
      ) : (
        <Button title="See full plan" size="lg" onPress={() => setSheetOpen(true)} />
      )}
      <PageSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="plan"
        background={colors.card}
        left={<TextButton title="Later" onPress={() => setSheetOpen(false)} />}
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
              How to run after approval
            </Text>
            <Segmented<PlanExecutionMode>
              label="Execution permission"
              options={planExecutionModes.map((option) => ({
                label: option.title,
                value: option.id as PlanExecutionMode,
              }))}
              value={mode}
              onChange={setMode}
              disabled={locked}
            />
            {mode === 'bypassPermissions' ? (
              <Callout>Skips all tool approvals during execution; use only in projects you trust.</Callout>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Execution model: ${executionLabel}, tap to change`}
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
              <Text style={{ flex: 1, fontSize: 15, color: colors.ink2 }}>Execution model</Text>
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
                <Text style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>What needs adjusting</Text>
                <NoteInput
                  accessibilityLabel="What needs adjusting"
                  placeholder="Tell it your feedback"
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
                  title={feedbackOpen ? 'Keep planning' : 'Give feedback'}
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
                  title="Approve and run"
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
          title="Execution model"
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
