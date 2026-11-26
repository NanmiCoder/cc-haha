import React, { useEffect, useMemo, useState } from 'react'
import { FlatList, View, useWindowDimensions } from 'react-native'
import { Text } from './Text'
import type { ApiClient } from '../core/client'
import {
  ANTIGRAVITY_LOGIN_GUIDANCE,
  ANTIGRAVITY_PROVIDER_ID,
  antigravitySourceDetail,
  canSetRuntimeEffort,
  discoverAntigravity,
  loadRuntimeDirectory,
  loadRuntimeModels,
  modelDetail,
  runtimeProviderIdentity,
  runtimeModelSelection,
  withAntigravityStatus,
  type Model,
  type RuntimeDirectory,
} from '../core/runtimeCatalog'
import type { RuntimeConfig } from '../core/types'
import {
  Button,
  Callout,
  InlineError,
  Loading,
  Sheet,
  SearchField,
  TextButton,
  useColors,
} from './kit'
import { errorText } from './theme'
import { ChoiceRow } from './newtask/ChoiceRow'

export type { Provider, Model } from '../core/runtimeCatalog'

/**
 * 来源与模型的选择状态，保留独立的思考强度。打开即从电脑重新读取来源与授权，
 * 读完后回到 initial；`epoch` 变化表示重新打开，丢弃上次未保存的选择。
 */
export function useRuntimeChoice({
  client,
  initial,
  defaultScope = false,
  active = true,
  epoch = 0,
  lockedProviderId,
  excludeProviderIds,
}: {
  client?: ApiClient | null
  initial?: RuntimeConfig
  defaultScope?: boolean
  active?: boolean
  epoch?: number
  /** Lock provider switching (e.g. an existing Antigravity session) while keeping model & effort switching open. */
  lockedProviderId?: string | null
  /** Hide specific providers from the selectable provider list (e.g. hide Antigravity on non-Antigravity sessions). */
  excludeProviderIds?: readonly string[]
}) {
  const locked = lockedProviderId !== undefined
  const lockedIdentity = locked ? runtimeProviderIdentity(lockedProviderId) : undefined
  const excludeKey = excludeProviderIds?.join('\0') ?? ''
  const [providerId, setProviderId] = useState<string | null>(
    locked ? lockedIdentity! : runtimeProviderIdentity(initial?.providerId ?? null)
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
  const [catalogRevision, setCatalogRevision] = useState(0)
  const [manualRefreshingAntigravity, setManualRefreshingAntigravity] = useState(false)
  const initialProvider = initial?.providerId
  const initialModel = initial?.modelId
  const initialEffort = initial?.effortLevel
  const request = useMemo(
    () => ({
      client,
      initialProvider,
      initialModel,
      initialEffort,
      locked,
      lockedIdentity,
      revision,
      epoch,
    }),
    [client, initialProvider, initialModel, initialEffort, locked, lockedIdentity, revision, epoch]
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
          request.locked
            ? request.lockedIdentity!
            : request.initialProvider === undefined
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
  const effectiveProviderId = locked ? lockedIdentity! : providerId
  const sources = useMemo(() => {
    const list = directory?.sources ?? []
    if (locked) return list.filter((value) => value.id === lockedIdentity)
    if (!excludeKey) return list
    const excluded = new Set(excludeKey.split('\0').filter(Boolean))
    return list.filter((value) => !value.id || !excluded.has(value.id))
  }, [directory, locked, lockedIdentity, excludeKey])
  const error =
    (!loading && loaded?.error) ||
    (directory &&
    modelError?.directory === directory &&
    modelError.id === effectiveProviderId
      ? modelError.message
      : '')
  const source = sources.find((value) => value.id === effectiveProviderId)
  const autoDiscoveringAntigravity = Boolean(
    active &&
      directory &&
      client &&
      effectiveProviderId === ANTIGRAVITY_PROVIDER_ID &&
      directory.antigravity?.status === 'unchecked' &&
      !error
  )
  useEffect(() => {
    if (
      !active ||
      !directory ||
      !client ||
      effectiveProviderId !== ANTIGRAVITY_PROVIDER_ID ||
      directory.antigravity?.status !== 'unchecked'
    )
      return
    const controller = new AbortController()
    discoverAntigravity(client, controller.signal)
      .then((fresh) => {
        if (controller.signal.aborted) return
        setLoaded((current) =>
          current?.directory === directory
            ? { ...current, directory: withAntigravityStatus(directory, fresh) }
            : current
        )
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setModelError({
            directory,
            id: ANTIGRAVITY_PROVIDER_ID,
            message: errorText(e),
          })
      })
    return () => controller.abort()
  }, [active, client, directory, effectiveProviderId])
  useEffect(() => {
    if (!directory || !client) return
    if (
      effectiveProviderId === ANTIGRAVITY_PROVIDER_ID &&
      directory.antigravity?.status === 'unchecked'
    )
      return
    const controller = new AbortController()
    loadRuntimeModels(client, directory, effectiveProviderId, controller.signal)
      .then((models) => {
        if (!controller.signal.aborted)
          setCatalog({ directory, id: effectiveProviderId, models })
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setModelError({
            directory,
            id: effectiveProviderId,
            message: errorText(e),
          })
      })
    return () => controller.abort()
  }, [client, directory, effectiveProviderId, catalogRevision])
  const catalogReady = Boolean(
    directory &&
      catalog?.directory === directory &&
      catalog.id === effectiveProviderId
  )
  const models = catalogReady ? catalog!.models : []
  const model = models.find((value) => value.id === modelId)
  const canSetEffort = canSetRuntimeEffort(effectiveProviderId, defaultScope)
  const refreshingAntigravity =
    manualRefreshingAntigravity || autoDiscoveringAntigravity
  async function refreshAntigravity() {
    if (!client || !directory || refreshingAntigravity) return
    setManualRefreshingAntigravity(true)
    setModelError(null)
    try {
      const fresh = await discoverAntigravity(client)
      setLoaded((current) =>
        current?.directory === directory
          ? { ...current, directory: withAntigravityStatus(directory, fresh) }
          : current
      )
    } catch (e) {
      setModelError({
        directory,
        id: ANTIGRAVITY_PROVIDER_ID,
        message: errorText(e),
      })
    } finally {
      setManualRefreshingAntigravity(false)
    }
  }
  return {
    loading,
    directory,
    sources,
    antigravity: directory?.antigravity ?? null,
    locked,
    error,
    source,
    providerId: effectiveProviderId,
    selectProvider(id: string | null) {
      if (locked && id !== lockedIdentity) return
      // Retrying this source must not reload the directory and reset to initial.
      if (id === effectiveProviderId && modelError?.directory === directory && modelError.id === id)
        setCatalogRevision((value) => value + 1)
      setProviderId(id)
      if (id !== effectiveProviderId) setModelId('')
      setModelError(null)
    },
    catalogReady,
    models,
    modelId,
    model,
    selectModel(id: string) {
      setModelId(id)
    },
    effort,
    setEffort,
    canSetEffort,
    refreshingAntigravity,
    refreshAntigravity,
    selectConfig: (next: Model) => runtimeModelSelection(effectiveProviderId, next, { ...initial, effortLevel: effort } as RuntimeConfig, defaultScope),
    reload: () => setRevision((value) => value + 1),
    /** 可以应用的选择；来源未授权或还没选模型时为 null。 */
    selection:
      model && source?.auth === 'ready'
        ? runtimeModelSelection(effectiveProviderId, model, { ...initial, effortLevel: effort } as RuntimeConfig, defaultScope)
        : null,
  }
}
export type RuntimeChoice = ReturnType<typeof useRuntimeChoice>

/** Two short steps in one bottom sheet; source and model lists scroll independently. */
export function RuntimeChoiceView({
  choice,
  busy = false,
  warning,
  onApply,
}: {
  choice: RuntimeChoice
  busy?: boolean
  warning?: string
  onApply?(value: RuntimeConfig, model: Model): void
}) {
  const colors = useColors()
  const { height } = useWindowDimensions()
  const locked = Boolean(choice.locked)
  const [step, setStep] = useState<'providers' | 'models'>(
    locked ? 'models' : 'providers'
  )
  const activeStep = locked ? 'models' : step
  const [query, setQuery] = useState('')
  const search = query.trim().toLocaleLowerCase()
  const allSources = choice.sources ?? choice.directory?.sources ?? []
  const sources = allSources.filter((source) =>
    !search || source.name.toLocaleLowerCase().includes(search)
  )
  const models = choice.models.filter((model) =>
    !search || `${model.name} ${model.id} ${model.description ?? ''}`.toLocaleLowerCase().includes(search)
  )
  const isAntigravity = choice.providerId === ANTIGRAVITY_PROVIDER_ID
  const antigravityNeedsLogin =
    isAntigravity &&
    (choice.source?.runtimeStatus === 'login_required' ||
      choice.source?.auth === 'missing')
  const antigravityPending =
    isAntigravity &&
    (choice.refreshingAntigravity ||
      choice.source?.runtimeStatus === 'unchecked')
  const refreshDisabled =
    busy || choice.loading || Boolean(choice.refreshingAntigravity)
  return (
    <View style={{ height: Math.min(480, height * 0.58), flexShrink: 1, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 36 }}>
        {activeStep === 'models' && !locked ? (
          <TextButton title="‹ 供应商" onPress={() => { setStep('providers'); setQuery('') }} />
        ) : null}
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: colors.ink2, paddingHorizontal: 4 }}>
          {activeStep === 'providers'
            ? '先选择供应商'
            : locked
              ? `${choice.source?.name ?? (isAntigravity ? 'Antigravity' : '当前引擎')}（已锁定引擎）`
              : choice.source?.name ?? '供应商已不可用'}
        </Text>
      </View>
      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder={activeStep === 'providers' ? '搜索供应商' : '搜索模型'}
        editable={!busy}
      />
      <InlineError text={choice.error} />
      {choice.loading ? <Loading /> : activeStep === 'providers' ? (
        <FlatList
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          data={sources}
          keyExtractor={(source) => source.id ?? 'claude-official'}
          renderItem={({ item }) => (
            <ChoiceRow
              title={item.name}
              selected={item.id === choice.providerId}
              detail={
                item.id === ANTIGRAVITY_PROVIDER_ID
                  ? antigravitySourceDetail(choice.antigravity)
                  : item.auth === 'missing'
                    ? '尚未登录'
                    : item.auth === 'error'
                      ? '授权状态待确认'
                      : undefined
              }
              trailingText="›"
              disabled={busy}
              onPress={() => { choice.selectProvider(item.id); setStep('models'); setQuery('') }}
            />
          )}
          ListEmptyComponent={<Text style={{ color: colors.ink3, padding: 16 }}>没有匹配的供应商。</Text>}
        />
      ) : antigravityPending ? <Loading /> : choice.source?.auth !== 'ready' ? (
        <Callout>
          {antigravityNeedsLogin
            ? ANTIGRAVITY_LOGIN_GUIDANCE
            : isAntigravity
              ? (choice.antigravity?.error || '尚未确认 Antigravity 状态，请点击下方刷新重试。')
              : choice.source?.auth === 'missing'
                ? '请先在电脑上登录或配置此供应商，再重新读取。'
                : '尚未确认此供应商的授权状态，请重新读取后再选模型。'}
        </Callout>
      ) : !choice.catalogReady && !choice.error ? <Loading /> : (
        <FlatList
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          data={models}
          keyExtractor={(model) => model.id}
          renderItem={({ item }) => (
            <ChoiceRow
              title={item.name}
              detail={modelDetail(item) || undefined}
              selected={item.id === choice.modelId}
              disabled={busy}
              onPress={() => {
                choice.selectModel(item.id)
                onApply?.(choice.selectConfig(item), item)
              }}
            />
          )}
          ListEmptyComponent={<Text style={{ color: colors.ink3, padding: 16 }}>{query ? '没有匹配的模型。' : '这个供应商没有可用模型。'}</Text>}
        />
      )}
      {warning ? <Callout>{warning}</Callout> : null}
      {activeStep === 'models' && isAntigravity && choice.refreshAntigravity ? (
        <TextButton
          title={choice.refreshingAntigravity ? '正在刷新…' : '刷新 Antigravity'}
          disabled={refreshDisabled}
          onPress={() => { void choice.refreshAntigravity() }}
        />
      ) : (
        <TextButton title="重新读取" disabled={busy || choice.loading} onPress={choice.reload} />
      )}
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
  lockedProviderId,
  excludeProviderIds,
}: {
  client: ApiClient
  initial?: RuntimeConfig
  onApply(value: RuntimeConfig, model?: Model): void
  applyLabel?: string
  busy?: boolean
  defaultScope?: boolean
  lockedProviderId?: string | null
  excludeProviderIds?: readonly string[]
}) {
  const choice = useRuntimeChoice({
    client,
    initial,
    defaultScope,
    lockedProviderId,
    excludeProviderIds,
  })
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
 * 先选供应商，再点模型应用；关闭不保存。思考强度由独立控件设置。
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
  inline,
  lockedProviderId,
  excludeProviderIds,
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
  inline?: boolean
  lockedProviderId?: string | null
  excludeProviderIds?: readonly string[]
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
    lockedProviderId,
    excludeProviderIds,
  })
  return (
    <Sheet
      inline={inline}
      visible={visible}
      onClose={onClose}
      title={title}
      left={
        <View style={{ paddingHorizontal: 4 }}>
          <TextButton title="取消" onPress={onClose} />
        </View>
      }
      scroll={false}
    >
      <View style={{ flexShrink: 1, minHeight: 0 }}>
        {client ? (
          <RuntimeChoiceView key={epoch} choice={choice} busy={busy} warning={warning} onApply={onApply} />
        ) : warning ? (
          <Callout>{warning}</Callout>
        ) : null}
      </View>
    </Sheet>
  )
}
