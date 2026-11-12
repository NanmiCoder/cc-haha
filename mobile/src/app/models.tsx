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

/** Computer settings → new task defaults: change the computer default provider, model and thinking effort (design P2). */
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
      setStatus(`Saved the default model for ${host?.name}. Existing sessions keep their own run configuration.`)
      setRevision((value) => value + 1)
    } catch (e) {
      setError(`${errorText(e)}. Settings already applied may have been saved; reload to confirm.`)
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
      <NavBar floating title="New task defaults" subtitle={host?.name ?? 'Selected computer'} />
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

        {/* Design P2: provider header 22, other group headers 20; row height 52 / 58, separator inset 48. */}
        <SectionHeader title="Provider" style={{ paddingTop: 22 }} />
        <Group>
          {choice.loading ? (
            <View style={{ minHeight: 52, justifyContent: 'center' }}>
              <Loading />
            </View>
          ) : (
            <SettingRow
              title={provider.name || 'Provider no longer available'}
              value={provider.others}
              valueSize={14}
              titleGrow
              disabled={busy || !sources.length}
              onPress={() => setProviderOpen(true)}
              label={`Provider: ${provider.name || 'No longer available'}${provider.others ? `, ${provider.others}` : ''}`}
            />
          )}
        </Group>

        <SectionHeader title="Model" style={{ paddingTop: 20 }} />
        {choice.loading ? (
          <Loading />
        ) : !authReady ? (
          <Callout>
            {choice.source?.auth === 'missing'
              ? 'Sign in or configure this provider on the computer first, then reload.'
              : choice.source?.auth === 'error'
                ? 'Authorization status of this provider is not confirmed yet; reload before choosing a model.'
                : 'The current provider is no longer available; please choose again.'}
          </Callout>
        ) : !choice.catalogReady && !choice.error ? (
          <Loading />
        ) : choice.models.length ? (
          <Group>
            <View accessibilityRole="radiogroup" accessibilityLabel="Model">
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
                      label={[row.title, row.detail, selected ? 'Selected' : '']
                        .filter(Boolean)
                        .join(', ')}
                      onPress={() => choice.selectModel(model.id)}
                    />
                  </Fragment>
                )
              })}
            </View>
          </Group>
        ) : choice.catalogReady ? (
          <Callout>This provider has no available models.</Callout>
        ) : null}

        <SectionHeader title="Thinking effort" style={{ paddingTop: 20 }} />
        {!choice.model ? (
          <Text style={{ paddingHorizontal: 4, fontSize: 14, lineHeight: 20, color: colors.ink3 }}>
            Adjustable after choosing a model.
          </Text>
        ) : segments.length ? (
          <EffortTrack
            label="Thinking effort"
            options={segments}
            value={at >= 0 ? (segments[at]?.value ?? '') : ''}
            disabled={busy}
            onChange={choice.setEffort}
          />
        ) : (
          <Callout>{effortUnavailableReason(choice)}</Callout>
        )}

        <Footnote style={{ paddingTop: 14 }}>Affects only tasks created afterwards; running ones are unchanged.</Footnote>
      </ScrollView>
      <BottomBar>
        <Button
          title="Save"
          size="lg"
          busy={busy}
          disabled={!choice.selection}
          onPress={() => {
            if (choice.selection) onSave(choice.selection)
          }}
        />
      </BottomBar>
      <Sheet visible={providerOpen} onClose={() => setProviderOpen(false)} title="Provider">
        <Group>
          {sources.map((source, index) => (
            <Fragment key={source.id ?? 'claude-official'}>
              {index > 0 && <Separator />}
              <ChoiceRow
                title={source.name}
                selected={source.id === choice.providerId}
                detail={
                  source.auth === 'missing'
                    ? 'Not signed in'
                    : source.auth === 'error'
                      ? 'Authorization status pending'
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
