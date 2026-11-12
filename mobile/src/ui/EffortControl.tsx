import { useState, type ReactNode } from 'react'
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
export function EffortControl({ client, runtime, onApply, disabled, defaultScope = false, warning, trigger }: {
  client: ApiClient | null
  runtime?: RuntimeConfig
  onApply(value: RuntimeConfig): void
  disabled?: boolean
  defaultScope?: boolean
  warning?: string
  /** Replace the default "Thinking · High" capsule, e.g. as a row in a settings list; the picker sheet stays the same. */
  trigger?(control: { open(): void; disabled: boolean; label: string }): ReactNode
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

  const show = () => { setEpoch((value) => value + 1); setOpen(true) }
  return (
    <>
      {trigger ? trigger({ open: show, disabled: Boolean(unavailable), label: effortName(runtime?.effortLevel) }) : <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Thinking effort: ${effortName(runtime?.effortLevel)}`}
        accessibilityState={{ disabled: Boolean(unavailable), expanded: open }}
        disabled={unavailable}
        onPress={show}
        style={({ pressed }) => ({
          minHeight: 36, paddingHorizontal: 10, borderRadius: 12,
          alignItems: 'center', justifyContent: 'center', backgroundColor: colors.fill,
          opacity: unavailable ? 0.45 : pressed ? 0.6 : 1,
        })}
      >
        <Text numberOfLines={1} style={{ fontSize: 13, color: colors.ink2 }}>
          Thinking · {effortName(runtime?.effortLevel)}
        </Text>
      </Pressable>}
      <Sheet visible={open} onClose={() => setOpen(false)} title="Thinking effort">
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
                  // Change only the effort; the model id is passed back unchanged.
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
        <TextButton title="Reload" disabled={waiting || disabled} onPress={choice.reload} />
      </Sheet>
    </>
  )
}
