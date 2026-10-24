import { useEffect, useState } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { useConnection } from '../state/AppContext'
import { RuntimePicker } from '../ui/RuntimePicker'
import { Button, Loading, Notice, Screen, errorText } from '../ui/theme'
import type { RuntimeConfig } from '../core/types'

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
    <Screen
      title="模型与思考"
      subtitle={`${host?.name ?? '所选电脑'} · 更改电脑默认值；会话内可独立选择`}
    >
      <Notice text={connectionError || error} error />
      <Notice text={status} />
      {!currentConfig && !error && <Loading />}
      {client && currentConfig && (
        <RuntimePicker
          key={JSON.stringify(currentConfig)}
          client={client}
          initial={currentConfig}
          onApply={save}
          busy={busy}
          defaultScope
        />
      )}
      {error && (
        <Button
          title="重新读取电脑配置"
          secondary
          onPress={() => {
            setError('')
            setRevision((value) => value + 1)
          }}
        />
      )}
    </Screen>
  )
}
