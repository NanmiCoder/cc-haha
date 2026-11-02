import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { ScrollView, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { useConnection } from '../state/AppContext'
import type { ApiClient } from '../core/client'
import { effortUnavailableReason } from '../core/runtimeCatalog'
import { useRuntimeChoice } from '../ui/RuntimePicker'
import { effortSegments } from '../ui/compose/runLogic'
import { ChoiceRow } from '../ui/newtask/ChoiceRow'
import { EffortTrack } from '../ui/computer/EffortTrack'
import { ModelOption, SettingRow, ErrorCallout } from '../ui/computer/parts'
import { effortIndex, modelRow, providerSummary } from '../ui/computer/computerModel'
import { Text } from '../ui/Text'
import {
  BottomBar,
  Button,
  Callout,
  Footnote,
  Group,
  Loading,
  NavBar,
  ScreenView,
  SectionHeader,
  Separator,
  Sheet,
  useColors,
} from '../ui/kit'
import { errorText } from '../ui/theme'
import type { RuntimeConfig } from '../core/types'

/** 电脑设置 → 新任务默认：改电脑的默认服务商、模型和思考强度（设计稿 P2）。 */
export default function Models() {
  const { host: id } = useLocalSearchParams<{ host: string }>()
  const { host, client, error: connectionError } = useConnection(id)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [currentConfig, setCurrentConfig] = useState<RuntimeConfig | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    if (client)
      Promise.all([
        client.get<{ activeId: string | null }>('/api/providers', {
          signal: controller.signal,
        }),
        client.get<{ model: { id: string } }>('/api/models/current', {
          signal: controller.signal,
        }),
        client.get<{ level: string }>('/api/effort', {
          signal: controller.signal,
        }),
      ])
        .then(([provider, model, effort]) => {
          if (!controller.signal.aborted)
            setCurrentConfig({
              providerId: provider.activeId,
              modelId: model.model.id,
              effortLevel: effort.level,
            })
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(errorText(e))
        })
    return () => controller.abort()
  }, [client, revision])
  async function save(config: RuntimeConfig) {
    if (!client || busy) return
    setBusy(true)
    setError('')
    setStatus('')
    try {
      const current = await client.get<{ activeId: string | null }>(
        '/api/providers'
      )
      if (current.activeId !== config.providerId) {
        if (config.providerId === null)
          await client.post('/api/providers/official', {})
        else
          await client.post(
            `/api/providers/${encodeURIComponent(config.providerId)}/activate`,
            {}
          )
      }
      await client.put('/api/models/current', { modelId: config.modelId })
      if (config.effortLevel)
        await client.put('/api/effort', { level: config.effortLevel })
      setStatus(`已保存 ${host?.name} 的默认模型。已有会话保持各自的运行配置。`)
      setRevision((value) => value + 1)
    } catch (e) {
      setError(`${errorText(e)}。已完成的设置可能已保存，请重新读取后确认。`)
    } finally {
      setBusy(false)
    }
  }
  const reload = () => {
    setError('')
    setRevision((value) => value + 1)
  }
  const banner = (
    <Banner
      error={connectionError || error}
      status={status}
      onReload={reload}
    />
  )
  return (
    <ScreenView>
      <NavBar floating title="新任务默认" subtitle={host?.name ?? '所选电脑'} />
      {client && currentConfig ? (
        <DefaultPicker
          key={JSON.stringify(currentConfig)}
          client={client}
          initial={currentConfig}
          busy={busy}
          onSave={(value) => {
            void save(value)
          }}
          banner={banner}
        />
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, gap: 12 }}>
          {banner}
          {!connectionError && !error && <Loading />}
        </ScrollView>
      )}
    </ScreenView>
  )
}

function Banner({
  error,
  status,
  onReload,
}: {
  error: string
  status: string
  onReload(): void
}) {
  return (
    <>
      <ErrorCallout text={error} onRetry={onReload} style={{ marginTop: 8 }} />
      {status ? (
        <Callout tone="info" icon="circle-check" style={{ marginTop: 8 }}>
          {status}
        </Callout>
      ) : null}
    </>
  )
}

function DefaultPicker({
  client,
  initial,
  busy,
  onSave,
  banner,
}: {
  client: ApiClient
  initial: RuntimeConfig
  busy: boolean
  onSave(value: RuntimeConfig): void
  banner: ReactNode
}) {
  const colors = useColors()
  const choice = useRuntimeChoice({ client, initial, defaultScope: true })
  const [providerOpen, setProviderOpen] = useState(false)
  const sources = choice.directory?.sources ?? []
  const provider = providerSummary(sources, choice.providerId)
  const authReady = choice.source?.auth === 'ready'
  const supported = choice.model?.supportedReasoningEfforts ?? []
  const segments = choice.model
    ? effortSegments({ canSetEffort: choice.canSetEffort, authReady, efforts: supported })
    : []
  const defaultEffort = choice.model?.defaultReasoningEffort
  const at = effortIndex(
    segments.map((item) => item.value),
    choice.effort,
    defaultEffort
  )
  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
      >
        {banner}
        <ErrorCallout text={choice.error} onRetry={choice.reload} style={{ marginTop: 8 }} />

        {/* 设计稿 P2：服务商头 22，其余分组头 20；行高 52 / 58，分隔线缩进 48。 */}
        <SectionHeader title="服务商" style={{ paddingTop: 22 }} />
        <Group>
          {choice.loading ? (
            <View style={{ minHeight: 52, justifyContent: 'center' }}>
              <Loading />
            </View>
          ) : (
            <SettingRow
              title={provider.name || '供应商已不可用'}
              value={provider.others}
              valueSize={14}
              titleGrow
              disabled={busy || !sources.length}
              onPress={() => setProviderOpen(true)}
              label={`服务商：${provider.name || '已不可用'}${provider.others ? `，${provider.others}` : ''}`}
            />
          )}
        </Group>

        <SectionHeader title="模型" style={{ paddingTop: 20 }} />
        {choice.loading ? (
          <Loading />
        ) : !authReady ? (
          <Callout>
            {choice.source?.auth === 'missing'
              ? '请先在电脑上登录或配置此供应商，再重新读取。'
              : choice.source?.auth === 'error'
                ? '尚未确认此供应商的授权状态，请重新读取后再选模型。'
                : '当前供应商已不可用，请重新选择。'}
          </Callout>
        ) : !choice.catalogReady && !choice.error ? (
          <Loading />
        ) : choice.models.length ? (
          <Group>
            <View accessibilityRole="radiogroup" accessibilityLabel="模型">
              {choice.models.map((model, index) => {
                const row = modelRow(model, model.description)
                const selected = model.id === choice.modelId
                return (
                  <Fragment key={model.id}>
                    {index > 0 && <Separator inset={48} />}
                    <ModelOption
                      title={row.title}
                      detail={row.detail}
                      mono={row.mono}
                      selected={selected}
                      disabled={busy}
                      label={[row.title, row.detail, selected ? '已选中' : '']
                        .filter(Boolean)
                        .join('，')}
                      onPress={() => choice.selectModel(model.id)}
                    />
                  </Fragment>
                )
              })}
            </View>
          </Group>
        ) : choice.catalogReady ? (
          <Callout>这个供应商没有可用模型。</Callout>
        ) : null}

        <SectionHeader title="思考强度" style={{ paddingTop: 20 }} />
        {!choice.model ? (
          <Text style={{ paddingHorizontal: 4, fontSize: 14, lineHeight: 20, color: colors.ink3 }}>
            选好模型后可以调整。
          </Text>
        ) : segments.length ? (
          <EffortTrack
            label="思考强度"
            options={segments}
            value={at >= 0 ? (segments[at]?.value ?? '') : ''}
            disabled={busy}
            onChange={choice.setEffort}
          />
        ) : (
          <Callout>{effortUnavailableReason(choice)}</Callout>
        )}

        <Footnote style={{ paddingTop: 14 }}>只影响之后新建的任务，已经在跑的不变。</Footnote>
      </ScrollView>
      <BottomBar>
        <Button
          title="保存"
          size="lg"
          busy={busy}
          disabled={!choice.selection}
          onPress={() => {
            if (choice.selection) onSave(choice.selection)
          }}
        />
      </BottomBar>
      <Sheet visible={providerOpen} onClose={() => setProviderOpen(false)} title="服务商">
        <Group>
          {sources.map((source, index) => (
            <Fragment key={source.id ?? 'claude-official'}>
              {index > 0 && <Separator />}
              <ChoiceRow
                title={source.name}
                selected={source.id === choice.providerId}
                detail={
                  source.auth === 'missing'
                    ? '尚未登录'
                    : source.auth === 'error'
                      ? '授权状态待确认'
                      : undefined
                }
                disabled={busy}
                onPress={() => {
                  choice.selectProvider(source.id)
                  setProviderOpen(false)
                }}
              />
            </Fragment>
          ))}
        </Group>
      </Sheet>
    </View>
  )
}
