import { useEffect, useRef, useState } from 'react'
import { getDesktopHost } from '@/lib/desktopHost'
import type { HostManagementResult, ManagedTransferJob } from '../../api/hostManagementApi'

type Context = { hostId: string; connectionId: string | null; generation: number; connected: boolean; onUploaded: () => void }
type Operation = { id: string; live: boolean; cancelled: boolean; api: ReturnType<typeof getDesktopHost>['hostManagement'] }

export function useRemoteTransfers(context: Context) {
  const [busy, setBusy] = useState(false)
  const [job, setJob] = useState<ManagedTransferJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const active = useRef<Operation | null>(null)
  const latest = useRef(context)
  latest.current = context
  useEffect(() => {
    setBusy(false)
    setJob(null)
    setError(null)
    return () => {
      const operation = active.current
      if (!operation) return
      operation.live = false
      operation.cancelled = true
      void operation.api.transferCancel(operation.id).catch(() => undefined)
      active.current = null
    }
  }, [context.hostId, context.connectionId, context.generation])

  async function run(direction: 'upload' | 'download', folder: boolean, remotePath: string, fileName?: string) {
    if (active.current || !context.connected || !context.connectionId) return
    const api = getDesktopHost().hostManagement
    const operation: Operation = { id: crypto.randomUUID(), live: true, cancelled: false, api }
    active.current = operation
    setBusy(true)
    setJob(null)
    setError(null)
    const input = { jobId: operation.id, connectionId: context.connectionId, generation: context.generation, remotePath }
    let token: string | undefined
    let polling = false
    let receivingProgress = true
    const timer = setInterval(async () => {
      if (!operation.live || !receivingProgress || polling) return
      polling = true
      try {
        const result = await api.transferGet(operation.id)
        if (operation.live && receivingProgress && result.ok
          && !['completed', 'failed', 'cancelled'].includes(result.data.state)) setJob(result.data)
      } catch { /* The initial native picker has not created a job yet. */ }
      finally { polling = false }
    }, 300)
    try {
      let result: HostManagementResult<ManagedTransferJob>
      if (folder) result = await (direction === 'upload' ? api.transferUploadFolder(input) : api.transferDownloadFolder(input))
      else {
        const picked = await (direction === 'upload' ? api.mintUploadToken('upload.bin') : api.mintDownloadToken(fileName!))
        if (!picked.ok) { if (picked.error.code !== 'CANCELLED') throw new Error(picked.error.code); return }
        token = picked.data.token
        if (!operation.live || operation.cancelled) return
        const current = latest.current
        if (!current.connected || current.connectionId !== input.connectionId || current.generation !== input.generation) throw new Error('DISCONNECTED')
        if (direction === 'upload') {
          const name = picked.data.absolutePath.split(/[\\/]/).pop()!.replace(/^[0-9a-f]{8}__/i, '')
          const target = `${remotePath.replace(/\/+$/, '')}/${name}`
          result = await api.transferStartUpload(input.jobId, input.connectionId, input.generation, target, token)
        } else result = await api.transferStartDownload(input.jobId, input.connectionId, input.generation, remotePath, token)
      }
      receivingProgress = false
      clearInterval(timer)
      if (!operation.live) return
      if (!result.ok) { if (result.error.code !== 'CANCELLED') throw new Error(result.error.code); return }
      setJob(result.data)
      if (result.data.state === 'failed') setError(result.data.error?.code ?? 'TRANSFER_FAILED')
      if (result.data.state === 'completed' && direction === 'upload') latest.current.onUploaded()
    } catch (failure) {
      if (operation.live) setError(failure instanceof Error ? failure.message : 'TRANSFER_FAILED')
    } finally {
      // A previously sent poll may settle while native token cleanup is awaited.
      receivingProgress = false
      clearInterval(timer)
      if (token) await api.revokeLocalToken(token).catch(() => undefined)
      if (operation.live) { setBusy(false); active.current = null }
      operation.live = false
    }
  }
  return {
    busy, job, error,
    upload: (remoteDirectory: string) => run('upload', false, remoteDirectory),
    download: (remotePath: string, name: string) => run('download', false, remotePath, name),
    uploadFolder: (remoteDirectory: string) => run('upload', true, remoteDirectory),
    downloadFolder: (remoteDirectory: string) => run('download', true, remoteDirectory),
    async cancel() {
      const operation = active.current
      if (!operation) return
      operation.cancelled = true
      try {
        const result = await operation.api.transferCancel(operation.id)
        if (operation.live && !result.ok && result.error.code !== 'RESOURCE_NOT_FOUND') setError(result.error.code)
      } catch { if (operation.live) setError('TRANSFER_FAILED') }
    },
  }
}
