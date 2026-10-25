import React, { useEffect, useMemo, useState } from 'react'
import { Pressable, View } from 'react-native'
import { Text } from './Text'
import type { ApiClient } from '../core/client'
import {
  canSetRuntimeEffort,
  loadRuntimeDirectory,
  loadRuntimeModels,
  modelDetail,
  runtimeProviderIdentity,
  runtimeSelection,
  type Model,
  type RuntimeDirectory,
  type RuntimeSource,
} from '../core/runtimeCatalog'
import type { RuntimeConfig } from '../core/types'
import {
  Button,
  Callout,
  Chip,
  Group,
  InlineError,
  Loading,
  SectionHeader,
  Segmented,
  Separator,
  Sheet,
  TextButton,
  useColors,
} from './kit'
import { effortName } from './modes'
import { errorText } from './theme'
import { ChoiceRow } from './newtask/ChoiceRow'

export type { Provider, Model } from '../core/runtimeCatalog'

/**
 * 来源、模型、思考强度的选择状态。打开即从电脑重新读取来源与授权，
 * 读完后回到 initial；`epoch` 变化表示重新打开，丢弃上次未保存的选择。
 */
export function useRuntimeChoice({
  client,
  initial,
  defaultScope = false,
  active = true,
  epoch = 0,
}: {
  client?: ApiClient | null
  initial?: RuntimeConfig
  defaultScope?: boolean
  active?: boolean
  epoch?: number
}) {
  const [providerId, setProviderId] = useState<string | null>(
    runtimeProviderIdentity(initial?.providerId ?? null)
  )
  const [modelId, setModelId] = useState(initial?.modelId ?? '')
  const [effort, setEffort] = useState(initial?.effortLevel)
  const [catalog, setCatalog] = useState<{
    directory: RuntimeDirectory
    id: string | null
    models: Model[]
  } | null>(null)
  const [modelError, setModelError] = useState<{
    directory: RuntimeDirectory
    id: string | null
    message: string
  } | null>(null)
  const [revision, setRevision] = useState(0)
  const initialProvider = initial?.providerId
  const initialModel = initial?.modelId
  const initialEffort = initial?.effortLevel
  const request = useMemo(
    () => ({
      client,
      initialProvider,
      initialModel,
      initialEffort,
      revision,
      epoch,
    }),
    [client, initialProvider, initialModel, initialEffort, revision, epoch]
  )
  const [loaded, setLoaded] = useState<{
    request: typeof request
    directory?: RuntimeDirectory
    error?: string
  } | null>(null)
  useEffect(() => {
    const target = request.client
    if (!active || !target) return
    const controller = new AbortController()
    loadRuntimeDirectory(target, controller.signal)
      .then((directory) => {
        if (controller.signal.aborted) return
        setLoaded({ request, directory })
        setProviderId(
          request.initialProvider === undefined
            ? directory.activeId
            : runtimeProviderIdentity(request.initialProvider)
        )
        setModelId(request.initialModel ?? '')
        setEffort(request.initialEffort)
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setLoaded({ request, error: errorText(e) })
      })
    return () => controller.abort()
  }, [request, active])
  const loading = Boolean(client) && loaded?.request !== request
  const directory = !loading ? (loaded?.directory ?? null) : null
  const error =
    (!loading && loaded?.error) ||
    (directory &&
    modelError?.directory === directory &&
    modelError.id === providerId
      ? modelError.message
      : '')
  const source = directory?.sources.find((value) => value.id === providerId)
  useEffect(() => {
    if (!directory || !client) return
    const controller = new AbortController()
    loadRuntimeModels(client, directory, providerId, controller.signal)
      .then((models) => {
        if (!controller.signal.aborted)
          setCatalog({ directory, id: providerId, models })
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setModelError({ directory, id: providerId, message: errorText(e) })
      })
    return () => controller.abort()
  }, [client, directory, providerId])
  const catalogReady = Boolean(
    directory && catalog?.directory === directory && catalog.id === providerId
  )
  const models = catalogReady ? catalog!.models : []
  const model = models.find((value) => value.id === modelId)
  const canSetEffort = canSetRuntimeEffort(providerId, defaultScope)
  return {
    loading,
    directory,
    error,
    source,
    providerId,
    selectProvider(id: string | null) {
      setProviderId(id)
      setModelId('')
      setEffort(undefined)
      setModelError(null)
    },
    catalogReady,
    models,
    modelId,
    model,
    selectModel(id: string) {
      setModelId(id)
      setEffort(undefined)
    },
    effort,
    setEffort,
    canSetEffort,
    reload: () => setRevision((value) => value + 1),
    /** 可以应用的选择；来源未授权或还没选模型时为 null。 */
    selection:
      model && source?.auth === 'ready'
        ? runtimeSelection(providerId, model, effort, defaultScope)
        : null,
  }
}
export type RuntimeChoice = ReturnType<typeof useRuntimeChoice>

function SourceChip({
  source,
  selected,
  onPress,
  disabled,
}: {
  source: RuntimeSource
  selected: boolean
  onPress(): void
  disabled?: boolean
}) {
  const colors = useColors()
  const ghost = source.auth !== 'ready'
  const label =
    source.auth === 'missing'
      ? `${source.name} · 未登录`
      : source.auth === 'error'
        ? `${source.name} · 待确认`
        : source.name
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 36,
        maxWidth: '100%',
        paddingHorizontal: 14,
        borderRadius: 18,
        justifyContent: 'center',
        backgroundColor: selected
          ? colors.btn
          : ghost
            ? 'transparent'
            : colors.card,
        boxShadow: selected ? undefined : `inset 0 0 0 1px ${colors.hair}`,
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      <Text
        numberOfLines={1}
        style={{
          fontSize: 14,
          fontWeight: selected ? '600' : '400',
          color: selected ? colors.btnInk : ghost ? colors.ink3 : colors.ink,
        }}
      >
        {label}
      </Text>
    </Pressable>
  )
}

/** 来源 chips · 模型列表 · 思考强度，加提示与“重新读取”。新任务、会话、计划执行、默认模型页共用。 */
export function RuntimeChoiceView({
  choice,
  busy = false,
  warning,
}: {
  choice: RuntimeChoice
  busy?: boolean
  warning?: string
}) {
  const colors = useColors()
  const {
    directory,
    source,
    providerId,
    models,
    model,
    effort,
    catalogReady,
    canSetEffort,
    error,
  } = choice
  const efforts = canSetEffort ? (model?.supportedReasoningEfforts ?? []) : []
  const effortOptions = [
    { label: '默认', value: '' },
    ...efforts.map((value) => ({ label: effortName(value), value })),
  ]
  return (
    <View>
      <InlineError text={error} style={{ marginTop: 10 }} />
      {choice.loading && <Loading />}
      {directory && (
        <>
          <SectionHeader title="来源" style={{ paddingTop: 10 }} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {directory.sources.map((value) => (
              <SourceChip
                key={value.id ?? 'claude-official'}
                source={value}
                selected={value.id === providerId}
                disabled={busy}
                onPress={() => choice.selectProvider(value.id)}
              />
            ))}
          </View>
          {!source && (
            <Callout tone="error" style={{ marginTop: 12 }}>
              当前会话的来源已不可用，请重新选择。
            </Callout>
          )}
          {source?.auth === 'missing' && (
            <Callout style={{ marginTop: 12 }}>
              此来源尚未授权。请在这台电脑上完成账号登录或配置，再重新读取。手机不接收官方账号凭据。
            </Callout>
          )}
          {source?.auth === 'error' && (
            <Callout tone="error" style={{ marginTop: 12 }}>
              尚未确认此来源的授权状态，暂不能应用选择。
            </Callout>
          )}
          {source?.auth === 'ready' && (
            <>
              <SectionHeader title="模型" style={{ paddingTop: 20 }} />
              {models.length ? (
                <Group>
                  {models.map((value, index) => (
                    <React.Fragment key={value.id}>
                      {index > 0 && <Separator inset={14} />}
                      <ChoiceRow
                        title={value.name}
                        detail={modelDetail(value) || undefined}
                        selected={value.id === choice.modelId}
                        disabled={busy}
                        onPress={() => choice.selectModel(value.id)}
                      />
                    </React.Fragment>
                  ))}
                </Group>
              ) : catalogReady ? (
                <Text
                  style={{
                    fontSize: 14,
                    lineHeight: 20,
                    color: colors.ink3,
                    paddingHorizontal: 4,
                  }}
                >
                  所选来源没有返回可用模型。
                </Text>
              ) : !error ? (
                <Loading />
              ) : null}
            </>
          )}
          {!canSetEffort && (
            <Callout tone="info" style={{ marginTop: 16 }}>
              这个账号来源的新会话使用电脑运行时的默认思考强度。需要调整时，请在具体会话内选择。
            </Callout>
          )}
          {efforts.length ? (
            <>
              <SectionHeader title="思考强度" style={{ paddingTop: 20 }} />
              {effortOptions.length <= 5 ? (
                <Segmented
                  label="思考强度"
                  options={effortOptions}
                  value={effort && efforts.includes(effort) ? effort : ''}
                  disabled={busy}
                  onChange={(value) => choice.setEffort(value || undefined)}
                />
              ) : (
                <View
                  accessibilityRole="radiogroup"
                  accessibilityLabel="思考强度"
                  style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}
                >
                  {effortOptions.map((option) => (
                    <Chip
                      key={option.value || 'default'}
                      label={option.label}
                      selected={
                        option.value
                          ? option.value === effort
                          : !effort || !efforts.includes(effort)
                      }
                      disabled={busy}
                      onPress={() => choice.setEffort(option.value || undefined)}
                    />
                  ))}
                </View>
              )}
            </>
          ) : null}
        </>
      )}
      {warning ? <Callout style={{ marginTop: 16 }}>{warning}</Callout> : null}
      <Button
        title="重新读取来源与授权"
        variant="plain"
        disabled={busy || choice.loading}
        onPress={choice.reload}
        style={{ marginTop: 8, alignSelf: 'center' }}
      />
    </View>
  )
}

/** 内嵌选择器（带应用按钮）。新代码优先用 RuntimeSheet。 */
export function RuntimePicker({
  client,
  initial,
  onApply,
  applyLabel = '应用选择',
  busy = false,
  defaultScope = false,
}: {
  client: ApiClient
  initial?: RuntimeConfig
  onApply(value: RuntimeConfig, model?: Model): void
  applyLabel?: string
  busy?: boolean
  defaultScope?: boolean
}) {
  const choice = useRuntimeChoice({ client, initial, defaultScope })
  return (
    <View style={{ gap: 12 }}>
      <RuntimeChoiceView choice={choice} busy={busy} />
      <Button
        title={applyLabel}
        size="lg"
        disabled={!choice.selection || busy}
        busy={busy}
        onPress={() => {
          if (choice.selection) onApply(choice.selection, choice.model)
        }}
      />
    </View>
  )
}

/**
 * 模型选择弹层。会话输入框、计划执行模型、新任务都用它，接口保持稳定：
 * 头部“取消 · 标题 · 完成”，点“完成”回调 onApply，关闭不保存。
 */
export function RuntimeSheet({
  visible,
  onClose,
  title = '模型',
  client,
  initial,
  onApply,
  busy,
  defaultScope,
  warning,
}: {
  visible: boolean
  onClose(): void
  title?: string
  client?: ApiClient | null
  initial?: RuntimeConfig
  onApply(value: RuntimeConfig, model?: Model): void
  busy?: boolean
  defaultScope?: boolean
  warning?: string
}) {
  // Each opening re-reads sources and starts from `initial`; closing discards the draft.
  const [shown, setShown] = useState(visible)
  const [epoch, setEpoch] = useState(0)
  if (shown !== visible) {
    setShown(visible)
    if (visible) setEpoch(epoch + 1)
  }
  const choice = useRuntimeChoice({
    client,
    initial,
    defaultScope,
    active: visible,
    epoch,
  })
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={title}
      left={
        <View style={{ paddingHorizontal: 4 }}>
          <TextButton title="取消" onPress={onClose} />
        </View>
      }
      right={
        <View style={{ paddingHorizontal: 4 }}>
          <TextButton
            title="完成"
            strong
            disabled={!choice.selection || Boolean(busy)}
            onPress={() => {
              if (choice.selection) onApply(choice.selection, choice.model)
            }}
          />
        </View>
      }
    >
      <View>
        {client ? (
          <RuntimeChoiceView choice={choice} busy={busy} warning={warning} />
        ) : warning ? (
          <Callout>{warning}</Callout>
        ) : null}
      </View>
    </Sheet>
  )
}
