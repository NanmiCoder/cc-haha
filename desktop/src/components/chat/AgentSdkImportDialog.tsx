import { useState } from 'react'
import { ActionDialog } from '@/components/ui/ActionDialog'
import { SelectField } from '@/components/ui/SelectField'
import { useTranslation } from '@/i18n'
import { resolveProviderSlotModelId } from '@/lib/runtimeSelection'
import { useProviderStore } from '@/stores/providerStore'

type Props = {
  loading: boolean
  onClose: () => void
  onImport: (selection: { providerId: string; modelId: string }) => Promise<void>
}

export function AgentSdkImportDialog({ loading, onClose, onImport }: Props) {
  const t = useTranslation()
  const allProviders = useProviderStore(state => state.providers)
  const activeId = useProviderStore(state => state.activeId)
  const providers = allProviders.filter(provider => provider.runtime === 'agent-sdk')
  const [providerId, setProviderId] = useState(() => providers.find(provider => provider.id === activeId)?.id ?? providers[0]?.id ?? '')
  const provider = providers.find(item => item.id === providerId)
  const models = provider ? [...new Set((['main', 'fable', 'haiku', 'sonnet', 'opus'] as const)
    .map(slot => resolveProviderSlotModelId(provider, slot)).filter(Boolean))] : []
  const [selectedModel, setSelectedModel] = useState('')
  const modelId = models.includes(selectedModel) ? selectedModel : models[0] ?? ''
  return (
    <ActionDialog open onClose={onClose} title={t('chat.agentSdkImportTitle')} loading={loading}
      body={(
        <div className="space-y-4">
          <p className="text-sm leading-6 text-[var(--color-text-secondary)]">{t('chat.agentSdkImportDescription')}</p>
          {providers.length ? <>
            <SelectField label={t('chat.agentSdkImportProvider')} value={providerId}
              options={providers.map(item => ({ value: item.id, label: item.name }))}
              onChange={value => { setProviderId(value); setSelectedModel('') }} disabled={loading} />
            <SelectField label={t('chat.agentSdkImportModel')} value={modelId}
              options={models.map(value => ({ value, label: value }))} onChange={setSelectedModel} disabled={loading} />
          </> : <p role="status" className="text-sm text-[var(--color-text-secondary)]">{t('chat.agentSdkImportNoProvider')}</p>}
        </div>
      )}
      actions={[
        { label: t('common.cancel'), onClick: onClose },
        { label: t('chat.agentSdkImportConfirm'), variant: 'primary', disabled: !provider || !modelId,
          onClick: () => onImport({ providerId, modelId }) },
      ]} />
  )
}
