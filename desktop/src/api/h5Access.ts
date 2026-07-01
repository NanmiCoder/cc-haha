import { api } from './client'
import { getDesktopHost } from '../lib/desktopHost'
import type { DesktopTunnelStartOptions, DesktopTunnelStatus } from '../lib/desktopHost/types'
import type { H5AccessDiagnostics, H5AccessSettings, H5TunnelMode } from '../types/settings'

export type { H5AccessDiagnostics, H5AccessSettings } from '../types/settings'

export type H5AccessStatus = {
  settings: H5AccessSettings
  diagnostics?: H5AccessDiagnostics
}

export type H5AccessTokenResult = {
  settings: H5AccessSettings
  token: string
}

export const h5AccessApi = {
  get() {
    return api.get<H5AccessStatus>('/api/h5-access')
  },

  enable() {
    return api.post<H5AccessTokenResult>('/api/h5-access/enable')
  },

  disable() {
    return api.post<H5AccessStatus>('/api/h5-access/disable')
  },

  regenerate() {
    return api.post<H5AccessTokenResult>('/api/h5-access/regenerate')
  },

  update(input: {
    allowedOrigins?: string[]
    publicBaseUrl?: string | null
    fixedPort?: number | null
    disconnectGraceSeconds?: number | null
    tunnelToken?: string | null
    tunnelMode?: H5TunnelMode | null
  }) {
    return api.put<H5AccessStatus>('/api/h5-access', input)
  },

  /**
   * Tunnel control runs in the desktop main process (it spawns cloudflared),
   * so these go through the desktop host bridge rather than the HTTP API.
   * Returns null when not running inside the desktop shell (e.g. a browser H5
   * session), where one-click tunnelling is unavailable.
   */
  tunnelAvailable(): boolean {
    return !!getDesktopHost().tunnel
  },

  startTunnel(options: DesktopTunnelStartOptions): Promise<DesktopTunnelStatus> {
    const host = getDesktopHost()
    if (!host.tunnel) {
      throw new Error('One-click tunnelling is only available in the desktop app.')
    }
    return host.tunnel.start(options)
  },

  stopTunnel(): Promise<DesktopTunnelStatus> {
    const host = getDesktopHost()
    if (!host.tunnel) {
      throw new Error('One-click tunnelling is only available in the desktop app.')
    }
    return host.tunnel.stop()
  },

  getTunnelStatus(): Promise<DesktopTunnelStatus> | null {
    const host = getDesktopHost()
    return host.tunnel ? host.tunnel.getStatus() : null
  },
}
