import { useState, type ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import type { ApiClient } from '../core/client'
import type { RuntimeConfig } from '../core/types'
import {
  ANTIGRAVITY_PROVIDER_ID,
  currentModelEfforts,
  effortUnavailableReason,
} from '../core/runtimeCatalog'
import { useRuntimeChoice } from './RuntimePicker'
import { Callout, InlineError, Loading, Sheet, TextButton, useColors } from './kit'
import { ChoiceRow } from './newtask/ChoiceRow'
import { Text } from './Text'
import { effortName } from './modes'

/** 独立思考强度弹层：用于在已有 Modal 内通过 `inline` 呈现，避免嵌套原生 Modal。 */
export function EffortSheet({
  visible,
  onClose,
  client,
  runtime,
  onApply,
  disabled,
  defaultScope = false,
  warning,
  inline,
}: {
  visible: boolean
  onClose(): void
  client: ApiClient | null
  runtime?: RuntimeConfig
  onApply(value: RuntimeConfig): void
  disabled?: boolean
  defaultScope?: boolean
  warning?: string
  inline?: boolean
}) {
  const [shown, setShown] = useState(visible)
  const [epoch, setEpoch] = useState(0)
  if (shown !== visible) {
    setShown(visible)
    if (visible) setEpoch(epoch + 1)
  }
  const choice = useRuntimeChoice({ client, initial: runtime, defaultScope, active: visible, epoch })
  const isAntigravity =
    runtime?.providerId === ANTIGRAVITY_PROVIDER_ID ||
    choice.providerId === ANTIGRAVITY_PROVIDER_ID
  const current =
    runtime && (choice.catalogReady || choice.error) ? currentModelEfforts(choice.models, runtime.modelId) : undefined
  const options = choice.canSetEffort ? (current?.efforts ?? []) : []
  const authReady =
    choice.source?.auth === 'ready' && choice.source?.runtimeStatus !== 'unchecked'
  const waiting =
    choice.loading ||
    Boolean(choice.refreshingAntigravity) ||
    (!choice.catalogReady && !choice.error && authReady)
  const reason = effortUnavailableReason(choice)
  const refresh = () => {
    if (
      isAntigravity &&
      typeof choice.refreshAntigravity === 'function' &&
      choice.directory !== null
    ) {
      void choice.refreshAntigravity()
      return
    }
    choice.reload()
  }
  return (
    <Sheet inline={inline} visible={visible} onClose={onClose} title="思考强度">
      <InlineError text={choice.error} />
      {waiting ? <Loading /> : options.length && authReady ? (
        <View>
          {options.map((value) => (
            <ChoiceRow
              key={value}
              title={effortName(value)}
              selected={value === (runtime?.effortLevel ?? current?.defaultEffort)}
              disabled={disabled}
              onPress={() => {
                if (!runtime || !authReady) return
                // 只换强度，模型 id 原样带回。
                onApply({ ...runtime, effortLevel: value })
                onClose()
              }}
            />
          ))}
        </View>
      ) : (
        <Callout>{reason}</Callout>
      )}
      {warning ? <Callout>{warning}</Callout> : null}
      <TextButton
        title={isAntigravity && choice.refreshingAntigravity ? '正在刷新…' : '重新读取'}
        disabled={waiting || disabled}
        onPress={refresh}
      />
    </Sheet>
  )
}

/** Shared composer control: changing effort never changes provider or model. */
export function EffortControl({ client, runtime, onApply, disabled, defaultScope = false, warning, trigger, onOpen }: {
  client: ApiClient | null
  runtime?: RuntimeConfig
  onApply(value: RuntimeConfig): void
  disabled?: boolean
  defaultScope?: boolean
  warning?: string
  /** 换掉默认的「思考 · 高」小胶囊，例如放进设置列表的一行；选择弹层不变。 */
  trigger?(control: { open(): void; disabled: boolean; label: string }): ReactNode
  /** 由外部全屏 Modal 通过 `EffortSheet` 的 `inline` 承载弹层时传入，避免嵌套原生 Modal。 */
  onOpen?(): void
}) {
  const colors = useColors()
  const [open, setOpen] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const choice = useRuntimeChoice({ client, initial: runtime, defaultScope, active: !onOpen && open, epoch })
  const isAntigravity =
    runtime?.providerId === ANTIGRAVITY_PROVIDER_ID ||
    choice.providerId === ANTIGRAVITY_PROVIDER_ID
  const current =
    runtime && (choice.catalogReady || choice.error) ? currentModelEfforts(choice.models, runtime.modelId) : undefined
  const options = choice.canSetEffort ? (current?.efforts ?? []) : []
  const unavailable = disabled || !client || !runtime
  const authReady =
    choice.source?.auth === 'ready' && choice.source?.runtimeStatus !== 'unchecked'
  const waiting =
    choice.loading ||
    Boolean(choice.refreshingAntigravity) ||
    (!choice.catalogReady && !choice.error && authReady)
  const reason = effortUnavailableReason(choice)
  const refresh = () => {
    if (
      isAntigravity &&
      typeof choice.refreshAntigravity === 'function' &&
      choice.directory !== null
    ) {
      void choice.refreshAntigravity()
      return
    }
    choice.reload()
  }

  const show = () => {
    if (onOpen) {
      onOpen()
      return
    }
    setEpoch((value) => value + 1)
    setOpen(true)
  }
  return (
    <>
      {trigger ? trigger({ open: show, disabled: Boolean(unavailable), label: effortName(runtime?.effortLevel) }) : <Pressable
        accessibilityRole="button"
        accessibilityLabel={`思考强度：${effortName(runtime?.effortLevel)}`}
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
          思考 · {effortName(runtime?.effortLevel)}
        </Text>
      </Pressable>}
      {onOpen ? null : (
        <Sheet visible={open} onClose={() => setOpen(false)} title="思考强度">
          <InlineError text={choice.error} />
          {waiting ? <Loading /> : options.length && authReady ? (
            <View>
              {options.map((value) => (
                <ChoiceRow
                  key={value}
                  title={effortName(value)}
                  selected={value === (runtime?.effortLevel ?? current?.defaultEffort)}
                  disabled={disabled}
                  onPress={() => {
                    if (!runtime || !authReady) return
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
          <TextButton
            title={isAntigravity && choice.refreshingAntigravity ? '正在刷新…' : '重新读取'}
            disabled={waiting || disabled}
            onPress={refresh}
          />
        </Sheet>
      )}
    </>
  )
}
