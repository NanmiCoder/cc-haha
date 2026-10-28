import { useState } from 'react'
import { Pressable, View } from 'react-native'
import type { ApiClient } from '../core/client'
import type { RuntimeConfig } from '../core/types'
import { currentModelEfforts, effortUnavailableReason } from '../core/runtimeCatalog'
import { useRuntimeChoice } from './RuntimePicker'
import { Callout, InlineError, Loading, Sheet, TextButton, useColors } from './kit'
import { ChoiceRow } from './newtask/ChoiceRow'
import { Text } from './Text'
import { effortName } from './modes'

/** Shared composer control: changing effort never changes provider or model. */
export function EffortControl({ client, runtime, onApply, disabled, defaultScope = false, warning }: {
  client: ApiClient | null
  runtime?: RuntimeConfig
  onApply(value: RuntimeConfig): void
  disabled?: boolean
  defaultScope?: boolean
  warning?: string
}) {
  const colors = useColors()
  const [open, setOpen] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const choice = useRuntimeChoice({ client, initial: runtime, defaultScope, active: open, epoch })
  const current =
    runtime && (choice.catalogReady || choice.error) ? currentModelEfforts(choice.models, runtime.modelId) : undefined
  const options = choice.canSetEffort ? (current?.efforts ?? []) : []
  const unavailable = disabled || !client || !runtime
  const waiting = choice.loading || (!choice.catalogReady && !choice.error && choice.source?.auth === 'ready')
  const reason = effortUnavailableReason(choice)

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`思考强度：${effortName(runtime?.effortLevel)}`}
        accessibilityState={{ disabled: Boolean(unavailable), expanded: open }}
        disabled={unavailable}
        onPress={() => { setEpoch((value) => value + 1); setOpen(true) }}
        style={({ pressed }) => ({
          minHeight: 36, paddingHorizontal: 10, borderRadius: 12,
          alignItems: 'center', justifyContent: 'center', backgroundColor: colors.fill,
          opacity: unavailable ? 0.45 : pressed ? 0.6 : 1,
        })}
      >
        <Text numberOfLines={1} style={{ fontSize: 13, color: colors.ink2 }}>
          思考 · {effortName(runtime?.effortLevel)}
        </Text>
      </Pressable>
      <Sheet visible={open} onClose={() => setOpen(false)} title="思考强度">
        <InlineError text={choice.error} />
        {waiting ? <Loading /> : options.length && choice.source?.auth === 'ready' ? (
          <View>
            {options.map((value) => (
              <ChoiceRow
                key={value}
                title={effortName(value)}
                selected={value === (runtime?.effortLevel ?? current?.defaultEffort)}
                disabled={disabled}
                onPress={() => {
                  if (!runtime || choice.source?.auth !== 'ready') return
                  // 只换强度，模型 id 原样带回。
                  onApply({ ...runtime, effortLevel: value })
                  setOpen(false)
                }}
              />
            ))}
          </View>
        ) : (
          <Callout>{reason}</Callout>
        )}
        {warning ? <Callout>{warning}</Callout> : null}
        <TextButton title="重新读取" disabled={waiting || disabled} onPress={choice.reload} />
      </Sheet>
    </>
  )
}
