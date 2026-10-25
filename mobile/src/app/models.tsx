import { useEffect, useState, type ReactNode } from 'react'
import { ScrollView, View } from 'react-native'
import { KeyboardViewport } from '../ui/KeyboardViewport'
import { useLocalSearchParams } from 'expo-router'
import { useConnection } from '../state/AppContext'
import type { ApiClient } from '../core/client'
import { RuntimeChoiceView, useRuntimeChoice } from '../ui/RuntimePicker'
import { EffortControl } from '../ui/EffortControl'
import {
  BottomBar,
  Button,
  Callout,
  Footnote,
  InlineError,
  Loading,
  NavBar,
  ScreenView,
} from '../ui/kit'
import { errorText } from '../ui/theme'
import type { RuntimeConfig } from '../core/types'

/** HostSheet “新任务默认模型”：改电脑的默认来源、模型和思考强度。 */
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
  return (
    <ScreenView>
      <NavBar title="新任务默认模型" subtitle={host?.name ?? '所选电脑'} />
      {client && currentConfig ? (
        <DefaultPicker
          key={JSON.stringify(currentConfig)}
          client={client}
          initial={currentConfig}
          busy={busy}
          onSave={(value) => {
            void save(value)
          }}
          banner={
            <Banner
              error={connectionError || error}
              status={status}
              onReload={() => {
                setError('')
                setRevision((value) => value + 1)
              }}
            />
          }
        />
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, gap: 12 }}>
          <Banner
            error={connectionError || error}
            status={status}
            onReload={() => {
              setError('')
              setRevision((value) => value + 1)
            }}
          />
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
      <InlineError text={error} />
      {error ? (
        <Button title="重新读取电脑配置" variant="outline" onPress={onReload} />
      ) : null}
      {status ? (
        <Callout tone="info" icon="circle-check">
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
  const choice = useRuntimeChoice({ client, initial, defaultScope: true })
  return (
    <KeyboardViewport style={{ flex: 1 }}>
      <View style={{ flex: 1, minHeight: 0, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, gap: 12 }}>
        {banner}
        <RuntimeChoiceView choice={choice} busy={busy} />
        <EffortControl
          client={client}
          runtime={choice.selection ?? undefined}
          defaultScope
          disabled={busy}
          onApply={(value) => choice.setEffort(value.effortLevel)}
        />
        <Footnote style={{ paddingTop: 0 }}>只影响之后新建的任务，已经在跑的不变。</Footnote>
      </View>
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
    </KeyboardViewport>
  )
}
