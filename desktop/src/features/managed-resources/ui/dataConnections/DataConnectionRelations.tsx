import { useEffect, useMemo, useState } from 'react'
import { getDesktopHost } from '../../../../lib/desktopHost'
import { useTranslation } from '../../../../i18n'
import type { Host, ResourceTag } from '../../types/resourceTypes'

type Props = {
  namespace: 'database' | 'redis'
  tagIds: string[]
  relatedHostId: string | null
  disabled: boolean
  onTagsChange: (ids: string[]) => void
  onHostChange: (id: string | null) => void
  onPendingChange: (pending: boolean) => void
}

export function DataConnectionRelations(props: Props) {
  const t = useTranslation()
  const host = useMemo(() => getDesktopHost(), [])
  const [tags, setTags] = useState<ResourceTag[]>([])
  const [hosts, setHosts] = useState<Host[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    let disposed = false
    void Promise.all([host.hostManagement.listTags(props.namespace), host.hostManagement.listHosts()]).then(([tagResult, hostResult]) => {
      if (disposed) return
      if (!tagResult.ok || !hostResult.ok) { setError(true); return }
      setTags(tagResult.data)
      setHosts(hostResult.data)
    }).catch(() => { if (!disposed) setError(true) })
    return () => { disposed = true }
  }, [host, props.namespace])

  const createTag = async () => {
    if (!name.trim() || busy || props.disabled) return
    setBusy(true)
    setError(false)
    props.onPendingChange(true)
    try {
      const result = await host.hostManagement.saveTag({ mode: 'create', namespace: props.namespace, name: name.trim(), colorToken: null })
      if (!result.ok) { setError(true); return }
      setTags(current => [...current, result.data])
      props.onTagsChange([...new Set([...props.tagIds, result.data.id])])
      setName('')
    } catch { setError(true) }
    finally { setBusy(false); props.onPendingChange(false) }
  }

  return (
    <fieldset disabled={props.disabled || busy} className="mt-4 space-y-3 rounded-md border border-[var(--color-border)] p-3">
      <legend className="px-1 text-sm">{t('managedResources.dataConnections.relations')}</legend>
      {error && <p role="alert" className="text-xs text-[var(--color-error)]">{t('managedResources.m2.operationFailed')}</p>}
      <div className="flex flex-wrap gap-3">
        {tags.map(tag => <label key={tag.id} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={props.tagIds.includes(tag.id)} onChange={event => props.onTagsChange(event.currentTarget.checked ? [...new Set([...props.tagIds, tag.id])] : props.tagIds.filter(id => id !== tag.id))} />{tag.name}</label>)}
      </div>
      <div className="flex items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-xs">
          <span>{t('managedResources.dataConnections.newTag')}</span>
          <input data-testid="data-connection-new-tag" className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2" value={name} maxLength={120} onChange={event => setName(event.currentTarget.value)} />
        </label>
        <button type="button" data-testid="data-connection-add-tag" className="h-8 rounded-md border border-[var(--color-border)] px-3 text-xs" disabled={!name.trim()} onClick={() => void createTag()}>{t('managedResources.addTag')}</button>
      </div>
      <label className="flex flex-col gap-1 text-xs">
        <span>{t('managedResources.dataConnections.relatedHost')}</span>
        <select data-testid="data-connection-related-host" className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2" value={props.relatedHostId ?? ''} onChange={event => props.onHostChange(event.currentTarget.value || null)}>
          <option value="">{t('managedResources.dataConnections.noRelatedHost')}</option>
          {hosts.map(item => <option key={item.id} value={item.id}>{item.name} ({item.address})</option>)}
          {props.relatedHostId && !hosts.some(item => item.id === props.relatedHostId) && <option value={props.relatedHostId}>{props.relatedHostId}</option>}
        </select>
      </label>
    </fieldset>
  )
}
