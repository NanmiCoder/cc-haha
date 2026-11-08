import { fetch as expoFetch } from 'expo/fetch'
import { addNetworkStateListener, getNetworkStateAsync } from 'expo-network'
import { AppState, Platform } from 'react-native'
import { ApiClient, type FetchAdapter } from '../core/client'
import { foregroundTransitions } from '../core/appVisibility'
import { HostLink, hostLinks } from '../core/hostLink'
import { watchNetwork } from '../core/networkWatcher'
import { nativeRtc } from '../core/p2p/rtc'
import type { SocketFactory, SocketLike } from '../core/sessionTransport'
import type { Host } from '../core/types'
import { isH5 } from './h5'

/** The H5 page's requests carry the remote device cookie; nothing else sends cookies. */
export const fetchCredentials = isH5 ? 'same-origin' : 'omit'

// Explicitly use Expo's native transport: RN's legacy fetch may follow redirects.
const cloudflareFetch: FetchAdapter = (input, options) => expoFetch(input, options)

const NativeSocket = WebSocket as unknown as new (
  url: string,
  protocols?: string[],
  options?: { headers?: Record<string, string> }
) => SocketLike
/** The native app's WebSocket: carries the bearer and pinned Origin headers. */
export const nativeSocketFactory: SocketFactory = (options) =>
  new NativeSocket(options.url, undefined, { headers: options.headers })

/**
 * Calls `onChange` when the device switches networks. The current state is read
 * once as a baseline: the native observer only reports it to its first
 * subscriber, so a later one would otherwise swallow the first real switch.
 */
export function watchDeviceNetwork(onChange: () => void) {
  return watchNetwork(
    (listener) => addNetworkStateListener((state) => listener({ type: state.type, isConnected: state.isConnected })),
    onChange,
    undefined,
    getNetworkStateAsync
  )
}

let watching = false
/** One app-wide watcher moves every host's link with the app and the network. */
function watchLinks() {
  if (watching) return
  watching = true
  // Only a real trip through the background counts: iOS flickers to inactive for
  // Control Center or Face ID, and that must not reset cooldowns each time.
  const transition = foregroundTransitions(AppState.currentState)
  AppState.addEventListener('change', (state) => {
    const change = transition(state)
    if (!change) return
    for (const link of hostLinks.all()) {
      if (change === 'returned') link.foreground()
      else link.background()
    }
  })
  watchDeviceNetwork(() => {
    for (const link of hostLinks.all()) link.networkChanged()
  })
}

/**
 * The connection path to a remote computer: Cloudflare first, upgraded to a
 * direct (P2P) path in the background when the native WebRTC module is there.
 * LAN hosts and the H5 page talk to the computer directly already.
 */
export function hostLinkFor(host: Host, credential: string) {
  if (host.auth !== 'remote' || Platform.OS === 'web') return undefined
  const rtc = nativeRtc()
  if (!rtc) return undefined
  watchLinks()
  return hostLinks.for(host, credential, () => new HostLink({
    host,
    credential,
    cfFetch: cloudflareFetch,
    cfSocket: nativeSocketFactory,
    rtc,
  }))
}

export function createApiClient(host: Host, credential: string) {
  const link = hostLinkFor(host, credential)
  return new ApiClient(host, credential, {
    fetch: link?.fetch ?? cloudflareFetch,
    credentials: fetchCredentials,
  })
}
