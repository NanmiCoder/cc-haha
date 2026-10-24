import { useEffect, useMemo, useState } from 'react'
import { View } from 'react-native'
import { Text } from './Text'
import type { ApiClient } from '../core/client'
import {
  canSetRuntimeEffort,
  loadRuntimeDirectory,
  loadRuntimeModels,
  runtimeProviderIdentity,
  runtimeSelection,
  type Model,
  type RuntimeDirectory,
} from '../core/runtimeCatalog'
import type { RuntimeConfig } from '../core/types'
import {
  Button,
  Icon,
  Loading,
  Notice,
  Row,
  errorText,
  useTheme,
} from './theme'

export type { Provider, Model } from '../core/runtimeCatalog'

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
  onApply(value: RuntimeConfig): void
  applyLabel?: string
  busy?: boolean
  defaultScope?: boolean
}) {
  const { colors: c, styles: s } = useTheme()
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
    () => ({ client, initialProvider, initialModel, initialEffort, revision }),
    [client, initialProvider, initialModel, initialEffort, revision]
  )
  const [loaded, setLoaded] = useState<{
    request: typeof request
    directory?: RuntimeDirectory
    error?: string
  } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    loadRuntimeDirectory(request.client, controller.signal)
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
  }, [request])
  const loading = loaded?.request !== request
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
    if (!directory) return
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
  return (
    <View style={{ gap: 18 }}>
      <Notice text={error} error />
      {loading && <Loading />}
      <View style={s.card}>
        <Text style={s.label}>模型来源</Text>
        {directory?.sources.map((value) => (
          <Row
            key={value.id ?? 'claude-official'}
            title={value.name}
            detail={
              value.auth === 'missing'
                ? '尚未授权，请在电脑端登录或配置'
                : value.auth === 'error'
                  ? '暂时无法确认授权，请重新读取'
                  : value.id === directory.activeId
                    ? '电脑当前默认'
                    : undefined
            }
            trailing={
              value.id === providerId ? (
                <Icon name="check-circle" color={c.accent} />
              ) : undefined
            }
            onPress={
              busy
                ? undefined
                : () => {
                    setProviderId(value.id)
                    setModelId('')
                    setEffort(undefined)
                    setModelError(null)
                  }
            }
          />
        ))}
      </View>
      {directory && !source && (
        <Notice text="当前会话的来源已不可用，请重新选择。" error />
      )}
      {source?.auth === 'missing' && (
        <Notice text="此来源尚未授权。请在这台电脑上完成账号登录或配置，再重新读取。手机不接收官方账号凭据。" />
      )}
      {source?.auth === 'error' && (
        <Notice text="尚未确认此来源的授权状态，暂不能应用选择。" error />
      )}
      <View style={s.card}>
        <Text style={s.label}>可用模型</Text>
        {directory && source?.auth === 'ready' && !catalogReady && !error && (
          <Loading />
        )}
        {models.map((value) => (
          <Row
            key={value.id}
            title={value.name}
            detail={[value.description, value.context]
              .filter(Boolean)
              .join(' · ')}
            trailing={
              value.id === modelId ? (
                <Icon name="check-circle" color={c.accent} />
              ) : undefined
            }
            onPress={
              busy
                ? undefined
                : () => {
                    setModelId(value.id)
                    setEffort(undefined)
                  }
            }
          />
        ))}
        {catalogReady && !models.length && source?.auth === 'ready' && (
          <Text style={s.small}>所选来源没有返回可用模型。</Text>
        )}
      </View>
      {!canSetEffort && (
        <Notice text="这个账号来源的新会话使用电脑运行时的默认思考强度。需要调整时，请在具体会话内选择。" />
      )}
      {canSetEffort && model?.supportedReasoningEfforts?.length ? (
        <View style={s.card}>
          <Text style={s.label}>思考强度</Text>
          <Row
            title={defaultScope ? '沿用电脑当前强度' : '模型默认'}
            onPress={busy ? undefined : () => setEffort(undefined)}
            trailing={!effort ? <Icon name="check" /> : undefined}
          />
          {model.supportedReasoningEfforts.map((value) => (
            <Row
              key={value}
              title={value}
              onPress={busy ? undefined : () => setEffort(value)}
              trailing={value === effort ? <Icon name="check" /> : undefined}
            />
          ))}
        </View>
      ) : null}
      <Button
        title={applyLabel}
        disabled={!model || source?.auth !== 'ready' || busy}
        busy={busy}
        onPress={() => {
          if (model && source?.auth === 'ready')
            onApply(runtimeSelection(providerId, model, effort, defaultScope))
        }}
      />
      <Button
        title="重新读取来源与授权"
        secondary
        disabled={busy || loading}
        onPress={() => setRevision((value) => value + 1)}
      />
    </View>
  )
}
