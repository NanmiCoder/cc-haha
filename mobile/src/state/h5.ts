import { Platform } from 'react-native'
import { h5EntryUrl, type H5Location } from '../core/h5Session'

/**
 * The web version hosted by the desktop server for phone browsers (H5 build, see withH5Build in app.config.ts).
 * Expo inlines this public variable into the bundle at export; the dev `bun run web` preview and the native app are not H5.
 */
export const isH5 = Platform.OS === 'web' && process.env.EXPO_PUBLIC_CC_HAHA_H5 === '1'

export function h5Location(): H5Location {
  return { origin: window.location.origin, hostname: window.location.hostname }
}

/** Return to the desktop H5 entry to reconnect (token page or remote pairing page); the entry sends back here afterwards. */
export function reconnectH5(remote: boolean) {
  window.location.assign(h5EntryUrl(h5Location(), remote))
}
