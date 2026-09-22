import { useEffect, useRef, useState } from 'react'
import { getDesktopHost } from '@/lib/desktopHost'
import type { HostManagementResult, ManagedTransferJob } from '../../api/hostManagementApi'

type Context = { hostId: string; connectionId: string | null; generation: number; connected: boolean; onUploaded: () => void; maxConcurrent?: 1 | 3 }
type Operation = { id: string; live: boolean; cancelled: boolean; picking: boolean; stopPolling: () => void; api: ReturnType<typeof getDesktopHost>['hostManagement'] }

export type RemoteTransferTask = {
  id: string
  direction: 'upload' | 'download'
  remotePath: string
  folder: boolean
  state: ManagedTransferJob['state']
  job: ManagedTransferJob | null
  active: boolean
  picking: boolean
  cancelling: boolean
  error: string | null
}

export function useRemoteTransfers(context: Context) {
  const [busy, setBusy] = useState(false)
  const [job, setJob] = useState<ManagedTransferJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tasks, setTasks] = useState<RemoteTransferTask[]>([])
  const active = useRef(new Map<string, Operation>())
  const limit = context.maxConcurrent ?? 1
  const patchTask = (operation: Operation, patch: Partial<RemoteTransferTask>) => {
    if (operation.live) setTasks(current => current.map(task => task.id === operation.id ? { ...task, ...patch } : task))
  }
  const latest = useRef(context)
  latest.current = context
  useEffect(() => {
    setBusy(false)
    setJob(null)
    setError(null)
    setTasks([])
    const operations = active.current
    return () => {
      for (const operation of operations.values()) {
        operation.live = false
        operation.cancelled = true
        operation.stopPolling()
        void operation.api.transferCancel(operation.id).catch(() => undefined)
      }
      operations.clear()
    }
  }, [context.hostId, context.connectionId, context.generation, context.connected])

  async function run(direction: 'upload' | 'download', folder: boolean, remotePath: string, fileName?: string) {
    if (active.current.size >= limit || [...active.current.values()].some(value => value.picking) || !context.connected || !context.connectionId) return
    const api = getDesktopHost().hostManagement
    const operation: Operation = { id: crypto.randomUUID(), live: true, cancelled: false, picking: true, stopPolling() {}, api }
    const freshBatch = active.current.size === 0
    active.current.set(operation.id, operation)
    setTasks(previous => [
      ...(freshBatch ? [] : previous.filter((task, index) => task.active || index >= previous.length - 16)),
      { id: operation.id, direction, remotePath, folder, job: null, state: 'preparing', active: true, picking: true, cancelling: false, error: null },
    ])
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
          && result.data.id === operation.id && result.data.connectionId === input.connectionId && result.data.generation === input.generation
          && !['completed', 'failed', 'cancelled'].includes(result.data.state)) {
          operation.picking = false
          setJob(result.data)
          patchTask(operation, { job: result.data, state: result.data.state, remotePath: result.data.remotePath, picking: false })
        }
      } catch { /* The initial native picker has not created a job yet. */ }
      finally { polling = false }
    }, 300)
    operation.stopPolling = () => { receivingProgress = false; clearInterval(timer) }
    try {
      let result: HostManagementResult<ManagedTransferJob>
      if (folder) result = await (direction === 'upload' ? api.transferUploadFolder(input) : api.transferDownloadFolder(input))
      else {
        const picked = await (direction === 'upload' ? api.mintUploadToken('upload.bin') : api.mintDownloadToken(fileName!))
        if (!picked.ok) throw new Error(picked.error.code)
        token = picked.data.token
        if (!operation.live || operation.cancelled) throw new Error('CANCELLED')
        operation.picking = false
        patchTask(operation, { picking: false })
        const current = latest.current
        if (!current.connected || current.connectionId !== input.connectionId || current.generation !== input.generation) throw new Error('DISCONNECTED')
        if (direction === 'upload') {
          const name = picked.data.absolutePath.split(/[\\/]/).pop()!.replace(/^[0-9a-f]{8}__/i, '')
          const target = `${remotePath.replace(/\/+$/, '')}/${name}`
          patchTask(operation, { remotePath: target })
          result = await api.transferStartUpload(input.jobId, input.connectionId, input.generation, target, token)
        } else result = await api.transferStartDownload(input.jobId, input.connectionId, input.generation, remotePath, token)
      }
      receivingProgress = false
      clearInterval(timer)
      if (!operation.live) return
      if (!result.ok) throw new Error(result.error.code)
      setJob(result.data)
      patchTask(operation, { job: result.data, state: result.data.state, remotePath: result.data.remotePath, picking: false, cancelling: false, error: result.data.error?.code ?? null })
      if (result.data.state === 'failed') setError(result.data.error?.code ?? 'TRANSFER_FAILED')
      if (result.data.state === 'completed' && direction === 'upload') latest.current.onUploaded()
    } catch (failure) {
      if (operation.live) {
        const code = failure instanceof Error ? failure.message : 'TRANSFER_FAILED'
        patchTask(operation, { state: code === 'CANCELLED' ? 'cancelled' : 'failed', picking: false, cancelling: false, error: code === 'CANCELLED' ? null : code })
        if (code !== 'CANCELLED') setError(code)
      }
    } finally {
      // A previously sent poll may settle while native token cleanup is awaited.
      receivingProgress = false
      clearInterval(timer)
      if (token) await api.revokeLocalToken(token).catch(() => undefined)
      if (operation.live) {
        patchTask(operation, { active: false, picking: false, cancelling: false })
        active.current.delete(operation.id)
        setBusy(active.current.size > 0)
      }
      operation.live = false
    }
  }
  return {
    busy, job, error, tasks,
    canStart: context.connected && !!context.connectionId && tasks.filter(task => task.active).length < limit && !tasks.some(task => task.active && task.picking),
    upload: (remoteDirectory: string) => run('upload', false, remoteDirectory),
    download: (remotePath: string, name: string) => run('download', false, remotePath, name),
    uploadFolder: (remoteDirectory: string) => run('upload', true, remoteDirectory),
    downloadFolder: (remoteDirectory: string) => run('download', true, remoteDirectory),
    async cancel(id?: string) {
      const operation = id ? active.current.get(id) : active.current.values().next().value
      if (!operation) return
      operation.cancelled = true
      patchTask(operation, { cancelling: true })
      try {
        const result = await operation.api.transferCancel(operation.id)
        if (operation.live && !result.ok && result.error.code !== 'RESOURCE_NOT_FOUND') {
          setError(result.error.code)
          patchTask(operation, { error: result.error.code })
        }
      } catch {
        if (operation.live) { setError('TRANSFER_FAILED'); patchTask(operation, { error: 'TRANSFER_FAILED' }) }
      } finally { patchTask(operation, { cancelling: false }) }
    },
  }
}
