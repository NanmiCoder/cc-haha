import { create } from 'zustand'
import type {
  Host,
  SshConnectionStatus,
  HostManagementEvent,
} from '../types/resourceTypes'
import { getDesktopHost } from '../../../lib/desktopHost/index'

export type HostSshStatus =
  | 'idle'
  | 'allocating'
  | 'connecting'
  | 'awaiting_host_key'
  | 'ready'
  | 'closing'
  | 'closed'
  | 'failed'

export type HostSshEntry = {
  hostId: string
  connectionId: string | null
  generation: number
  status: HostSshStatus
  challenge: { challengeId: string; endpoint: string; algorithm: string; fingerprint: string } | null
  lastError: string | null
  changedKey: null | { oldFingerprint: string; newFingerprint: string; endpoint: string; algorithm: string }
  unackedBytes: number
  isPaused: boolean
  // We store the most recent output byte length so the surface can ack on
  // render. The service itself owns backpressure semantics; the store only
  // mirrors the current unacked count surfaced by the host.
  unlistenEvent: (() => void) | null
}

export type HostSshState = {
  byHostId: Record<string, HostSshEntry>
  ensureEntry: (hostId: string) => HostSshEntry
  start: (host: Host, cols: number, rows: number) => Promise<void>
  answer: (hostId: string, decision: 'trust' | 'reject') => Promise<void>
  write: (hostId: string, data: string) => Promise<void>
  resize: (hostId: string, cols: number, rows: number) => Promise<void>
  ack: (hostId: string, bytesAcked: number) => Promise<void>
  disconnect: (hostId: string) => Promise<void>
  teardownAll: () => void
}

function toSshStatus(status: SshConnectionStatus): HostSshStatus {
  switch (status) {
    case 'allocated': return 'allocating'
    case 'connecting': return 'connecting'
    case 'awaiting_host_key': return 'awaiting_host_key'
    case 'authenticating': return 'connecting'
    case 'ready': return 'ready'
    case 'closing': return 'closing'
    case 'closed': return 'closed'
    case 'disconnected': return 'closed'
    case 'failed': return 'failed'
  }
}

function emptyEntry(hostId: string): HostSshEntry {
  return {
    hostId,
    connectionId: null,
    generation: 0,
    status: 'idle',
    challenge: null,
    lastError: null,
    changedKey: null,
    unackedBytes: 0,
    isPaused: false,
    unlistenEvent: null,
  }
}

// We track every per-host event unlisten globally so the store can release
// them when the workbench unmounts or when the user switches hosts.
const unlistenByHost = new Map<string, () => void>()

export const useHostSshStore = create<HostSshState>((set, get) => ({
  byHostId: {},
  ensureEntry(hostId) {
    const existing = get().byHostId[hostId]
    if (existing) return existing
    const entry = emptyEntry(hostId)
    set(state => ({ byHostId: { ...state.byHostId, [hostId]: entry } }))
    return entry
  },
  async start(host, cols, rows) {
    const entry = get().byHostId[host.id] ?? emptyEntry(host.id)
    const hostApi = getDesktopHost().hostManagement
    if (entry.connectionId) {
      // Active attempts are idempotent, but a failed generation is explicitly
      // retryable through the same service connection so the main process can
      // advance its generation without leaking another allocated session.
      if (entry.status !== 'failed' && entry.status !== 'closed') return
      const retry = await hostApi.startConnection({ connectionId: entry.connectionId })
      if (!retry.ok) {
        set(state => ({
          byHostId: {
            ...state.byHostId,
            [host.id]: {
              ...(state.byHostId[host.id] ?? emptyEntry(host.id)),
              status: 'failed',
              lastError: retry.error.messageKey,
            },
          },
        }))
      }
      return
    }

    // Bind event subscription for this host BEFORE createConnection so the
    // first 'allocated' event reaches us. The IPC handler also registers its
    // own binding for delivery gating — that one is the gate; this one is
    // the UI's mirror.
    if (!unlistenByHost.has(host.id)) {
      const unlisten = await hostApi.onEvent((event: HostManagementEvent) => {
        if (!('connectionId' in event)) return
        const entryNow = get().byHostId[host.id]
        if (!entryNow) return
        if (entryNow.connectionId && entryNow.connectionId !== event.connectionId) return
        if (event.type === 'connection-state') {
          set(state => {
            const existing = state.byHostId[host.id] ?? emptyEntry(host.id)
            const status = toSshStatus(event.status)
            return {
              byHostId: {
                ...state.byHostId,
                [host.id]: {
                  ...existing,
                  status,
                  // A host-key challenge only exists while KEX is explicitly
                  // waiting for a decision. Never keep a stale challenge after
                  // authentication, success, rejection or disconnect.
                  challenge: event.status === 'awaiting_host_key'
                    ? (event.hostKeyChallenge ?? existing.challenge)
                    : null,
                  lastError: status === 'failed' ? (event.error ?? existing.lastError) : null,
                  generation: event.generation,
                  connectionId: event.connectionId,
                  changedKey: event.status === 'connecting' || event.status === 'ready'
                    ? null
                    : existing.changedKey,
                },
              },
            }
          })
        } else if (event.type === 'connection-host-key-changed') {
          set(state => {
            const existing = state.byHostId[host.id] ?? emptyEntry(host.id)
            return {
              byHostId: {
                ...state.byHostId,
                [host.id]: {
                  ...existing,
                  status: 'failed',
                  lastError: 'HOST_KEY_CHANGED',
                  changedKey: {
                    oldFingerprint: event.oldFingerprint,
                    newFingerprint: event.newFingerprint,
                    endpoint: event.endpoint,
                    algorithm: event.algorithm,
                  },
                },
              },
            }
          })
        }
      })
      unlistenByHost.set(host.id, unlisten)
    }

    const create = await hostApi.createConnection({ hostId: host.id, cols, rows })
    if (!create.ok) {
      const unlisten = unlistenByHost.get(host.id)
      if (unlisten) unlisten()
      unlistenByHost.delete(host.id)
      set(state => ({
        byHostId: {
          ...state.byHostId,
          [host.id]: {
            ...(state.byHostId[host.id] ?? emptyEntry(host.id)),
            status: 'failed',
            lastError: create.error.messageKey,
          },
        },
      }))
      return
    }
    set(state => ({
      byHostId: {
        ...state.byHostId,
        [host.id]: {
          ...(state.byHostId[host.id] ?? emptyEntry(host.id)),
          connectionId: create.data.connectionId,
          generation: create.data.generation,
          status: 'allocating',
          lastError: null,
        },
      },
    }))
    const startRes = await hostApi.startConnection({ connectionId: create.data.connectionId })
    if (!startRes.ok) {
      // A start failure leaves an allocated main-process connection. Release it
      // before clearing the renderer id so a retry cannot exhaust the per-owner
      // connection limit with unreachable sessions.
      await hostApi.disconnect({ connectionId: create.data.connectionId }).catch(() => undefined)
      const unlisten = unlistenByHost.get(host.id)
      if (unlisten) unlisten()
      unlistenByHost.delete(host.id)
      set(state => {
        const existing = state.byHostId[host.id] ?? emptyEntry(host.id)
        return {
          byHostId: {
            ...state.byHostId,
            [host.id]: {
              ...existing,
              connectionId: null,
              generation: 0,
              status: 'failed',
              lastError: startRes.error.messageKey,
            },
          },
        }
      })
      return
    }
  },
  async answer(hostId, decision) {
    const entry = get().byHostId[hostId]
    if (!entry || !entry.connectionId || !entry.challenge) return
    const res = await getDesktopHost().hostManagement.answerHostKey({
      connectionId: entry.connectionId,
      challengeId: entry.challenge.challengeId,
      decision,
    })
    if (!res.ok) {
      set(state => {
        const existing = state.byHostId[hostId] ?? emptyEntry(hostId)
        return {
          byHostId: {
            ...state.byHostId,
            [hostId]: { ...existing, lastError: res.error.messageKey },
          },
        }
      })
      return
    }
    set(state => {
      const existing = state.byHostId[hostId] ?? emptyEntry(hostId)
      return {
        byHostId: {
          ...state.byHostId,
          [hostId]: { ...existing, challenge: null },
        },
      }
    })
  },
  async write(hostId, data) {
    const entry = get().byHostId[hostId]
    if (!entry || !entry.connectionId) return
    const res = await getDesktopHost().hostManagement.writeConnection({
      connectionId: entry.connectionId,
      generation: entry.generation,
      data,
    })
    if (!res.ok) {
      set(state => {
        const existing = state.byHostId[hostId] ?? emptyEntry(hostId)
        return {
          byHostId: {
            ...state.byHostId,
            [hostId]: { ...existing, lastError: res.error.messageKey },
          },
        }
      })
    }
  },
  async resize(hostId, cols, rows) {
    const entry = get().byHostId[hostId]
    if (!entry || !entry.connectionId) return
    const res = await getDesktopHost().hostManagement.resizeConnection({
      connectionId: entry.connectionId,
      generation: entry.generation,
      cols,
      rows,
    })
    if (!res.ok) {
      set(state => {
        const existing = state.byHostId[hostId] ?? emptyEntry(hostId)
        return {
          byHostId: {
            ...state.byHostId,
            [hostId]: { ...existing, lastError: res.error.messageKey },
          },
        }
      })
    }
  },
  async ack(hostId, bytesAcked) {
    const entry = get().byHostId[hostId]
    if (!entry || !entry.connectionId) return
    const res = await getDesktopHost().hostManagement.ackOutput({
      connectionId: entry.connectionId,
      generation: entry.generation,
      bytesAcked,
    })
    if (!res.ok) return
    set(state => {
      const existing = state.byHostId[hostId] ?? emptyEntry(hostId)
      return {
        byHostId: {
          ...state.byHostId,
          [hostId]: {
            ...existing,
            unackedBytes: Math.max(0, existing.unackedBytes - bytesAcked),
          },
        },
      }
    })
  },
  async disconnect(hostId) {
    const entry = get().byHostId[hostId]
    if (!entry || !entry.connectionId) return
    const result = await getDesktopHost().hostManagement.disconnect({ connectionId: entry.connectionId })
    if (!result.ok) {
      set(state => {
        const existing = state.byHostId[hostId] ?? emptyEntry(hostId)
        return {
          byHostId: {
            ...state.byHostId,
            [hostId]: { ...existing, lastError: result.error.messageKey },
          },
        }
      })
      return
    }
    // The main process emits closing/closed before resolving the IPC call. Do
    // not overwrite that terminal state with a stale local "closing" value.
    set(state => {
      const existing = state.byHostId[hostId] ?? emptyEntry(hostId)
      return {
        byHostId: {
          ...state.byHostId,
          [hostId]: {
            ...existing,
            connectionId: null,
            generation: 0,
            status: 'closed',
            challenge: null,
          },
        },
      }
    })
    const unlisten = unlistenByHost.get(hostId)
    if (unlisten) unlisten()
    unlistenByHost.delete(hostId)
  },
  teardownAll() {
    for (const [, unlisten] of unlistenByHost.entries()) unlisten()
    unlistenByHost.clear()
    set({ byHostId: {} })
  },
}))
