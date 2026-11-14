import { create } from 'zustand'

import { getBaseUrl } from '@/api/client'
import {
  connectRemoteWorkspace,
  disconnectRemoteWorkspace,
  waitForHealth,
} from '@/lib/desktopRuntime'
import { readRemoteWorkspace, type RemoteWorkspaceProfile } from '@/lib/remoteWorkspace'

export type RemoteWorkspaceStatus = 'idle' | 'connecting' | 'connected' | 'error'

type RemoteWorkspaceStore = {
  profile: RemoteWorkspaceProfile | null
  status: RemoteWorkspaceStatus
  error: string | null
  load: () => void
  /** Probe a URL without switching to it, for a "test connection" button. */
  verify: (url: string) => Promise<boolean>
  /** Switch the whole workspace to `url`, persisting the choice and its token. */
  connect: (url: string, sshHost: string, token?: string) => Promise<string>
  /** Forget the remote choice and return to the local server. */
  disconnect: () => void
}

/**
 * Drives the Settings ▸ Remote Workspace pane.
 *
 * The choice is persisted (`lib/remoteWorkspace`) and applied at startup by
 * `desktopRuntime.initializeDesktopServerUrl`, which runs before the renderer
 * mounts. Switching at runtime therefore reloads the window, so the session
 * list, file browser and diffs all re-resolve against the new server together
 * instead of half the app pointing at one machine and half at another.
 */
export const useRemoteWorkspaceStore = create<RemoteWorkspaceStore>((set, get) => ({
  profile: null,
  status: 'idle',
  error: null,

  load: () => {
    const profile = readRemoteWorkspace()
    const active = !!profile?.enabled && profile.url === getBaseUrl()
    set({ profile, status: active ? 'connected' : 'idle', error: null })
  },

  verify: async (url) => {
    set({ status: 'connecting', error: null })
    try {
      await waitForHealth(url.trim().replace(/\/$/, ''))
      set({ status: 'idle' })
      return true
    } catch {
      set({ status: 'error', error: 'unreachable' })
      return false
    }
  },

  connect: async (url, sshHost, token) => {
    if (get().status === 'connecting') throw new Error('already connecting')
    set({ status: 'connecting', error: null })
    try {
      const connectedUrl = await connectRemoteWorkspace(url, sshHost, token)
      // The renderer's session list, file browser and diffs were resolved
      // against the old server. Reload so startup re-resolves every one of them
      // against the remote, rather than leaving the app split across machines.
      set({ profile: readRemoteWorkspace(), status: 'connected', error: null })
      reloadWindow()
      return connectedUrl
    } catch (error) {
      set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  },

  disconnect: () => {
    disconnectRemoteWorkspace()
    set({ profile: null, status: 'idle', error: null })
    reloadWindow()
  },
}))

function reloadWindow() {
  if (typeof window !== 'undefined') window.location.reload()
}
