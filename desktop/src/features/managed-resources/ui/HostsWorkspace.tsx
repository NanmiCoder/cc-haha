import { useEffect, useState } from 'react'
import { useHostManagementStore } from '../stores/hostManagementStore'
import { HostList } from './hosts/HostList'
import { HostDetail } from './hosts/HostDetail'
import { HostEditModal } from './hosts/HostEditModal'
import { TagManagementModal } from './hosts/TagManagementModal'
import { ImportExportModal } from './hosts/ImportExportModal'
import { DataConnectionsWorkspace } from './DataConnectionsWorkspace'
import { useTranslation } from '../../../i18n'

export function HostsWorkspace() {
  const t = useTranslation()
  const [surface, setSurface] = useState<'hosts' | 'dataConnections'>('hosts')
  const {
    fetchCapabilities,
    fetchHosts,
    fetchTags,
    isCreatingHost,
    editingHostId,
    setIsCreatingHost,
    setEditingHostId,
  } = useHostManagementStore()

  const [isTagModalOpen, setIsTagModalOpen] = useState(false)
  const [isImportExportOpen, setIsImportExportOpen] = useState(false)

  useEffect(() => {
    fetchCapabilities()
    fetchHosts()
    fetchTags()
  }, [])

  return (
    <div data-testid="hosts-workspace" className="flex h-full w-full flex-col overflow-hidden bg-[var(--color-surface)] text-[var(--color-text-primary)]">
      <div className="flex h-11 flex-shrink-0 items-center gap-1 border-b border-[var(--color-border)] px-3">
        <button type="button" data-testid="managed-resources-hosts-surface" className={`rounded-md px-3 py-1.5 text-sm ${surface === 'hosts' ? 'bg-[var(--color-surface-selected)] font-medium' : 'text-[var(--color-text-secondary)]'}`} onClick={() => setSurface('hosts')}>{t('managedResources.surface.hosts')}</button>
        <button type="button" data-testid="managed-resources-data-surface" className={`rounded-md px-3 py-1.5 text-sm ${surface === 'dataConnections' ? 'bg-[var(--color-surface-selected)] font-medium' : 'text-[var(--color-text-secondary)]'}`} onClick={() => setSurface('dataConnections')}>{t('managedResources.surface.dataConnections')}</button>
      </div>
      {surface === 'dataConnections' ? (
        <DataConnectionsWorkspace />
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex w-80 flex-shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-sidebar)]">
            <HostList onOpenTagModal={() => setIsTagModalOpen(true)} onOpenImportExport={() => setIsImportExportOpen(true)} />
          </div>
          <div className="flex flex-1 flex-col overflow-y-auto bg-[var(--color-surface)]">
            <HostDetail onOpenTagModal={() => setIsTagModalOpen(true)} onOpenImportExport={() => setIsImportExportOpen(true)} />
          </div>
        </div>
      )}

      {surface === 'hosts' && (isCreatingHost || editingHostId !== null) && (
        <HostEditModal hostId={editingHostId} onClose={() => { setIsCreatingHost(false); setEditingHostId(null) }} />
      )}
      {surface === 'hosts' && isTagModalOpen && <TagManagementModal onClose={() => setIsTagModalOpen(false)} />}
      {surface === 'hosts' && isImportExportOpen && <ImportExportModal onClose={() => setIsImportExportOpen(false)} />}
    </div>
  )
}
